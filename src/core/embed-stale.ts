/**
 * Stale-chunk embedding loop, extracted from `src/commands/embed.ts:embedAllStale`
 * for reuse by the v0.40 `embed-backfill` Minion handler (D15.2 — codex
 * outside-voice catch).
 *
 * Single source of truth for the cursor-paginated, source-grouped, rate-limit-
 * aware embedding pipeline. The `embed-backfill` job (Minion) calls this
 * helper, and the foreground stale path shares its fallback state machine.
 * Keyset pagination, grouping by `source_id::slug`, merge-with-existing via
 * `getChunks` + `upsertChunks`, and AbortSignal threading into HTTP all live
 * here. Foreground-only aggregation and CLI logging deliberately remain in
 * `embed.ts`.
 */
import type { BrainEngine } from './engine.ts';
import type { Chunk, ChunkInput } from './types.ts';
import { embedBatchWithBackoff, restampIfDemotedToTitleTier } from '../commands/embed.ts';
import { wrapChunkTextsForStoredMode } from './embedding-context.ts';
import { type DbPacer, createNoopPacer, observed } from './db-pacer.ts';
import { AbortError } from './abort-check.ts';
import { persistStaleSlice } from './embed-slice-persist.ts';
import { resolveEmbedSubBatchSize } from './embed-slices.ts';

/**
 * W0 fix-wave (Tier-1 #3, CONFIRMED): the ONE carry-through field list for
 * re-embed upserts. upsertChunks writes these columns as EXCLUDED.<col>
 * (overwrite, not COALESCE), so any re-embed path that omits a field resets
 * it — omitting `modality` flipped every image chunk to modality='text',
 * silently zeroing the image search arm (filter `cc.modality = 'image'`).
 * Pre-fix this list existed twice: here (correct, with modality) and in
 * commands/embed.ts preserveCodeMetadata (missing modality — the bug). Both
 * consumers now share THIS list; embedding_image is deliberately NOT carried
 * (the upsert COALESCEs it, and getChunks returns the pgvector as a string
 * which upsertChunks would mis-serialize).
 */
export function carryChunkMetadata(
  loaded: Pick<Partial<Chunk>,
    'modality' | 'language' | 'symbol_name' | 'symbol_type' | 'start_line'
    | 'end_line' | 'parent_symbol_path' | 'doc_comment' | 'symbol_name_qualified'>,
  base: ChunkInput,
): ChunkInput {
  return {
    ...base,
    modality: loaded.modality ?? undefined,
    language: loaded.language ?? undefined,
    symbol_name: loaded.symbol_name ?? undefined,
    symbol_type: loaded.symbol_type ?? undefined,
    start_line: loaded.start_line ?? undefined,
    end_line: loaded.end_line ?? undefined,
    parent_symbol_path: loaded.parent_symbol_path ?? undefined,
    doc_comment: loaded.doc_comment ?? undefined,
    symbol_name_qualified: loaded.symbol_name_qualified ?? undefined,
  };
}

/** Last visited (page_id, chunk_index) for keyset-resume across runs. */
export interface StaleCursor {
  afterPageId: number;
  afterChunkIndex: number;
}

export interface EmbedStaleOpts {
  /** Chunks per cursor page. Default 2000 (matches the legacy CLI default). */
  batchSize?: number;
  /** Max parallel slug-keys embedded inside a single batch. Default 20. */
  concurrency?: number;
  /** Resume cursor from a prior run. Default: from start. */
  cursor?: StaleCursor;
  /** AbortSignal honored at batch claim, retry sleep, and HTTP body. */
  signal?: AbortSignal;
  /** Fired after each completed batch for crash-resumable Minion progress. */
  onProgress?: (state: { embedded: number; chunksProcessed: number; cursor: StaleCursor }) => void;
  /** Optional deterministic test seam; production uses embedBatchWithBackoff. */
  embedFn?: (texts: string[], opts: { abortSignal?: AbortSignal }) => Promise<Float32Array[]>;
  /**
   * Current embedding provenance signature (`<provider:model>:<dims>`). When
   * set, embeddings from a different signature are invalidated before the
   * NULL cursor walks them; omit for legacy NULL-only stale mode.
   */
  embeddingSignature?: string;
  /**
   * Optional DB-contention pacer. It observes DB latency and paces between
   * keys, but never acquires an additional permit on this worker pool.
   */
  pacer?: DbPacer;
}

export interface EmbedStaleResult {
  /** Chunks newly embedded in this call. */
  embedded: number;
  /** Total chunks pulled across all batches (including ones that errored). */
  chunksProcessed: number;
  /** Pages whose partial/full vectors landed. */
  pagesProcessed: number;
  /** Last cursor reached; null iff no stale chunks existed at start. */
  lastCursor: StaleCursor | null;
  /** True iff the loop exited because every stale chunk was processed. */
  done: boolean;
  /** True iff the supplied signal fired. */
  aborted: boolean;
  /**
   * Atomic DB checkpoint attempts that rolled back; never enter the ledger.
   * Also counts a #3507 contextual-retrieval restamp that failed AFTER its
   * page's vectors already committed (codex review round 2) — not itself a
   * rolled-back checkpoint, but reusing this counter (rather than crashing
   * the whole `embedStaleForSource` call, its pre-existing behavior) is the
   * cheapest way to surface it without a re-embed-triggering false failure.
   */
  persistFailures?: number;
}

/**
 * Embed every stale (`embedding IS NULL`) chunk for one source.
 *
 * Re-entrancy contract: if interrupted, a later call resumes from the next
 * stale row. The cursor is a progress optimization, not a correctness
 * mechanism: completed vectors are naturally excluded on a later NULL-only
 * pass. Ordinary per-page failures do not poison the run; partial successes
 * persist before return or a typed must-abort is propagated to the handler.
 */
export async function embedStaleForSource(
  engine: BrainEngine,
  sourceId: string,
  opts: EmbedStaleOpts = {},
): Promise<EmbedStaleResult> {
  const batchSize = opts.batchSize ?? 2000;
  const concurrency = opts.concurrency ?? 20;
  const signal = opts.signal;
  const embedFn = opts.embedFn ?? ((texts, fnOpts) =>
    embedBatchWithBackoff(texts, { abortSignal: fnOpts.abortSignal }));
  const pacer = opts.pacer ?? createNoopPacer();
  let afterPageId = opts.cursor?.afterPageId ?? 0;
  let afterChunkIndex = opts.cursor?.afterChunkIndex ?? -1;
  const result: EmbedStaleResult = {
    embedded: 0,
    chunksProcessed: 0,
    pagesProcessed: 0,
    lastCursor: null,
    done: false,
    aborted: false,
    persistFailures: 0,
  };
  const committedPages = new Set<string>();
  const subBatchSize = resolveEmbedSubBatchSize();
  const signature = opts.embeddingSignature;
  const write = (message: string): void => { process.stderr.write(`\n  ${message}\n`); };
  let signatureInvalidationFailed = false;

  if (signature) {
    try {
      await engine.invalidateStaleSignatureEmbeddings({ signature, sourceId });
    } catch (error) {
      signatureInvalidationFailed = true;
      write(`[embed-signature-invalidation-fail] source_id=${sourceId} err=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (;;) {
    if (signal?.aborted) {
      result.aborted = true;
      return result;
    }
    const batch = await observed(pacer, () => engine.listStaleChunks({
      batchSize,
      afterPageId,
      afterChunkIndex,
      sourceId,
      ...(signature && { signature }),
    }));
    if (batch.length === 0) {
      result.done = true;
      return result;
    }

    result.chunksProcessed += batch.length;
    const last = batch[batch.length - 1]!;
    afterPageId = last.page_id;
    afterChunkIndex = last.chunk_index;
    result.lastCursor = { afterPageId, afterChunkIndex };

    const byKey = new Map<string, typeof batch>();
    for (const row of batch) {
      const key = `${row.source_id}::${row.slug}`;
      const list = byKey.get(key);
      if (list) list.push(row);
      else byKey.set(key, [row]);
    }
    const keys = Array.from(byKey.keys());
    let nextIdx = 0;

    async function embedOneKey(key: string): Promise<void> {
      const stale = byKey.get(key)!;
      const keySourceId = stale[0]?.source_id ?? sourceId;
      const slug = stale[0].slug;
      // #3507: fetch the page row for its title + stored CR mode so the
      // re-embed reproduces the page's wrapping convention instead of
      // silently stripping contextual prefixes (mirrors
      // src/commands/embed.ts:embedAllStale).
      const pageRow = await observed(pacer, () =>
        engine.getPage(slug, { sourceId: keySourceId }),
      );
      const wrappedTexts = wrapChunkTextsForStoredMode(pageRow, stale);
      const slices = Math.ceil(stale.length / subBatchSize);
      let pageHadFailure = false;
      // codex review finding #5: a CAS stale-skip is not a failure, but it
      // also means those chunks weren't freshly committed THIS pass —
      // restamping on top of a skip would claim coverage the run didn't
      // actually verify.
      let pageStaleSkipped = 0;
      for (let offset = 0; offset < stale.length; offset += subBatchSize) {
        if (signal?.aborted) return;
        const sliceRows = stale.slice(offset, offset + subBatchSize);
        const checkpoint = await persistStaleSlice({
          engine,
          embedTexts: wrappedTexts.slice(offset, offset + subBatchSize),
          rows: sliceRows,
          embeddingSignature: signature,
          signatureInvalidationFailed,
          embedFn,
          signal,
          slice: { index: (offset / subBatchSize) + 1, total: slices },
          write,
        });
        result.embedded += checkpoint.embedded;
        if (checkpoint.failureCount > 0) pageHadFailure = true;
        if (checkpoint.persistFailed) {
          result.persistFailures = (result.persistFailures ?? 0) + 1;
          pageHadFailure = true;
        }
        pageStaleSkipped += checkpoint.outcome?.staleSkippedChunks ?? 0;
        const pageKey = `${sliceRows[0]!.source_id}:${sliceRows[0]!.page_id}`;
        if (checkpoint.pageCommitted && !committedPages.has(pageKey)) {
          committedPages.add(pageKey);
          result.pagesProcessed++;
        }
        if (checkpoint.aborted) {
          result.aborted = true;
          return;
        }
        // SPEC V4: any run-global terminal error must still propagate and
        // reject the whole embedStaleForSource call — persistStaleSlice
        // RETURNS fatalError (instead of throwing) so the accounting above
        // is never lost, but this call site's pre-existing contract has no
        // #3037 cost-bounding carve-out: rethrow unconditionally.
        if (checkpoint.fatalError !== undefined) throw checkpoint.fatalError;
      }
      // #3507: a FULLY re-embedded per_chunk_synopsis page landed at the
      // title tier — keep the stamped mode honest (mixed pages stay as-is).
      if (!pageHadFailure && pageStaleSkipped === 0) {
        const existing = await observed(pacer, () =>
          engine.getChunks(slug, { sourceId: keySourceId }),
        );
        if (stale.length === existing.length) {
          // codex review round 2 finding #1: a restamp failure here is AFTER
          // vectors already committed successfully. Left unguarded, it
          // propagates through this file's Promise.all worker loop (no pool
          // absorption here, unlike embed.ts) and rejects the whole
          // embedStaleForSource call — crashing an otherwise-successful
          // Minion run and getting retried for the wrong reason (the retry's
          // own listStaleChunks finds nothing stale, since the vectors did
          // land; only the mode stamp is behind). Record it instead of
          // crashing the run.
          try {
            await observed(pacer, () =>
              restampIfDemotedToTitleTier(engine, pageRow, slug, keySourceId),
            );
          } catch (error) {
            if (signal?.aborted) return;
            result.persistFailures = (result.persistFailures ?? 0) + 1;
            write(`[embed-restamp-fail] slug=${slug} err=${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }

    async function worker(): Promise<void> {
      while (nextIdx < keys.length && !signal?.aborted) {
        const index = nextIdx++;
        await embedOneKey(keys[index]!);
        try {
          await pacer.pace(signal);
        } catch (error) {
          if (error instanceof AbortError) return;
          throw error;
        }
      }
    }

    const numWorkers = Math.min(concurrency, keys.length);
    await Promise.all(Array.from({ length: numWorkers }, () => worker()));

    // A final short batch can be aborted inside its embedFn. Check before the
    // short-batch done path so the Minion handler cannot report false success.
    if (signal?.aborted) {
      result.aborted = true;
      return result;
    }
    opts.onProgress?.({
      embedded: result.embedded,
      chunksProcessed: result.chunksProcessed,
      cursor: { afterPageId, afterChunkIndex },
    });
    if (batch.length < batchSize) {
      result.done = true;
      return result;
    }
  }
}

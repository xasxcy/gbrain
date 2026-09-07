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
import { embedBatchWithBackoff, restampIfDemotedToTitleTier } from './embed-retry.ts';
import { wrapChunkTextsForStoredMode } from './embedding-context.ts';
import { healOversizedPageChunks } from './embed-oversize-heal.ts';
import { invalidateStaleSignatureEmbeddingsGuarded } from './embedding-invalidation.ts';
import {
  resolveActiveEmbeddingColumnFromEngine,
  quoteIdentifier,
} from './search/embedding-column.ts';
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
  /**
   * #4283: chunks whose embeddings THIS run set to NULL (signature drift +
   * content drift). Callers use `invalidated > 0 && embedded === 0` as the
   * mass-null-without-replacement failure signal.
   */
  invalidated: number;
  /**
   * #4283: set when signature-drifted chunks existed but the pre-invalidation
   * embedder probe failed, so nothing was NULLed. The run degrades to
   * NULL-embedding-only staleness instead of destroying working vectors.
   */
  invalidationSkipped?: 'embedder_probe_failed';
  /** Last cursor reached. null iff zero stale chunks existed at start. */
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

/** Probe input for `probeEmbedder`. Exported so tests can detect probe calls. */
export const EMBED_PROBE_TEXT = 'gbrain embedder preflight probe';

/**
 * #4283: live embedder health check, run BEFORE any signature-drift
 * invalidation NULLs working vectors. A misresolved worker config (e.g. a
 * temp GBRAIN_HOME resolving the compile-time default model with no API key)
 * yields a signature that mismatches 100% of the corpus AND an embedder that
 * cannot write a single vector — pre-probe, that combination stripped every
 * embedding and reported success. The probe embeds one short string; when
 * `signature` carries a parseable trailing `:<dims>`, the returned vector
 * must match it (a wrong-dims vector would fail every upsert AFTER the
 * NULLing). Any throw or malformed result → false.
 */
export async function probeEmbedder(
  embedFn: (texts: string[], opts: { abortSignal?: AbortSignal }) => Promise<Float32Array[]>,
  signature?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const vecs = await embedFn([EMBED_PROBE_TEXT], { abortSignal: signal });
    const vec = vecs?.[0];
    if (!vec || vec.length === 0) return false;
    const dims = signature ? Number(signature.split(':').pop()) : NaN;
    if (Number.isFinite(dims) && dims > 0 && vec.length !== dims) return false;
    return true;
  } catch {
    return false;
  }
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

/**
 * #4216 phase-end closure: embed the NULL-embedding chunks of an EXPLICIT
 * page list (pages a synthesis phase just wrote with deferEmbeds).
 * Deliberately NOT a source-wide sweep: no cursor walk over the backlog, no
 * global signature-invalidation pass (both belong to the budget-tracked
 * embed-backfill job) — the spend here is exactly the deferred cost of the
 * caller's own writes. Per-page mechanics mirror embedStaleForSource's
 * worker: stored-CR-mode wrapping, metadata carry, full-restale signature
 * stamp, title-tier restamp.
 */
export async function embedStalePages(
  engine: BrainEngine,
  slugs: string[],
  sourceId: string,
  opts: {
    signal?: AbortSignal;
    embedFn?: (texts: string[], o: { abortSignal?: AbortSignal }) => Promise<Float32Array[]>;
    embeddingSignature?: string;
  } = {},
): Promise<{ embedded: number; pagesProcessed: number; aborted: boolean }> {
  const embedFn = opts.embedFn ?? (async (texts: string[], fnOpts: { abortSignal?: AbortSignal }) =>
    embedBatchWithBackoff(texts, { abortSignal: fnOpts.abortSignal }));
  const result = { embedded: 0, pagesProcessed: 0, aborted: false };
  // S2: stale = NULL in the registry-ACTIVE column (the one upsertChunks
  // writes) — the literal legacy `embedding` stays NULL forever on a
  // registry-routed brain, which would re-embed every chunk on every phase
  // end. Resolved once per call; fallback keeps the per-page log+skip
  // contract (a broken registry surfaces at the upsert, loudly).
  const staleColId = quoteIdentifier(
    (await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name,
  );
  for (const slug of slugs) {
    if (opts.signal?.aborted) {
      result.aborted = true;
      return result;
    }
    try {
      // SUP-3874: split legacy oversized rows before embedding so a single
      // pre-cap chunk cannot permanently fail the page.
      await healOversizedPageChunks(engine, slug, { sourceId });
      const existing = await engine.getChunks(slug, { sourceId });
      const staleIdx = new Set(
        (await engine.executeRaw<{ chunk_index: number }>(
          `SELECT cc.chunk_index
             FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
            WHERE p.slug = $1 AND p.source_id = $2 AND cc.${staleColId} IS NULL
            ORDER BY cc.chunk_index`,
          [slug, sourceId],
        )).map(r => r.chunk_index),
      );
      if (staleIdx.size === 0) continue;
      const stale = existing.filter(c => staleIdx.has(c.chunk_index));
      const pageRow = await engine.getPage(slug, { sourceId });
      const embeddings = await embedFn(
        wrapChunkTextsForStoredMode(pageRow, stale),
        { abortSignal: opts.signal },
      );
      const staleIdxToEmbedding = new Map<number, Float32Array>();
      for (let j = 0; j < stale.length; j++) {
        staleIdxToEmbedding.set(stale[j].chunk_index, embeddings[j]);
      }
      const merged: ChunkInput[] = existing.map((c) => carryChunkMetadata(c, {
        chunk_index: c.chunk_index,
        chunk_text: c.chunk_text,
        chunk_source: c.chunk_source,
        embedding: staleIdxToEmbedding.get(c.chunk_index) ?? undefined,
        token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
      }));
      await engine.upsertChunks(slug, merged, { sourceId });
      if (opts.embeddingSignature && stale.length === existing.length) {
        await engine.setPageEmbeddingSignature(slug, { sourceId, signature: opts.embeddingSignature });
      }
      if (stale.length === existing.length) {
        await restampIfDemotedToTitleTier(engine, pageRow, slug, sourceId);
      }
      result.embedded += stale.length;
      result.pagesProcessed += 1;
    } catch (e) {
      if (opts.signal?.aborted) {
        result.aborted = true;
        return result;
      }
      process.stderr.write(`\n  [embed-stale] error on ${sourceId}/${slug}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return result;
}

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
    invalidated: 0,
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

  // v0.41.31: invalidate embeddings stamped under a prior model signature so
  // the NULL cursor below re-embeds them. GRANDFATHER: NULL signature
  // untouched. Best-effort — a failure here must not abort the backfill.
  //
  // #4283: NULLing is conditional on a WORKING embedder. The drift pre-count
  // (two cheap COUNTs; probe only fires when drift exists) keeps the probe's
  // one embed call off the no-drift common path; a failed probe skips the
  // invalidation entirely so a misresolved worker can't strip a corpus it
  // can never re-embed.
  if (signature) {
    try {
      const wide = await engine.countStaleChunks({ sourceId, signature });
      const nullOnly = await engine.countStaleChunks({ sourceId });
      if (wide - nullOnly > 0) {
        if (await probeEmbedder(embedFn, signature, signal)) {
          // #4306: guarded wrapper — never NULL embed_skip pages the stale
          // selectors below can't re-embed.
          result.invalidated += await invalidateStaleSignatureEmbeddingsGuarded(engine, { signature, sourceId });
        } else {
          result.invalidationSkipped = 'embedder_probe_failed';
          process.stderr.write(
            `\n  [embed-stale] ${wide - nullOnly} chunk(s) drifted from signature ${signature} but the embedder probe failed — ` +
            `SKIPPING invalidation (existing vectors preserved). Check embedding provider config/credentials.\n`,
          );
        }
      }
    } catch (error) {
      // Non-fatal: fall through to the NULL-only stale loop. FORK: the failure
      // is recorded so the caller can tell a degraded run from a clean one.
      signatureInvalidationFailed = true;
      write(`[embed-signature-invalidation-fail] source_id=${sourceId} err=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // #4246: invalidate chunks whose embedding was computed from a PREVIOUS
  // chunk_text revision (embedded_text_hash <> md5(chunk_text)) so content
  // edits flow through the NULL cursor. NOT probe-gated: the blast radius is
  // bounded by real content edits (config-independent, unlike signature
  // drift) and those vectors point at stale text either way. NULL hash
  // (pre-v133 rows) is grandfathered.
  try {
    result.invalidated += await engine.invalidateContentDriftEmbeddings({ sourceId });
  } catch {
    // Non-fatal: fall through to the NULL-only stale loop.
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
      let stale = byKey.get(key)!;
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

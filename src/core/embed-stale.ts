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
import { embedBatchWithBackoff } from '../commands/embed.ts';
import { type DbPacer, createNoopPacer, observed } from './db-pacer.ts';
import { AbortError } from './abort-check.ts';
import { persistStaleSlice } from './embed-slice-persist.ts';
import { resolveEmbedSubBatchSize } from './embed-slices.ts';

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
  /** Atomic DB checkpoint attempts that rolled back; never enter the ledger. */
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
      const slices = Math.ceil(stale.length / subBatchSize);
      for (let offset = 0; offset < stale.length; offset += subBatchSize) {
        if (signal?.aborted) return;
        const sliceRows = stale.slice(offset, offset + subBatchSize);
        const checkpoint = await persistStaleSlice({
          engine,
          rows: sliceRows,
          embeddingSignature: signature,
          signatureInvalidationFailed,
          embedFn,
          signal,
          slice: { index: (offset / subBatchSize) + 1, total: slices },
          write,
        });
        result.embedded += checkpoint.embedded;
        if (checkpoint.persistFailed) result.persistFailures = (result.persistFailures ?? 0) + 1;
        const pageKey = `${sliceRows[0]!.source_id}:${sliceRows[0]!.page_id}`;
        if (checkpoint.pageCommitted && !committedPages.has(pageKey)) {
          committedPages.add(pageKey);
          result.pagesProcessed++;
        }
        if (checkpoint.aborted) {
          result.aborted = true;
          return;
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

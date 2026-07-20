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
import type { ChunkInput } from './types.ts';
import { embedBatchWithBackoff } from '../commands/embed.ts';
import { type DbPacer, createNoopPacer, observed } from './db-pacer.ts';
import { AbortError } from './abort-check.ts';
import { isMustAbortError } from './worker-pool.ts';
import { embedWithTruncationFallbackPartial } from './embed-fallback.ts';

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
  };
  const signature = opts.embeddingSignature;

  if (signature) {
    try {
      await engine.invalidateStaleSignatureEmbeddings({ signature, sourceId });
    } catch {
      // Existing best-effort invalidation contract: proceed with NULL cursor.
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
      const slug = stale[0]!.slug;
      const partial = await embedWithTruncationFallbackPartial(
        stale.map((chunk) => chunk.chunk_text),
        embedFn,
        { abortSignal: signal },
      );
      if (partial.failures.length > 0 || partial.fatalError !== undefined) {
        const indexes = [
          ...partial.failures.map((failure) => failure.index),
          ...(partial.fatalIndexes ?? []),
        ].map((index) => stale[index]?.chunk_index)
          .filter((index): index is number => index !== undefined);
        const firstError = partial.failures[0]?.error ?? partial.fatalError;
        process.stderr.write(
          `\n  [embed-stale] error on ${keySourceId}/${slug}: failed chunk_index [${indexes.join(', ')}]${
            firstError instanceof Error ? `: ${firstError.message}` : firstError === undefined ? '' : `: ${String(firstError)}`
          }\n`,
        );
      }

      const successCount = partial.vectors.filter((vector): vector is Float32Array => vector !== null).length;
      if (successCount > 0) {
        // No signal-based early return: abort-time DB failures must remain
        // observable. Correctness of this stamp assumes no concurrent
        // rechunk/upsert writer, as accepted by SPEC V4.
        try {
          const existing = await observed(pacer, () => engine.getChunks(slug, { sourceId: keySourceId }));
          const staleIdxToEmbedding = new Map<number, Float32Array>();
          for (let index = 0; index < stale.length; index++) {
            const vector = partial.vectors[index];
            if (vector !== null) staleIdxToEmbedding.set(stale[index]!.chunk_index, vector);
          }
          const merged: ChunkInput[] = existing.map((chunk) => ({
            chunk_index: chunk.chunk_index,
            chunk_text: chunk.chunk_text,
            chunk_source: chunk.chunk_source,
            embedding: staleIdxToEmbedding.get(chunk.chunk_index) ?? undefined,
            token_count: chunk.token_count || Math.ceil(chunk.chunk_text.length / 4),
          }));
          await observed(pacer, () => engine.upsertChunks(slug, merged, { sourceId: keySourceId }));
          result.embedded += successCount;
          result.pagesProcessed += 1;

          if (signature) {
            const rows = (await observed(pacer, () => engine.executeRaw<{ embedding_signature: string | null }>(
              'SELECT embedding_signature FROM pages WHERE slug = $1 AND source_id = $2',
              [slug, keySourceId],
            ))) ?? [];
            const storedSignature = rows[0]?.embedding_signature ?? null;
            const shouldStamp = storedSignature !== null
              ? storedSignature !== signature
              : stale.length === existing.length;
            if (shouldStamp) {
              await observed(pacer, () =>
                engine.setPageEmbeddingSignature(slug, { sourceId: keySourceId, signature }),
              );
            }
          }
        } catch (error) {
          process.stderr.write(
            `\n  [embed-stale] persist error on ${keySourceId}/${slug}${signal?.aborted ? ' (aborted context)' : ''}: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        }
      }

      if (partial.fatalError !== undefined && isMustAbortError(partial.fatalError)) {
        throw partial.fatalError;
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

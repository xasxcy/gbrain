import { createHash } from 'node:crypto';
import type { BrainEngine, PersistEmbedOutcomeResult } from './engine.ts';
import type { StaleChunkRow } from './types.ts';
import { embedWithTruncationFallbackPartial, type EmbedFn } from './embed-fallback.ts';
import { classifyEmbedFailure, fingerprintEmbedFailure } from './embed-failure.ts';

export interface PersistStaleSliceOptions {
  engine: BrainEngine;
  rows: StaleChunkRow[];
  embeddingSignature?: string;
  signatureInvalidationFailed?: boolean;
  embedFn: EmbedFn;
  signal?: AbortSignal;
  slice: { index: number; total: number };
  write: (message: string) => void;
  /**
   * #3507: text to send to the embedding provider for each row, aligned by
   * index with `rows`. When a page's stored contextual-retrieval mode wraps
   * chunk_text with a title-tier prefix, the caller precomputes those wrapped
   * strings (wrapChunkTextsForStoredMode) so a stale re-embed doesn't
   * silently strip the prefix. Falls back to the raw row.chunk_text when
   * omitted (legacy callers). The content hash always stays on the raw
   * chunk_text — hashing the wrapped text would make untouched chunks look
   * changed to every other staleness check.
   */
  embedTexts?: string[];
}

export interface PersistStaleSliceResult {
  embedded: number;
  pageCommitted: boolean;
  persistFailed: boolean;
  signatureFailed?: boolean;
  failureCount: number;
  /** #3037: the first per-chunk failure's error, for building result.failure_samples. */
  firstFailureError?: unknown;
  aborted: boolean;
  outcome?: PersistEmbedOutcomeResult;
  /**
   * codex review finding #3: a run-global terminal error (e.g. sustained
   * rate-limit/outage, or a must-abort class like AIConfigError). Any chunk
   * successes/failures already computed before hitting it are still reflected
   * in `embedded`/`failureCount`/`outcome` above — the caller decides whether
   * to record-and-continue or rethrow, but either way it sees the real
   * partial accounting instead of losing it to a thrown exception.
   */
  fatalError?: unknown;
}

const hashChunk = (text: string): string => createHash('md5').update(text).digest('hex');

/**
 * One outer stale slice is one provider call/fallback unit and one atomic DB
 * checkpoint. Legacy callers intentionally never invoke this function.
 */
export async function persistStaleSlice(opts: PersistStaleSliceOptions): Promise<PersistStaleSliceResult> {
  const { engine, rows, embeddingSignature, signatureInvalidationFailed, embedFn, signal, slice, write, embedTexts } = opts;
  const first = rows[0];
  if (!first) return { embedded: 0, pageCommitted: false, persistFailed: false, failureCount: 0, aborted: !!signal?.aborted };

  write(`[embed-slice] slug=${first.slug} slice=${slice.index}/${slice.total} chunks=${rows.length}`);

  const partial = await embedWithTruncationFallbackPartial(
    rows.map((row, index) => embedTexts?.[index] ?? row.chunk_text),
    embedFn,
    { abortSignal: signal, policy: 'partial-stale' },
  );
  const entries = [] as Parameters<BrainEngine['persistEmbedOutcome']>[0]['entries'];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const vector = partial.vectors[index];
    if (vector !== null) {
      entries.push({ chunkIndex: row.chunk_index, chunkHash: hashChunk(row.chunk_text), outcome: { vector } });
    }
  }
  for (const failure of partial.failures) {
    const row = rows[failure.index];
    if (!row) continue;
    const classified = classifyEmbedFailure(failure.error);
    if (classified.kind === 'fatal') continue;
    entries.push({
      chunkIndex: row.chunk_index,
      chunkHash: hashChunk(row.chunk_text),
      outcome: {
        failure: {
          errorClass: classified.errorClass,
          errorFingerprint: fingerprintEmbedFailure(failure.error),
        },
      },
    });
    write(`[embed-fail] slug=${first.slug} chunk_index=${row.chunk_index} class=${classified.errorClass}`);
  }

  if (partial.fatalError !== undefined) {
    const indexes = (partial.fatalIndexes ?? []).map((index) => rows[index]?.chunk_index).filter((index): index is number => index !== undefined);
    write(`[embed-stale] error slug=${first.slug} chunk_index=[${indexes.join(',')}] err=${partial.fatalError instanceof Error ? partial.fatalError.message : String(partial.fatalError)}`);
  }

  let outcome: PersistEmbedOutcomeResult | undefined;
  let persistFailed = false;
  let persistError: unknown;
  if (entries.length > 0) {
    try {
      outcome = await engine.persistEmbedOutcome({
        sourceId: first.source_id,
        pageId: first.page_id,
        slug: first.slug,
        embeddingSignature: embeddingSignature ?? 'legacy',
        entries,
      });
    } catch (error) {
      write(`[embed-persist-fail] slug=${first.slug} slice=${slice.index}/${slice.total} err=${error instanceof Error ? error.message : String(error)}`);
      persistFailed = true;
      persistError = error;
    }
  }
  // codex review finding #4: a persist failure loses every vector that WOULD
  // have committed — those rows stay stale in the DB but previously vanished
  // from failureCount entirely (only result.persistFailures, which src/cli.ts
  // doesn't gate the exit code on, saw it). Count just the vector-success
  // entries here; the invalid_input-style failure entries are already
  // counted via partial.failures.length below regardless of persist outcome.
  const lostVectorCount = persistFailed ? entries.filter((entry) => 'vector' in entry.outcome).length : 0;

  let signatureFailed = false;
  if (embeddingSignature && outcome && outcome.vectorCommittedChunks > 0) {
    try {
      const stateRows = await engine.executeRaw<{
        embedding_signature: string | null;
        chunk_count: number;
      }>(
        `SELECT p.embedding_signature,
                COUNT(cc.id)::integer AS chunk_count
           FROM pages p
           LEFT JOIN content_chunks cc ON cc.page_id = p.id
          WHERE p.id = $1 AND p.source_id = $2
          GROUP BY p.embedding_signature`,
        [first.page_id, first.source_id],
      );
      const [state] = Array.isArray(stateRows) ? stateRows : [];
      const storedSignature = state?.embedding_signature ?? null;
      // Successful invalidation proves that any remaining non-NULL vector is
      // current-generation. NULL chunks stay eligible through the retry ledger
      // and are pending work, not mixed-generation contamination. Grandfathered
      // NULL-signature pages were never invalidated, so they still require this
      // slice to cover the whole page before stamping.
      const shouldStamp = !signatureInvalidationFailed
        && storedSignature !== embeddingSignature
        && (storedSignature !== null || rows.length === Number(state?.chunk_count ?? -1));
      if (shouldStamp) {
        await engine.setPageEmbeddingSignature(first.slug, { sourceId: first.source_id, signature: embeddingSignature });
      }
    } catch (error) {
      signatureFailed = true;
      write(`[embed-signature-fail] slug=${first.slug} slice=${slice.index}/${slice.total} err=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (outcome?.staleSkippedChunkIndexes) {
    for (const chunkIndex of outcome.staleSkippedChunkIndexes) {
      write(`[embed-stale-skip] slug=${first.slug} chunk_index=${chunkIndex}`);
    }
  }

  write(`[embed-slice] slug=${first.slug} slice=${slice.index}/${slice.total} committed=${outcome?.vectorCommittedChunks ?? 0} stale_skipped=${outcome?.staleSkippedChunks ?? 0} persist_failed=${persistFailed}`);

  // codex review finding #3: return the fatal error instead of throwing it —
  // throwing here discarded the embedded/failureCount accounting already
  // computed above for a MIXED slice (some chunks isolated successfully,
  // one hit a run-global terminal error). The caller sees the real partial
  // state via the return value and decides for itself whether to
  // record-and-continue or rethrow.
  const fatalChunkCount = partial.fatalError !== undefined ? (partial.fatalIndexes ?? []).length : 0;

  return {
    embedded: outcome?.vectorCommittedChunks ?? 0,
    pageCommitted: (outcome?.vectorCommittedChunks ?? 0) > 0,
    persistFailed,
    signatureFailed,
    failureCount: partial.failures.length + fatalChunkCount + lostVectorCount + (signatureFailed ? 1 : 0),
    firstFailureError: partial.failures[0]?.error ?? partial.fatalError ?? persistError,
    aborted: partial.aborted,
    outcome,
    fatalError: partial.fatalError,
  };
}

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
}

export interface PersistStaleSliceResult {
  embedded: number;
  pageCommitted: boolean;
  persistFailed: boolean;
  signatureFailed?: boolean;
  failureCount: number;
  aborted: boolean;
  outcome?: PersistEmbedOutcomeResult;
}

const hashChunk = (text: string): string => createHash('md5').update(text).digest('hex');

/**
 * One outer stale slice is one provider call/fallback unit and one atomic DB
 * checkpoint. Legacy callers intentionally never invoke this function.
 */
export async function persistStaleSlice(opts: PersistStaleSliceOptions): Promise<PersistStaleSliceResult> {
  const { engine, rows, embeddingSignature, signatureInvalidationFailed, embedFn, signal, slice, write } = opts;
  const first = rows[0];
  if (!first) return { embedded: 0, pageCommitted: false, persistFailed: false, failureCount: 0, aborted: !!signal?.aborted };

  write(`[embed-slice] slug=${first.slug} slice=${slice.index}/${slice.total} chunks=${rows.length}`);

  const partial = await embedWithTruncationFallbackPartial(
    rows.map((row) => row.chunk_text),
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
    }
  }

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

  if (partial.fatalError !== undefined) {
    // The original must-abort object must outlive any failed checkpoint. Other
    // run-global failures follow the same post-checkpoint path.
    throw partial.fatalError;
  }

  return {
    embedded: outcome?.vectorCommittedChunks ?? 0,
    pageCommitted: (outcome?.vectorCommittedChunks ?? 0) > 0,
    persistFailed,
    signatureFailed,
    failureCount: partial.failures.length + (signatureFailed ? 1 : 0),
    aborted: partial.aborted,
    outcome,
  };
}

import { createHash } from 'node:crypto';
import type { BrainEngine, PersistEmbedOutcomeResult } from './engine.ts';
import type { StaleChunkRow } from './types.ts';
import { embedWithTruncationFallbackPartial, type EmbedFn } from './embed-fallback.ts';
import { classifyEmbedFailure, fingerprintEmbedFailure } from './embed-failure.ts';
import { splitEmbeddingSignature } from './embedding-invalidation.ts';
import { installPageEmbeddings, readProjectionSnapshot, type ProjectionSnapshot } from './page-state/projections.ts';

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
  /**
   * Registry-active vector column (already SQL-quoted). When set, a page is
   * only stamped with the new signature once no chunk of it is still PENDING
   * (NULL vector with no live ledger row for this generation) — #5051: an
   * interrupted drain must leave the old signature so the untouched chunks
   * are not orphaned behind a new-generation stamp. Ledgered (quarantined /
   * backing-off) chunks do not count as pending, which is what keeps the
   * B5 quarantine-storm fix intact.
   */
  activeColumn?: string;
  /** Observed `pages.corpus_generation` (see PersistEmbedOutcomeRequest.expectedCorpusGeneration). */
  expectedCorpusGeneration?: string | null;
  /** Projection snapshot prepared before the provider call. */
  prepared?: ProjectionSnapshot;
  /** A source lease/deadline fence; it is invoked inside the final write transaction. */
  assertOwned?: (tx: BrainEngine) => Promise<void>;
}

export interface PersistStaleSliceResult {
  embedded: number;
  pageCommitted: boolean;
  persistFailed: boolean;
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

/**
 * Target vector width. A registered plane names its own width. The legacy
 * `embedding` descriptor's width is only a static default, so it defers to the
 * signature's width (`<model>:<dims>`); unknown stays unchecked (the database
 * column rejects a mismatch).
 */
function expectedVectorDimensions(prepared: ProjectionSnapshot | undefined, signature: string | undefined): number | undefined {
  if (!prepared) return undefined;
  if (prepared.embeddingColumn.name !== 'embedding') return prepared.embeddingColumn.dimensions;
  return signature && signature !== 'legacy' ? splitEmbeddingSignature(signature).dims ?? undefined : undefined;
}

const hashChunk = (text: string): string => createHash('md5').update(text).digest('hex');

/**
 * One outer stale slice is one provider call/fallback unit and one atomic DB
 * checkpoint. Legacy callers intentionally never invoke this function.
 */
export async function persistStaleSlice(opts: PersistStaleSliceOptions): Promise<PersistStaleSliceResult> {
  const { engine, rows, embeddingSignature, signatureInvalidationFailed, embedFn, signal, slice, write, embedTexts, activeColumn, expectedCorpusGeneration } = opts;
  const first = rows[0];
  if (!first) return { embedded: 0, pageCommitted: false, persistFailed: false, failureCount: 0, aborted: !!signal?.aborted };

  write(`[embed-slice] slug=${first.slug} slice=${slice.index}/${slice.total} chunks=${rows.length}`);

  // The projection snapshot (with its checked column descriptor) is fixed
  // BEFORE the provider call; the installer re-verifies it under the page lock.
  let prepared = opts.prepared;
  let preparedError: unknown;
  if (!prepared) {
    try {
      prepared = await readProjectionSnapshot(engine, first.slug, first.source_id, { allowUnsealed: true, requireLiveSource: true }) ?? undefined;
    } catch (error) {
      preparedError = error;
    }
  }

  const partial = await embedWithTruncationFallbackPartial(
    rows.map((row, index) => embedTexts?.[index] ?? row.chunk_text),
    embedFn,
    { abortSignal: signal, policy: 'partial-stale', expectedDimensions: expectedVectorDimensions(prepared, embeddingSignature) },
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

    // FB-002: a run-global fatalError (e.g. a whole-batch timeout that
    // #3037 correctly refuses to fan out into per-chunk retries) previously
    // left `entries` untouched for these chunks, so persistEmbedOutcome was
    // never called with them and embed_failures stayed at zero rows forever
    // — the retry/backoff ledger this table exists for was unreachable for
    // the single most likely reason to need it. Record them here; this does
    // NOT retry anything (zero extra provider calls), it only makes the
    // failure observable so the next round's backoff/quarantine machinery
    // can see it.
    const classified = classifyEmbedFailure(partial.fatalError);
    if (classified.kind !== 'fatal') {
      for (const index of partial.fatalIndexes ?? []) {
        const row = rows[index];
        if (!row) continue;
        entries.push({
          chunkIndex: row.chunk_index,
          chunkHash: hashChunk(row.chunk_text),
          outcome: {
            failure: {
              errorClass: classified.errorClass,
              errorFingerprint: fingerprintEmbedFailure(partial.fatalError),
            },
          },
        });
        write(`[embed-fail] slug=${first.slug} chunk_index=${row.chunk_index} class=${classified.errorClass}`);
      }
    }
  }

  let outcome: PersistEmbedOutcomeResult | undefined;
  let persistFailed = false;
  let persistError: unknown;
  if (entries.length > 0) {
    let ownershipFailure: { error: unknown } | undefined;
    try {
      if (!prepared) throw preparedError ?? new Error('projection unavailable before embedding slice persistence');
      let engineOutcome: PersistEmbedOutcomeResult | undefined;
      const installed = await installPageEmbeddings(engine, prepared, [], undefined, undefined, {
        assertOwned: async tx => {
          try { await opts.assertOwned?.(tx); } catch (error) { ownershipFailure = { error }; throw error; }
        },
        outcome: { embeddingSignature: embeddingSignature ?? 'legacy', entries, expectedCorpusGeneration },
        onOutcome: value => { engineOutcome = value; },
      });
      outcome = installed && engineOutcome
        ? engineOutcome
        : { committedChunks: 0, vectorCommittedChunks: 0, staleSkippedChunks: entries.length,
            staleSkippedChunkIndexes: entries.map(entry => entry.chunkIndex), ledgerUpserts: 0, ledgerDeletes: 0 };
    } catch (error) {
      // Ownership loss and cancellation are control flow, not persistence
      // failures.  The caller owns their propagation and must stop its drain.
      if (ownershipFailure || (error instanceof Error && error.name === 'AbortError')) throw error;
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
    failureCount: partial.failures.length + fatalChunkCount + lostVectorCount,
    firstFailureError: partial.failures[0]?.error ?? partial.fatalError ?? persistError,
    aborted: partial.aborted,
    outcome,
    fatalError: partial.fatalError,
  };
}

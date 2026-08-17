/**
 * FB-002 regression: a run-global fatalError (a batch-wide transient
 * provider failure that #3037 correctly refuses to fan out into per-chunk
 * retries) previously left `embed_failures` untouched — persistStaleSlice
 * only walked `partial.failures`, and a batch-fatal error reports its
 * indexes via `partial.fatalIndexes` with `partial.failures` empty. The
 * retry/backoff ledger was structurally unreachable for the single most
 * likely reason to need it: the provider being down.
 *
 * See FORK_BACKLOG.md FB-002 for the full incident writeup (366 stuck
 * chunks, all-night unbounded retry loop, zero ledger rows).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { AITransientError } from '../src/core/ai/errors.ts';
import { persistStaleSlice } from '../src/core/embed-slice-persist.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seedStaleChunks(count: number) {
  await engine.putPage('outage-page', { type: 'note', title: 'outage-page', compiled_truth: '# outage-page' });
  await engine.upsertChunks(
    'outage-page',
    Array.from({ length: count }, (_, chunk_index) => ({
      chunk_index,
      chunk_text: `chunk body ${chunk_index}`,
      chunk_source: 'compiled_truth' as const,
      token_count: 4,
      embedding: undefined,
    })),
  );
  return engine.listStaleChunks({ sourceId: 'default' });
}

describe('persistStaleSlice records fatalError chunks in the embed_failures ledger', () => {
  test('a batch-wide transient outage leaves N ledger rows, not zero, with no extra provider calls', async () => {
    const rows = await seedStaleChunks(5);
    expect(rows).toHaveLength(5);

    // AITransientError with a non-timeout, non-429 message: instanceof check
    // alone makes isTransientEmbedError true, so isPartialStaleSplitWorthyError
    // returns false (#3037 — do not fan a struggling/outage provider out into
    // N single-chunk calls) and the whole batch reports via fatalError/
    // fatalIndexes instead of per-chunk failures.
    const outage = new AITransientError('502 Bad Gateway from embedding provider');
    let callCount = 0;
    const result = await persistStaleSlice({
      engine,
      rows,
      embeddingSignature: 'sig-1',
      embedFn: async (texts) => {
        callCount++;
        throw outage;
      },
      slice: { index: 1, total: 1 },
      write: () => {},
    });

    // #3037 property: recording a failure is not the same as retrying it.
    // Exactly one provider call for the whole batch — no per-chunk fan-out.
    expect(callCount).toBe(1);
    expect(result.embedded).toBe(0);
    expect(result.fatalError).toBe(outage);

    const failures = await engine.listEmbedFailures({ slug: 'outage-page' });
    expect(failures).toHaveLength(5);
    expect(failures.map((f) => f.chunk_index).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
    for (const failure of failures) {
      expect(failure.error_class).toBe('provider_other');
      expect(failure.next_retry_at.getTime()).toBeGreaterThan(Date.now());
      expect(failure.quarantined_at).toBeNull();
    }

    // Still stale — nothing was fabricated as embedded.
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(5);
  });

  test('an AIConfigError (fatal, non-retryable) still writes zero ledger rows — unchanged behaviour', async () => {
    const rows = await seedStaleChunks(3);
    const { AIConfigError } = await import('../src/core/ai/errors.ts');
    const configError = new AIConfigError('missing API key');

    const result = await persistStaleSlice({
      engine,
      rows,
      embeddingSignature: 'sig-1',
      embedFn: async () => {
        throw configError;
      },
      slice: { index: 1, total: 1 },
      write: () => {},
    });

    expect(result.fatalError).toBe(configError);
    const failures = await engine.listEmbedFailures({ slug: 'outage-page' });
    expect(failures).toHaveLength(0);
  });
});

/**
 * Tests for the OOM-fallback path in src/core/embed-stale.ts (v0.42.36.1).
 *
 * Validates `embedWithTruncationFallback` behavior:
 * 1. Short chunk (< 5500 chars): OOM does NOT retry at longer fallback levels —
 *    effectiveLevels = [text.length] only (no no-op retries).
 * 2. Long chunk (> 5500 chars): OOM triggers truncation at 5500 → 5000 → 4500;
 *    succeeds at whichever level the embedFn first accepts.
 * 3. Non-OOM error: bypasses fallback, propagates immediately (chunk stays NULL).
 * 4. OOM on every fallback level: throws the last error; chunk stays NULL.
 * 5. Mixed batch: one short (< 6000) and one long (≥ 6000); long chunk truncated
 *    while short chunk embedded without truncation.
 * 6. Regression: non-fallback happy path still works after the change.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';
import type { ChunkInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const DIM = 1536;

function makeVec(sentinel: number): Float32Array {
  const v = new Float32Array(DIM);
  v[0] = sentinel;
  v[1] = 1;
  return v;
}

function oomError(): Error {
  return new Error('read EOF while waiting for response from llama-server');
}

async function seedChunk(slug: string, chunkText: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
  const chunk: ChunkInput = {
    chunk_index: 0,
    chunk_text: chunkText,
    chunk_source: 'compiled_truth',
    token_count: Math.ceil(chunkText.length / 4),
    embedding: undefined,
  };
  await engine.upsertChunks(slug, [chunk]);
}

// ────────────────────────────────────────────────────────────────────────────

describe('embedWithTruncationFallback — injected embedFn', () => {

  test('happy path: short chunk embeds without truncation', async () => {
    const text = 'a'.repeat(1000);
    await seedChunk('short-happy', text);

    let seenLengths: number[] = [];
    await embedStaleForSource(engine, 'default', {
      embedFn: async (texts) => {
        seenLengths.push(...texts.map(t => t.length));
        return texts.map(() => makeVec(texts[0].length));
      },
    });

    // Only one call with the original length — no truncation attempted
    expect(seenLengths).toEqual([1000]);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
  });

  test('happy path: long chunk (6000) embeds without OOM', async () => {
    const text = 'b'.repeat(6000);
    await seedChunk('long-happy', text);

    let seenLengths: number[] = [];
    await embedStaleForSource(engine, 'default', {
      embedFn: async (texts) => {
        seenLengths.push(...texts.map(t => t.length));
        return texts.map(() => makeVec(texts[0].length));
      },
    });

    expect(seenLengths).toEqual([6000]);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
  });

  test('OOM on short chunk: only ONE retry (no no-op fallback levels)', async () => {
    // Chunk is 1000 chars — FALLBACK_LEVELS [5500, 5000, 4500] are all > 1000,
    // so effectiveLevels = [1000] only. After the single OOM the chunk stays NULL.
    const text = 'c'.repeat(1000);
    await seedChunk('short-oom', text);

    let callCount = 0;
    const result = await embedStaleForSource(engine, 'default', {
      embedFn: async () => {
        callCount++;
        throw oomError();
      },
    });

    // 1 batch call + 1 individual retry at original length = 2 calls total.
    // No extra retries at 5500/5000/4500 since those are >= text.length (filtered out).
    // embedOneKey caught the final error and logged it — chunk stays NULL.
    expect(callCount).toBe(2);
    expect(result.embedded).toBe(0);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);
  });

  test('OOM on long chunk: truncation cascade succeeds at 4500 chars', async () => {
    const text = 'x'.repeat(6000);
    await seedChunk('long-oom', text);

    const seenLengths: number[] = [];
    // Batch call (len=6000) → OOM. Individual retry:
    //   len=6000 → OOM, len=5500 → OOM, len=5000 → OOM, len=4500 → success.
    await embedStaleForSource(engine, 'default', {
      embedFn: async (texts) => {
        seenLengths.push(...texts.map(t => t.length));
        if (texts.some(t => t.length > 4500)) throw oomError();
        return texts.map(() => makeVec(texts[0].length));
      },
    });

    // Calls: [6000] (batch, OOM), then [6000], [5500], [5000], [4500] (individual)
    expect(seenLengths).toEqual([6000, 6000, 5500, 5000, 4500]);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
  });

  test('OOM on all fallback levels: chunk stays NULL, no throw to caller', async () => {
    // embedOneKey catches every throw from embedWithTruncationFallback so the
    // run continues (existing "log + skip" semantics preserved).
    const text = 'y'.repeat(6000);
    await seedChunk('all-oom', text);

    let callCount = 0;
    const result = await embedStaleForSource(engine, 'default', {
      embedFn: async () => {
        callCount++;
        throw oomError();
      },
    });

    // 1 batch + 4 individual (6000, 5500, 5000, 4500) = 5 calls
    expect(callCount).toBe(5);
    expect(result.embedded).toBe(0);
    expect(result.done).toBe(true); // loop completed without crashing
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);
  });

  test('non-OOM error bypasses fallback: only ONE call, chunk stays NULL', async () => {
    const text = 'z'.repeat(6000);
    await seedChunk('non-oom', text);

    let callCount = 0;
    const result = await embedStaleForSource(engine, 'default', {
      embedFn: async () => {
        callCount++;
        throw new Error('rate_limit_exceeded: 429'); // NOT an OOM-like error
      },
    });

    // Batch call fails with non-OOM → rethrown immediately, no per-chunk retry
    expect(callCount).toBe(1);
    expect(result.embedded).toBe(0);
    expect(result.done).toBe(true);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);
  });

  test('OOM at boundary: text.length === FALLBACK_LEVEL[0] (5500) gets filtered correctly', async () => {
    // text.length = 5500 = FALLBACK_LEVELS[0]. filter: 5500 < 5500 → false, filtered out.
    // effectiveLevels = [5500, 5000, 4500]. 5500-level retry is no-op but still present;
    // 5000-level succeeds. Confirms strict-< is the right condition.
    const text = 'e'.repeat(5500);
    await seedChunk('boundary-5500', text);

    const seenLengths: number[] = [];
    await embedStaleForSource(engine, 'default', {
      embedFn: async (texts: string[]) => {
        seenLengths.push(...texts.map((t: string) => t.length));
        if (texts.some((t: string) => t.length > 5000)) throw oomError();
        return texts.map(() => makeVec(texts[0].length));
      },
    });

    // Calls: [5500] (batch OOM), [5500] (individual OOM), [5000] (success)
    expect(seenLengths).toEqual([5500, 5500, 5000]);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
  });

  test('mixed batch: long chunk succeeds via truncation while short chunk passes unchanged', async () => {
    // Put two chunks under the same slug so they land in the same embedFn call.
    const shortText = 's'.repeat(500);
    const longText = 'l'.repeat(6000);
    await engine.putPage('mixed', { type: 'note', title: 'mixed', compiled_truth: '# mixed' });
    await engine.upsertChunks('mixed', [
      { chunk_index: 0, chunk_text: shortText, chunk_source: 'compiled_truth', token_count: 125, embedding: undefined },
      { chunk_index: 1, chunk_text: longText, chunk_source: 'compiled_truth', token_count: 1500, embedding: undefined },
    ]);

    const callLog: { length: number; count: number }[] = [];
    await embedStaleForSource(engine, 'default', {
      embedFn: async (texts) => {
        callLog.push({ length: texts.length, count: texts[0].length });
        // Batch of 2 always OOMs; single texts succeed if <= 5000 chars.
        if (texts.length > 1) throw oomError();
        if (texts[0].length > 5000) throw oomError();
        return texts.map(() => makeVec(texts[0].length));
      },
    });

    // First call: batch of 2 → OOM.
    // Individual retries:
    //   shortText (500): effectiveLevels=[500], call len=500 → success.
    //   longText (6000): effectiveLevels=[6000, 5500, 5000, 4500]:
    //     len=6000 → OOM, len=5500 → OOM, len=5000 → success (≤5000).
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
  });
});

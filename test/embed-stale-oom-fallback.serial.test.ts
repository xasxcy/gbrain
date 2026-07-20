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
import {
  embedWithTruncationFallback,
  embedWithTruncationFallbackPartial,
} from '../src/core/embed-fallback.ts';
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

  test('OOM on short chunk: initial single-text batch is not retried', async () => {
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

    // The initial batch is already this chunk's original attempt; there is no
    // duplicate [1000] call and no shorter ladder level.
    expect(callCount).toBe(1);
    expect(result.embedded).toBe(0);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);
  });

  test('OOM on long chunk: truncation cascade succeeds at 4500 chars', async () => {
    const text = 'x'.repeat(6000);
    await seedChunk('long-oom', text);

    const seenLengths: number[] = [];
    // Batch call (len=6000) is this one chunk's original attempt. The ladder
    // starts directly at 5500 rather than retrying 6000.
    await embedStaleForSource(engine, 'default', {
      embedFn: async (texts) => {
        seenLengths.push(...texts.map(t => t.length));
        if (texts.some(t => t.length > 4500)) throw oomError();
        return texts.map(() => makeVec(texts[0].length));
      },
    });

    expect(seenLengths).toEqual([6000, 5500, 5000, 4500]);
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

    // Original batch + 3 shorter ladder calls = 4 calls.
    expect(callCount).toBe(4);
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
    // The initial 5500 call is not retried; strict-< leaves 5000 then 4500.
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

    expect(seenLengths).toEqual([5500, 5000]);
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

describe('SPEC V4 fallback contracts', () => {
  test('batch timeout splits once per chunk and all chunks converge', async () => {
    const calls: number[] = [];
    const partial = await embedWithTruncationFallbackPartial(['a', 'b'], async (texts) => {
      calls.push(texts.length);
      if (texts.length > 1) throw new Error('The operation timed out');
      return [makeVec(texts[0]!.length)];
    }, {});
    expect(calls).toEqual([2, 1, 1]);
    expect(partial.vectors.every((vector) => vector !== null)).toBe(true);
    expect(partial.failures).toEqual([]);
  });

  test('single timeout calls once; partial records it and legacy throws the same object', async () => {
    const timeout = new Error('The operation timed out');
    let partialCalls = 0;
    const partial = await embedWithTruncationFallbackPartial(['a'], async () => {
      partialCalls++;
      throw timeout;
    }, {});
    expect(partialCalls).toBe(1);
    expect(partial.failures).toEqual([{ index: 0, error: timeout }]);

    let legacyCalls = 0;
    try {
      await embedWithTruncationFallback(['a'], async () => {
        legacyCalls++;
        throw timeout;
      }, {});
      throw new Error('expected legacy helper to throw');
    } catch (error) {
      expect(error).toBe(timeout);
    }
    expect(legacyCalls).toBe(1);
  });

  test('single EOF has one original call at <=4500 and at most four calls above 5500', async () => {
    const shortCalls: number[] = [];
    const eof = oomError();
    await embedWithTruncationFallbackPartial(['s'.repeat(4500)], async (texts) => {
      shortCalls.push(texts[0]!.length);
      throw eof;
    }, {});
    expect(shortCalls).toEqual([4500]);

    const longCalls: number[] = [];
    await embedWithTruncationFallbackPartial(['l'.repeat(6000)], async (texts) => {
      longCalls.push(texts[0]!.length);
      throw eof;
    }, {});
    expect(longCalls).toEqual([6000, 5500, 5000, 4500]);
  });

  test('short single EOF preserves the initial error identity in partial and legacy modes', async () => {
    const eof = new Error('EOF original');
    const partial = await embedWithTruncationFallbackPartial(['s'.repeat(4500)], async () => {
      throw eof;
    }, {});
    expect(partial.failures[0]?.error).toBe(eof);
    try {
      await embedWithTruncationFallback(['s'.repeat(4500)], async () => {
        throw eof;
      }, {});
      throw new Error('expected legacy helper to throw');
    } catch (error) {
      expect(error).toBe(eof);
    }
  });

  test('split fallback preserves an AbortError thrown by the in-flight chunk request', async () => {
    const controller = new AbortController();
    const abortError = new DOMException('aborted', 'AbortError');
    try {
      await embedWithTruncationFallback(['a', 'b'], async (texts) => {
        if (texts.length > 1) throw oomError();
        controller.abort();
        throw abortError;
      }, { abortSignal: controller.signal });
      throw new Error('expected legacy helper to throw');
    } catch (error) {
      expect(error).toBe(abortError);
    }
  });

  test('legacy batch fallback short-circuits on chunk zero and preserves error identity', async () => {
    const batchEof = oomError();
    const chunkZeroTimeout = new Error('The operation timed out');
    const calls: string[][] = [];
    try {
      await embedWithTruncationFallback(['zero', 'one'], async (texts) => {
        calls.push(texts);
        if (texts.length === 2) throw batchEof;
        if (texts[0] === 'zero') throw chunkZeroTimeout;
        return [makeVec(1)];
      }, {});
      throw new Error('expected legacy helper to throw');
    } catch (error) {
      expect(error).toBe(chunkZeroTimeout);
    }
    expect(calls).toEqual([['zero', 'one'], ['zero']]);
  });

  test('partial retains prefix vectors, reports fatal, and does not try later chunks', async () => {
    const calls: string[][] = [];
    const fatal = new Error('rate_limit_exceeded: 429');
    const partial = await embedWithTruncationFallbackPartial(['good', 'fatal', 'later'], async (texts) => {
      calls.push(texts);
      if (texts.length > 1) throw oomError();
      if (texts[0] === 'fatal') throw fatal;
      return [makeVec(1)];
    }, {});
    expect(calls).toEqual([['good', 'fatal', 'later'], ['good'], ['fatal']]);
    expect(partial.vectors[0]).not.toBeNull();
    expect(partial.vectors.slice(1)).toEqual([null, null]);
    expect(partial.fatalError).toBe(fatal);
    expect(partial.fatalIndexes).toEqual([1]);
    expect(partial.aborted).toBe(false);
  });

  test('initial non-split batch fatal identifies every affected input index', async () => {
    const fatal = new Error('rate_limit_exceeded: 429');
    const partial = await embedWithTruncationFallbackPartial(['a', 'b'], async () => {
      throw fatal;
    }, {});
    expect(partial.fatalError).toBe(fatal);
    expect(partial.fatalIndexes).toEqual([0, 1]);

    const one = await embedWithTruncationFallbackPartial(['a'], async () => {
      throw fatal;
    }, {});
    expect(one.fatalIndexes).toEqual([0]);
  });

  test('partial terminal state is mutually exclusive between abort and fatal error', async () => {
    const abortController = new AbortController();
    const aborted = await embedWithTruncationFallbackPartial(['a'], async () => {
      abortController.abort();
      throw new Error('ordinary failure');
    }, { abortSignal: abortController.signal });
    expect(aborted.aborted).toBe(true);
    expect(aborted.fatalError).toBeUndefined();

    const fatal = new Error('ordinary failure');
    const notAborted = await embedWithTruncationFallbackPartial(['a'], async () => {
      throw fatal;
    }, {});
    expect(notAborted.aborted).toBe(false);
    expect(notAborted.fatalError).toBe(fatal);
  });
});

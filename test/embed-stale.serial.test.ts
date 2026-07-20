/**
 * Tests for src/core/embed-stale.ts (v0.40 D15.2).
 *
 * Hermetic — uses an injected `embedFn` so no network call lands. Validates:
 *   - empty stale set → done:true, embedded:0
 *   - multi-batch run → embed every stale chunk, advance cursor correctly
 *   - kill mid-flight (signal.aborted) → aborted:true, partial progress preserved
 *   - resume from cursor → picks up where prior call left off (DB predicate)
 *   - per-page embedFn throw → logged + skipped, NOT propagated; chunks stay NULL
 *
 * Why PGLite: validates the engine.listStaleChunks/getChunks/upsertChunks
 * roundtrip the helper depends on, not just the loop control flow.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';
import type { ChunkInput } from '../src/core/types.ts';
import { BudgetExhausted } from '../src/core/budget/budget-tracker.ts';

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

/** Seed a page with N stale chunks (no embedding) into the default source. */
async function seedPageWithStaleChunks(slug: string, chunkCount: number): Promise<void> {
  await engine.putPage(slug, {
    type: 'note',
    title: slug,
    compiled_truth: `# ${slug}\n\nseeded`,
  });
  const chunks: ChunkInput[] = Array.from({ length: chunkCount }, (_, i) => ({
    chunk_index: i,
    chunk_text: `chunk ${i} of ${slug}`,
    chunk_source: 'compiled_truth',
    token_count: 4,
    embedding: undefined, // NULL = stale
  }));
  await engine.upsertChunks(slug, chunks);
}

/** Deterministic fake embedder — returns unit-length 1536-dim vectors with
 *  first dim = text length, so we can assert specific chunks got embedded. */
function fakeEmbedFn(texts: string[]): Promise<Float32Array[]> {
  return Promise.resolve(
    texts.map((t) => {
      const v = new Float32Array(1536);
      v[0] = t.length;
      v[1] = 1;
      return v;
    }),
  );
}

function fakeVector(): Float32Array {
  const vector = new Float32Array(1536);
  vector[0] = 1;
  return vector;
}

describe('embedStaleForSource', () => {
  test('empty stale set returns done:true with zero embedded', async () => {
    const result = await embedStaleForSource(engine, 'default', {
      embedFn: fakeEmbedFn,
    });
    expect(result).toEqual({
      embedded: 0,
      chunksProcessed: 0,
      pagesProcessed: 0,
      lastCursor: null,
      done: true,
      aborted: false,
    });
  });

  test('embeds every stale chunk across multiple pages in one call', async () => {
    await seedPageWithStaleChunks('a', 5);
    await seedPageWithStaleChunks('b', 3);

    const result = await embedStaleForSource(engine, 'default', {
      embedFn: fakeEmbedFn,
    });
    expect(result.done).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.embedded).toBe(8);
    expect(result.pagesProcessed).toBe(2);

    // Verify DB: zero stale remaining for default.
    const stale = await engine.countStaleChunks({ sourceId: 'default' });
    expect(stale).toBe(0);
  });

  test('respects batchSize for cursor pagination', async () => {
    await seedPageWithStaleChunks('a', 3);
    await seedPageWithStaleChunks('b', 3);
    let batchCount = 0;
    const result = await embedStaleForSource(engine, 'default', {
      embedFn: fakeEmbedFn,
      batchSize: 2,
      onProgress: () => {
        batchCount++;
      },
    });
    expect(result.embedded).toBe(6);
    // 2-chunk batches across 6 stale rows = at least 3 progress callbacks.
    expect(batchCount).toBeGreaterThanOrEqual(3);
  });

  test('IRON-RULE: aborted mid-flight → aborted:true, partial progress preserved', async () => {
    await seedPageWithStaleChunks('a', 4);
    await seedPageWithStaleChunks('b', 4);
    await seedPageWithStaleChunks('c', 4);
    const controller = new AbortController();
    // Batch size 4 = one page per batch. concurrency 1 = serialize keys.
    // Abort fires inside embedFn for page 'b', so 'a' lands, 'b' aborts mid-call,
    // and the third batch ('c') never starts.
    const result = await embedStaleForSource(engine, 'default', {
      batchSize: 4,
      concurrency: 1,
      signal: controller.signal,
      embedFn: async (texts) => {
        if (texts.some((t) => t.includes(' of b'))) {
          controller.abort();
          throw new Error('aborted'); // simulates HTTP abort throw
        }
        return fakeEmbedFn(texts);
      },
    });
    expect(result.aborted).toBe(true);
    expect(result.done).toBe(false);
    expect(result.embedded).toBe(4); // only 'a' landed
    // 'b' and 'c' (8 chunks) remain stale
    const stale = await engine.countStaleChunks({ sourceId: 'default' });
    expect(stale).toBe(8);
  });

  test('IRON-RULE: kill + resume — second call picks up via embedding-IS-NULL predicate', async () => {
    await seedPageWithStaleChunks('a', 4);
    await seedPageWithStaleChunks('b', 4);

    // First call aborts when 'b' is reached
    const controller = new AbortController();
    const first = await embedStaleForSource(engine, 'default', {
      batchSize: 4,
      concurrency: 1,
      signal: controller.signal,
      embedFn: async (texts) => {
        if (texts.some((t) => t.includes(' of b'))) {
          controller.abort();
          throw new Error('aborted');
        }
        return fakeEmbedFn(texts);
      },
    });
    expect(first.aborted).toBe(true);
    expect(first.embedded).toBe(4); // 'a' landed

    // Second call with NO cursor — predicate excludes already-embedded chunks
    const second = await embedStaleForSource(engine, 'default', {
      embedFn: fakeEmbedFn,
    });
    expect(second.done).toBe(true);
    expect(first.embedded + second.embedded).toBe(8);

    const stale = await engine.countStaleChunks({ sourceId: 'default' });
    expect(stale).toBe(0);
  });

  test('per-page embedFn throw is logged but does NOT propagate', async () => {
    await seedPageWithStaleChunks('good', 2);
    await seedPageWithStaleChunks('bad', 2);

    let badCount = 0;
    const result = await embedStaleForSource(engine, 'default', {
      embedFn: async (texts) => {
        if (texts.some((t) => t.includes('bad'))) {
          badCount++;
          throw new Error('intentional embed failure');
        }
        return fakeEmbedFn(texts);
      },
    });

    // The helper itself didn't throw
    expect(result.done).toBe(true);
    expect(badCount).toBe(1);

    // 'good' chunks got embedded; 'bad' chunks stayed NULL
    expect(result.embedded).toBe(2);
    const stale = await engine.countStaleChunks({ sourceId: 'default' });
    expect(stale).toBe(2);
  });

  test('SPEC V4: good/bad chunks on one page persist the good vector only', async () => {
    await engine.putPage('mixed', { type: 'note', title: 'mixed', compiled_truth: '# mixed' });
    await engine.upsertChunks('mixed', [
      { chunk_index: 0, chunk_text: 'good', chunk_source: 'compiled_truth', token_count: 1, embedding: undefined },
      { chunk_index: 1, chunk_text: 'bad', chunk_source: 'compiled_truth', token_count: 1, embedding: undefined },
    ]);
    const result = await embedStaleForSource(engine, 'default', {
      embedFn: async (texts) => {
        if (texts.length > 1) throw new Error('EOF');
        if (texts[0] === 'bad') throw new Error('The operation timed out');
        return [fakeVector()];
      },
    });
    expect(result.embedded).toBe(1);
    expect(result.pagesProcessed).toBe(1);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);
    const persisted = await engine.executeRaw<{ chunk_index: number; has_embedding: boolean }>(
      `SELECT chunk_index, embedding IS NOT NULL AS has_embedding
         FROM content_chunks
        WHERE page_id = (SELECT id FROM pages WHERE slug = 'mixed' AND source_id = 'default')
        ORDER BY chunk_index`,
    );
    expect(persisted).toEqual([
      { chunk_index: 0, has_embedding: true },
      { chunk_index: 1, has_embedding: false },
    ]);
  });

  test('SPEC V4: abort inside final short batch persists prefix and returns done:false', async () => {
    await engine.putPage('final-batch', { type: 'note', title: 'final-batch', compiled_truth: '# final' });
    await engine.upsertChunks('final-batch', [
      { chunk_index: 0, chunk_text: 'good', chunk_source: 'compiled_truth', token_count: 1, embedding: undefined },
      { chunk_index: 1, chunk_text: 'abort', chunk_source: 'compiled_truth', token_count: 1, embedding: undefined },
    ]);
    const controller = new AbortController();
    const result = await embedStaleForSource(engine, 'default', {
      signal: controller.signal,
      embedFn: async (texts) => {
        if (texts.length > 1) throw new Error('EOF');
        if (texts[0] === 'abort') {
          controller.abort();
          throw new Error('EOF');
        }
        return [fakeVector()];
      },
    });
    expect(result).toMatchObject({ embedded: 1, pagesProcessed: 1, aborted: true, done: false });
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);
  });

  test('SPEC V4: must-abort is rethrown after prefix partial persistence', async () => {
    await engine.putPage('budget', { type: 'note', title: 'budget', compiled_truth: '# budget' });
    await engine.upsertChunks('budget', [
      { chunk_index: 0, chunk_text: 'good', chunk_source: 'compiled_truth', token_count: 1, embedding: undefined },
      { chunk_index: 1, chunk_text: 'budget', chunk_source: 'compiled_truth', token_count: 1, embedding: undefined },
    ]);
    const exhausted = new BudgetExhausted('budget exhausted', {
      reason: 'cost', spent: 1, cap: 1,
    });
    try {
      await embedStaleForSource(engine, 'default', {
        embedFn: async (texts) => {
          if (texts.length > 1) throw new Error('EOF');
          if (texts[0] === 'budget') throw exhausted;
          return [fakeVector()];
        },
      });
      throw new Error('expected BudgetExhausted');
    } catch (error) {
      expect(error).toBe(exhausted);
    }
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);
  });

  test('SPEC V4: drifted page split across cursor batches stamps once and is not invalidated next run', async () => {
    await seedPageWithStaleChunks('signature-split', 3);
    await engine.executeRaw(
      `UPDATE content_chunks
          SET embedding = ('[' || array_to_string(array_fill(0.0::real, ARRAY[1536]), ',') || ']')::vector
        WHERE page_id = (SELECT id FROM pages WHERE slug = 'signature-split' AND source_id = 'default')`,
    );
    await engine.setPageEmbeddingSignature('signature-split', { signature: 'old:model:1536' });

    const first = await embedStaleForSource(engine, 'default', {
      batchSize: 2,
      embeddingSignature: 'new:model:1536',
      embedFn: fakeEmbedFn,
    });
    expect(first.embedded).toBe(3);
    const signature = await engine.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE slug = 'signature-split' AND source_id = 'default'`,
    );
    expect(signature[0]?.embedding_signature).toBe('new:model:1536');

    let secondRunCalls = 0;
    const second = await embedStaleForSource(engine, 'default', {
      batchSize: 2,
      embeddingSignature: 'new:model:1536',
      embedFn: async (texts) => {
        secondRunCalls++;
        return fakeEmbedFn(texts);
      },
    });
    expect(second).toMatchObject({ embedded: 0, done: true, aborted: false });
    expect(secondRunCalls).toBe(0);
  });

  test('SPEC V4: whole-page drift partial stamps good vector and preserves it on the next run', async () => {
    await seedPageWithStaleChunks('signature-partial', 2);
    await engine.executeRaw(
      `UPDATE content_chunks
          SET embedding = ('[' || array_to_string(array_fill(0.0::real, ARRAY[1536]), ',') || ']')::vector
        WHERE page_id = (SELECT id FROM pages WHERE slug = 'signature-partial' AND source_id = 'default')`,
    );
    await engine.setPageEmbeddingSignature('signature-partial', { signature: 'old:model:1536' });
    const first = await embedStaleForSource(engine, 'default', {
      embeddingSignature: 'new:model:1536',
      embedFn: async (texts) => {
        if (texts.length > 1) throw new Error('EOF');
        if (texts[0]?.includes('chunk 1')) throw new Error('The operation timed out');
        return [fakeVector()];
      },
    });
    expect(first.embedded).toBe(1);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);

    const secondCalls: string[][] = [];
    await embedStaleForSource(engine, 'default', {
      embeddingSignature: 'new:model:1536',
      embedFn: async (texts) => {
        secondCalls.push(texts);
        return [fakeVector()];
      },
    });
    expect(secondCalls).toEqual([['chunk 1 of signature-partial']]);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
  });

  test('SPEC V4: Minion logs the actual chunk_index for a fatal after a prefix', async () => {
    await engine.putPage('fatal-index', { type: 'note', title: 'fatal-index', compiled_truth: '# fatal-index' });
    await engine.upsertChunks('fatal-index', [
      { chunk_index: 3, chunk_text: 'good', chunk_source: 'compiled_truth', token_count: 1, embedding: undefined },
      { chunk_index: 9, chunk_text: 'fatal', chunk_source: 'compiled_truth', token_count: 1, embedding: undefined },
    ]);
    const originalWrite = process.stderr.write;
    let stderr = '';
    (process.stderr.write as any) = (chunk: string) => { stderr += chunk; return true; };
    try {
      const result = await embedStaleForSource(engine, 'default', {
        embedFn: async (texts) => {
          if (texts.length > 1) throw new Error('EOF');
          if (texts[0] === 'fatal') throw new Error('fatal embedding');
          return [fakeVector()];
        },
      });
      expect(result.embedded).toBe(1);
    } finally {
      (process.stderr.write as any) = originalWrite;
    }
    expect(stderr).toContain('failed chunk_index [9]: fatal embedding');
  });

  test('source-scoped: does not touch other sources', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{"federated":true}'::jsonb) ON CONFLICT (id) DO NOTHING`,
    );
    await seedPageWithStaleChunks('a', 3);
    await engine.putPage('b', {
      type: 'note',
      title: 'b',
      compiled_truth: '# b\n\nseeded',
    }, { sourceId: 'other' });
    await engine.upsertChunks(
      'b',
      Array.from({ length: 3 }, (_, i) => ({
        chunk_index: i,
        chunk_text: `other ${i}`,
        chunk_source: 'compiled_truth',
        token_count: 4,
        embedding: undefined,
      })),
      { sourceId: 'other' },
    );

    const result = await embedStaleForSource(engine, 'default', {
      embedFn: fakeEmbedFn,
    });
    expect(result.embedded).toBe(3);

    // 'other' source still has 3 stale chunks
    const otherStale = await engine.countStaleChunks({ sourceId: 'other' });
    expect(otherStale).toBe(3);
  });
});

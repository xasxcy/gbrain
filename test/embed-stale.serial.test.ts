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
import { AIConfigError } from '../src/core/ai/errors.ts';

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
      persistFailures: 0,
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
    // partial-stale now isolates unknown provider failures one chunk at a
    // time, so the initial batch plus its two leaf attempts are expected.
    expect(badCount).toBe(3);

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

  test('partial stale: AIConfigError is run-global and never enters the ledger', async () => {
    await seedPageWithStaleChunks('config-fatal', 1);
    const fatal = new AIConfigError('401 invalid key');
    await expect(embedStaleForSource(engine, 'default', {
      embeddingSignature: 'test:model:1536',
      embedFn: async () => { throw fatal; },
    })).rejects.toBe(fatal);
    expect(await engine.executeRaw(`SELECT 1 FROM embed_failures`)).toHaveLength(0);
  });

  test('partial stale: batch invalid-input is bisected to one ledger row', async () => {
    await seedPageWithStaleChunks('invalid-batch', 4);
    await embedStaleForSource(engine, 'default', {
      embeddingSignature: 'test:model:1536',
      embedFn: async (texts) => {
        if (texts.some((text) => text.includes('chunk 2'))) throw new Error('422 unprocessable entity: invalid input');
        return texts.map(() => fakeVector());
      },
    });
    expect(await engine.executeRaw<{ chunk_index: number; error_class: string }>(
      `SELECT chunk_index, error_class FROM embed_failures WHERE slug = 'invalid-batch'`,
    )).toEqual([{ chunk_index: 2, error_class: 'invalid_input' }]);
  });

  test('partial stale: a single toxic input is ledgered without poisoning siblings', async () => {
    await seedPageWithStaleChunks('invalid-single', 2);
    await embedStaleForSource(engine, 'default', {
      embeddingSignature: 'test:model:1536',
      embedFn: async (texts) => {
        if (texts.some((text) => text.includes('chunk 1'))) throw new Error('invalid input: token limit');
        return texts.map(() => fakeVector());
      },
    });
    expect(await engine.executeRaw<{ chunk_index: number }>(
      `SELECT chunk_index FROM embed_failures WHERE slug = 'invalid-single' AND error_class = 'invalid_input'`,
    )).toEqual([{ chunk_index: 1 }]);
  });

  test('partial stale: unknown transient provider errors enter the provider_other ledger', async () => {
    await seedPageWithStaleChunks('unknown-transient', 2);
    await embedStaleForSource(engine, 'default', {
      embeddingSignature: 'test:model:1536',
      embedFn: async (texts) => {
        if (texts.some((text) => text.includes('chunk 1'))) throw new Error('provider 502 upstream reset');
        return texts.map(() => fakeVector());
      },
    });
    expect(await engine.executeRaw<{ chunk_index: number; error_class: string }>(
      `SELECT chunk_index, error_class FROM embed_failures WHERE slug = 'unknown-transient'`,
    )).toEqual([{ chunk_index: 1, error_class: 'provider_other' }]);
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

  test('B5 regression: a 5-chunk page split into 2+2+1 stamps once and stays current', async () => {
    await seedPageWithStaleChunks('signature-five-chunks', 5);
    await engine.executeRaw(
      `UPDATE content_chunks
          SET embedding = ('[' || array_to_string(array_fill(0.0::real, ARRAY[1536]), ',') || ']')::vector
        WHERE page_id = (SELECT id FROM pages WHERE slug = 'signature-five-chunks' AND source_id = 'default')`,
    );
    await engine.setPageEmbeddingSignature('signature-five-chunks', { signature: 'old:model:1536' });

    const first = await embedStaleForSource(engine, 'default', {
      batchSize: 2,
      embeddingSignature: 'new:model:1536',
      embedFn: fakeEmbedFn,
    });
    expect(first).toMatchObject({ embedded: 5, done: true, aborted: false });
    const signature = await engine.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE slug = 'signature-five-chunks' AND source_id = 'default'`,
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

  test('SPEC V4: whole-page drift partial stamps after invalidation and retries only the failed chunk', async () => {
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
    expect(await engine.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE slug = 'signature-partial' AND source_id = 'default'`,
    )).toEqual([{ embedding_signature: 'new:model:1536' }]);

    const secondCalls: string[][] = [];
    await embedStaleForSource(engine, 'default', {
      embeddingSignature: 'new:model:1536',
      embedFn: async (texts) => {
        secondCalls.push(texts);
        return [fakeVector()];
      },
    });
    // The failed chunk is ledger-deferred; the successful sibling remains
    // attributable to the current page signature and is not invalidated.
    expect(secondCalls).toEqual([]);
    expect(await engine.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE slug = 'signature-partial' AND source_id = 'default'`,
    )).toEqual([{ embedding_signature: 'new:model:1536' }]);
    // The legacy no-signature count remains a raw NULL count; the active
    // signed stale pipeline is what excludes this backoff-deferred row.
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);

    await engine.executeRaw(
      `UPDATE embed_failures
          SET next_retry_at = now() - INTERVAL '1 second'
        WHERE slug = 'signature-partial' AND embedding_signature = 'new:model:1536'`,
    );
    const retryCalls: string[][] = [];
    await embedStaleForSource(engine, 'default', {
      embeddingSignature: 'new:model:1536',
      embedFn: async (texts) => {
        retryCalls.push(texts);
        return [fakeVector()];
      },
    });
    expect(retryCalls).toEqual([['chunk 1 of signature-partial']]);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
  });

  test('B5-storm: a quarantined chunk does not trigger permanent whole-page re-embedding', async () => {
    const slug = 'signature-quarantined-storm';
    const signature = 'new:model:1536';
    await seedPageWithStaleChunks(slug, 5);
    await engine.executeRaw(
      `UPDATE content_chunks
          SET embedding = ('[' || array_to_string(array_fill(0.0::real, ARRAY[1536]), ',') || ']')::vector
        WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = 'default')`,
      [slug],
    );
    await engine.setPageEmbeddingSignature(slug, { signature: 'old:model:1536' });

    const permanentlyFailingEmbedFn = async (texts: string[]): Promise<Float32Array[]> => {
      if (texts.some((text) => text.includes('chunk 4'))) {
        throw new Error('provider 502 permanent toxic chunk');
      }
      return fakeEmbedFn(texts);
    };

    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) {
        await engine.executeRaw(
          `UPDATE embed_failures
              SET next_retry_at = now() - INTERVAL '1 second'
            WHERE slug = $1 AND embedding_signature = $2`,
          [slug, signature],
        );
      }
      await embedStaleForSource(engine, 'default', {
        embeddingSignature: signature,
        embedFn: permanentlyFailingEmbedFn,
      });
    }

    const quarantined = await engine.executeRaw<{ attempt_count: number; quarantined_at: Date | null }>(
      `SELECT attempt_count, quarantined_at
         FROM embed_failures
        WHERE slug = $1 AND embedding_signature = $2 AND chunk_index = 4`,
      [slug, signature],
    );
    expect(quarantined[0]?.attempt_count).toBe(5);
    expect(quarantined[0]?.quarantined_at).not.toBeNull();
    expect(await engine.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE slug = $1 AND source_id = 'default'`,
      [slug],
    )).toEqual([{ embedding_signature: signature }]);

    let postQuarantineCalls = 0;
    const afterQuarantine = await embedStaleForSource(engine, 'default', {
      embeddingSignature: signature,
      embedFn: async (texts) => {
        postQuarantineCalls++;
        return fakeEmbedFn(texts);
      },
    });
    expect(afterQuarantine).toMatchObject({ embedded: 0, done: true, aborted: false });
    expect(postQuarantineCalls).toBe(0);
  });

  test('SPEC V4: a NULL-signature page with pre-existing vectors never stamps from a partial stale slice', async () => {
    await seedPageWithStaleChunks('signature-null-partial', 2);
    await engine.executeRaw(
      `UPDATE content_chunks SET embedding = ('[' || array_to_string(array_fill(0.0::real, ARRAY[1536]), ',') || ']')::vector
        WHERE page_id = (SELECT id FROM pages WHERE slug = 'signature-null-partial') AND chunk_index = 0`,
    );
    await embedStaleForSource(engine, 'default', { embeddingSignature: 'new:model:1536', embedFn: fakeEmbedFn });
    const rows = await engine.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE slug = 'signature-null-partial'`,
    );
    expect(rows[0]?.embedding_signature).toBeNull();
  });

  test('B5 grandfather: a single slice covering the whole page stamps the current signature', async () => {
    const slug = 'signature-null-whole-page';
    const signature = 'new:model:1536';
    await seedPageWithStaleChunks(slug, 3);

    const first = await embedStaleForSource(engine, 'default', {
      embeddingSignature: signature,
      embedFn: fakeEmbedFn,
    });
    expect(first).toMatchObject({ embedded: 3, done: true, aborted: false });
    expect(await engine.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE slug = $1 AND source_id = 'default'`,
      [slug],
    )).toEqual([{ embedding_signature: signature }]);

    let secondRunCalls = 0;
    const second = await embedStaleForSource(engine, 'default', {
      embeddingSignature: signature,
      embedFn: async (texts) => {
        secondRunCalls++;
        return fakeEmbedFn(texts);
      },
    });
    expect(second).toMatchObject({ embedded: 0, done: true, aborted: false });
    expect(secondRunCalls).toBe(0);
  });

  test('B5: invalidation failure never stamps a mixed-generation page', async () => {
    await seedPageWithStaleChunks('signature-invalidation-fail', 2);
    await engine.executeRaw(
      `UPDATE content_chunks
          SET embedding = ('[1,' || array_to_string(array_fill(0.0::real, ARRAY[1535]), ',') || ']')::vector
        WHERE page_id = (SELECT id FROM pages WHERE slug = 'signature-invalidation-fail')
          AND chunk_index = 0`,
    );
    await engine.setPageEmbeddingSignature('signature-invalidation-fail', { signature: 'old:model:1536' });

    const originalInvalidate = engine.invalidateStaleSignatureEmbeddings.bind(engine);
    const originalWrite = process.stderr.write;
    let stderr = '';
    engine.invalidateStaleSignatureEmbeddings = async () => { throw new Error('invalidation unavailable'); };
    (process.stderr.write as any) = (chunk: string) => { stderr += chunk; return true; };
    try {
      const result = await embedStaleForSource(engine, 'default', {
        embeddingSignature: 'new:model:1536',
        embedFn: async (texts) => texts.map(() => {
          const vector = new Float32Array(1536);
          vector[0] = 9;
          return vector;
        }),
      });
      expect(result).toMatchObject({ embedded: 1, done: true, aborted: false });
    } finally {
      engine.invalidateStaleSignatureEmbeddings = originalInvalidate;
      (process.stderr.write as any) = originalWrite;
    }

    const rows = await engine.executeRaw<{
      chunk_index: number;
      embedding_text: string;
      embedding_signature: string | null;
    }>(
      `SELECT cc.chunk_index,
              cc.embedding::text AS embedding_text,
              p.embedding_signature
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = 'signature-invalidation-fail'
        ORDER BY cc.chunk_index`,
    );
    expect(rows.map((row) => Number(row.embedding_text.slice(1).split(',', 1)[0]))).toEqual([1, 9]);
    expect(rows[0]?.embedding_signature).toBe('old:model:1536');
    expect(await engine.countStaleChunks({ sourceId: 'default', signature: 'new:model:1536' })).toBe(2);
    expect(stderr).toContain('[embed-signature-invalidation-fail] source_id=default err=invalidation unavailable');
  });

  test('signature-write failure preserves committed vector and page counters', async () => {
    await seedPageWithStaleChunks('signature-write-fail', 1);
    await engine.setPageEmbeddingSignature('signature-write-fail', { signature: 'old:model:1536' });
    const originalStamp = engine.setPageEmbeddingSignature.bind(engine);
    engine.setPageEmbeddingSignature = async () => { throw new Error('signature write failed'); };
    try {
      const result = await embedStaleForSource(engine, 'default', { embeddingSignature: 'new:model:1536', embedFn: fakeEmbedFn });
      expect(result).toMatchObject({ embedded: 1, pagesProcessed: 1, persistFailures: 0 });
    } finally {
      engine.setPageEmbeddingSignature = originalStamp;
    }
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
    expect(stderr).toContain('[embed-fail] slug=fatal-index chunk_index=9 class=provider_other');
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

  test('preserves modality and code-symbol metadata across the merge round-trip', async () => {
    // Regression: the merged ChunkInput[] used to rebuild rows with only 5
    // fields; upsertChunks writes modality/symbol columns as EXCLUDED.<col>,
    // so an image page with one stale TEXT chunk got its image row reset to
    // modality='text' — permanently invisible to the image search arm.
    await engine.putPage('media/mixed-page', {
      type: 'image',
      title: 'mixed',
      compiled_truth: 'mixed modality page',
    });
    const imgVec = new Float32Array(1024).fill(0.03);
    await engine.upsertChunks('media/mixed-page', [
      {
        chunk_index: 0,
        chunk_text: 'field-photo.jpg',
        chunk_source: 'image_asset',
        modality: 'image',
        embedding_image: imgVec,
        // embedding intentionally present so this row is NOT stale.
        embedding: new Float32Array(1536).fill(0.01),
        token_count: 4,
      },
      {
        chunk_index: 1,
        chunk_text: 'ocr caption text needing embed',
        chunk_source: 'compiled_truth',
        language: 'python',
        symbol_name: 'kept_symbol',
        symbol_type: 'function',
        symbol_name_qualified: 'mod::kept_symbol',
        token_count: 6,
        embedding: undefined, // stale — triggers the merge path
      },
    ]);

    const result = await embedStaleForSource(engine, 'default', { embedFn: fakeEmbedFn });
    expect(result.embedded).toBe(1);

    const after = await engine.getChunks('media/mixed-page');
    const imgRow = after.find((c) => c.chunk_index === 0)!;
    const txtRow = after.find((c) => c.chunk_index === 1)!;
    expect(imgRow.modality).toBe('image');
    expect(txtRow.language).toBe('python');
    expect(txtRow.symbol_name).toBe('kept_symbol');
    expect(txtRow.symbol_name_qualified).toBe('mod::kept_symbol');
    // The stale text row actually got its embedding.
    expect(txtRow.embedded_at).not.toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// #3507 — re-embed must reproduce the page's STORED contextual-retrieval
// wrapping convention. Before the fix, every plain re-embed (including the
// normal post-model-migration `embed --stale`) embedded raw chunk_text,
// silently replacing context-wrapped vectors with unwrapped ones.
// ────────────────────────────────────────────────────────────────

describe('contextual-retrieval wrapping on re-embed (#3507)', () => {
  /** embedFn that records every text it is asked to embed. */
  function capturingEmbedFn(seen: string[]) {
    return (texts: string[]): Promise<Float32Array[]> => {
      seen.push(...texts);
      return fakeEmbedFn(texts);
    };
  }

  async function seedWrappablePage(slug: string, title: string): Promise<void> {
    await engine.putPage(slug, { type: 'note', title, compiled_truth: 'seeded' });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: 'prose chunk about widgets', chunk_source: 'compiled_truth', token_count: 4 },
      { chunk_index: 1, chunk_text: 'const x = 1;', chunk_source: 'fenced_code', token_count: 4 },
    ]);
  }

  test('title-mode page: stale re-embed sends title-wrapped texts; fenced_code stays raw', async () => {
    await seedWrappablePage('wrapped-page', 'Widget Notes');
    await engine.updatePageContextualRetrievalState('wrapped-page', 'default', 'title', 'gen-title');

    const seen: string[] = [];
    const result = await embedStaleForSource(engine, 'default', { embedFn: capturingEmbedFn(seen) });
    expect(result.embedded).toBe(2);

    expect(seen).toContain('<context>Widget Notes\n</context>\nprose chunk about widgets');
    expect(seen).toContain('const x = 1;'); // fenced_code is NEVER wrapped (D20-T4)

    // D20-T1: the canonical chunk_text is NOT rewritten — wrapping is embed-input-only.
    const chunks = await engine.getChunks('wrapped-page');
    expect(chunks.map((c) => c.chunk_text).sort()).toEqual(['const x = 1;', 'prose chunk about widgets']);
    // Mode stamp unchanged for title-tier pages.
    const rows = await engine.executeRaw<{ contextual_retrieval_mode: string }>(
      `SELECT contextual_retrieval_mode FROM pages WHERE slug = 'wrapped-page'`,
    );
    expect(rows[0].contextual_retrieval_mode).toBe('title');
  });

  test('per_chunk_synopsis page: re-embed applies the title-tier wrapper and restamps honestly', async () => {
    await seedWrappablePage('synopsis-page', 'Synopsis Notes');
    await engine.updatePageContextualRetrievalState('synopsis-page', 'default', 'per_chunk_synopsis', 'gen-synopsis');

    const seen: string[] = [];
    const result = await embedStaleForSource(engine, 'default', { embedFn: capturingEmbedFn(seen) });
    expect(result.embedded).toBe(2);

    // Synopsis re-generation is a paid backfill concern; the plain re-embed
    // lands at the title tier (the service's own D14 fallback tier)…
    expect(seen).toContain('<context>Synopsis Notes\n</context>\nprose chunk about widgets');
    // …and the stamped mode is updated so it keeps describing the vectors.
    const rows = await engine.executeRaw<{ contextual_retrieval_mode: string }>(
      `SELECT contextual_retrieval_mode FROM pages WHERE slug = 'synopsis-page'`,
    );
    expect(rows[0].contextual_retrieval_mode).toBe('title');
  });

  test('unstamped page (NULL mode) embeds raw chunk_text — convention preserved', async () => {
    await seedWrappablePage('plain-page', 'Plain Notes');
    // No updatePageContextualRetrievalState call: pre-CR page.

    const seen: string[] = [];
    const result = await embedStaleForSource(engine, 'default', { embedFn: capturingEmbedFn(seen) });
    expect(result.embedded).toBe(2);

    expect(seen).toContain('prose chunk about widgets');
    expect(seen.some((t) => t.startsWith('<context>'))).toBe(false);
  });
});

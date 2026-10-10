/**
 * P2B — markdown import inline-embed seam.
 *
 * Hermetic: the embedding module is mocked before importing import-file.ts;
 * the engine is an in-memory PGLite brain. Upstream's import path runs through
 * revision-bound projections and transaction settings (executeRaw row reads), which a
 * null-returning Proxy recorder can no longer model, so the seam is exercised against
 * the real engine. No gateway or network is used.
 *
 * Locks two behaviours production checkpoint-drain evidence showed missing:
 *   1. `importFromContent`'s inline embed call at import-file.ts:707 must
 *      share the EOF/timeout truncation fallback — a batch failure retries
 *      chunk-by-chunk instead of throwing and aborting the whole import.
 *   2. `isOllamaOomLikeError` must classify the production
 *      "socket connection was closed" error text as fallback-eligible.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let embedCalls: string[][] = [];
let embedImpl = async (texts: string[]): Promise<Float32Array[]> => {
  if (texts.length > 1) throw new Error('read EOF while waiting for response from llama-server');
  return texts.map(() => new Float32Array(1536));
};

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => {
    embedCalls.push(texts);
    return embedImpl(texts);
  },
  embedMultimodal: async () => {
    throw new Error('embedMultimodal not used by this test');
  },
  currentEmbeddingSignature: () => 'test:model:1536',
}));

const { importFromContent } = await import('../src/core/import-file.ts');
const { isOllamaOomLikeError } = await import('../src/core/embed-fallback.ts');

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

// >300 words so the real recursive chunker (300-word target) splits this
// into 2 chunks — required to reproduce the batch-of-2 EOF failure.
const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(60);

describe('markdown import inline-embed fallback (import-file.ts:707 seam)', () => {
  test('batch EOF on inline import embed falls back to per-chunk retry instead of aborting the import', async () => {
    embedCalls = [];
    embedImpl = async (texts) => {
      if (texts.length > 1) throw new Error('read EOF while waiting for response from llama-server');
      return texts.map(() => new Float32Array(1536));
    };

    // Required P2B behaviour: a batch EOF at the import seam must not
    // propagate and abort the import — it must fall back to per-chunk
    // embedding and still land the page with all chunks embedded.
    const result = await importFromContent(engine, 'seam-test-page', LOREM, { sourceId: 'default' });

    expect(result.status).toBe('imported');
    expect(result.chunks).toBe(2);
    const rows = await engine.executeRaw<{ has_embedding: boolean }>(
      `SELECT embedding IS NOT NULL AS has_embedding FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = 'seam-test-page' AND p.source_id = 'default' ORDER BY cc.chunk_index`,
    );
    expect(rows).toEqual([{ has_embedding: true }, { has_embedding: true }]);
    // Batch-of-2 failed, then two individual retries succeeded.
    expect(embedCalls.map((call) => call.length)).toEqual([2, 1, 1]);
  });

  test('isOllamaOomLikeError classifies the production socket-closed error text', () => {
    // Production error, verbatim (BRIEF-P2B背景): "Cannot connect to API:
    // The socket connection was closed unexpectedly".
    const err = new Error('Cannot connect to API: The socket connection was closed unexpectedly');
    expect(isOllamaOomLikeError(err)).toBe(true);
  });

  test('inline-import legacy seam preserves the chunk AbortError object', async () => {
    embedCalls = [];
    const abortError = new DOMException('aborted', 'AbortError');
    embedImpl = async (texts) => {
      if (texts.length > 1) throw new Error('EOF');
      throw abortError;
    };
    try {
      await importFromContent(engine, 'seam-abort', LOREM, { sourceId: 'default' });
      throw new Error('expected import to throw');
    } catch (error) {
      expect(error).toBe(abortError);
    }
    expect(embedCalls.map((call) => call.length)).toEqual([2, 1]);
  });
});

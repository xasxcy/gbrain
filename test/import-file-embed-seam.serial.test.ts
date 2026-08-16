/**
 * P2B — markdown import inline-embed seam.
 *
 * Hermetic: the embedding module is mocked before importing import-file.ts;
 * the engine is an in-memory Proxy recorder (getPage/config default to
 * "nothing on file"). No gateway, network, or DB is used. The first case
 * overrides that default with a minimal write-then-read page store, because
 * importFromContent's closing verifyPageReadable would otherwise fail before
 * the embedding assertions are reached — see the comment there.
 *
 * Locks two behaviours production checkpoint-drain evidence showed missing:
 *   1. `importFromContent`'s inline embed call at import-file.ts:707 must
 *      share the EOF/timeout truncation fallback — a batch failure retries
 *      chunk-by-chunk instead of throwing and aborting the whole import.
 *   2. `isOllamaOomLikeError` must classify the production
 *      "socket connection was closed" error text as fallback-eligible.
 */
import { describe, expect, mock, test } from 'bun:test';

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

function mockEngine(overrides: Partial<Record<string, any>>): any {
  const engine: any = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'transaction') {
          // tx === the same recorder, so overrides (putPage/upsertChunks/...)
          // apply whether called on the outer engine or the tx handle.
          return async (fn: (e: any) => Promise<unknown>) => fn(engine);
        }
        return overrides[prop] ?? (async () => null);
      },
    },
  );
  return engine;
}

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

    const stored: any[][] = [];
    // Minimal write-then-read store. importFromContent ends with
    // verifyPageReadable, which re-reads the page it just wrote and throws if
    // getPage returns null — a real guard against the silent-desync class, and
    // unconditional since long before this test existed. The default recorder
    // ("putPage writes nothing, getPage always null") models a database that
    // lost the write, so this test could never reach its own assertions.
    //
    // That negative case is not this test's job: it is covered explicitly, both
    // branches, in test/write-verify-guard.test.ts. The SUT here is the inline
    // embedding seam. Same in-memory-page-store shape as test/import-file.ts.
    const pages = new Map<string, any>();
    const engine = mockEngine({
      getPage: async (slug: string) => pages.get(slug) ?? null,
      putPage: async (slug: string, page: any) => { pages.set(slug, { slug, ...page }); },
      updatePageContextualRetrievalState: async () => {},
      upsertChunks: async (_slug: string, chunks: any[]) => {
        stored.push(chunks);
      },
      setPageEmbeddingSignature: async () => {},
      setPageAliases: async () => {},
    });

    // Required P2B behaviour: a batch EOF at the import seam must not
    // propagate and abort the import — it must fall back to per-chunk
    // embedding and still land the page with all chunks embedded.
    const result = await importFromContent(engine, 'seam-test-page', LOREM, { sourceId: 'default' });

    expect(result.status).toBe('imported');
    expect(result.chunks).toBe(2);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toHaveLength(2);
    expect(stored[0].every((c: any) => c.embedding instanceof Float32Array)).toBe(true);
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
    const engine = mockEngine({
      getPage: async () => null,
      putPage: async () => {},
      updatePageContextualRetrievalState: async () => {},
      upsertChunks: async () => {},
      setPageEmbeddingSignature: async () => {},
      setPageAliases: async () => {},
    });
    try {
      await importFromContent(engine, 'seam-abort', LOREM, { sourceId: 'default' });
      throw new Error('expected import to throw');
    } catch (error) {
      expect(error).toBe(abortError);
    }
    expect(embedCalls.map((call) => call.length)).toEqual([2, 1]);
  });
});

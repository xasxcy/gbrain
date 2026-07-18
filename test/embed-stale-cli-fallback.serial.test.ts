/**
 * Regression seam for the foreground `gbrain embed --stale` path.
 *
 * Hermetic: the embedding module is mocked before importing the command, and
 * the engine is an in-memory call recorder. No gateway, network, or DB is used.
 *
 * Locks the shared fallback contract: an EOF-failed page batch is retried one
 * chunk at a time, while a permanently failing page is skipped without
 * preventing a later page from embedding.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';

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
  currentEmbeddingSignature: () => 'test:model:1536',
}));

const { runEmbedCore } = await import('../src/commands/embed.ts');
const { __setEmbedTransportForTests } = await import('../src/core/ai/gateway.ts');
__setEmbedTransportForTests(async () => ({ embeddings: [], usage: { tokens: 0 } } as any));

function mockEngine(overrides: Partial<Record<string, any>>): BrainEngine {
  return new Proxy({} as BrainEngine, {
    get(_, prop: string) {
      return overrides[prop] ?? (async () => null);
    },
  });
}

describe('foreground stale embed fallback', () => {
  test('stale CLI splits an EOF-failed page batch before retry', async () => {
    embedCalls = [];
    embedImpl = async (texts) => {
      if (texts.length > 1) throw new Error('read EOF while waiting for response from llama-server');
      return texts.map(() => new Float32Array(1536));
    };
    const stale = [
      { slug: 'mixed', chunk_index: 0, chunk_text: 'short', chunk_source: 'compiled_truth' as const, token_count: 2, source_id: 'default', page_id: 1 },
      { slug: 'mixed', chunk_index: 1, chunk_text: 'long'.repeat(2000), chunk_source: 'compiled_truth' as const, token_count: 2000, source_id: 'default', page_id: 1 },
    ];
    const stored: any[][] = [];
    const engine = mockEngine({
      invalidateStaleSignatureEmbeddings: async () => 0,
      countStaleChunks: async () => stale.length,
      listStaleChunks: async ({ afterPageId }: { afterPageId: number }) => afterPageId === 0 ? stale : [],
      getChunks: async () => stale.map(({ source_id, page_id, ...chunk }) => ({ ...chunk, embedded_at: null })),
      upsertChunks: async (_slug: string, chunks: any[]) => { stored.push(chunks); },
      setPageEmbeddingSignature: async () => {},
    });

    const result = await runEmbedCore(engine, { stale: true, sourceId: 'default' });

    // Required P2 behaviour: batch EOF → individual retries → both chunks land.
    expect(result.embedded).toBe(2);
    expect(stored).toHaveLength(1);
    expect(embedCalls.map((call) => call.length)).toEqual([2, 1, 1]);
  });

  test('sync inline per-slug embeds share fallback and skip one failed page', async () => {
    embedCalls = [];
    const chunksBySlug = new Map<string, any[]>([
      ['sync-mixed', [
        { chunk_index: 0, chunk_text: 'short', chunk_source: 'compiled_truth', token_count: 2, embedded_at: null },
        { chunk_index: 1, chunk_text: 'long'.repeat(2000), chunk_source: 'compiled_truth', token_count: 2000, embedded_at: null },
      ]],
      ['sync-bad', [
        { chunk_index: 0, chunk_text: 'always-fail', chunk_source: 'compiled_truth', token_count: 3, embedded_at: null },
      ]],
      ['sync-later', [
        { chunk_index: 0, chunk_text: 'later', chunk_source: 'compiled_truth', token_count: 2, embedded_at: null },
      ]],
    ]);
    const stored = new Map<string, any[]>();
    embedImpl = async (texts) => {
      if (texts.some((text) => text === 'always-fail')) {
        throw new Error('The operation timed out.');
      }
      if (texts.length > 1 || texts.some((text) => text.length > 4500)) {
        throw new Error('read EOF while waiting for response from llama-server');
      }
      return texts.map(() => new Float32Array(1536));
    };
    const engine = mockEngine({
      getPage: async (slug: string) => ({ slug, compiled_truth: slug, timeline: '' }),
      getChunks: async (slug: string) => chunksBySlug.get(slug) ?? [],
      upsertChunks: async (slug: string, chunks: any[]) => { stored.set(slug, chunks); },
      setPageEmbeddingSignature: async () => {},
    });

    // Incremental sync calls this same runEmbedCore({ slugs }) branch.
    const result = await runEmbedCore(engine, {
      slugs: ['sync-mixed', 'sync-bad', 'sync-later'],
      sourceId: 'default',
    });

    // Required P2 behaviour: fallback lands the first page, a permanently
    // failing chunk is logged/skipped, and the following page still lands.
    expect(result.embedded).toBe(3);
    expect(Array.from(stored.keys())).toEqual(['sync-mixed', 'sync-later']);
    expect(embedCalls.map((call) => call[0].length)).toContain(4500);
  });
});

/**
 * Large pages (Wave A, T3/T16): the CLI embed paths meter a large page under
 * `embed.max_usd_per_page`. `gbrain embed --all` and `--stale` send the
 * provider only the newest chunks that fit the page's remaining budget and
 * leave the page unstamped (partially embedded, keyword-searchable); a held
 * page sends nothing until `--slugs <slug> --max-usd N` approves it. The
 * shared sweep (sync, cycle, minion) and the phase-end closure meter the same way.
 *
 * Serial: uses mock.module (module-registry quarantine per docs/TESTING.md).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';

let embedded: string[] = [];
mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => {
    embedded.push(...texts);
    return texts.map(() => new Float32Array(1536).fill(0.1));
  },
  currentEmbeddingSignature: () => null,
  embedMultimodal: async (inputs: unknown[]) => inputs.map(() => new Float32Array(512)),
}));

const { runEmbedCore } = await import('../src/commands/embed.ts');
const { embedStaleForSource, embedStalePages } = await import('../src/core/embed-stale.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { resetPgliteState } = await import('./helpers/reset-pglite.ts');
const { installFixtureChunks } = await import('./helpers/page-projection.ts');
const { __setEmbedTransportForTests } = await import('../src/core/ai/gateway.ts');
const { PAGE_INLINE_MAX_BYTES } = await import('../src/core/page-size-policy.ts');
const { estimateCostFromChars } = await import('../src/core/embedding-pricing.ts');
const { holdPageEmbedding, PAGE_EMBED_CAP_KEY } = await import('../src/core/page-embedding-budget.ts');
import type { ChunkInput } from '../src/core/types.ts';

__setEmbedTransportForTests(async () => ({ embeddings: [], usage: { tokens: 0 } } as never));

const CHUNK_CHARS = 7_000;
const chunkCost = estimateCostFromChars(CHUNK_CHARS, 0.13);
const texts = Array.from({ length: 5 }, (_, i) => `chunk ${i} `.padEnd(CHUNK_CHARS, 'alice-example met acme-example. '));
let engine: InstanceType<typeof PGLiteEngine>;

beforeAll(async () => {
  process.env.GBRAIN_EMBED_CONCURRENCY = '1';
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);
afterAll(async () => {
  delete process.env.GBRAIN_EMBED_CONCURRENCY;
  __setEmbedTransportForTests(null);
  await engine.disconnect();
});
beforeEach(async () => {
  await resetPgliteState(engine);
  embedded = [];
});

async function seedLargePage(slug: string): Promise<number> {
  const body = 'Weekly notes from acme-example with alice-example. '.repeat(Math.ceil((PAGE_INLINE_MAX_BYTES + 4096) / 51));
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body });
  const chunks: ChunkInput[] = texts.map((chunk_text, chunk_index) => ({ chunk_index, chunk_text, chunk_source: 'compiled_truth', token_count: 2000 }));
  await installFixtureChunks(engine, slug, chunks);
  return (await engine.getPage(slug))!.id;
}

async function vectorIndexes(slug: string): Promise<number[]> {
  const chunks = await engine.getChunks(slug, { includeEmbedding: true });
  return chunks.filter(c => c.embedding_is_null === false).map(c => c.chunk_index).sort();
}

describe('CLI embed paths meter large pages', () => {
  test('--all embeds only the newest chunks that fit the per-page cap', async () => {
    await engine.setConfig(PAGE_EMBED_CAP_KEY, String(chunkCost * 2.5));
    await seedLargePage('chats/all');
    const result = await runEmbedCore(engine, { all: true, quiet: true });
    expect(embedded.map(t => t.slice(0, 8)).sort()).toEqual(['chunk 3 ', 'chunk 4 ']);
    expect(await vectorIndexes('chats/all')).toEqual([3, 4]);
    expect(result.embedded).toBe(2);
  });

  test('--stale embeds only the newest chunks that fit, and a second run spends nothing more', async () => {
    await engine.setConfig(PAGE_EMBED_CAP_KEY, String(chunkCost * 2.5));
    await seedLargePage('chats/stale');
    await runEmbedCore(engine, { stale: true, quiet: true });
    expect(await vectorIndexes('chats/stale')).toEqual([3, 4]);
    embedded = [];
    await runEmbedCore(engine, { stale: true, quiet: true });
    expect(embedded).toEqual([]);
  });

  test('a held page sends nothing until --slugs with --max-usd approves it', async () => {
    await engine.setConfig(PAGE_EMBED_CAP_KEY, '0');
    const pageId = await seedLargePage('chats/held');
    await holdPageEmbedding(engine, pageId, 'upgrade_backfill');
    await runEmbedCore(engine, { all: true, quiet: true });
    await runEmbedCore(engine, { slugs: ['chats/held'], quiet: true });
    expect(embedded).toEqual([]);
    await runEmbedCore(engine, { slugs: ['chats/held'], quiet: true, approvedPageCapUsd: chunkCost * 6 });
    expect(embedded).toHaveLength(5);
    expect(await vectorIndexes('chats/held')).toEqual([0, 1, 2, 3, 4]);
  });

  test('the shared stale sweep and the phase-end closure embed only what fits', async () => {
    await engine.setConfig(PAGE_EMBED_CAP_KEY, String(chunkCost * 2.5));
    await seedLargePage('chats/sweep');
    await embedStaleForSource(engine, 'default', { embedFn: async (batch: string[]) => { embedded.push(...batch); return batch.map(() => new Float32Array(1536).fill(0.1)); } });
    expect(await vectorIndexes('chats/sweep')).toEqual([3, 4]);

    await seedLargePage('chats/closure');
    embedded = [];
    await embedStalePages(engine, ['chats/closure'], 'default', { embedFn: async (batch: string[]) => { embedded.push(...batch); return batch.map(() => new Float32Array(1536).fill(0.1)); } });
    expect(embedded.map(t => t.slice(0, 8)).sort()).toEqual(['chunk 3 ', 'chunk 4 ']);
    expect(await vectorIndexes('chats/closure')).toEqual([3, 4]);
  });

  // FORK: the grant must not widen the batch past the embed_failures retry ledger.
  test('the shared stale sweep never sends a quarantined chunk of a metered page to the provider', async () => {
    await engine.setConfig(PAGE_EMBED_CAP_KEY, String(chunkCost * 10));
    const pageId = await seedLargePage('chats/ledger');
    const signature = 'test:model:1536';
    const now = new Date().toISOString();
    await engine.executeRaw(
      `INSERT INTO embed_failures
        (source_id, page_id, slug, chunk_index, embedding_signature, chunk_hash, error_class, error_fingerprint, first_seen, last_seen, next_retry_at, quarantined_at, quarantine_reason)
       SELECT 'default', $1::int, 'chats/ledger', 4, $2, md5(chunk_text), 'provider_timeout', 'fp', $3::timestamptz, $3::timestamptz, now() + interval '1 hour', $3::timestamptz, 'provider_timeout'
         FROM content_chunks WHERE page_id = $1::int AND chunk_index = 4`, [pageId, signature, now]);
    await embedStaleForSource(engine, 'default', { embeddingSignature: signature, embedFn: async (batch: string[]) => { embedded.push(...batch); return batch.map(() => new Float32Array(1536).fill(0.1)); } });
    expect(embedded.map(t => t.slice(0, 8)).sort()).toEqual(['chunk 0 ', 'chunk 1 ', 'chunk 2 ', 'chunk 3 ']);
    expect(await vectorIndexes('chats/ledger')).toEqual([0, 1, 2, 3]);
  });

  // FORK: the slice drain settles the grant at the provider boundary — a returned (billed) call stays booked
  // even when the lease is lost before the slice commits.
  test('a lease lost after the provider call returned keeps the reservation booked as spent', async () => {
    await engine.setConfig(PAGE_EMBED_CAP_KEY, String(chunkCost * 10));
    const pageId = await seedLargePage('chats/stolen');
    const { LockStolenError } = await import('../src/core/db-lock.ts');
    const assertOwned = async (tx?: unknown) => { if (tx && embedded.length > 0) throw new LockStolenError('test-lock'); };
    await expect(embedStaleForSource(engine, 'default', { assertOwned, embedFn: async (batch: string[]) => { embedded.push(...batch); return batch.map(() => new Float32Array(1536).fill(0.1)); } }))
      .rejects.toBeInstanceOf(LockStolenError);
    expect(embedded).toHaveLength(5);
    const [row] = await engine.executeRaw<{ spent_usd: number; reserved_usd: number }>(
      'SELECT spent_usd::float8 AS spent_usd, reserved_usd::float8 AS reserved_usd FROM page_embedding_budget WHERE page_id = $1', [pageId]);
    expect(row!.reserved_usd).toBe(0);
    expect(row!.spent_usd).toBeGreaterThan(0);
  });
});

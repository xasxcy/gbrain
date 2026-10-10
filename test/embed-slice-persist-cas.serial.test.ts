import { installFixtureChunks } from './helpers/page-projection.ts';
/**
 * persistStaleSlice installs vectors through the canonical projection
 * installer: ownership fence inside the write transaction, revision/projection
 * CAS, atomic embedding_input_hash, ledger writes in the same transaction, and
 * result-shape validation. The embed function is injected; no provider is used.
 * Gateway configuration is process-global, so this stays a `.serial` file.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { installPageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';
import { persistStaleSlice } from '../src/core/embed-slice-persist.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { StaleChunkRow } from '../src/core/types.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { createHash } from 'node:crypto';

const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';
const SIGNATURE = `${MODEL}:${DIMS}`;
let engine: PGLiteEngine;

const md5 = (text: string) => createHash('md5').update(text).digest('hex');
const vec = (value: number) => new Float32Array(DIMS).fill(value);

beforeAll(async () => {
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' } });
  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: DIMS } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seed(slug: string, count: number): Promise<StaleChunkRow[]> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
  await installFixtureChunks(engine, slug, Array.from({ length: count }, (_, i) => ({
    chunk_index: i, chunk_text: `${slug} body ${i}`, chunk_source: 'compiled_truth' as const, token_count: 4,
  })));
  return engine.executeRaw<StaleChunkRow>(
    `SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source, cc.model, cc.token_count, p.source_id, p.id AS page_id
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = $1 ORDER BY cc.chunk_index`, [slug]);
}

async function chunkState(slug: string) {
  return engine.executeRaw<{ chunk_index: number; has_vector: boolean; input_hash: string | null }>(
    `SELECT cc.chunk_index, (cc.embedding IS NOT NULL) AS has_vector, cc.embedding_input_hash AS input_hash
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = $1 ORDER BY cc.chunk_index`, [slug]);
}

const run = (rows: StaleChunkRow[], embedFn: Parameters<typeof persistStaleSlice>[0]['embedFn'], extra: Partial<Parameters<typeof persistStaleSlice>[0]> = {}) =>
  persistStaleSlice({ engine, rows, embeddingSignature: SIGNATURE, embedFn, slice: { index: 1, total: 1 }, write: () => {}, ...extra });

describe('persistStaleSlice canonical installation', () => {
  test('installs vectors with their embedding_input_hash and clears the chunk ledger rows atomically', async () => {
    const rows = await seed('cas/ok', 2);
    await engine.persistEmbedOutcome({
      sourceId: 'default', pageId: rows[0]!.page_id, slug: 'cas/ok', embeddingSignature: SIGNATURE,
      entries: [{ chunkIndex: 0, chunkHash: md5(rows[0]!.chunk_text), outcome: { failure: { errorClass: 'provider_other', errorFingerprint: 'x' } } }],
    });
    expect(await engine.listEmbedFailures({ sourceId: 'default', slug: 'cas/ok' })).toHaveLength(1);

    const result = await run(rows, async texts => texts.map(() => vec(0.01)));
    expect(result.embedded).toBe(2);
    expect(result.persistFailed).toBe(false);
    const state = await chunkState('cas/ok');
    expect(state.every(row => row.has_vector && typeof row.input_hash === 'string' && row.input_hash.length > 0)).toBe(true);
    expect(await engine.listEmbedFailures({ sourceId: 'default', slug: 'cas/ok' })).toEqual([]);
  });

  test('a title/revision change during the provider call installs nothing and ledgers nothing', async () => {
    const rows = await seed('cas/revision', 2);
    const result = await run(rows, async texts => {
      await engine.putPage('cas/revision', { type: 'note', title: 'a different title', compiled_truth: '# changed' });
      return texts.map(() => vec(0.01));
    });
    expect(result.embedded).toBe(0);
    expect(result.outcome?.staleSkippedChunks).toBe(2);
    expect((await chunkState('cas/revision')).some(row => row.has_vector)).toBe(false);
  });

  test('an ownership failure inside the write transaction rolls back and propagates', async () => {
    const rows = await seed('cas/owner', 2);
    const lost = new Error('lease lost');
    await expect(run(rows, async texts => texts.map(() => vec(0.01)), {
      assertOwned: async () => { throw lost; },
    })).rejects.toBe(lost);
    expect((await chunkState('cas/owner')).some(row => row.has_vector)).toBe(false);
  });

  test('a short result array or wrong-width vector never reaches the database', async () => {
    const rows = await seed('cas/shape', 2);
    const short = await run(rows, async () => []);
    expect(short.embedded).toBe(0);
    expect(short.fatalError ?? short.firstFailureError).toBeDefined();
    const narrow = await run(rows, async texts => texts.map(() => new Float32Array(3).fill(0.01)));
    expect(narrow.embedded).toBe(0);
    expect(narrow.fatalError ?? narrow.firstFailureError).toBeDefined();
    const nonFinite = await run(rows, async texts => texts.map(() => vec(Number.NaN)));
    expect(nonFinite.embedded).toBe(0);
    expect((await chunkState('cas/shape')).some(row => row.has_vector)).toBe(false);
  });

  test('a backed-off ledger row keeps the drain incomplete and the page unstamped', async () => {
    await seed('cas/mixed', 3);
    const result = await embedStaleForSource(engine, 'default', {
      embeddingSignature: SIGNATURE,
      embedFn: async (texts: string[]) => {
        if (texts.some((text: string) => text.endsWith('body 1'))) {
          throw new Error('invalid input: token limit exceeded');
        }
        return texts.map(() => vec(0.01));
      },
    });
    expect(result.embedded).toBe(2);
    expect(result.remaining).toBe(1);
    expect(result.complete).toBe(false);
    const [page] = await engine.executeRaw<{ embedding_signature: string | null }>(
      "SELECT embedding_signature FROM pages WHERE slug='cas/mixed' AND source_id='default'");
    expect(page?.embedding_signature ?? null).toBeNull();
  });

  // A projection re-install keeps a vector only when its recorded embedding_input_hash equals the hash of the
  // input the page would produce now, so this fails if the slice wrote a wrong or missing hash.
  async function reinstallPreservingVectors(slug: string) {
    const snapshot = (await readProjectionSnapshot(engine, slug, 'default', { allowUnsealed: true }))!;
    await installPageProjection(engine, snapshot, snapshot.chunks.map(chunk => ({
      chunk_index: chunk.chunk_index, chunk_text: chunk.chunk_text, chunk_source: chunk.chunk_source, token_count: chunk.token_count ?? undefined,
    })), { seal: true, preserveEmbeddings: true });
  }

  test('the installed embedding_input_hash is the one a later projection re-install accepts', async () => {
    const rows = await seed('cas/hash', 2);
    expect((await run(rows, async texts => texts.map(() => vec(0.01)))).embedded).toBe(2);
    await reinstallPreservingVectors('cas/hash');
    expect((await chunkState('cas/hash')).map(row => row.has_vector)).toEqual([true, true]);
  });

  test('a contextual (per_chunk_synopsis) page keeps slice vectors across a projection re-install', async () => {
    await engine.putPage('cas/synopsis', { type: 'note', title: 'cas/synopsis', compiled_truth: '# cas/synopsis' });
    await engine.updatePageContextualRetrievalState('cas/synopsis', 'default', 'per_chunk_synopsis', 'gen-1');
    const rows = await seed('cas/synopsis', 2);
    expect((await run(rows, async texts => texts.map(() => vec(0.01)))).embedded).toBe(2);
    await reinstallPreservingVectors('cas/synopsis');
    expect((await chunkState('cas/synopsis')).map(row => row.has_vector)).toEqual([true, true]);
  });

  test('control: a vector whose recorded hash is wrong is dropped by the same re-install', async () => {
    const rows = await seed('cas/control', 2);
    await run(rows, async texts => texts.map(() => vec(0.01)));
    await engine.executeRaw(`UPDATE content_chunks SET embedding_input_hash='bogus' WHERE page_id=(SELECT id FROM pages WHERE slug='cas/control')`);
    await reinstallPreservingVectors('cas/control');
    expect((await chunkState('cas/control')).map(row => row.has_vector)).toEqual([false, false]);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';

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
  await engine.putPage('ledger', { type: 'note', title: 'ledger', compiled_truth: '# ledger' });
  await engine.upsertChunks('ledger', [
    { chunk_index: 0, chunk_text: 'good', chunk_source: 'compiled_truth' },
    { chunk_index: 1, chunk_text: 'bad', chunk_source: 'compiled_truth' },
  ]);
});

describe('persistEmbedOutcome', () => {
  test('signature-aware stale list/count/sum exclude only active exact ledger rows', async () => {
    const [{ id: pageId }] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'ledger'`);
    await engine.executeRaw(
      `INSERT INTO embed_failures (source_id, page_id, slug, chunk_index, embedding_signature, chunk_hash, error_class, error_fingerprint, first_seen, last_seen, next_retry_at)
       SELECT 'default', $1::bigint, 'ledger', 1, 'sig', md5(chunk_text), 'provider_timeout', 'x', now(), now(), now() + INTERVAL '1 hour'
         FROM content_chunks WHERE page_id = $1 AND chunk_index = 1`,
      [pageId],
    );
    // Legacy callers do not opt into retry-ledger eligibility.
    expect(await engine.countStaleChunks()).toBe(2);
    // A current signature applies the exact (page, index, signature, hash) ledger gate.
    expect(await engine.countStaleChunks({ signature: 'sig' })).toBe(1);
    expect(await engine.sumStaleChunkChars({ signature: 'sig' })).toBe(4);
    // All four list branches share the same signature-aware eligibility gate.
    expect((await engine.listStaleChunks({ signature: 'sig' })).map(r => r.chunk_index)).toEqual([0]);
    expect((await engine.listStaleChunks({ signature: 'sig', sourceId: 'default' })).map(r => r.chunk_index)).toEqual([0]);
    expect((await engine.listStaleChunks({ signature: 'sig', orderBy: 'updated_desc' })).map(r => r.chunk_index)).toEqual([0]);
    expect((await engine.listStaleChunks({ signature: 'sig', sourceId: 'default', orderBy: 'updated_desc' })).map(r => r.chunk_index)).toEqual([0]);

    // A due (non-quarantined) row is eligible again without deleting history.
    await engine.executeRaw(`UPDATE embed_failures SET next_retry_at = now() - INTERVAL '1 second' WHERE page_id = $1::bigint`, [pageId]);
    expect(await engine.countStaleChunks({ signature: 'sig' })).toBe(2);
    expect((await engine.listStaleChunks({ signature: 'sig' })).map(r => r.chunk_index)).toEqual([0, 1]);
  });

  test('v126 itself covers fresh, upgrade, replay, and verify', async () => {
    const v126 = MIGRATIONS.find((migration) => migration.version === 126);
    expect(v126).toBeDefined();
    // Fresh schema includes the canonical objects.
    await engine.initSchema();
    expect(await engine.executeRaw(`SELECT 1 FROM information_schema.tables WHERE table_name = 'embed_failures'`)).toHaveLength(1);
    expect(await engine.executeRaw(`SELECT 1 FROM pg_indexes WHERE indexname = 'embed_failures_active_idx'`)).toHaveLength(1);
    expect(await v126!.verify!(engine)).toBe(true);

    // Upgrade starts at v125 with the v126 objects absent, then executes the
    // real migration entry and its verify hook. runMigrations always drives
    // the schema to LATEST_VERSION (not just v126), so the assertion here
    // targets v126's own behavior — the migration count pending after v125
    // and v126's verify — instead of hardcoding "latest == 126", which broke
    // (applied:1,current:126 → applied:3,current:128) the moment v127/v128
    // were added.
    const pendingFromV125 = MIGRATIONS.filter((m) => m.version > 125).length;
    await engine.executeRaw(`DROP TABLE embed_failures`);
    await engine.setConfig('version', '125');
    expect(await runMigrations(engine)).toMatchObject({ applied: pendingFromV125, current: LATEST_VERSION });
    expect(await v126!.verify!(engine)).toBe(true);

    // Replay is the migration body again, not a second fresh-schema init.
    await engine.setConfig('version', '125');
    expect(await runMigrations(engine)).toMatchObject({ applied: pendingFromV125, current: LATEST_VERSION });
    expect(await v126!.verify!(engine)).toBe(true);
  });

  test('atomically persists vectors, writes failures, and removes a stale ledger generation', async () => {
    const [{ id: pageId }] = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'ledger' AND source_id = 'default'`,
    );
    await engine.executeRaw(
      `INSERT INTO embed_failures
         (source_id, page_id, slug, chunk_index, embedding_signature, chunk_hash,
          error_class, error_fingerprint, first_seen, last_seen, next_retry_at)
       SELECT 'default', $1::bigint, 'ledger', 0, 'old-signature', md5(chunk_text),
              'provider_other', 'old', now(), now(), now()
         FROM content_chunks WHERE page_id = $1::integer AND chunk_index = 0`,
      [pageId],
    );

    const result = await engine.persistEmbedOutcome({
      sourceId: 'default',
      pageId,
      slug: 'ledger',
      embeddingSignature: 'new-signature',
      entries: [
        { chunkIndex: 0, chunkHash: '755f85c2723bb39381c7379a604160d8', outcome: { vector: new Float32Array(1536) } },
        { chunkIndex: 1, chunkHash: 'bae60998ffe4923b131e3d6e4c19993e', outcome: { failure: { errorClass: 'provider_timeout', errorFingerprint: 'timeout' } } },
      ],
    });

    expect(result).toEqual({ committedChunks: 1, vectorCommittedChunks: 1, staleSkippedChunks: 0, ledgerUpserts: 1, ledgerDeletes: 1 });
    expect(await engine.executeRaw(`SELECT * FROM embed_failures`)).toHaveLength(1);
    expect(await engine.executeRaw(`SELECT 1 FROM content_chunks WHERE page_id = $1 AND chunk_index = 0 AND embedding IS NOT NULL`, [pageId])).toHaveLength(1);
  });

  test('increments a failure streak, quarantines its fifth attempt, and skips rechunked content', async () => {
    const [{ id: pageId }] = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'ledger' AND source_id = 'default'`,
    );
    const failure = {
      sourceId: 'default', pageId, slug: 'ledger', embeddingSignature: 'signature',
      entries: [{
        chunkIndex: 1,
        chunkHash: 'bae60998ffe4923b131e3d6e4c19993e',
        outcome: { failure: { errorClass: 'provider_timeout' as const, errorFingerprint: 'timeout' } },
      }],
    };
    for (let i = 0; i < 5; i++) await engine.persistEmbedOutcome(failure);

    const rows = await engine.executeRaw<{ attempt_count: number; quarantined_at: string | null }>(
      `SELECT attempt_count, quarantined_at FROM embed_failures WHERE page_id = $1::bigint AND chunk_index = 1`,
      [pageId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.attempt_count).toBe(5);
    expect(rows[0]?.quarantined_at).not.toBeNull();

    await engine.executeRaw(`UPDATE content_chunks SET chunk_text = 'rechunked' WHERE page_id = $1 AND chunk_index = 1`, [pageId]);
    const skipped = await engine.persistEmbedOutcome(failure);
    expect(skipped).toEqual({ committedChunks: 0, vectorCommittedChunks: 0, staleSkippedChunks: 1, staleSkippedChunkIndexes: [1], ledgerUpserts: 0, ledgerDeletes: 0 });
    expect(await engine.executeRaw(`SELECT 1 FROM embed_failures WHERE page_id = $1::bigint AND chunk_index = 1`, [pageId])).toHaveLength(1);

    await engine.upsertChunks('ledger', [
      { chunk_index: 0, chunk_text: 'good', chunk_source: 'compiled_truth' },
      { chunk_index: 1, chunk_text: 'rechunked', chunk_source: 'compiled_truth' },
    ]);
    expect(await engine.executeRaw(`SELECT 1 FROM embed_failures WHERE page_id = $1::bigint AND chunk_index = 1`, [pageId])).toHaveLength(0);
  });

  test('source-scoped signature invalidation deletes only that source ledger in its transaction', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{}'::jsonb)`);
    await engine.putPage('other-ledger', { type: 'note', title: 'other', compiled_truth: '# other' }, { sourceId: 'other' });
    await engine.upsertChunks('other-ledger', [{ chunk_index: 0, chunk_text: 'other', chunk_source: 'compiled_truth' }], { sourceId: 'other' });
    const [{ id: defaultPageId }] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'ledger'`);
    const [{ id: otherPageId }] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'other-ledger' AND source_id = 'other'`);
    await engine.executeRaw(
      `INSERT INTO embed_failures (source_id, page_id, slug, chunk_index, embedding_signature, chunk_hash, error_class, error_fingerprint, first_seen, last_seen, next_retry_at)
       VALUES ('default', $1::bigint, 'ledger', 0, 'old', 'hash', 'provider_other', 'x', now(), now(), now()),
              ('other', $2::bigint, 'other-ledger', 0, 'old', 'hash', 'provider_other', 'x', now(), now(), now())`,
      [defaultPageId, otherPageId],
    );

    await engine.invalidateStaleSignatureEmbeddings({ signature: 'current', sourceId: 'default' });
    expect(await engine.executeRaw(`SELECT 1 FROM embed_failures WHERE source_id = 'default'`)).toHaveLength(0);
    expect(await engine.executeRaw(`SELECT 1 FROM embed_failures WHERE source_id = 'other'`)).toHaveLength(1);
  });

  test('fresh ledger schema has FK cascade', async () => {
    const [{ id: pageId }] = await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'ledger'`);
    await engine.executeRaw(
      `INSERT INTO embed_failures (source_id, page_id, slug, chunk_index, embedding_signature, chunk_hash, error_class, error_fingerprint, first_seen, last_seen, next_retry_at)
       VALUES ('default', $1::bigint, 'ledger', 0, 'signature', 'hash', 'provider_other', 'x', now(), now(), now())`,
      [pageId],
    );
    await engine.executeRaw(`DELETE FROM pages WHERE id = $1`, [pageId]);
    expect(await engine.executeRaw(`SELECT 1 FROM embed_failures WHERE page_id = $1::bigint`, [pageId])).toHaveLength(0);
  });
});

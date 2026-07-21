/**
 * Regression: batch-1 (c052e015) wrapped upsertChunks in this.transaction().
 * The sync import path already runs inside an outer transaction, so the inner
 * call re-entered transaction() with `this.sql` bound to the tx handle — which
 * has no .begin — and threw "this.sql.begin is not a function", making sync
 * skip every changed file.
 *
 * Contract: transaction() must be re-entrant. Postgres has no true nested
 * transactions; re-entering must reuse the open transaction rather than
 * attempting to open a second one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const DATABASE_URL = process.env.DATABASE_URL;

describe('transaction() re-entrancy (PGLite)', () => {
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
    await engine.putPage('reentrant', { type: 'note', title: 'reentrant', compiled_truth: '# reentrant' });
  });

  test('upsertChunks succeeds when already inside an open transaction (sync import shape)', async () => {
    await engine.transaction(async (tx) => {
      await tx.upsertChunks('reentrant', [
        { chunk_index: 0, chunk_text: 'nested-write', chunk_source: 'compiled_truth' },
      ]);
    });

    const rows = await engine.executeRaw<{ chunk_text: string }>(
      `SELECT chunk_text FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = 'reentrant'`,
    );
    expect(rows.map(r => r.chunk_text)).toEqual(['nested-write']);
  });

  test('persistEmbedOutcome succeeds when already inside an open transaction', async () => {
    await engine.upsertChunks('reentrant', [
      { chunk_index: 0, chunk_text: 'to-embed', chunk_source: 'compiled_truth' },
    ]);
    const [{ id: pageId }] = await engine.executeRaw<{ id: number }>(
      `SELECT id FROM pages WHERE slug = 'reentrant'`,
    );

    await engine.transaction(async (tx) => {
      await tx.persistEmbedOutcome({
        sourceId: 'default',
        pageId,
        slug: 'reentrant',
        signature: 'sig',
        entries: [],
      } as never);
    });
    // Reaching here without a thrown TypeError is the assertion.
    expect(true).toBe(true);
  });

  test('writes inside a re-entered transaction roll back with the outer transaction', async () => {
    await expect(
      engine.transaction(async (tx) => {
        await tx.upsertChunks('reentrant', [
          { chunk_index: 0, chunk_text: 'rolled-back', chunk_source: 'compiled_truth' },
        ]);
        throw new Error('force-rollback');
      }),
    ).rejects.toThrow('force-rollback');

    const rows = await engine.executeRaw<{ n: string }>(
      `SELECT count(*)::text AS n FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = 'reentrant'`,
    );
    expect(rows[0]!.n).toBe('0');
  });
});

const d = DATABASE_URL ? describe : describe.skip;

d('transaction() re-entrancy (Postgres)', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! } as never);
    await engine.initSchema();
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path)
      VALUES ('reentrant-src', 'reentrant-src', '/tmp/reentrant-src')
      ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('reentrant/pg', {
      type: 'note', title: 'reentrant', compiled_truth: '# reentrant',
    }, { sourceId: 'reentrant-src' });
  });

  afterAll(async () => {
    await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'reentrant-src'`).catch(() => {});
    await engine.executeRaw(`DELETE FROM sources WHERE id = 'reentrant-src'`).catch(() => {});
    await engine.disconnect();
  });

  test('upsertChunks succeeds when already inside an open transaction', async () => {
    await engine.transaction(async (tx) => {
      await tx.upsertChunks('reentrant/pg', [
        { chunk_index: 0, chunk_text: 'nested-write-pg', chunk_source: 'compiled_truth' },
      ], { sourceId: 'reentrant-src' });
    });

    const rows = await engine.executeRaw<{ chunk_text: string }>(
      `SELECT chunk_text FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = 'reentrant/pg' AND p.source_id = 'reentrant-src'`,
    );
    expect(rows.map(r => r.chunk_text)).toEqual(['nested-write-pg']);
  });
});

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

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
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ('other', 'other', '/tmp/other')
     ON CONFLICT (id) DO NOTHING`,
  );
  await engine.putPage('summary/default', { type: 'note', title: 'default', compiled_truth: '# default' });
  await engine.putPage('summary/other', { type: 'note', title: 'other', compiled_truth: '# other' }, { sourceId: 'other' });
  await engine.upsertChunks('summary/default', [
    { chunk_index: 0, chunk_text: 'eligible', chunk_source: 'compiled_truth' },
    { chunk_index: 1, chunk_text: 'backoff', chunk_source: 'compiled_truth' },
    { chunk_index: 2, chunk_text: 'quarantined', chunk_source: 'compiled_truth' },
    { chunk_index: 3, chunk_text: 'retry-due', chunk_source: 'compiled_truth' },
  ]);
  await engine.upsertChunks('summary/other', [
    { chunk_index: 0, chunk_text: 'other-source', chunk_source: 'compiled_truth' },
  ], { sourceId: 'other' });

  const rows = await engine.executeRaw<{ page_id: number; source_id: string; chunk_index: number; chunk_hash: string }>(
    `SELECT cc.page_id, p.source_id, cc.chunk_index, md5(cc.chunk_text) AS chunk_hash
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE p.slug LIKE 'summary/%'
      ORDER BY p.source_id, cc.chunk_index`,
  );
  const now = new Date().toISOString();
  for (const row of rows.filter((row) => row.source_id === 'default' && row.chunk_index > 0)) {
    const future = row.chunk_index === 3 ? new Date(Date.now() - 60_000).toISOString() : new Date(Date.now() + 3_600_000).toISOString();
    await engine.executeRaw(
      `INSERT INTO embed_failures
        (source_id, page_id, slug, chunk_index, embedding_signature, chunk_hash, error_class, error_fingerprint, first_seen, last_seen, next_retry_at, quarantined_at, quarantine_reason)
       VALUES ($1, $2, 'summary/default', $3, 'test:model:1536', $4, $5, 'fp', $6, $6, $7, $8, $9)`,
      [
        row.source_id,
        row.page_id,
        row.chunk_index,
        row.chunk_hash,
        row.chunk_index === 2 ? 'provider_conn' : 'provider_timeout',
        now,
        future,
        row.chunk_index === 2 ? now : null,
        row.chunk_index === 2 ? 'provider_conn' : null,
      ],
    );
  }
});

describe('embed failure summary', () => {
  test('shares stale eligibility while reporting all four failure states and source-scoped details', async () => {
    const summary = await engine.getEmbedFailureSummary({ sourceId: 'default', signature: 'test:model:1536' });

    expect(summary.counts).toEqual({
      total_null: 4,
      eligible_now: 2,
      backoff_deferred: 1,
      quarantined: 1,
    });
    expect(summary.by_error_class).toEqual([
      { error_class: 'provider_timeout', count: 2 },
      { error_class: 'provider_conn', count: 1 },
    ]);
    expect(summary.quarantined_top).toEqual([
      { slug: 'summary/default', chunk_index: 2, error_class: 'provider_conn', attempt_count: 1 },
    ]);
  });

  test('uses the active vector plane and excludes soft-deleted pages in every count', async () => {
    await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN embedding_summary_test vector(1536)');
    await engine.setConfig('embedding_columns', JSON.stringify({
      embedding_summary_test: { type: 'vector', dimensions: 1536, provider: 'test:model' },
    }));
    await engine.setConfig('search_embedding_column', 'embedding_summary_test');
    try {
      await engine.executeRaw(
        `UPDATE content_chunks SET embedding_summary_test='[${Array(1536).fill('0.01').join(',')}]'::vector`,
      );
      await engine.executeRaw(
        `UPDATE content_chunks SET embedding_summary_test=NULL
          WHERE page_id=(SELECT id FROM pages WHERE slug='summary/default') AND chunk_index=0`,
      );
      expect((await engine.getEmbedFailureSummary({ sourceId: 'default', signature: 'test:model:1536' })).counts).toEqual({
        total_null: 1, eligible_now: 1, backoff_deferred: 0, quarantined: 0,
      });

      await engine.softDeletePage('summary/default', { sourceId: 'default' });
      expect((await engine.getEmbedFailureSummary({ sourceId: 'default', signature: 'test:model:1536' })).counts).toEqual({
        total_null: 0, eligible_now: 0, backoff_deferred: 0, quarantined: 0,
      });
    } finally {
      await engine.executeRaw("DELETE FROM config WHERE key IN ('embedding_columns', 'search_embedding_column')");
      await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN embedding_summary_test');
    }
  });
});

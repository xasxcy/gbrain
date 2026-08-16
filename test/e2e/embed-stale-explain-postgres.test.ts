/**
 * Postgres-only structural acceptance for the retry-ledger stale selectors.
 * PGLite has no stable planner contract; its functional keyset coverage lives
 * in test/pglite-engine.test.ts "listStaleChunks: cursor pagination across
 * page boundaries" and "listStaleChunks: page split across batches".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const d = DATABASE_URL ? describe : describe.skip;

function planText(value: unknown): string {
  return JSON.stringify(value);
}

d('Postgres EXPLAIN — stale eligibility branches', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    // Connects directly instead of going through setupDB(), so it owns the
    // production guard itself: initSchema + the fixture writes below run
    // against whatever DATABASE_URL points at.
    assertSafeE2eDatabaseUrl(DATABASE_URL!);
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! } as never);
    await engine.initSchema();
    await engine.executeRaw(`SET enable_seqscan = off`);
    await engine.executeRaw(`INSERT INTO sources (id, name, local_path)
      VALUES ('explain-source', 'explain-source', '/tmp/explain-source')
      ON CONFLICT (id) DO NOTHING`);
    await engine.putPage('explain/stale', {
      type: 'note', title: 'stale', compiled_truth: '# stale',
    }, { sourceId: 'explain-source' });
    await engine.upsertChunks('explain/stale', Array.from({ length: 64 }, (_, chunk_index) => ({
      chunk_index,
      chunk_text: `stale ${chunk_index}`,
      chunk_source: 'compiled_truth',
    })), { sourceId: 'explain-source' });
    const row = await engine.executeRaw<{ page_id: number; chunk_hash: string }>(
      `SELECT cc.page_id, md5(cc.chunk_text) AS chunk_hash
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.source_id = 'explain-source' AND p.slug = 'explain/stale' AND cc.chunk_index = 1`,
    );
    await engine.executeRaw(
      `INSERT INTO embed_failures
        (source_id, page_id, slug, chunk_index, embedding_signature, chunk_hash, error_class, error_fingerprint, first_seen, last_seen, next_retry_at)
       VALUES ('explain-source', $1, 'explain/stale', 1, 'explain:model:1536', $2, 'provider_timeout', 'fp', now(), now(), now() + interval '1 hour')
       ON CONFLICT DO NOTHING`,
      [row[0]!.page_id, row[0]!.chunk_hash],
    );
  });

  afterAll(async () => {
    if (!engine) return;
    await engine.executeRaw(`RESET enable_seqscan`);
    await engine.executeRaw(`DELETE FROM pages WHERE source_id = 'explain-source' AND slug = 'explain/stale'`);
    await engine.disconnect();
  });

  test('four branches preserve the stale partial-index keyset and active-ledger index lookup', async () => {
    // These are the production selector builders, deliberately reached from
    // the engine instance rather than duplicated predicates in this test.
    const production = engine as unknown as {
      buildStaleChunkWhere(opts: { sourceId: string }): { where: string; params: unknown[] };
      buildListStaleChunkWhere(opts: { sourceId: string; signature?: string }): { where: string; params: unknown[] };
    };
    const total = production.buildStaleChunkWhere({ sourceId: 'explain-source' });
    const eligible = production.buildListStaleChunkWhere({ sourceId: 'explain-source', signature: 'explain:model:1536' });
    const base = production.buildListStaleChunkWhere({ sourceId: 'explain-source' });
    const signatureParam = base.params.length + 1;
    const exact = `l.source_id = p.source_id
      AND l.page_id = cc.page_id
      AND l.chunk_index = cc.chunk_index
      AND l.embedding_signature = $${signatureParam}
      AND l.chunk_hash = md5(cc.chunk_text)`;
    const queries = {
      total_null: { sql: `SELECT cc.page_id, cc.chunk_index FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE ${total.where} ORDER BY cc.page_id, cc.chunk_index LIMIT 16`, params: total.params },
      eligible_now: { sql: `SELECT cc.page_id, cc.chunk_index FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE ${eligible.where} ORDER BY cc.page_id, cc.chunk_index LIMIT 16`, params: eligible.params },
      backoff_deferred: { sql: `SELECT cc.page_id, cc.chunk_index FROM content_chunks cc JOIN pages p ON p.id = cc.page_id JOIN embed_failures l ON ${exact} WHERE ${base.where} AND l.quarantined_at IS NULL AND l.next_retry_at > now() ORDER BY cc.page_id, cc.chunk_index LIMIT 16`, params: [...base.params, 'explain:model:1536'] },
      quarantined: { sql: `SELECT cc.page_id, cc.chunk_index FROM content_chunks cc JOIN pages p ON p.id = cc.page_id JOIN embed_failures l ON ${exact} WHERE ${base.where} AND l.quarantined_at IS NOT NULL ORDER BY cc.page_id, cc.chunk_index LIMIT 16`, params: [...base.params, 'explain:model:1536'] },
    };

    await engine.getEmbedFailureSummary({ sourceId: 'explain-source', signature: 'explain:model:1536' });
    const plans = await Promise.all(Object.values(queries).map(async ({ sql, params }) => {
      const rows = await engine.executeRaw<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON) ${sql}`, params);
      return planText(rows[0]?.['QUERY PLAN']);
    }));
    for (const plan of plans) {
      // Planner may pick either stale partial index (content_chunks_stale_idx
      // keyset index or the older idx_chunks_embedding_null); acceptance is
      // "uses a stale partial index, not a full scan of content_chunks".
      expect(/content_chunks_stale_idx|idx_chunks_embedding_null/.test(plan)).toBe(true);
      expect(plan).toContain('Limit');
    }
    for (const plan of plans.slice(1)) {
      // Planner may satisfy the ledger lookup via embed_failures_active_idx
      // or the primary key (both index the anti-join key prefix); acceptance
      // is "indexed access on embed_failures, not a sequential scan".
      expect(/embed_failures_active_idx|embed_failures_pkey/.test(plan)).toBe(true);
      expect(plan).not.toMatch(/"Node Type":"Seq Scan","Parent Relationship":"[^"]*","Parallel Aware":(true|false),"Async Capable":(true|false),"Relation Name":"embed_failures"/);
    }
  });
});

if (!DATABASE_URL) {
  console.log('[embed-stale-explain-postgres] DATABASE_URL not set — skipped Postgres EXPLAIN acceptance.');
}

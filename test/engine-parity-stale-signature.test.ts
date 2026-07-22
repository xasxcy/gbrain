/**
 * FORK-FIX (2026-07-22, batch 2, item 1): Postgres's `listStaleChunks`
 * silently dropped the signature-aware dispatch to
 * `listSignatureEligibleStaleChunks` during the upstream RLS
 * transaction-wrapper refactor — `embed-stale.ts` passes `signature`, but
 * the Postgres path fell through to the plain NULL-embedding cursor,
 * bypassing the `embed_failures` eligibility/backoff/quarantine gate that
 * PGLite still applies. This test pins engine parity for the three chunk
 * states the eligibility gate distinguishes: an in-backoff failure record
 * (next_retry_at in the future), a quarantined failure record
 * (quarantined_at set), and a plain not-yet-embedded chunk with no failure
 * record at all (eligible). `countStaleChunks`/`sumStaleChunkChars` are
 * covered too since they share the same `appendEmbedFailureEligibility`
 * helper as `listStaleChunks`.
 *
 * PGLite-half always runs (hermetic). Postgres-half runs only when
 * `DATABASE_URL` is set — same gate as the other engine-parity tests
 * (see test/phantom-redirect-engine-parity.test.ts).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let pglite: PGLiteEngine;
let pg: PostgresEngine | null = null;

beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();

  if (process.env.DATABASE_URL) {
    pg = new PostgresEngine();
    await pg.connect({ database_url: process.env.DATABASE_URL });
    await pg.initSchema();
  }
}, 60_000);

afterAll(async () => {
  await pglite.disconnect();
  if (pg) await pg.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(pglite);
  if (pg) {
    await pg.executeRaw('DELETE FROM embed_failures');
    await pg.executeRaw('DELETE FROM content_chunks');
    await pg.executeRaw('DELETE FROM pages');
  }
});

/**
 * Seeds a page with 3 not-yet-embedded chunks:
 *   0 — plain, no embed_failures row (eligible)
 *   1 — embed_failures row with next_retry_at in the FUTURE, not quarantined
 *       (in-backoff, ineligible)
 *   2 — embed_failures row with quarantined_at SET (quarantined, ineligible)
 * All under the same `sig` embedding_signature ledger entries.
 */
async function seedThreeChunkStates(engine: BrainEngine, slug: string): Promise<number> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
  await engine.upsertChunks(slug, [
    { chunk_index: 0, chunk_text: 'eligible chunk text', chunk_source: 'compiled_truth' },
    { chunk_index: 1, chunk_text: 'backoff chunk text', chunk_source: 'compiled_truth' },
    { chunk_index: 2, chunk_text: 'quarantined chunk text', chunk_source: 'compiled_truth' },
  ]);
  const [{ id: pageId }] = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'`,
    [slug],
  );
  // chunk_index 1 — in backoff: next_retry_at 1 hour in the future, not quarantined.
  await engine.executeRaw(
    `INSERT INTO embed_failures
       (source_id, page_id, slug, chunk_index, embedding_signature, chunk_hash,
        error_class, error_fingerprint, first_seen, last_seen, next_retry_at)
     SELECT 'default', $1::bigint, $2, 1, 'sig', md5(chunk_text),
            'provider_timeout', 'x', now(), now(), now() + INTERVAL '1 hour'
       FROM content_chunks WHERE page_id = $1 AND chunk_index = 1`,
    [pageId, slug],
  );
  // chunk_index 2 — quarantined (quarantined_at set; next_retry_at in the
  // past would otherwise look "due", but quarantined_at alone must gate it).
  await engine.executeRaw(
    `INSERT INTO embed_failures
       (source_id, page_id, slug, chunk_index, embedding_signature, chunk_hash,
        error_class, error_fingerprint, first_seen, last_seen, next_retry_at,
        quarantined_at, quarantine_reason)
     SELECT 'default', $1::bigint, $2, 2, 'sig', md5(chunk_text),
            'provider_other', 'y', now(), now(), now() - INTERVAL '1 hour',
            now(), 'too many failures'
       FROM content_chunks WHERE page_id = $1 AND chunk_index = 2`,
    [pageId, slug],
  );
  return pageId;
}

describe.each([
  ['PGLite', () => pglite] as const,
])('listStaleChunks/countStaleChunks/sumStaleChunkChars — signature eligibility (%s)', (name, getEngine) => {
  test(`${name}: only the plain chunk (index 0) is signature-eligible`, async () => {
    const engine = getEngine();
    await seedThreeChunkStates(engine, 'parity/stale-sig');

    expect(await engine.countStaleChunks({ signature: 'sig' })).toBe(1);

    const listed = await engine.listStaleChunks({ signature: 'sig' });
    expect(listed.map(r => r.chunk_index)).toEqual([0]);

    const listedSourceScoped = await engine.listStaleChunks({ signature: 'sig', sourceId: 'default' });
    expect(listedSourceScoped.map(r => r.chunk_index)).toEqual([0]);

    const listedRecent = await engine.listStaleChunks({ signature: 'sig', orderBy: 'updated_desc' });
    expect(listedRecent.map(r => r.chunk_index)).toEqual([0]);

    // Legacy callers (no signature) ignore the ledger entirely — all 3
    // NULL-embedding chunks are "stale".
    expect(await engine.countStaleChunks()).toBe(3);
    expect((await engine.listStaleChunks()).map(r => r.chunk_index).sort()).toEqual([0, 1, 2]);
  });
});

// Postgres-half — same assertions, runs only when DATABASE_URL is set.
describe('listStaleChunks/countStaleChunks/sumStaleChunkChars — signature eligibility (Postgres)', () => {
  test('Postgres: only the plain chunk (index 0) is signature-eligible', async () => {
    if (!pg) {
      console.warn('[engine-parity-stale-signature] DATABASE_URL not set — skipping Postgres half');
      return;
    }
    await seedThreeChunkStates(pg, 'parity/stale-sig');

    expect(await pg.countStaleChunks({ signature: 'sig' })).toBe(1);

    const listed = await pg.listStaleChunks({ signature: 'sig' });
    expect(listed.map(r => r.chunk_index)).toEqual([0]);

    const listedSourceScoped = await pg.listStaleChunks({ signature: 'sig', sourceId: 'default' });
    expect(listedSourceScoped.map(r => r.chunk_index)).toEqual([0]);

    const listedRecent = await pg.listStaleChunks({ signature: 'sig', orderBy: 'updated_desc' });
    expect(listedRecent.map(r => r.chunk_index)).toEqual([0]);

    // Legacy callers (no signature) ignore the ledger entirely — all 3
    // NULL-embedding chunks are "stale". This is the exact regression:
    // pre-fix, Postgres's listStaleChunks({signature}) returned this same
    // unfiltered [0,1,2] set instead of respecting the ledger.
    expect(await pg.countStaleChunks()).toBe(3);
    expect((await pg.listStaleChunks()).map(r => r.chunk_index).sort()).toEqual([0, 1, 2]);
  });

  test('Postgres parity with PGLite on the identical fixture', async () => {
    if (!pg) {
      console.warn('[engine-parity-stale-signature] DATABASE_URL not set — skipping Postgres half');
      return;
    }
    await seedThreeChunkStates(pglite, 'parity/stale-sig-cmp');
    await seedThreeChunkStates(pg, 'parity/stale-sig-cmp');

    const pgliteListed = (await pglite.listStaleChunks({ signature: 'sig' })).map(r => r.chunk_index);
    const pgListed = (await pg.listStaleChunks({ signature: 'sig' })).map(r => r.chunk_index);
    expect(pgListed).toEqual(pgliteListed);

    const pgliteCount = await pglite.countStaleChunks({ signature: 'sig' });
    const pgCount = await pg.countStaleChunks({ signature: 'sig' });
    expect(pgCount).toBe(pgliteCount);

    const pgliteSum = await pglite.sumStaleChunkChars({ signature: 'sig' });
    const pgSum = await pg.sumStaleChunkChars({ signature: 'sig' });
    expect(pgSum).toBe(pgliteSum);
  });
});

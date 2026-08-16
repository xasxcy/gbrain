/**
 * FORK-FIX (2026-07-22, batch 2, item 1): Postgres's `listStaleChunks`
 * silently dropped the signature-aware dispatch to
 * `listSignatureEligibleStaleChunks` during the upstream RLS
 * transaction-wrapper refactor — `embed-stale.ts` passes `signature`, but
 * the Postgres path fell through to the plain NULL-embedding cursor,
 * bypassing the `embed_failures` eligibility/backoff/quarantine gate that
 * PGLite still applies. This test pins engine parity for the four chunk
 * states the eligibility gate distinguishes: an in-backoff failure record
 * (next_retry_at in the future), a quarantined failure record
 * (quarantined_at set), a plain not-yet-embedded chunk with no failure
 * record at all (eligible), and a signature-mismatch failure record — one
 * that LOOKS in-backoff but is stamped with a DIFFERENT (prior-generation)
 * embedding_signature than the one queried, which must not block the
 * current generation's re-embed attempt (also eligible). `countStaleChunks`/
 * `sumStaleChunkChars` are covered too since they share the same
 * `appendEmbedFailureEligibility` helper as `listStaleChunks`.
 *
 * E2E lane (moved 2026-07-22, batch 2 FIX2 T5): this file requires a real
 * Postgres to exercise its Postgres-half assertions and parity check. Prior
 * to this move it lived in the root unit shard, where the two Postgres
 * cases silently warn+return "pass" whenever `DATABASE_URL` is unset — a
 * false-green protection net for exactly the regression this file exists to
 * catch. It is wired into the e2e workflow's Tier 1 job, which provisions
 * pgvector and hard-fails on a missing DATABASE_URL: moving a guard out of
 * the unit shard only helps if something in CI actually runs it there.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import type { BrainEngine } from '../../src/core/engine.ts';

let pglite: PGLiteEngine;
let pg: PostgresEngine | null = null;

beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();

  if (process.env.DATABASE_URL) {
    // Connects directly instead of going through setupDB(), so it owns the
    // production guard itself: initSchema + the destructive fixtures below
    // run against whatever DATABASE_URL points at.
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL);
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
 * Seeds a page with 4 not-yet-embedded chunks:
 *   0 — plain, no embed_failures row (eligible)
 *   1 — embed_failures row with next_retry_at in the FUTURE, not quarantined,
 *       under the SAME signature under test (in-backoff, ineligible)
 *   2 — embed_failures row with quarantined_at SET, under the SAME signature
 *       under test (quarantined, ineligible)
 *   3 — embed_failures row that LOOKS like an in-backoff record (next_retry_at
 *       in the future, not quarantined) but is stamped with a DIFFERENT
 *       embedding_signature ('mismatch-sig') than the one queried ('sig')
 *       (signature mismatch — eligible: appendEmbedFailureEligibility's
 *       NOT EXISTS anti-join only matches ledger rows whose
 *       embedding_signature equals the query's signature, so a ledger entry
 *       from a PRIOR generation must not block the current generation's
 *       re-embed attempt)
 */
async function seedFourChunkStates(engine: BrainEngine, slug: string): Promise<number> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
  await engine.upsertChunks(slug, [
    { chunk_index: 0, chunk_text: 'eligible chunk text', chunk_source: 'compiled_truth' },
    { chunk_index: 1, chunk_text: 'backoff chunk text', chunk_source: 'compiled_truth' },
    { chunk_index: 2, chunk_text: 'quarantined chunk text', chunk_source: 'compiled_truth' },
    { chunk_index: 3, chunk_text: 'mismatch chunk text', chunk_source: 'compiled_truth' },
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
  // chunk_index 3 — signature mismatch: an in-backoff-shaped ledger row
  // stamped under a PRIOR generation's signature ('mismatch-sig'), queried
  // under 'sig'. Must NOT block eligibility for the current signature.
  await engine.executeRaw(
    `INSERT INTO embed_failures
       (source_id, page_id, slug, chunk_index, embedding_signature, chunk_hash,
        error_class, error_fingerprint, first_seen, last_seen, next_retry_at)
     SELECT 'default', $1::bigint, $2, 3, 'mismatch-sig', md5(chunk_text),
            'provider_timeout', 'z', now(), now(), now() + INTERVAL '1 hour'
       FROM content_chunks WHERE page_id = $1 AND chunk_index = 3`,
    [pageId, slug],
  );
  return pageId;
}

describe.each([
  ['PGLite', () => pglite] as const,
])('listStaleChunks/countStaleChunks/sumStaleChunkChars — signature eligibility (%s)', (name, getEngine) => {
  test(`${name}: only the plain + signature-mismatch chunks (index 0, 3) are signature-eligible`, async () => {
    const engine = getEngine();
    await seedFourChunkStates(engine, 'parity/stale-sig');

    expect(await engine.countStaleChunks({ signature: 'sig' })).toBe(2);

    const listed = await engine.listStaleChunks({ signature: 'sig' });
    expect(listed.map(r => r.chunk_index).sort()).toEqual([0, 3]);

    const listedSourceScoped = await engine.listStaleChunks({ signature: 'sig', sourceId: 'default' });
    expect(listedSourceScoped.map(r => r.chunk_index).sort()).toEqual([0, 3]);

    const listedRecent = await engine.listStaleChunks({ signature: 'sig', orderBy: 'updated_desc' });
    expect(listedRecent.map(r => r.chunk_index).sort()).toEqual([0, 3]);

    // Legacy callers (no signature) ignore the ledger entirely — all 4
    // NULL-embedding chunks are "stale".
    expect(await engine.countStaleChunks()).toBe(4);
    expect((await engine.listStaleChunks()).map(r => r.chunk_index).sort()).toEqual([0, 1, 2, 3]);
  });
});

// Postgres-half — same assertions. Gated at the SUITE level, not inside each
// case: a per-case `if (!pg) return` reports as a PASS, so a runner without
// DATABASE_URL produced a green tick for the exact Postgres branch this file
// exists to guard. `skipIf` reports skipped, which is the truth. The e2e
// workflow's Tier 1 job hard-fails when DATABASE_URL is missing, so on CI
// these always run.
describe.skipIf(!process.env.DATABASE_URL)('listStaleChunks/countStaleChunks/sumStaleChunkChars — signature eligibility (Postgres)', () => {
  test('Postgres: only the plain + signature-mismatch chunks (index 0, 3) are signature-eligible', async () => {
    await seedFourChunkStates(pg!, 'parity/stale-sig');

    expect(await pg!.countStaleChunks({ signature: 'sig' })).toBe(2);

    const listed = await pg!.listStaleChunks({ signature: 'sig' });
    expect(listed.map(r => r.chunk_index).sort()).toEqual([0, 3]);

    const listedSourceScoped = await pg!.listStaleChunks({ signature: 'sig', sourceId: 'default' });
    expect(listedSourceScoped.map(r => r.chunk_index).sort()).toEqual([0, 3]);

    const listedRecent = await pg!.listStaleChunks({ signature: 'sig', orderBy: 'updated_desc' });
    expect(listedRecent.map(r => r.chunk_index).sort()).toEqual([0, 3]);

    // Legacy callers (no signature) ignore the ledger entirely — all 4
    // NULL-embedding chunks are "stale". This is the exact regression:
    // pre-fix, Postgres's listStaleChunks({signature}) returned this same
    // unfiltered [0,1,2,3] set instead of respecting the ledger.
    expect(await pg!.countStaleChunks()).toBe(4);
    expect((await pg!.listStaleChunks()).map(r => r.chunk_index).sort()).toEqual([0, 1, 2, 3]);
  });

  test('Postgres parity with PGLite on the identical fixture', async () => {
    await seedFourChunkStates(pglite, 'parity/stale-sig-cmp');
    await seedFourChunkStates(pg!, 'parity/stale-sig-cmp');

    const pgliteListed = (await pglite.listStaleChunks({ signature: 'sig' })).map(r => r.chunk_index);
    const pgListed = (await pg!.listStaleChunks({ signature: 'sig' })).map(r => r.chunk_index);
    expect(pgListed).toEqual(pgliteListed);

    const pgliteCount = await pglite.countStaleChunks({ signature: 'sig' });
    const pgCount = await pg!.countStaleChunks({ signature: 'sig' });
    expect(pgCount).toBe(pgliteCount);

    const pgliteSum = await pglite.sumStaleChunkChars({ signature: 'sig' });
    const pgSum = await pg!.sumStaleChunkChars({ signature: 'sig' });
    expect(pgSum).toBe(pgliteSum);
  });
});

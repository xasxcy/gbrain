/**
 * FORK-ONLY E2E. The fork's own migration counter on real Postgres: adoption of a brain the last shared-counter layout
 * stamped 275 (no fork migration re-runs), and the drift self-heal re-creating the PGroonga index an upstream column
 * rewrite would drop.
 *
 * Run: DATABASE_URL=postgresql://... bun run test:e2e test/e2e/fork-schema-counter-postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { FORK_MIGRATIONS, LATEST_VERSION, runMigrations } from '../../src/core/migrate.ts';
import { FORK_COUNTER_KEY, FORK_LATEST_VERSION, LEGACY_FORK_MAX, LEGACY_UPSTREAM_MAX } from '../../src/core/fork-migrations.ts';
import type { Migration } from '../../src/core/migrate.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const PGROONGA_INDEX = `SELECT to_regclass('public.idx_content_chunks_pgroonga') IS NOT NULL AS present`;

describe.skipIf(!DATABASE_URL)('fork schema counter (Postgres E2E)', () => {
  let engine: PostgresEngine;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const fixture = await isolatedPersistencePostgres(DATABASE_URL!, 'module');
    engine = fixture.engine;
    close = fixture.close;
  }, 60_000);

  afterAll(async () => {
    await close?.();
  });

  test('a brain stamped 275 adopts (260, 15) and re-runs no fork migration', async () => {
    const ran: number[] = [];
    const forkMigrations: Migration[] = FORK_MIGRATIONS.map(m => ({
      version: m.version, name: m.name, idempotent: true, sql: '', handler: async () => { ran.push(m.version); },
    }));
    await engine.setConfig('version', String(LEGACY_FORK_MAX));
    await engine.executeRaw(`DELETE FROM config WHERE key = '${FORK_COUNTER_KEY}'`);

    const result = await runMigrations(engine, { forkMigrations });

    expect(ran).toEqual([]);
    expect(result.current).toBe(LATEST_VERSION);
    expect(await engine.getConfig(FORK_COUNTER_KEY)).toBe(String(LEGACY_FORK_MAX - LEGACY_UPSTREAM_MAX));
    expect(await engine.getConfig(FORK_COUNTER_KEY)).toBe(String(FORK_LATEST_VERSION));
  }, 120_000);

  test('the PGroonga index an upstream rewrite dropped is re-created on the next run', async () => {
    expect(await engine.executeRaw(PGROONGA_INDEX)).toEqual([{ present: true }]);
    await engine.executeRaw('DROP INDEX public.idx_content_chunks_pgroonga');
    expect(await engine.executeRaw(PGROONGA_INDEX)).toEqual([{ present: false }]);

    await runMigrations(engine);

    expect(await engine.executeRaw(PGROONGA_INDEX)).toEqual([{ present: true }]);
    expect(await engine.getConfig(FORK_COUNTER_KEY)).toBe(String(FORK_LATEST_VERSION));
  }, 120_000);
});

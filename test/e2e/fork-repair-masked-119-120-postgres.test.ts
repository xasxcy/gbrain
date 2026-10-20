/**
 * FORK-ONLY E2E. v275 on real Postgres: restores the op_checkpoints CHECK and the page_links security_invoker
 * option on a brain stamped 274 that lacks both, and leaves a view it does not own untouched (reported instead of
 * failing the migration, as on a brain whose view a superuser created).
 *
 * Run: DATABASE_URL=postgresql://... bun run test:e2e test/e2e/fork-repair-masked-119-120-postgres.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { MIGRATIONS, runMigrations } from '../../src/core/migrate.ts';
import { noticePageLinksSecurityInvoker, PAGE_LINKS_SECURITY_INVOKER_SQL } from '../../src/core/fork-migrations.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const CHECK = 'op_checkpoints_completed_keys_array';
const VIEW_OPTIONS = `SELECT c.reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'page_links' AND c.relkind = 'v'`;

describe.skipIf(!DATABASE_URL)('v275 repair_masked_upstream_119_120 (Postgres E2E)', () => {
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

  test('the runner restores the CHECK and the view option on a brain stamped 274 that lacks both', async () => {
    await engine.executeRaw(`ALTER TABLE op_checkpoints DROP CONSTRAINT ${CHECK}`);
    await engine.executeRaw('ALTER VIEW public.page_links RESET (security_invoker)');
    await engine.executeRaw(`INSERT INTO op_checkpoints (op, fingerprint, completed_keys)
      VALUES ('v275-test', 'scalar', '5'::jsonb)`);
    await engine.setConfig('version', '274');
    expect(await engine.executeRaw(VIEW_OPTIONS)).toEqual([{ reloptions: null }]);

    const result = await runMigrations(engine, { migrations: MIGRATIONS.filter(m => m.version === 275) });

    expect(result).toEqual({ applied: 1, current: 275 });
    expect(await engine.executeRaw(VIEW_OPTIONS)).toEqual([{ reloptions: ['security_invoker=on'] }]);
    expect(await engine.executeRaw(`SELECT completed_keys FROM op_checkpoints
      WHERE op = 'v275-test' AND fingerprint = 'scalar'`)).toEqual([{ completed_keys: [] }]);
    await expect(engine.executeRaw(`INSERT INTO op_checkpoints (op, fingerprint, completed_keys)
      VALUES ('v275-test', 'again', '"x"'::jsonb)`)).rejects.toThrow(CHECK);
  }, 60_000);

  test('a role that does not own page_links skips the ALTER instead of failing', async () => {
    const role = `gbrain_v275_probe_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await engine.executeRaw('ALTER VIEW public.page_links RESET (security_invoker)');
    await engine.executeRaw(`CREATE ROLE ${role} NOLOGIN`);
    try {
      const conn = await (engine as any).sql.reserve();
      let roleReset = false;
      try {
        await conn.unsafe(`SET ROLE ${role}`);
        await conn.unsafe(PAGE_LINKS_SECURITY_INVOKER_SQL);
      } finally {
        try {
          await conn.unsafe('RESET ROLE');
          roleReset = true;
        } finally {
          // A connection that may still carry the probe role must never return to the pool.
          if (roleReset) conn.release(); else await conn.unsafe('DISCARD ALL').catch(() => {}).finally(() => conn.release());
        }
      }
    } finally {
      await engine.executeRaw(`DROP ROLE IF EXISTS ${role}`);
    }
    expect(await engine.executeRaw(VIEW_OPTIONS)).toEqual([{ reloptions: null }]);
  }, 60_000);

  test('the notice reads the real catalog: any boolean spelling of on counts as enabled, unset and off are reported', async () => {
    const noticed = async () => {
      const lines: string[] = [];
      await noticePageLinksSecurityInvoker(engine, line => lines.push(line));
      return lines.length;
    };
    await engine.executeRaw("ALTER VIEW public.page_links SET (security_invoker = 't')");
    expect(await noticed()).toBe(0);
    await engine.executeRaw('ALTER VIEW public.page_links SET (security_invoker = off)');
    expect(await noticed()).toBe(1);
    await engine.executeRaw('ALTER VIEW public.page_links RESET (security_invoker)');
    expect(await noticed()).toBe(1);
    await engine.executeRaw('ALTER VIEW public.page_links SET (security_invoker = on)');
    expect(await noticed()).toBe(0);
  }, 60_000);
});

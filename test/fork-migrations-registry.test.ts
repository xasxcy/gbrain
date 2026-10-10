/**
 * FORK-ONLY. Guards the seam between upstream's `migrate.ts` and the fork's
 * `fork-migrations.ts`.
 *
 * The bodies of the fork's migrations were moved out of `migrate.ts` so the
 * upstream sync script never has to carry migration text through three
 * quoting layers (it silently corrupted an escape on 2026-08-16). What the
 * script still has to do is three fixed edits to `migrate.ts`: an import, a
 * `MIGRATIONS.push(...)`, and one `export` keyword.
 *
 * Every one of those can silently no-op, and the two most likely failures are
 * both invisible at runtime:
 *
 *   1. The push lands AFTER `export const LATEST_VERSION = Math.max(...)`.
 *      LATEST_VERSION then computes over the upstream-only array — 130 instead
 *      of 137 — and `runMigrations`' `m.version > current` filter drops every
 *      fork migration out of `pending`. No error, no warning: exactly the
 *      computed-high-water silent-exclusion class that ADR-087 exists about.
 *   2. The push is dropped entirely and the fork's migrations just aren't
 *      there.
 *
 * Per ADR-087 ⑤ the guard belongs on the OUTCOME (what the registry actually
 * contains) rather than on the edits, because a checker that greps for the
 * edits passes on an empty result.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MIGRATIONS, LATEST_VERSION } from '../src/core/migrate.ts';
import { buildForkMigrations, FORK_MIGRATION_FLOOR } from '../src/core/fork-migrations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Migration } from '../src/core/migrate.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { FACT_WITHDRAWAL_NORMALIZED_SQL } from '../src/core/facts/withdrawal-schema.ts';

describe('fork migration registry seam', () => {
  test('LATEST_VERSION is computed AFTER the fork migrations are pushed', () => {
    // The failure this catches is LATEST_VERSION === max(upstream) while the
    // array already holds higher fork versions.
    expect(LATEST_VERSION).toBe(Math.max(...MIGRATIONS.map(m => m.version)));
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(FORK_MIGRATION_FLOOR);
  });

  test('the fork migrations are present and contiguous from the floor', () => {
    const forkVersions = MIGRATIONS
      .filter(m => m.version >= FORK_MIGRATION_FLOOR)
      .map(m => m.version)
      .sort((a, b) => a - b);

    expect(forkVersions.length).toBeGreaterThan(0);
    // Contiguous: a gap means a migration was dropped during a renumber.
    const expected = Array.from(
      { length: forkVersions.length },
      (_, i) => FORK_MIGRATION_FLOOR + i,
    );
    expect(forkVersions).toEqual(expected);
  });

  test('no duplicate version numbers anywhere in the registry', () => {
    // A duplicate is not a numbering-hygiene nit: runMigrations gates on a
    // single high-water integer, so the second entry under a shared number is
    // masked permanently. That is how upstream v125 went unapplied for weeks
    // while the brain reported schema_version 136 (ADR-087 补充).
    const versions = MIGRATIONS.map(m => m.version);
    const duplicates = versions.filter((v, i) => versions.indexOf(v) !== i);
    expect(duplicates).toEqual([]);
  });

  test('every fork migration declares idempotent: true', () => {
    // Renumbering on each upstream sync means a brain that already ran one of
    // these under an older number runs the same DDL again under the new one.
    // ADR-087 ③ makes real idempotency the precondition for the whole scheme.
    const notIdempotent = MIGRATIONS
      .filter(m => m.version >= FORK_MIGRATION_FLOOR && m.idempotent !== true)
      .map(m => `${m.version}:${m.name}`);
    expect(notIdempotent).toEqual([]);
  });

  test('v240 never commits v149\'s obsolete queue protocol when canonical restoration is interrupted', async () => {
    const v149: Migration = { version: 149, name: 'minion_submission_authority', sql: 'old protocol' };
    let committedProtocol = 'canonical protocol';
    const engine = {
      kind: 'pglite',
      transaction: async (work: (tx: Pick<BrainEngine, 'runMigration'>) => Promise<void>) => {
        let stagedProtocol = committedProtocol;
        const tx = {
          runMigration: async (_version: number, sql: string) => {
            if (sql === 'old protocol') stagedProtocol = 'old protocol';
            else throw new Error('interrupted before canonical protocol can commit');
          },
        };
        await work(tx);
        committedProtocol = stagedProtocol;
      },
    } as unknown as BrainEngine;
    const migrations = buildForkMigrations({
      allMigrations: () => [v149],
      applyOneMigration: async () => { throw new Error('v149 must not use the independently committing helper'); },
      migrationNotice: () => {},
    });
    const repair = migrations.find(migration => migration.version === 240)!;

    await expect(repair.handler!(engine)).rejects.toThrow('interrupted before canonical protocol can commit');
    expect(committedProtocol).toBe('canonical protocol');
  });

  test('v240 keeps the migration runner envelope: SET LOCAL statement_timeout first, retry on statement_timeout, fail loud otherwise', async () => {
    const v149: Migration = { version: 149, name: 'minion_submission_authority', sql: 'old protocol' };
    const attempts: string[][] = [];
    let failuresLeft = 1;
    const engine = {
      kind: 'postgres',
      transaction: async (work: (tx: Pick<BrainEngine, 'runMigration'>) => Promise<void>) => {
        const statements: string[] = [];
        attempts.push(statements);
        await work({ runMigration: async (_version: number, sql: string) => {
          statements.push(sql);
          if (sql === 'old protocol' && failuresLeft-- > 0) {
            throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
          }
        } });
      },
    } as unknown as BrainEngine;
    const repair = buildForkMigrations({
      allMigrations: () => [v149],
      applyOneMigration: async () => {},
      migrationNotice: () => {},
    }).find(migration => migration.version === 240)!;
    await withEnv({ GBRAIN_MIGRATE_BACKOFF_MS: '0' }, async () => {
      await repair.handler!(engine);
      expect(attempts.length).toBe(2); // one retried statement_timeout, then success
      for (const statements of attempts) {
        expect(statements[0]).toBe("SET LOCAL statement_timeout = '600000'");
        expect(statements[1]).toBe('old protocol');
      }
      expect(attempts[1]!.length).toBe(3); // SET LOCAL + v149 + canonical protocol in the one transaction

      // A non-retryable failure is not retried.
      attempts.length = 0;
      const failing = {
        kind: 'postgres',
        transaction: async (work: (tx: Pick<BrainEngine, 'runMigration'>) => Promise<void>) => {
          attempts.push([]);
          await work({ runMigration: async (_version: number, sql: string) => { if (sql === 'old protocol') throw new Error('syntax error'); } });
        },
      } as unknown as BrainEngine;
      await expect(repair.handler!(failing)).rejects.toThrow('syntax error');
      expect(attempts.length).toBe(1);
    });
  });

  test('v240 retries announce the attempt, the error, the delay and the idle-in-transaction blockers (F4a R4-5)', async () => {
    const v149: Migration = { version: 149, name: 'minion_submission_authority', sql: 'old protocol' };
    let failuresLeft = 2;
    const engine = {
      kind: 'postgres',
      // getIdleBlockers' pg_stat_activity query; anything else is unexpected here.
      executeRaw: async (sql: string) => {
        if (!sql.includes('pg_stat_activity')) throw new Error(`unexpected query: ${sql}`);
        return [{ pid: 4242, state: 'idle in transaction', query_start: '2026-10-10 00:00:00+00', query: 'LOCK TABLE minion_jobs' }];
      },
      transaction: async (work: (tx: Pick<BrainEngine, 'runMigration'>) => Promise<void>) => {
        await work({ runMigration: async (_version: number, sql: string) => {
          if (sql === 'old protocol' && failuresLeft-- > 0) {
            throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
          }
        } });
      },
    } as unknown as BrainEngine;
    const notices: string[] = [];
    const repair = buildForkMigrations({
      allMigrations: () => [v149],
      applyOneMigration: async () => {},
      migrationNotice: line => { notices.push(line); },
    }).find(migration => migration.version === 240)!;
    await withEnv({ GBRAIN_MIGRATE_BACKOFF_MS: '0' }, async () => { await repair.handler!(engine); });

    const output = notices.join('');
    expect(output).toContain('[retry 1/3] v149 hit canceling statement due to statement timeout; retrying in 0ms');
    expect(output).toContain('[retry 2/3] v149 hit canceling statement due to statement timeout; retrying in 0ms');
    expect(output).toContain('1 idle-in-transaction blocker(s)');
    expect(output).toContain('PID 4242 idle since 2026-10-10 00:00:00+00');
    expect(output).toContain('LOCK TABLE minion_jobs');
    // The final repair notice still follows the successful attempt.
    expect(notices[notices.length - 1]).toContain('repair: re-applied upstream migrations 146/147/148/149');
  });

  test('v240 on PGLite never issues SET LOCAL statement_timeout (F4a R4-5)', async () => {
    const v149: Migration = { version: 149, name: 'minion_submission_authority', sql: 'old protocol' };
    const statements: string[] = [];
    const engine = {
      kind: 'pglite',
      transaction: async (work: (tx: Pick<BrainEngine, 'runMigration'>) => Promise<void>) => {
        await work({ runMigration: async (_version: number, sql: string) => { statements.push(sql); } });
      },
    } as unknown as BrainEngine;
    const repair = buildForkMigrations({
      allMigrations: () => [v149],
      applyOneMigration: async () => {},
      migrationNotice: () => {},
    }).find(migration => migration.version === 240)!;
    await repair.handler!(engine);
    expect(statements.length).toBe(2); // v149's body and the canonical protocol, nothing else
    expect(statements[0]).toBe('old protocol');
    expect(statements.some(sql => /statement_timeout/i.test(sql))).toBe(false);
  });
});

describe('fork repair under the managed PGLite writer guard', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => {
    await engine.disconnect();
  });

  test('v243 can replay v174 withdrawal expiry under the managed PGLite writer guard without leaking its source grant', async () => {
    const fact = await engine.insertFact(
      { fact: 'Managed repair withdrawal sentinel', source: 'test', visibility: 'world' },
      { source_id: 'default' },
    );
    await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash, withdrawn_at)
      VALUES ('default', 'world', '*', gbrain_fact_fingerprint($1), '2026-10-10T00:00:00Z')`,
    ['Managed repair withdrawal sentinel']);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

    await expect(engine.executeRaw('UPDATE facts SET valid_until=now() WHERE id=$1', [fact.id]))
      .rejects.toThrow('writer_coordinator_required');
    // runMigration is the production SQL runner: unlike executeRaw it
    // accepts a multi-statement migration body and preserves its transaction.
    await engine.transaction(tx => tx.runMigration(174, FACT_WITHDRAWAL_NORMALIZED_SQL));
    expect(await engine.executeRaw('SELECT expired_at, valid_until FROM facts WHERE id=$1', [fact.id]))
      .toEqual([{ expired_at: new Date('2026-10-10T00:00:00.000Z'), valid_until: new Date('2026-10-10T00:00:00.000Z') }]);
    await expect(engine.executeRaw('UPDATE facts SET valid_until=now() WHERE id=$1', [fact.id]))
      .rejects.toThrow('writer_coordinator_required');
  }, 60_000);
});

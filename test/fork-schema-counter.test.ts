/**
 * FORK-ONLY. The fork's migrations run on their own counter (`fork_schema_version`), so neither upstream's
 * high-water nor the fork's can mask the other's migrations. Pins the one-time adoption of a brain stamped by the
 * last shared-counter layout, the pending probe, the drift self-heal, and the masking class this ends.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { FORK_MIGRATIONS, LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { hasPendingMigrations } from '../src/core/migrate-pending.ts';
import {
  adoptForkCounter, FORK_COUNTER_KEY, FORK_LATEST_VERSION, LEGACY_FORK_MAX, LEGACY_UPSTREAM_MAX,
} from '../src/core/fork-migrations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Migration } from '../src/core/migrate.ts';
import { __testing } from '../src/commands/apply-migrations.ts';

async function counters(engine: BrainEngine): Promise<[string | null, string | null]> {
  return [await engine.getConfig('version'), await engine.getConfig(FORK_COUNTER_KEY)];
}

/** Puts the brain back into a pre-counter state stamped `version`. */
async function stampLegacy(engine: BrainEngine, version: number): Promise<void> {
  await engine.setConfig('version', String(version));
  await engine.executeRaw(`DELETE FROM config WHERE key = '${FORK_COUNTER_KEY}'`);
}

describe('fork schema counter (PGLite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => {
    await engine.disconnect();
  });
  beforeEach(async () => {
    await engine.setConfig('version', String(LATEST_VERSION));
    await engine.setConfig(FORK_COUNTER_KEY, String(FORK_LATEST_VERSION));
  });

  test('a fresh install ends with both counters at their latest', async () => {
    const fresh = new PGLiteEngine();
    await fresh.connect({});
    try {
      await fresh.initSchema();
      expect(await counters(fresh)).toEqual([String(LATEST_VERSION), String(FORK_LATEST_VERSION)]);
    } finally {
      await fresh.disconnect();
    }
  }, 60_000);

  test('adoption maps the last legacy layout by position: 274 -> (260, 14), 275 -> (260, 15)', async () => {
    for (const legacy of [274, LEGACY_FORK_MAX]) {
      await stampLegacy(engine, legacy);
      await adoptForkCounter(engine);
      expect(await counters(engine)).toEqual([String(LEGACY_UPSTREAM_MAX), String(legacy - LEGACY_UPSTREAM_MAX)]);
    }
  });

  test('adoption leaves an upstream-numbered brain alone and starts the fork at 0: 243 -> (243, 0)', async () => {
    await stampLegacy(engine, 243);
    await adoptForkCounter(engine);
    expect(await counters(engine)).toEqual(['243', '0']);
  });

  test('adoption refuses a version above the last legacy layout and writes nothing', async () => {
    await stampLegacy(engine, LEGACY_FORK_MAX + 1);
    await expect(adoptForkCounter(engine)).rejects.toThrow('above the last legacy fork layout');
    expect(await counters(engine)).toEqual([String(LEGACY_FORK_MAX + 1), null]);
  });

  test('adoption is a no-op once the fork key exists', async () => {
    await engine.setConfig('version', '270');
    await engine.setConfig(FORK_COUNTER_KEY, '3');
    await adoptForkCounter(engine);
    expect(await counters(engine)).toEqual(['270', '3']);
  });

  test('the masking class is gone: an upstream 261 runs on a brain the fork stamped 275', async () => {
    // Under the shared counter this brain's high-water (275) is above 261, so the new upstream migration
    // was skipped forever. Adoption moves upstream's counter back to 260 and the migration runs.
    const upstream261: Migration = {
      version: LEGACY_UPSTREAM_MAX + 1, name: 'synthetic_upstream_261', idempotent: true,
      sql: 'CREATE TABLE IF NOT EXISTS synthetic_upstream_261 (id INT)',
    };
    await stampLegacy(engine, LEGACY_FORK_MAX);
    const result = await runMigrations(engine, { migrations: [...MIGRATIONS, upstream261] });
    expect(result.applied).toBe(1);
    expect(await engine.executeRaw(`SELECT to_regclass('synthetic_upstream_261') IS NOT NULL AS made`)).toEqual([{ made: true }]);
    expect(await counters(engine)).toEqual([String(LEGACY_UPSTREAM_MAX + 1), String(FORK_LATEST_VERSION)]);
  }, 60_000);

  test('the fork pass runs only fork migrations above its own counter, whatever upstream\'s counter says', async () => {
    const ran: number[] = [];
    const forkMigrations: Migration[] = FORK_MIGRATIONS.map(m => ({
      version: m.version, name: m.name, idempotent: true, sql: '', handler: async () => { ran.push(m.version); },
    }));
    await engine.setConfig(FORK_COUNTER_KEY, String(FORK_LATEST_VERSION - 2));
    await runMigrations(engine, { forkMigrations });
    expect(ran).toEqual([FORK_LATEST_VERSION - 1, FORK_LATEST_VERSION]);
    expect(await engine.getConfig(FORK_COUNTER_KEY)).toBe(String(FORK_LATEST_VERSION));
  }, 60_000);

  test('hasPendingMigrations sees a missing or behind fork counter', async () => {
    expect(await hasPendingMigrations(engine)).toBe(false);
    await engine.setConfig(FORK_COUNTER_KEY, String(FORK_LATEST_VERSION - 1));
    expect(await hasPendingMigrations(engine)).toBe(true);
    await engine.executeRaw(`DELETE FROM config WHERE key = '${FORK_COUNTER_KEY}'`);
    expect(await hasPendingMigrations(engine)).toBe(true);
  });

  test('a fork object an upstream migration dropped is re-applied on the next run', async () => {
    await engine.executeRaw('ALTER TABLE files DROP CONSTRAINT files_source_storage_key');
    await runMigrations(engine);
    expect(await engine.executeRaw(`SELECT conname FROM pg_constraint WHERE conname = 'files_source_storage_key'`))
      .toEqual([{ conname: 'files_source_storage_key' }]);
  }, 60_000);
});

describe('fork counter adoption atomicity', () => {
  test('a failure after the version rewrite commits neither counter', async () => {
    const committed = new Map<string, string>([['version', '274']]);
    const engine = {
      getConfig: async (key: string) => committed.get(key) ?? null,
      transaction: async (work: (tx: BrainEngine) => Promise<void>) => {
        const staged = new Map(committed);
        const tx = {
          executeRaw: async () => [],
          getConfig: async (key: string) => staged.get(key) ?? null,
          setConfig: async (key: string, value: string) => {
            if (key === FORK_COUNTER_KEY) throw new Error('crash before the fork key is written');
            staged.set(key, value);
          },
        } as unknown as BrainEngine;
        await work(tx);
        for (const [k, v] of staged) committed.set(k, v);
      },
    } as unknown as BrainEngine;
    await expect(adoptForkCounter(engine)).rejects.toThrow('crash before the fork key is written');
    expect([...committed]).toEqual([['version', '274']]);
  });
});

describe('apply-migrations pre-flight sees the fork counter', () => {
  const { resolveSchemaBehind } = __testing;

  test('upstream at head but the fork counter behind (or a legacy 275 stamp) still runs schema migrations', async () => {
    for (const schemaVer of [LATEST_VERSION, LEGACY_FORK_MAX]) {
      let ran = false;
      const behind = await resolveSchemaBehind({
        schemaVer, latest: LATEST_VERSION, forkPending: true, autoApply: true,
        run: async () => { ran = true; return { applied: 0, current: LATEST_VERSION }; },
      });
      expect([behind, ran]).toEqual([false, true]);
    }
  });

  test('without --yes it reports the fork migrations as pending instead of "up to date"', async () => {
    let ran = false;
    const behind = await resolveSchemaBehind({
      schemaVer: LATEST_VERSION, latest: LATEST_VERSION, forkPending: true, autoApply: false,
      run: async () => { ran = true; return { applied: 0, current: LATEST_VERSION }; },
    });
    expect([behind, ran]).toEqual([true, false]);
  });
});

/**
 * FORK-ONLY. Entry points outside runMigrations that must see the fork's own counter (`fork_schema_version`):
 * the apply-migrations post-check on PGLite, and graduation's "is the target empty" config check.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { FORK_COUNTER_KEY, FORK_LATEST_VERSION, forkSchemaBehind } from '../src/core/fork-migrations.ts';
import { schemaVersionHealth } from '../src/core/schema-version-health.ts';
import { checkSchemaAfterOrchestrators } from '../src/commands/apply-migrations-schema.ts';
import { userConfigKeys } from '../src/core/persistence/engine-graduation.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';

describe('the fork counter key is bookkeeping, not user state', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => {
    await engine.disconnect();
  });

  test('graduation sees a freshly initialized brain as holding no user config keys', async () => {
    expect(await engine.getConfig(FORK_COUNTER_KEY)).toBe(String(FORK_LATEST_VERSION));
    expect(await userConfigKeys(engine)).toEqual([]);
  });

  test('health checks see a fork counter left behind by a failed fork migration', async () => {
    expect(await forkSchemaBehind(engine)).toBeNull();
    await engine.setConfig(FORK_COUNTER_KEY, String(FORK_LATEST_VERSION - 1));
    try {
      const behind = await forkSchemaBehind(engine);
      expect(behind).toContain(`fork#${FORK_LATEST_VERSION - 1}`);
      const health = schemaVersionHealth(LATEST_VERSION, LATEST_VERSION, { forkBehind: behind });
      expect(health.status).toBe('warn');
      expect(health.message).toContain('gbrain apply-migrations --yes');
      expect(schemaVersionHealth(LATEST_VERSION, LATEST_VERSION, { forkBehind: null }).status).toBe('ok');
    } finally {
      await engine.setConfig(FORK_COUNTER_KEY, String(FORK_LATEST_VERSION));
    }
  });
});

describe('apply-migrations post-check on PGLite sees the fork counter', () => {
  let dir: string;
  let cfg: GBrainConfig;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-fork-counter-'));
    cfg = { engine: 'pglite', database_path: join(dir, 'brain.pglite') } as GBrainConfig;
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: cfg.database_path });
    await engine.initSchema();
    // A brain the last shared-counter layout stamped 274: upstream's 260 is "current", the fork key is absent.
    await engine.setConfig('version', '274');
    await engine.executeRaw(`DELETE FROM config WHERE key = '${FORK_COUNTER_KEY}'`);
    await engine.disconnect();
  }, 60_000);
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('without --yes a legacy brain stamped 274 is reported pending, not current', async () => {
    let applied = false;
    const result = await checkSchemaAfterOrchestrators({
      cfg, authorized: false, preflightVersion: null, apply: async () => { applied = true; },
    });
    expect(applied).toBe(false);
    expect(result?.reason).toBe('not_applied');
  }, 60_000);

  test('with --yes it applies them and reports nothing left', async () => {
    let after: (string | null)[] = [];
    const result = await checkSchemaAfterOrchestrators({
      cfg, authorized: true, preflightVersion: null,
      apply: async (engine: BrainEngine) => {
        await runMigrations(engine);
        after = [await engine.getConfig('version'), await engine.getConfig(FORK_COUNTER_KEY)];
      },
    });
    expect(result).toBeNull();
    expect(after).toEqual([String(LATEST_VERSION), String(FORK_LATEST_VERSION)]);
  }, 60_000);
});

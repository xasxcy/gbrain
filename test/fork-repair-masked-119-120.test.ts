/**
 * FORK-ONLY. v275 repairs the two lasting gaps upstream 119 and 120 leave on a brain whose high-water skipped them:
 * the op_checkpoints completed_keys CHECK (both engines) and the page_links security_invoker option (Postgres; see
 * test/e2e/fork-repair-masked-119-120-postgres.test.ts). This file drives the real runner on PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { FORK_MIGRATIONS, LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { FORK_COUNTER_KEY, noticePageLinksSecurityInvoker } from '../src/core/fork-migrations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const CHECK = 'op_checkpoints_completed_keys_array';

describe('v275 repair_masked_upstream_119_120 (PGLite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => {
    await engine.disconnect();
  });

  test('the runner restores the CHECK on a legacy brain stamped 274 that lacks it, resetting only scalar rows', async () => {
    await engine.executeRaw(`ALTER TABLE op_checkpoints DROP CONSTRAINT ${CHECK}`);
    await engine.executeRaw(`INSERT INTO op_checkpoints (op, fingerprint, completed_keys) VALUES
      ('v275-test', 'scalar', '5'::jsonb), ('v275-test', 'array', '["a","b"]'::jsonb)`);
    // A brain stamped 274 by the last shared-counter layout: adoption maps it to (260, fork#14).
    await engine.setConfig('version', '274');
    await engine.executeRaw(`DELETE FROM config WHERE key = '${FORK_COUNTER_KEY}'`);

    const result = await runMigrations(engine);

    expect(result.current).toBe(LATEST_VERSION);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    expect(await engine.getConfig(FORK_COUNTER_KEY)).toBe('15');
    expect(await engine.executeRaw(`SELECT conname FROM pg_constraint WHERE conname = '${CHECK}'`)).toHaveLength(1);
    expect(await engine.executeRaw(`SELECT fingerprint, completed_keys FROM op_checkpoints
      WHERE op = 'v275-test' ORDER BY fingerprint`)).toEqual([
      { fingerprint: 'array', completed_keys: ['a', 'b'] },
      { fingerprint: 'scalar', completed_keys: [] },
    ]);
    await expect(engine.executeRaw(`INSERT INTO op_checkpoints (op, fingerprint, completed_keys)
      VALUES ('v275-test', 'again', '"x"'::jsonb)`)).rejects.toThrow(CHECK);
  }, 60_000);

  test('re-running v275 on a repaired brain is a no-op that still verifies', async () => {
    const v275 = FORK_MIGRATIONS.find(m => m.version === 15)!;
    await v275.handler!(engine as unknown as BrainEngine);
    expect(await v275.verify!(engine as unknown as BrainEngine)).toBe(true);
    expect(await engine.executeRaw(`SELECT conname FROM pg_constraint WHERE conname = '${CHECK}'`)).toHaveLength(1);
  });
});

describe('noticePageLinksSecurityInvoker', () => {
  test('names the view owner and the exact superuser command for each unrepaired view', async () => {
    const lines: string[] = [];
    const engine = { executeRaw: async () => [{ owner: 'postgres' }] } as unknown as BrainEngine;
    await noticePageLinksSecurityInvoker(engine, line => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('owned by postgres');
    expect(lines[0]).toContain('ALTER VIEW public.page_links SET (security_invoker = on);');
  });

  test('stays silent when the view already runs as the invoker', async () => {
    const lines: string[] = [];
    const engine = { executeRaw: async () => [] } as unknown as BrainEngine;
    await noticePageLinksSecurityInvoker(engine, line => lines.push(line));
    expect(lines).toEqual([]);
  });
});

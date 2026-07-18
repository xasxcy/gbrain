import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { MIGRATIONS, LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { resetFtsLanguageCache } from '../src/core/fts-language.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const ENV_KEY = 'GBRAIN_FTS_LANGUAGE';
const originalLang = process.env[ENV_KEY];

beforeEach(() => {
  delete process.env[ENV_KEY];
  resetFtsLanguageCache();
});

afterEach(() => {
  delete process.env[ENV_KEY];
  if (originalLang !== undefined) process.env[ENV_KEY] = originalLang;
  resetFtsLanguageCache();
});

describe('configurable_fts_language migration', () => {
  test('migration is registered', () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    expect(ftsMig).toBeDefined();
    expect(ftsMig?.version).toBeGreaterThan(115);
  });

  test('fork v123 collision repair is the latest migration', () => {
    const repair = MIGRATIONS.find(m => m.name === 'repair_configurable_fts_language_skipped_by_fork_v123');
    expect(repair?.version).toBe(LATEST_VERSION);
    expect(repair?.handler).toBeTypeOf('function');
  });

  test('ftsMig uses handler (not static SQL) because language interpolation is dynamic', () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    expect(ftsMig?.sql).toBe('');
    expect(ftsMig?.handler).toBeTypeOf('function');
  });

  test('ftsMig handler is async', () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    // Async function check: the constructor name is 'AsyncFunction'
    expect(ftsMig?.handler?.constructor.name).toBe('AsyncFunction');
  });

  test('migration handler issues recreate-function calls (smoke check via mock engine)', async () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    const calls: string[] = [];

    const mockEngine = {
      executeRaw: async (sql: string) => {
        calls.push(sql);
        return [];
      },
    } as unknown as BrainEngine;

    process.env[ENV_KEY] = 'english';
    resetFtsLanguageCache();

    await ftsMig?.handler?.(mockEngine);

    // Default 'english' \u2014 no backfill, only 2 CREATE OR REPLACE calls.
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain('CREATE OR REPLACE FUNCTION update_page_search_vector');
    expect(calls[0]).toContain("to_tsvector('english'");
    expect(calls[1]).toContain('CREATE OR REPLACE FUNCTION update_chunk_search_vector');
    expect(calls[1]).toContain("to_tsvector('english'");
    // v120/#1647 hardening must survive the CREATE OR REPLACE (which resets
    // proconfig): both recreated bodies pin search_path.
    expect(calls[0]).toContain('SET search_path = pg_catalog, public');
    expect(calls[1]).toContain('SET search_path = pg_catalog, public');
  });

  test('non-english language triggers backfill', async () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    const calls: string[] = [];

    const mockEngine = {
      executeRaw: async (sql: string) => {
        calls.push(sql);
        return [];
      },
    } as unknown as BrainEngine;

    process.env[ENV_KEY] = 'pt_br';
    resetFtsLanguageCache();

    await ftsMig?.handler?.(mockEngine);

    // pt_br \u2014 2 CREATE + 2 backfill UPDATEs = 4 calls
    expect(calls.length).toBe(4);
    expect(calls[0]).toContain("to_tsvector('pt_br'");
    expect(calls[1]).toContain("to_tsvector('pt_br'");
    expect(calls[2]).toMatch(/UPDATE pages/);
    expect(calls[3]).toContain("to_tsvector('pt_br'");
    expect(calls[3]).toMatch(/UPDATE content_chunks/);
  });

  test('fork-v123 repair replays the upstream FTS handler', async () => {
    const repair = MIGRATIONS.find(m => m.name === 'repair_configurable_fts_language_skipped_by_fork_v123');
    const calls: string[] = [];
    const mockEngine = { executeRaw: async (sql: string) => { calls.push(sql); return []; } } as unknown as BrainEngine;
    process.env[ENV_KEY] = 'pt_br';
    resetFtsLanguageCache();
    await repair?.handler?.(mockEngine);
    expect(calls).toHaveLength(4);
    expect(calls[0]).toContain("to_tsvector('pt_br'");
    expect(calls[3]).toMatch(/UPDATE content_chunks/);
  });

  test('persisted fork v123 marker upgrades through v127 and replays configurable FTS', async () => {
    const databasePath = mkdtempSync(join(tmpdir(), 'gbrain-fts-v123-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({ database_path: databasePath });
      await engine.initSchema();
      // This persisted marker models a pre-upstream fork: its own PGroonga
      // migration occupied v123, so upstream v123 would otherwise be skipped.
      await engine.setConfig('version', '123');
      await engine.disconnect();

      await engine.connect({ database_path: databasePath });
      const calls: string[] = [];
      const executeRaw = engine.executeRaw.bind(engine);
      engine.executeRaw = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        calls.push(sql);
        return executeRaw<T>(sql, params);
      };

      // PGLite only ships the default text-search configuration. This test
      // proves the persisted v123 marker takes the v124→v127 runner path;
      // the non-English backfill SQL remains covered by the mock-handler test.
      process.env[ENV_KEY] = 'english';
      resetFtsLanguageCache();
      const result = await runMigrations(engine);

      expect(result.current).toBe(LATEST_VERSION);
      expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
      expect(calls.some(sql => sql.includes("to_tsvector('english'"))).toBe(true);
      expect(calls.some(sql => sql.includes('CREATE OR REPLACE FUNCTION update_chunk_search_vector'))).toBe(true);
    } finally {
      await engine.disconnect();
      rmSync(databasePath, { recursive: true, force: true });
    }
  }, 30_000);

  test('invalid language falls back to english (no SQL injection)', async () => {
    const ftsMig = MIGRATIONS.find(m => m.name === 'configurable_fts_language');
    const calls: string[] = [];

    const mockEngine = {
      executeRaw: async (sql: string) => {
        calls.push(sql);
        return [];
      },
    } as unknown as BrainEngine;

    process.env[ENV_KEY] = "english'; DROP TABLE pages; --";
    resetFtsLanguageCache();

    await ftsMig?.handler?.(mockEngine);

    // Falls back to english: 2 CREATE OR REPLACE only, no DROP TABLE in any SQL.
    expect(calls.length).toBe(2);
    for (const sql of calls) {
      expect(sql).not.toContain('DROP TABLE');
      expect(sql).toContain("to_tsvector('english'");
    }
  });
});

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import { resetFtsLanguageCache } from '../src/core/fts-language.ts';

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

  // #2704 (v124, page_search_vector_drop_compiled_truth) landed after this
  // migration — "is the latest migration" was only ever true at the
  // moment v123 was added and would break on every subsequent migration,
  // so it's removed rather than bumped to a hardcoded v124. The
  // registration + shape assertions below don't depend on migration order.

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

  test('non-english language triggers content_chunks backfill only (pages backfill moved to v128)', async () => {
    // FORK-FIX (2026-07-22, batch 2, item 2): v127 now installs the FINAL
    // (no-compiled_truth) pages trigger from the start instead of a
    // transitional compiled_truth-including one, which removes the
    // overflow risk that made the old `UPDATE pages SET id = id` backfill
    // in this migration crash on large pages (#2704 follow-up). Backfilling
    // EXISTING pages.search_vector rows is now v128's job \u2014 batched, and
    // for every language, not just non-English (see v128's own tests) \u2014
    // so v127 no longer touches the pages table at all.
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

    // pt_br \u2014 2 CREATE (pages fn, chunk fn) + 1 content_chunks backfill = 3 calls.
    expect(calls.length).toBe(3);
    expect(calls[0]).toContain("to_tsvector('pt_br'");
    expect(calls[0]).toContain('update_page_search_vector');
    expect(calls[0]).not.toContain('compiled_truth');
    expect(calls[1]).toContain("to_tsvector('pt_br'");
    expect(calls[1]).toContain('update_chunk_search_vector');
    expect(calls[2]).toContain("to_tsvector('pt_br'");
    expect(calls[2]).toMatch(/UPDATE content_chunks/);
    for (const sql of calls) {
      expect(sql).not.toMatch(/UPDATE pages/);
    }
  });

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

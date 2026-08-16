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

  test('non-english language backfills both pages and content_chunks (upstream shape)', async () => {
    // configurable_fts_language is upstream's migration, kept byte-identical
    // so the automated upstream sync stops conflicting on migrate.ts. Its
    // non-English path recreates both trigger functions and then backfills
    // pages (via UPDATE-to-same-value) and content_chunks. The pages trigger
    // it installs still indexes compiled_truth; the fork narrows that in its
    // own later migration, asserted separately below.
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

    // pt_br \u2014 2 CREATE (pages fn, chunk fn) + pages backfill + chunks backfill.
    expect(calls.length).toBe(4);
    expect(calls[0]).toContain("to_tsvector('pt_br'");
    expect(calls[0]).toContain('update_page_search_vector');
    expect(calls[1]).toContain("to_tsvector('pt_br'");
    expect(calls[1]).toContain('update_chunk_search_vector');
    expect(calls[2]).toMatch(/UPDATE pages/);
    expect(calls[3]).toContain("to_tsvector('pt_br'");
    expect(calls[3]).toMatch(/UPDATE content_chunks/);
  });

  test('the fork migration installs a compiled_truth-free pages trigger and backfills in batches', async () => {
    // The fork's standing repair for upstream's #2704 pair. Upstream's
    // configurable_fts_language still builds pages.search_vector from
    // compiled_truth (unbounded whole-page body, overflows Postgres's 1MB
    // tsvector cap on large pages) and upstream's
    // page_search_vector_drop_compiled_truth never backfills existing rows.
    // This migration owns both halves for the fork. Looked up BY NAME: fork
    // migrations are re-sequenced to max(upstream)+1 on every sync.
    const forkMig = MIGRATIONS.find(
      m => m.name === 'fork_page_search_vector_final_trigger_and_batched_backfill',
    );
    expect(forkMig).toBeDefined();
    const calls: string[] = [];

    const mockEngine = {
      executeRaw: async (sql: string) => {
        calls.push(sql);
        return [];
      },
    } as unknown as BrainEngine;

    process.env[ENV_KEY] = 'pt_br';
    resetFtsLanguageCache();

    await forkMig!.handler!(mockEngine);

    // The installed pages trigger must not index compiled_truth.
    expect(calls[0]).toContain('update_page_search_vector');
    expect(calls[0]).not.toContain('compiled_truth');
    expect(calls[0]).toContain('SET search_path = pg_catalog, public');
    // The backfill must be batched (keyset over the SERIAL PK), never a
    // single unbounded UPDATE holding a lock over the whole pages table.
    const backfills = calls.filter(sql => /UPDATE pages/.test(sql));
    expect(backfills.length).toBeGreaterThan(0);
    for (const sql of backfills) {
      expect(sql).toMatch(/WHERE id > \$1 AND search_vector IS NOT NULL/);
      expect(sql).toMatch(/LIMIT \$2/);
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

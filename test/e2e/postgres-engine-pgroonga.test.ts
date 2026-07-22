/**
 * G2 · TD-2 PGroonga 基线测试
 *
 * Runs 5 read-only baseline test cases against a real Postgres DB that has
 * PGroonga installed and the idx_content_chunks_pgroonga index on chunk_text.
 *
 * Design:
 * - No initSchema(), no DDL, read-only
 * - Skips the whole suite when DATABASE_URL is not set
 *
 * FORK-FIX (2026-07-22, batch 2 FIX2 T5): this file previously fell back to
 * a hardcoded NAS URL (`192.168.50.232:...`) carrying a PLAINTEXT password,
 * committed to a public fork. It also connected to a LAN-only address on
 * every CI run regardless of DATABASE_URL, which idled ~10s to a connect
 * timeout on GitHub-hosted runners (CI `test (4)`, observed 10014ms). Fixed
 * by reading ONLY `process.env.DATABASE_URL` and skipping the entire suite
 * (not per-test warn+pass) when it's unset.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('PostgresEngine PGroonga baseline', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL! });
    // Intentionally NOT calling initSchema() — read-only access, do not mutate DB state
  });

  afterAll(async () => {
    if (engine) await engine.disconnect();
  });

  test('① 纯中文: 量子计算 should return ≥1 results', async () => {
    const results = await engine.searchKeyword('量子计算');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test('② 纯ASCII: Aexas should return ≥1 results', async () => {
    const results = await engine.searchKeyword('Aexas');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test('③ 中英混排 smoke test: "claude 重合" should not throw', async () => {
    const results = await engine.searchKeyword('claude 重合');
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  test('④ empty query should not crash', async () => {
    const results = await engine.searchKeyword('');
    expect(results.length).toBeGreaterThanOrEqual(0);
  });

  test('⑤ _usePgroonga=false downgrade path should not throw', async () => {
    const orig = (engine as any)._usePgroonga;
    (engine as any)._usePgroonga = false;
    try {
      const results = await engine.searchKeyword('量子计算');
      expect(results).toBeDefined();
    } finally {
      (engine as any)._usePgroonga = orig;
    }
  });
});

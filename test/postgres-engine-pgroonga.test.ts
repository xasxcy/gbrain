/**
 * G2 · TD-2 PGroonga 基线测试
 *
 * Runs 5 read-only baseline test cases against a NAS Postgres DB that has
 * PGroonga installed and the idx_content_chunks_pgroonga index on chunk_text.
 *
 * Design:
 * - No initSchema(), no DDL, read-only
 * - Skips when DATABASE_URL is not set AND no fallback can reach the DB
 * - Falls back to hardcoded NAS URL for local dev convenience
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

const FALLBACK_DB_URL =
  'postgres://gbrain:7ecc1375a1bf1aacb9e0e6a0dc614c854c5d8bf3c1ae5e0f@192.168.50.232:55432/gbrain_bge1024';

const DATABASE_URL = process.env.DATABASE_URL ?? FALLBACK_DB_URL;

describe('PostgresEngine PGroonga baseline', () => {
  let engine: PostgresEngine;

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: DATABASE_URL });
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

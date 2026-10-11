/**
 * FORK: PGroonga selects keyword matches; ranking stays on upstream's ts_rank * source factor scale.
 * A PGroonga-only hit (the text matches `&@~` but the English tsquery is empty, e.g. a stopword query)
 * has ts_rank 0. Its score keeps a small floor so the source factor still orders it: without the floor
 * every such hit scores 0 and falls back to id order, letting an older chat page outrank a curated one.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';

const CHAT = 'openclaw/chat/2026-04-15';
const CURATED = 'originals/talks/stopword-outline';

describe.skipIf(!hasDatabase())('PGroonga keyword rank: PGroonga-only hits keep source weighting', () => {
  let engine: PostgresEngine;
  beforeAll(async () => {
    engine = await setupDB();
    // The chat page is created first, so it wins any id-order tie.
    for (const [slug, body] of [[CHAT, 'the the the and the'], [CURATED, 'the outline']] as const) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: body });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body }]);
    }
  }, 120_000);
  afterAll(async () => { await teardownDB(); });

  test('a stopword query ranks the curated page above the dampened chat page on both keyword paths', async () => {
    expect(await engine.executeRaw("SELECT 1 FROM pg_extension WHERE extname = 'pgroonga'")).toHaveLength(1);
    const pages = (await engine.searchKeyword('the')).map(hit => hit.slug);
    const chunks = (await engine.searchKeywordChunks('the')).map(hit => hit.slug);
    for (const order of [pages, chunks]) {
      expect(order).toContain(CHAT);
      expect(order.indexOf(CURATED)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(CURATED)).toBeLessThan(order.indexOf(CHAT));
    }
  });
});

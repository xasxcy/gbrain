/**
 * FORK-FIX (2026-07-22, batch 2, item 2): v126 → v128 upgrade path for the
 * configurable-FTS-language migrations.
 *
 * Pre-fix bug (two parts):
 *   1. v127 still built `search_vector` FROM `compiled_truth` (an unbounded
 *      whole-page body) and then, for any non-English language, ran a
 *      full-table `UPDATE pages SET id = id` to force trigger recompute.
 *      A page whose compiled_truth serializes to a tsvector over Postgres's
 *      hard 1,048,575-byte cap makes that recompute throw `string is too
 *      long for tsvector`, aborting the WHOLE migration transaction before
 *      v128 (which drops compiled_truth from the trigger) ever gets a
 *      chance to run.
 *   2. Even when 127 didn't crash, v128 only ever did `CREATE OR REPLACE`
 *      on the trigger function — it never touched EXISTING rows. An
 *      upgraded brain's pre-existing pages kept compiled_truth baked into
 *      `search_vector` forever, while a freshly created brain (schema.sql,
 *      already final) never had it — upgraded vs. fresh brains diverged in
 *      search semantics indefinitely (page/title-arm hits on body text,
 *      double-counted against the chunk arm in RRF).
 *
 * The fix: v127 installs the FINAL (no-compiled_truth) trigger from the
 * start (no overflow risk, so no crash), and v128 does an explicit batched
 * backfill of every existing non-null search_vector row, for every
 * language, so upgraded and fresh installs converge on the same state.
 *
 * This test drives the REAL `MIGRATIONS` entries (not hand-rolled SQL)
 * through `runMigrations()`, starting from a hand-seeded "v126 install"
 * state: the pre-127 trigger shape (english, WITH compiled_truth) plus one
 * row seeded bypassing that trigger (so an oversized compiled_truth can
 * exist in the table without crashing at seed time — matching how a real
 * v126 install would have accumulated the row before this fix ever ran).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runMigrations } from '../src/core/migrate.ts';
import { resetFtsLanguageCache } from '../src/core/fts-language.ts';

const ENV_KEY = 'GBRAIN_FTS_LANGUAGE';
const originalLang = process.env[ENV_KEY];

let engine: PGLiteEngine;

beforeEach(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema(); // brings up tables at LATEST_VERSION; we roll back below.
  await resetPgliteState(engine);
  delete process.env[ENV_KEY];
  resetFtsLanguageCache();
});

afterEach(async () => {
  await engine.disconnect();
  delete process.env[ENV_KEY];
  if (originalLang !== undefined) process.env[ENV_KEY] = originalLang;
  resetFtsLanguageCache();
});

/** Installs the pre-127 trigger shape: english, WITH compiled_truth. */
async function installPre127Trigger(): Promise<void> {
  await engine.executeRaw(`
    CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
    DECLARE timeline_text TEXT;
    BEGIN
      SELECT coalesce(string_agg(summary || ' ' || detail, ' '), '') INTO timeline_text FROM timeline_entries WHERE page_id = NEW.id;
      NEW.search_vector := setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A') || setweight(to_tsvector('english', coalesce(NEW.compiled_truth, '')), 'B') || setweight(to_tsvector('english', coalesce(NEW.timeline, '')), 'C') || setweight(to_tsvector('english', coalesce(timeline_text, '')), 'C');
      RETURN NEW;
    END;
    $fn$ LANGUAGE plpgsql;
  `);
  await engine.setConfig('version', '126');
}

/** Reads the live trigger function body from the catalog. */
async function getTriggerFunctionSource(): Promise<string> {
  const rows = await engine.executeRaw<{ src: string }>(
    `SELECT pg_get_functiondef('update_page_search_vector'::regproc) AS src`,
  );
  return rows[0]!.src;
}

describe('v126 → v128 upgrade: configurable_fts_language + drop_compiled_truth', () => {
  test('English: upgrade does not crash, drops compiled_truth from the trigger, matches a fresh install', async () => {
    await installPre127Trigger();
    await engine.putPage('normal-page', {
      type: 'note',
      title: 'zzTitleTokenA',
      timeline: '',
      compiled_truth: 'zzBodyOnlyTokenA short unrelated prose',
    });

    process.env[ENV_KEY] = 'english';
    resetFtsLanguageCache();
    const result = await runMigrations(engine);
    expect(result.applied).toBeGreaterThan(0);

    const src = await getTriggerFunctionSource();
    expect(src).not.toContain('compiled_truth');

    // A page whose title/timeline don't contain the body-only token must NOT
    // match it via search_vector after the upgrade — matches a fresh install,
    // where compiled_truth was never indexed at all.
    const bodyOnlyHit = await engine.executeRaw<{ hit: boolean }>(
      `SELECT search_vector @@ to_tsquery('english', 'zzbodyonlytokena') AS hit
         FROM pages WHERE slug = 'normal-page'`,
    );
    expect(bodyOnlyHit[0]?.hit).toBe(false);
    // Title tokens still index — the trigger isn't inert, just narrower.
    const titleHit = await engine.executeRaw<{ hit: boolean }>(
      `SELECT search_vector @@ to_tsquery('english', 'zztitletokena') AS hit
         FROM pages WHERE slug = 'normal-page'`,
    );
    expect(titleHit[0]?.hit).toBe(true);
  });

  test("non-English ('simple'): upgrade does not crash, drops compiled_truth, matches a fresh install", async () => {
    await installPre127Trigger();
    await engine.putPage('normal-page-simple', {
      type: 'note',
      title: 'zzTitleTokenB',
      timeline: '',
      compiled_truth: 'zzBodyOnlyTokenB short unrelated prose',
    });

    process.env[ENV_KEY] = 'simple';
    resetFtsLanguageCache();
    const result = await runMigrations(engine);
    expect(result.applied).toBeGreaterThan(0);

    const src = await getTriggerFunctionSource();
    expect(src).not.toContain('compiled_truth');
    expect(src).toContain("'simple'");

    const bodyOnlyHit = await engine.executeRaw<{ hit: boolean }>(
      `SELECT search_vector @@ to_tsquery('simple', 'zzbodyonlytokenb') AS hit
         FROM pages WHERE slug = 'normal-page-simple'`,
    );
    expect(bodyOnlyHit[0]?.hit).toBe(false);
    const titleHit = await engine.executeRaw<{ hit: boolean }>(
      `SELECT search_vector @@ to_tsquery('simple', 'zztitletokenb') AS hit
         FROM pages WHERE slug = 'normal-page-simple'`,
    );
    expect(titleHit[0]?.hit).toBe(true);
  });

  test('large page body (>1MB, high-token-diversity): upgrade to a non-English language does not crash', async () => {
    // Seed bypassing the trigger — under the pre-127 trigger this body
    // would already overflow at insert time (compiled_truth is unbounded
    // regardless of language), so a real v126 install could only have
    // accumulated a row like this via some other path (bulk import,
    // direct restore, etc.). What matters for this regression is what
    // happens when the migration's OWN full-table recompute touches it.
    await installPre127Trigger();
    await engine.executeRaw(`ALTER TABLE pages DISABLE TRIGGER trg_pages_search_vector`);
    const oversized = Array.from({ length: 200_000 }, (_, i) => `token${i.toString(36)}`).join(' ');
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, search_vector)
       VALUES ('default', 'oversized-existing', 'note', 'zzTitleTokenC', $1, to_tsvector('english', 'placeholder'))`,
      [oversized],
    );
    await engine.executeRaw(`ALTER TABLE pages ENABLE TRIGGER trg_pages_search_vector`);

    process.env[ENV_KEY] = 'simple';
    resetFtsLanguageCache();

    // Pre-fix, this next call would throw:
    //   "string is too long for tsvector (2706616 bytes, max 1048575 bytes)"
    // — reproduced against the OLD migration bodies during diagnosis.
    const result = await runMigrations(engine);
    expect(result.applied).toBeGreaterThan(0);

    const src = await getTriggerFunctionSource();
    expect(src).not.toContain('compiled_truth');

    // The oversized row's search_vector must have been backfilled by v128
    // (not left in its placeholder state) and must not carry compiled_truth
    // tokens — matches a fresh install.
    const row = await engine.executeRaw<{ hit_body: boolean; hit_title: boolean }>(
      `SELECT
         search_vector @@ to_tsquery('simple', 'token0') AS hit_body,
         search_vector @@ to_tsquery('simple', 'zztitletokenc') AS hit_title
       FROM pages WHERE slug = 'oversized-existing'`,
    );
    expect(row[0]?.hit_body).toBe(false);
    expect(row[0]?.hit_title).toBe(true);
  }, 30_000);
});

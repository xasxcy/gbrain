/**
 * FORK: a source's `sources.config.exclude_paths` must gate the FULL walk with
 * the same predicate the incremental diff uses.
 *
 * The incremental path matches each entry as itself AND as a subtree
 * (`dir` → `dir`, `dir/**`). The full walk used to hand the raw entries to
 * runImport's glob filter, where a bare directory entry matches only the
 * directory itself and none of the files inside it — so every `sync --full`
 * (and every first sync) imported the excluded trees wholesale.
 *
 * Under test, on every available backend:
 *   1. a first sync (full walk) skips files under a bare `dir` entry and a
 *      trailing-slash `trail/` entry, at any depth, without over-matching a
 *      sibling that only shares the prefix (`dirx/`);
 *   2. `--full --dry-run` counts the same set the real walk imports;
 *   3. the incremental diff excludes the same set;
 *   4. an explicit `--full` re-walk skips a newly-added excluded file and does
 *      NOT soft-delete a page imported before the exclusion existed
 *      (exclusion gates imports only; the reconcile walk carries no exclude).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { runSources } from '../src/commands/sources.ts';
import { matchesAnyGlob } from '../src/core/sync.ts';
import { sourceExcludeGlobs } from '../src/commands/sync/full.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dirs: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;
// Postgres full sync opens worker connections through DATABASE_URL, so it must name the isolated database.
let postgresUrl: string | undefined;

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine);
    closePostgres = pg.close;
    postgresUrl = pg.databaseUrl;
  }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 60_000);

function write(repo: string, rel: string, body: string): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), body);
}

function commitAll(repo: string, msg: string): void {
  execSync('git add -A', { cwd: repo, stdio: 'pipe' });
  execSync(`git commit -m "${msg}"`, { cwd: repo, stdio: 'pipe' });
}

function makeRepo(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), 'gbrain-src-excl-full-'));
  dirs.push(repo);
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "t@t.com"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });
  for (const [rel, body] of Object.entries(files)) write(repo, rel, body);
  commitAll(repo, 'seed');
  return repo;
}

async function addSource(engine: BrainEngine, excludePaths: string[] | null): Promise<string> {
  const id = `excl-full-${randomUUID().slice(0, 8)}`;
  await runSources(engine, ['add', id, '--no-federated']);
  if (excludePaths) await setExcludePaths(engine, id, excludePaths);
  return id;
}

async function setExcludePaths(engine: BrainEngine, id: string, excludePaths: string[]): Promise<void> {
  await engine.executeRaw(
    `UPDATE sources SET config = config || jsonb_build_object('exclude_paths', $2::text::jsonb) WHERE id = $1`,
    [id, JSON.stringify(excludePaths)],
  );
}

async function liveSlugs(engine: BrainEngine, sourceId: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL ORDER BY slug`,
    [sourceId],
  );
  return rows.map(r => r.slug);
}

/** Every sync runs with an isolated GBRAIN_HOME so the failure ledger never touches the operator's. */
async function sync(engine: BrainEngine, repoPath: string, sourceId: string, extra: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-src-excl-home-'));
  dirs.push(home);
  return withEnv(
    { GBRAIN_HOME: home, DATABASE_URL: engine.kind === 'postgres' ? postgresUrl : undefined, GBRAIN_DATABASE_URL: undefined },
    () => performSync(engine, { repoPath, sourceId, noPull: true, noEmbed: true, noExtract: true, ...extra }),
  );
}

const SEED = {
  'keep/z.md': '# Z\n\nindexed\n',
  'dirx/a.md': '# A\n\nshares the prefix only, indexed\n',
  'dir/x.md': '# X\n\nexcluded by a bare dir entry\n',
  'dir/deep/y.md': '# Y\n\nexcluded at depth\n',
  'trail/t.md': '# T\n\nexcluded by a trailing-slash entry\n',
};

describe('sourceExcludeGlobs — the one predicate both sync paths match', () => {
  test('a bare or trailing-slash entry covers the entry and its whole subtree, nothing wider', () => {
    const globs = sourceExcludeGlobs(['dir', 'trail/', 'notes/skip.md']);
    expect(matchesAnyGlob('dir', globs)).toBe(true);
    expect(matchesAnyGlob('dir/x.md', globs)).toBe(true);
    expect(matchesAnyGlob('dir/deep/y.md', globs)).toBe(true);
    expect(matchesAnyGlob('trail/t.md', globs)).toBe(true);
    expect(matchesAnyGlob('notes/skip.md', globs)).toBe(true);
    expect(matchesAnyGlob('dirx/a.md', globs)).toBe(false);
    expect(matchesAnyGlob('keep/dir/x.md', globs)).toBe(false);
    expect(matchesAnyGlob('notes/kept.md', globs)).toBe(false);
  });

  test('no entries means no exclusion', () => {
    expect(sourceExcludeGlobs([])).toEqual([]);
  });
});

describe('sources.config.exclude_paths on the full-walk path', () => {
  test('first sync skips files under excluded directories at any depth', async () => {
    for (const engine of engines) {
      const repo = makeRepo(SEED);
      const sourceId = await addSource(engine, ['dir', 'trail/']);
      const first = await sync(engine, repo, sourceId);
      expect(first.status).toBe('first_sync');
      expect(await liveSlugs(engine, sourceId)).toEqual(['dirx/a', 'keep/z']);
    }
  }, 120_000);

  test('--full --dry-run counts only the files the real walk would import', async () => {
    for (const engine of engines) {
      const repo = makeRepo(SEED);
      const sourceId = await addSource(engine, ['dir', 'trail/']);
      const dry = await sync(engine, repo, sourceId, { full: true, dryRun: true });
      expect(dry.status).toBe('dry_run');
      expect(dry.added).toBe(2);
      expect(await liveSlugs(engine, sourceId)).toEqual([]);
    }
  }, 120_000);

  test('the incremental delta applies the same predicate', async () => {
    for (const engine of engines) {
      const repo = makeRepo({ 'keep/z.md': SEED['keep/z.md'] });
      const sourceId = await addSource(engine, null);
      expect((await sync(engine, repo, sourceId)).status).toBe('first_sync');

      await setExcludePaths(engine, sourceId, ['dir', 'trail/']);
      write(repo, 'dir/inc.md', '# Inc\n\nexcluded on the incremental diff\n');
      write(repo, 'dir/deep/inc.md', '# Deep inc\n\nexcluded at depth\n');
      write(repo, 'trail/inc.md', '# Trail inc\n\nexcluded by a trailing-slash entry\n');
      write(repo, 'dirx/inc.md', '# Dirx inc\n\nshares the prefix only, indexed\n');
      write(repo, 'keep/inc.md', '# Keep inc\n\nindexed\n');
      commitAll(repo, 'incremental files');

      const inc = await sync(engine, repo, sourceId);
      expect(inc.status).toBe('synced');
      expect(await liveSlugs(engine, sourceId)).toEqual(['dirx/inc', 'keep/inc', 'keep/z']);
    }
  }, 120_000);

  test('an explicit --full re-walk skips new excluded files and keeps pre-exclusion pages live', async () => {
    for (const engine of engines) {
      const repo = makeRepo(SEED);
      // Imported before any exclusion existed — the conservative-posture subject.
      const sourceId = await addSource(engine, null);
      expect((await sync(engine, repo, sourceId)).status).toBe('first_sync');
      expect(await liveSlugs(engine, sourceId)).toContain('dir/x');

      await setExcludePaths(engine, sourceId, ['dir']);
      write(repo, 'dir/new.md', '# New\n\nexcluded on the full re-walk\n');
      write(repo, 'keep/new.md', '# Keep new\n\nindexed on the full re-walk\n');
      commitAll(repo, 'post-exclusion files');

      const full = await sync(engine, repo, sourceId, { full: true });
      expect(['synced', 'first_sync', 'up_to_date']).toContain(full.status);
      const live = await liveSlugs(engine, sourceId);
      expect(live).not.toContain('dir/new');
      expect(live).toContain('keep/new');
      // Exclusion gates imports only: the pre-existing pages are not tombstoned.
      expect(live).toContain('dir/x');
      expect(live).toContain('dir/deep/y');
    }
  }, 180_000);
});

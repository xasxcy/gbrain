/**
 * FORK-FIX (2026-07-22, batch 2, item 3): sync.ts's rename loop
 * (~line 2758) must not write the completion checkpoint when the
 * post-rename reimport never ran at all — only "ran and failed" was
 * covered by the prior fix (batch 1).
 *
 * Two ways the reimport block gets skipped entirely, pre-fix, with
 * `renameImportOk` defaulting to `true` and no entry landing in
 * `failedFiles`:
 *   1. the destination file is missing from the live working tree at
 *      import time (git diff says "renamed here", disk disagrees)
 *   2. the destination path resolves (via realpath) outside
 *      `gitContextRoot` — a symlink escape, TOCTOU-checked the same way
 *      the add/modify path already handles it (sync.ts:2940-ish)
 *
 * `engine.updateSlug()` has ALREADY run by the time either check fires,
 * so pre-fix the OLD page is gone under its old slug, the NEW slug exists
 * with STALE (pre-rename) content, and — because nothing landed in
 * `failedFiles` — the #1939 fail-closed bookmark gate never sees a
 * failure, so `sources.last_commit` advances past the corruption and it
 * becomes permanent (the next sync's git diff no longer even mentions
 * this path).
 *
 * Post-fix: both cases land in `failedFiles`, the gate sees a fresh
 * failure and refuses to advance the bookmark (`status:
 * 'blocked_by_failures'`), and a subsequent sync — once the underlying
 * problem is fixed — re-diffs the SAME commit range and actually
 * reimports.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, symlinkSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
const repos: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterEach(() => {
  while (repos.length) {
    const d = repos.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function personMd(title: string, body: string): string {
  return ['---', 'type: person', `title: ${title}`, '---', '', body].join('\n');
}

function mkRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-rename-ckpt-'));
  repos.push(dir);
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  execSync('git add -A && git commit -m "initial"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

const SYNC_OPTS = { noPull: true, noEmbed: true, noExtract: true, sourceId: 'default' } as const;

async function bookmark(): Promise<string | null> {
  const rows = await engine.executeRaw<{ last_commit: string | null }>(
    `SELECT last_commit FROM sources WHERE id = 'default'`,
  );
  return rows[0]?.last_commit ?? null;
}

describe('rename checkpoint regression — reimport block entirely skipped', () => {
  test('missing destination file: no checkpoint advance, page left stale, failedFiles records it, retry on next sync recovers it', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/carol.md': personMd('Carol', 'Carol original body.') });

    const first = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(first.status).toBe('first_sync');
    expect(await engine.getPage('people/carol')).not.toBeNull();
    const bookmarkAfterFirst = await bookmark();

    // git mv + commit: the diff says people/carol.md -> people/carol2.md
    // (R100), but then the destination is removed from the LIVE working
    // tree without a further commit — importFile reads the live tree, not
    // the git blob, so this reproduces "renamed here, disk disagrees".
    execSync('git mv people/carol.md people/carol2.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename carol"', { cwd: repo, stdio: 'pipe' });
    const renameCommit = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim();
    rmSync(join(repo, 'people/carol2.md'));

    const second = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    // The fail-closed #1939 gate must see this as a fresh failure and
    // refuse to advance the bookmark — this IS the "checkpoint not
    // written" contract at the sync-result level (see sync.ts's `advance`
    // vs. the blocked-return branch: last_commit only moves on `advance`).
    expect(second.status).toBe('blocked_by_failures');
    expect(second.failedFiles).toBeGreaterThanOrEqual(1);
    expect(await bookmark()).toBe(bookmarkAfterFirst);
    expect(await bookmark()).not.toBe(renameCommit);

    // updateSlug already ran (pre-existing batch-1 contract: slug renames
    // even when reimport later fails) — old slug gone, new slug exists but
    // was NEVER reimported (still whatever updateSlug left it as, not a
    // fresh parse of a body that doesn't exist on disk).
    expect(await engine.getPage('people/carol')).toBeNull();

    // Fix the underlying problem (restore the file) and re-sync with NO
    // further git changes — the bookmark never advanced past the rename
    // commit, so the same diff is re-walked and the file is retried.
    writeFileSync(join(repo, 'people/carol2.md'), personMd('Carol', 'Carol original body.'));
    const third = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(third.status).toBe('synced');
    expect(await bookmark()).toBe(renameCommit);
    const recovered = await engine.getPage('people/carol2');
    expect(recovered).not.toBeNull();
    expect(recovered!.compiled_truth).toContain('Carol original body');
  });

  test('symlink-escaping destination: no checkpoint advance, failedFiles records it, retry on next sync recovers it', async () => {
    const { performSync } = await import('../src/commands/sync.ts');
    const repo = mkRepo({ 'people/dave.md': personMd('Dave', 'Dave original body.') });

    const first = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(first.status).toBe('first_sync');
    expect(await engine.getPage('people/dave')).not.toBeNull();
    const bookmarkAfterFirst = await bookmark();

    // Commit an ordinary rename (R100) so the diff is well-formed...
    execSync('git mv people/dave.md people/escaped.md', { cwd: repo, stdio: 'pipe' });
    execSync('git commit -m "rename dave"', { cwd: repo, stdio: 'pipe' });
    const renameCommit = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim();

    // ...then swap the LIVE file for a symlink escaping gitContextRoot,
    // without touching git — the exact TOCTOU shape isPathSafe's docstring
    // describes ("one swapped in after the scope-entry check").
    const secretFile = join(tmpdir(), `gbrain-rename-ckpt-secret-${Date.now()}`);
    writeFileSync(secretFile, 'not part of the repo');
    unlinkSync(join(repo, 'people/escaped.md'));
    symlinkSync(secretFile, join(repo, 'people/escaped.md'));

    const second = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });

    expect(second.status).toBe('blocked_by_failures');
    expect(second.failedFiles).toBeGreaterThanOrEqual(1);
    expect(await bookmark()).toBe(bookmarkAfterFirst);
    expect(await bookmark()).not.toBe(renameCommit);
    expect(await engine.getPage('people/dave')).toBeNull();

    // Fix it: replace the symlink with a real file, re-sync with no
    // further git changes.
    unlinkSync(join(repo, 'people/escaped.md'));
    writeFileSync(join(repo, 'people/escaped.md'), personMd('Dave', 'Dave original body.'));
    const third = await performSync(engine, { repoPath: repo, ...SYNC_OPTS });
    expect(third.status).toBe('synced');
    expect(await bookmark()).toBe(renameCommit);
    const recovered = await engine.getPage('people/escaped');
    expect(recovered).not.toBeNull();
    expect(recovered!.compiled_truth).toContain('Dave original body');

    rmSync(secretFile, { force: true });
  });
});

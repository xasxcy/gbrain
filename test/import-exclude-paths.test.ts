/**
 * Tests for the excludePaths option added to collectSyncableFiles (v0.42.36.1).
 *
 * Validates:
 * 1. Without excludePaths: all markdown files are collected (baseline).
 * 2. Directory prefix is excluded (path === ep || path.startsWith(ep + '/')).
 * 3. Similar-named directory is NOT excluded (no false positives).
 *    e.g. "01-raw/canvas-backup" is not excluded by "01-raw/canvas".
 * 4. Files directly in root matching the prefix are excluded.
 * 5. Nested files under excluded prefix are excluded.
 * 6. Multiple excludePaths entries work independently.
 * 7. Trailing slash in excludePaths entry is normalized (no crash, correct exclusion).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectSyncableFiles } from '../src/commands/import.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-exclude-paths-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function md(dir: string, name: string, content = '# test\n'): string {
  const full = join(dir, name);
  writeFileSync(full, content);
  return full;
}

function mkdir(...parts: string[]): string {
  const p = join(root, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
}

// ────────────────────────────────────────────────────────────────────────────

describe('collectSyncableFiles — excludePaths', () => {

  test('baseline: without excludePaths collects all markdown files', () => {
    const rawDir = mkdir('01-raw');
    const canvasDir = mkdir('01-raw', 'canvas');
    const noteFile = md(root, 'note.md');
    const rawFile = md(rawDir, 'raw.md');
    const canvasFile = md(canvasDir, 'drawing.md');

    const files = collectSyncableFiles(root);
    expect(files).toContain(noteFile);
    expect(files).toContain(rawFile);
    expect(files).toContain(canvasFile);
  });

  test('excludes directory by prefix', () => {
    const canvasDir = mkdir('01-raw', 'canvas');
    const rawDir = mkdir('01-raw');
    const kept = md(rawDir, 'kept.md');
    const excluded = md(canvasDir, 'drawing.md');

    const files = collectSyncableFiles(root, { excludePaths: ['01-raw/canvas'] });
    expect(files).toContain(kept);
    expect(files).not.toContain(excluded);
  });

  test('no false positive: similar-named directory is NOT excluded', () => {
    // "01-raw/canvas-backup" should not be excluded by "01-raw/canvas"
    const canvasDir = mkdir('01-raw', 'canvas');
    const backupDir = mkdir('01-raw', 'canvas-backup');
    const excluded = md(canvasDir, 'in-canvas.md');
    const kept = md(backupDir, 'in-backup.md');

    const files = collectSyncableFiles(root, { excludePaths: ['01-raw/canvas'] });
    expect(files).not.toContain(excluded);
    expect(files).toContain(kept);
  });

  test('excludes nested files under excluded prefix', () => {
    const deepDir = mkdir('01-raw', 'canvas', 'subfolder');
    const excluded = md(deepDir, 'deep.md');
    const other = md(root, 'other.md');

    const files = collectSyncableFiles(root, { excludePaths: ['01-raw/canvas'] });
    expect(files).not.toContain(excluded);
    expect(files).toContain(other);
  });

  test('multiple excludePaths entries work independently', () => {
    const canvasDir = mkdir('01-raw', 'canvas');
    const opsDir = mkdir('ops-notes');
    const normalDir = mkdir('wiki');
    const excl1 = md(canvasDir, 'canvas.md');
    const excl2 = md(opsDir, 'ops.md');
    const kept = md(normalDir, 'wiki.md');

    const files = collectSyncableFiles(root, {
      excludePaths: ['01-raw/canvas', 'ops-notes'],
    });
    expect(files).not.toContain(excl1);
    expect(files).not.toContain(excl2);
    expect(files).toContain(kept);
  });

  test('trailing slash in excludePaths is normalized (no crash, correct exclusion)', () => {
    const canvasDir = mkdir('01-raw', 'canvas');
    const excluded = md(canvasDir, 'drawing.md');
    const kept = md(root, 'root.md');

    // "01-raw/canvas/" with trailing slash should behave the same as "01-raw/canvas"
    const files = collectSyncableFiles(root, { excludePaths: ['01-raw/canvas/'] });
    expect(files).not.toContain(excluded);
    expect(files).toContain(kept);
  });

  test('empty excludePaths has no effect', () => {
    const canvasDir = mkdir('01-raw', 'canvas');
    const file = md(canvasDir, 'drawing.md');

    const files = collectSyncableFiles(root, { excludePaths: [] });
    expect(files).toContain(file);
  });
});

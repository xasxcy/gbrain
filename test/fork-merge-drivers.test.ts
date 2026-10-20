/**
 * FORK: the merge drivers that keep machine-maintained files out of an upstream sync's
 * conflict list (scripts/fork/merge/). Pure three-way cases first, then a real `git merge`
 * in a scratch repository with the drivers installed the way install.sh installs them.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DuplicateKeyError, mergeJsonUnion, mergeKeyedTsv, TSV_SPECS } from '../scripts/fork/merge/merge-lib.ts';

const MODULE = TSV_SPECS['scripts/module-size-limits.tsv']!;
const FUNCTION = TSV_SPECS['scripts/function-size-baseline.tsv']!;
const ENGINE_SQL = TSV_SPECS['scripts/engine-sql-baseline.tsv']!;
const tsv = (...rows: string[][]) => rows.map(r => r.join('\t')).join('\n') + '\n';

describe('mergeKeyedTsv', () => {
  test('a row only one side changed takes that side', () => {
    const base = tsv(['a.ts', '100', 'ratchet', 'seed'], ['b.ts', '200', 'ratchet', 'seed']);
    const ours = tsv(['a.ts', '110', 'ratchet', 'seed; +10 fork'], ['b.ts', '200', 'ratchet', 'seed']);
    const theirs = tsv(['a.ts', '100', 'ratchet', 'seed'], ['b.ts', '150', 'ratchet', 'seed; lowered']);
    expect(mergeKeyedTsv(base, ours, theirs, MODULE)).toEqual({
      text: tsv(['a.ts', '110', 'ratchet', 'seed; +10 fork'], ['b.ts', '150', 'ratchet', 'seed; lowered']), conflicts: 0,
    });
  });

  test('a row both sides changed keeps the fork delta on upstream ceiling and appends the fork reason', () => {
    const base = tsv(['a.ts', '100', 'ratchet', 'seed']);
    const ours = tsv(['a.ts', '112', 'ratchet', 'seed; +12 FORK pgroonga']);
    const theirs = tsv(['a.ts', '90', 'ratchet', 'seed; lowered: peel']);
    expect(mergeKeyedTsv(base, ours, theirs, MODULE)).toEqual({
      text: tsv(['a.ts', '102', 'ratchet', 'seed; lowered: peel; +12 FORK pgroonga']), conflicts: 0,
    });
  });

  test('two-column keys, fork-only rows keep their place, upstream deletions stand', () => {
    const base = tsv(['path', 'name', 'lines', 'justification'], ['x.ts', 'f', '400', 'seed'], ['y.ts', 'g', '350', 'seed']);
    const ours = tsv(['path', 'name', 'lines', 'justification'], ['x.ts', 'f', '400', 'seed'], ['x.ts', 'h', '320', 'FORK'], ['y.ts', 'g', '350', 'seed']);
    const theirs = tsv(['path', 'name', 'lines', 'justification'], ['x.ts', 'f', '400', 'seed']);
    expect(mergeKeyedTsv(base, ours, theirs, FUNCTION)).toEqual({
      text: tsv(['path', 'name', 'lines', 'justification'], ['x.ts', 'f', '400', 'seed'], ['x.ts', 'h', '320', 'FORK']), conflicts: 0,
    });
  });

  test('a row the fork changed and upstream deleted is a marked conflict', () => {
    const base = tsv(['a.ts', '100', 'ratchet', 'seed']);
    const ours = tsv(['a.ts', '110', 'ratchet', 'seed; +10']);
    const out = mergeKeyedTsv(base, ours, '', MODULE);
    expect(out.conflicts).toBe(1);
    expect(out.text).toBe('<<<<<<< fork\na.ts\t110\tratchet\tseed; +10\n=======\n>>>>>>> upstream\n');
  });

  test('a fork row ahead of every retained row stays ahead (sorted files keep their order)', () => {
    const base = tsv(['b.ts', 'g', '400', 'seed']);
    const ours = tsv(['a.ts', 'f', '320', 'FORK'], ['b.ts', 'g', '400', 'seed']);
    const theirs = tsv(['b.ts', 'g', '380', 'seed; lowered']);
    expect(mergeKeyedTsv(base, ours, theirs, FUNCTION).text).toBe(tsv(['a.ts', 'f', '320', 'FORK'], ['b.ts', 'g', '380', 'seed; lowered']));
  });

  test('a numeric change both sides made identically is not applied twice', () => {
    const base = tsv(['a.ts', '100', 'ratchet', 'seed']);
    const out = mergeKeyedTsv(base, tsv(['a.ts', '110', 'ratchet', 'seed']), tsv(['a.ts', '110', 'ratchet', 'seed; note']), MODULE);
    expect(out).toEqual({ text: tsv(['a.ts', '110', 'ratchet', 'seed; note']), conflicts: 0 });
  });

  test('engine-sql rows of one file are distinct rows (whole-row key)', () => {
    const base = tsv(['migrated', 'facts'], ['method', 'src/core/pglite-engine.ts', 'PGLiteEngine.a'], ['method', 'src/core/pglite-engine.ts', 'PGLiteEngine.b']);
    const ours = tsv(['migrated', 'facts'], ['method', 'src/core/pglite-engine.ts', 'PGLiteEngine.a'], ['method', 'src/core/pglite-engine.ts', 'PGLiteEngine.b'], ['method', 'src/core/pglite-engine.ts', 'PGLiteEngine.fork']);
    const theirs = tsv(['migrated', 'facts'], ['migrated', 'links'], ['method', 'src/core/pglite-engine.ts', 'PGLiteEngine.b']);
    expect(mergeKeyedTsv(base, ours, theirs, ENGINE_SQL)).toEqual({
      text: tsv(['migrated', 'facts'], ['migrated', 'links'], ['method', 'src/core/pglite-engine.ts', 'PGLiteEngine.b'], ['method', 'src/core/pglite-engine.ts', 'PGLiteEngine.fork']), conflicts: 0,
    });
  });

  test('two rows under one key are refused, never silently dropped', () => {
    const dup = tsv(['a.ts', '100', 'ratchet', 'seed'], ['a.ts', '90', 'ratchet', 'other']);
    expect(() => mergeKeyedTsv(dup, dup, dup, MODULE)).toThrow(DuplicateKeyError);
  });

  test('a reason both sides rewrote (not an append) is a conflict', () => {
    const base = tsv(['a.ts', '100', 'ratchet', 'seed']);
    const out = mergeKeyedTsv(base, tsv(['a.ts', '100', 'ratchet', 'fork text']), tsv(['a.ts', '100', 'ratchet', 'upstream text']), MODULE);
    expect(out.conflicts).toBe(1);
  });
});

describe('mergeJsonUnion', () => {
  test('upstream values, plus fork-added keys, minus fork-deleted keys', () => {
    const base = JSON.stringify({ 'a.test.ts': 1, 'b.test.ts': 2, 'gone.test.ts': 9 }, null, 2) + '\n';
    const ours = JSON.stringify({ 'a.test.ts': 1, 'b.test.ts': 2, 'fork.test.ts': 5 }, null, 2) + '\n';
    const theirs = JSON.stringify({ 'a.test.ts': 7, 'b.test.ts': 2, 'gone.test.ts': 9, 'new.test.ts': 3 }, null, 2) + '\n';
    const out = mergeJsonUnion(base, ours, theirs);
    expect(out.conflicts).toBe(0);
    expect(JSON.parse(out.text)).toEqual({ 'a.test.ts': 7, 'b.test.ts': 2, 'fork.test.ts': 5, 'new.test.ts': 3 });
    expect(Object.keys(JSON.parse(out.text))).toEqual(['a.test.ts', 'b.test.ts', 'fork.test.ts', 'new.test.ts']);
    expect(out.text.endsWith('}\n')).toBe(true);
  });

  test('unparsable input is a conflict', () => {
    expect(mergeJsonUnion('{}', '{', '{}').conflicts).toBe(1);
  });
});

describe('drivers in a real git merge', () => {
  const REPO = resolve(import.meta.dir, '..');
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
  };

  test('generated, ratchet and weight files merge without conflicts; a source conflict still stops', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fork-merge-drivers-'));
    git(dir, 'init', '-q', '-b', 'fork');
    mkdirSync(join(dir, 'scripts/fork/merge'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    for (const f of ['driver.ts', 'merge-lib.ts', 'attributes', 'install.sh']) writeFileSync(join(dir, 'scripts/fork/merge', f), readFileSync(join(REPO, 'scripts/fork/merge', f)));
    const put = (files: Record<string, string>) => { for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c); };
    put({
      'scripts/module-size-limits.tsv': tsv(['src/a.ts', '100', 'ratchet', 'seed']),
      'scripts/test-weights.json': '{\n  "test/a.test.ts": 1\n}\n',
      'src/x.generated.ts': 'export const X = 1;\n',
      'src/code.ts': 'export const v = 1;\n',
    });
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
    git(dir, 'checkout', '-qb', 'upstream');
    put({
      'scripts/module-size-limits.tsv': tsv(['src/a.ts', '90', 'ratchet', 'seed; lowered']),
      'scripts/test-weights.json': '{\n  "test/a.test.ts": 4\n}\n',
      'src/x.generated.ts': 'export const X = 2;\n',
      'src/code.ts': 'export const v = 2;\n',
    });
    git(dir, 'commit', '-qam', 'upstream');
    git(dir, 'checkout', '-q', 'fork');
    put({
      'scripts/module-size-limits.tsv': tsv(['src/a.ts', '105', 'ratchet', 'seed; +5 FORK']),
      'scripts/test-weights.json': '{\n  "test/a.test.ts": 1,\n  "test/fork.test.ts": 2\n}\n',
      'src/x.generated.ts': 'export const X = 3;\n',
      'src/code.ts': 'export const v = 3;\n',
    });
    git(dir, 'commit', '-qam', 'fork');
    const install = spawnSync('bash', ['scripts/fork/merge/install.sh'], { cwd: dir, encoding: 'utf8' });
    expect(install.status).toBe(0);

    git(dir, 'merge', '--no-edit', 'upstream');
    const unmerged = git(dir, 'diff', '--name-only', '--diff-filter=U').out.trim().split('\n').filter(Boolean);
    expect(unmerged).toEqual(['src/code.ts']);
    expect(readFileSync(join(dir, 'scripts/module-size-limits.tsv'), 'utf8')).toBe(tsv(['src/a.ts', '95', 'ratchet', 'seed; lowered; +5 FORK']));
    expect(JSON.parse(readFileSync(join(dir, 'scripts/test-weights.json'), 'utf8'))).toEqual({ 'test/a.test.ts': 4, 'test/fork.test.ts': 2 });
    expect(readFileSync(join(dir, 'src/x.generated.ts'), 'utf8')).toBe('export const X = 2;\n');
  }, 60_000);
});

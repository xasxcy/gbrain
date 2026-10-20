#!/usr/bin/env bun
/**
 * FORK: git merge driver entry point (installed by scripts/fork/merge/install.sh).
 *
 *   bun scripts/fork/merge/driver.ts <tsv|json-union|theirs> %O %A %B %P
 *
 * %O base, %A the fork's version (the merge result is written here), %B
 * upstream's, %P the path. Exit 0 = merged cleanly, 1 = conflict left in %A.
 * `theirs` takes upstream's bytes for a generated file; after-merge.sh
 * regenerates it from the merged sources.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DuplicateKeyError, mergeJsonUnion, mergeKeyedTsv, TSV_SPECS, type MergeOutcome } from './merge-lib.ts';

const [kind, base, ours, theirs, path] = process.argv.slice(2);
if (!kind || !base || !ours || !theirs) {
  console.error('usage: driver.ts <tsv|json-union|theirs> %O %A %B %P');
  process.exit(2);
}
const read = (f: string) => readFileSync(f, 'utf8');

/** Plain three-way text merge into %A (git's own behaviour), for a file a driver has no rule for. */
function textMerge(): number {
  return spawnSync('git', ['merge-file', '-L', 'fork', '-L', 'base', '-L', 'upstream', ours!, base!, theirs!], { stdio: 'inherit' }).status === 0 ? 0 : 1;
}

let code: number;
if (kind === 'theirs') {
  copyFileSync(theirs, ours);
  code = 0;
} else if (kind === 'tsv') {
  const spec = path ? TSV_SPECS[path] : undefined;
  let out: MergeOutcome | null = null;
  if (spec) {
    try { out = mergeKeyedTsv(read(base), read(ours), read(theirs), spec); }
    catch (err) {
      if (!(err instanceof DuplicateKeyError)) throw err;
      console.error(`[fork-merge] ${path}: ${err.message}; falling back to a text merge`);
    }
  }
  if (!out) code = textMerge();
  else {
    writeFileSync(ours, out.text);
    code = out.conflicts ? 1 : 0;
    if (out.conflicts) console.error(`[fork-merge] ${path}: ${out.conflicts} row(s) changed differently on both sides; resolve the marked rows`);
  }
} else if (kind === 'json-union') {
  const out = mergeJsonUnion(read(base), read(ours), read(theirs));
  if (out.conflicts) code = textMerge();
  else { writeFileSync(ours, out.text); code = 0; }
} else {
  console.error(`[fork-merge] unknown driver kind ${kind}`);
  code = 2;
}
process.exit(code);

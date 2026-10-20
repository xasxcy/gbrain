/**
 * FORK: three-way merges for machine-maintained files, so an upstream sync
 * does not stop on files nobody should hand-merge.
 *
 * - `mergeKeyedTsv`: ratchet/baseline TSVs (`scripts/*.tsv`). Rows are keyed
 *   by their first `keyCols` columns. A row only one side changed takes that
 *   side; a row both sides changed takes upstream's row with the fork's delta
 *   on the numeric column (`upstream + (fork - base)`) and the fork's appended
 *   justification text. Anything else is a conflict, written with the usual
 *   markers around that row only.
 * - `mergeJsonUnion`: shard-weight JSONs. Upstream's object, plus the keys the
 *   fork added, minus the keys the fork deleted.
 *
 * A file with two rows under one key is not merged here (`DuplicateKeyError`):
 * the driver falls back to git's text merge rather than drop a row.
 *
 * The ratchet checks (`bun run verify`) still judge the merged numbers against
 * the merged code, so a delta that no longer fits fails loudly after the merge.
 */

export interface TsvSpec {
  /** Columns that identify a row. */
  keyCols: number;
  /** 0-based numeric column that carries a ceiling/count, or -1. */
  numCol: number;
  /** 0-based free-text column a fork appends its reason to, or -1. */
  textCol: number;
}

export interface MergeOutcome {
  text: string;
  conflicts: number;
}

interface Parsed {
  /** Leading comment/header lines (`#…` or a `path\t…` header row). */
  head: string[];
  rows: Map<string, string>;
  order: string[];
  trailingNewline: boolean;
}

const HEADER = /^(path|kind|name)\t/;

export class DuplicateKeyError extends Error {}

function parseTsv(text: string, spec: TsvSpec): Parsed {
  const trailingNewline = text.endsWith('\n');
  const lines = text === '' ? [] : text.split('\n');
  if (trailingNewline) lines.pop();
  const head: string[] = [];
  const rows = new Map<string, string>();
  const order: string[] = [];
  for (const line of lines) {
    if (rows.size === 0 && (line.startsWith('#') || HEADER.test(line) || line === '')) { head.push(line); continue; }
    const key = line.split('\t').slice(0, spec.keyCols).join('\t');
    if (rows.has(key)) throw new DuplicateKeyError(`duplicate row key: ${key}`);
    rows.set(key, line);
    order.push(key);
  }
  return { head, rows, order, trailingNewline };
}

/** Both sides changed one row: upstream's row with the fork's numeric delta and appended reason, or null. */
function combineRow(base: string, ours: string, theirs: string, spec: TsvSpec): string | null {
  const o = base.split('\t');
  const a = ours.split('\t');
  const b = theirs.split('\t');
  if (a.length !== o.length || b.length !== o.length) return null;
  const out = [...b];
  for (let i = spec.keyCols; i < o.length; i++) {
    if (a[i] === o[i] || a[i] === b[i]) continue; // fork left it alone, or both made the same change
    if (b[i] === o[i]) { out[i] = a[i]!; continue; } // only the fork changed it
    if (i === spec.numCol) {
      const [on, an, bn] = [Number(o[i]), Number(a[i]), Number(b[i])];
      if (![on, an, bn].every(Number.isFinite)) return null;
      out[i] = String(bn + (an - on));
      continue;
    }
    if (i === spec.textCol && a[i]!.startsWith(o[i]!)) {
      out[i] = b[i]! + a[i]!.slice(o[i]!.length);
      continue;
    }
    return null;
  }
  return out.join('\t');
}

export function mergeKeyedTsv(baseText: string, oursText: string, theirsText: string, spec: TsvSpec): MergeOutcome {
  const base = parseTsv(baseText, spec);
  const ours = parseTsv(oursText, spec);
  const theirs = parseTsv(theirsText, spec);
  let conflicts = 0;
  const merged = new Map<string, string>();
  const keys = new Set([...theirs.order, ...ours.order, ...base.order]);
  for (const key of keys) {
    const o = base.rows.get(key);
    const a = ours.rows.get(key);
    const b = theirs.rows.get(key);
    let row: string | undefined | null;
    if (a === b) row = a;
    else if (a === o) row = b; // only upstream changed (or deleted) it
    else if (b === o) row = a; // only the fork changed (added, deleted) it
    else if (o !== undefined && a !== undefined && b !== undefined) row = combineRow(o, a, b, spec);
    else row = null; // added differently on both sides, or deleted on one side and changed on the other
    if (row === null) {
      conflicts++;
      merged.set(key, ['<<<<<<< fork', ...(a === undefined ? [] : [a]), '=======', ...(b === undefined ? [] : [b]), '>>>>>>> upstream'].join('\n'));
    } else if (row !== undefined) merged.set(key, row);
  }
  // Upstream's order, with each fork-only row placed after the row that precedes it in the fork's file
  // (or, with no placed predecessor, before the row that follows it).
  const order = theirs.order.filter(k => merged.has(k));
  for (const [i, key] of ours.order.entries()) {
    if (!merged.has(key) || order.includes(key)) continue;
    let at = -1;
    for (let j = i - 1; j >= 0 && at < 0; j--) {
      const p = order.indexOf(ours.order[j]!);
      if (p >= 0) at = p + 1;
    }
    for (let j = i + 1; j < ours.order.length && at < 0; j++) {
      const p = order.indexOf(ours.order[j]!);
      if (p >= 0) at = p;
    }
    order.splice(at < 0 ? order.length : at, 0, key);
  }
  for (const key of merged.keys()) if (!order.includes(key)) order.push(key);
  const head = theirs.head.length ? theirs.head : ours.head;
  const lines = [...head, ...order.map(k => merged.get(k)!)];
  return { text: lines.join('\n') + (theirs.trailingNewline || ours.trailingNewline ? '\n' : ''), conflicts };
}

export function mergeJsonUnion(baseText: string, oursText: string, theirsText: string): MergeOutcome {
  const parse = (t: string): Record<string, unknown> => (t.trim() ? JSON.parse(t) : {});
  let base: Record<string, unknown>, ours: Record<string, unknown>, theirs: Record<string, unknown>;
  try { [base, ours, theirs] = [parse(baseText), parse(oursText), parse(theirsText)]; }
  catch { return { text: oursText, conflicts: 1 }; }
  const out: Record<string, unknown> = { ...theirs };
  for (const [k, v] of Object.entries(ours)) if (!(k in base) && !(k in theirs)) out[k] = v;
  for (const k of Object.keys(base)) if (!(k in ours) && k in out && JSON.stringify(out[k]) === JSON.stringify(base[k])) delete out[k];
  const sorted = Object.keys(theirs).join('\u0000') === Object.keys(theirs).sort().join('\u0000');
  const keys = sorted ? Object.keys(out).sort() : Object.keys(out);
  const indent = /^\{\n( +)"/.exec(theirsText)?.[1]?.length ?? 2;
  return { text: JSON.stringify(Object.fromEntries(keys.map(k => [k, out[k]])), null, indent) + (theirsText.endsWith('\n') ? '\n' : ''), conflicts: 0 };
}

/** Per-file TSV specs (0-based columns). A TSV not listed here is merged as text by git. */
export const TSV_SPECS: Record<string, TsvSpec> = {
  'scripts/module-size-limits.tsv': { keyCols: 1, numCol: 1, textCol: 3 },
  'scripts/function-size-baseline.tsv': { keyCols: 2, numCol: 2, textCol: 3 },
  'scripts/chunk-visibility-baseline.tsv': { keyCols: 1, numCol: 1, textCol: -1 },
  'scripts/item-allowlist-catches-baseline.tsv': { keyCols: 1, numCol: 1, textCol: -1 },
  'scripts/serial-files.tsv': { keyCols: 1, numCol: -1, textCol: 2 },
  // Rows are `migrated<TAB>domain` or `method<TAB>path<TAB>Name`: the whole row is the key.
  'scripts/engine-sql-baseline.tsv': { keyCols: 3, numCol: -1, textCol: -1 },
  'scripts/guards-manifest.tsv': { keyCols: 1, numCol: -1, textCol: 3 },
};

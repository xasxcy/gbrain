/**
 * FORK-ONLY. Guards the seam between upstream's `migrate.ts` and the fork's
 * `fork-migrations.ts`.
 *
 * The bodies of the fork's migrations were moved out of `migrate.ts` so the
 * upstream sync script never has to carry migration text through three
 * quoting layers (it silently corrupted an escape on 2026-08-16). What the
 * script still has to do is three fixed edits to `migrate.ts`: an import, a
 * `MIGRATIONS.push(...)`, and one `export` keyword.
 *
 * Every one of those can silently no-op, and the two most likely failures are
 * both invisible at runtime:
 *
 *   1. The push lands AFTER `export const LATEST_VERSION = Math.max(...)`.
 *      LATEST_VERSION then computes over the upstream-only array — 130 instead
 *      of 137 — and `runMigrations`' `m.version > current` filter drops every
 *      fork migration out of `pending`. No error, no warning: exactly the
 *      computed-high-water silent-exclusion class that ADR-087 exists about.
 *   2. The push is dropped entirely and the fork's migrations just aren't
 *      there.
 *
 * Per ADR-087 ⑤ the guard belongs on the OUTCOME (what the registry actually
 * contains) rather than on the edits, because a checker that greps for the
 * edits passes on an empty result.
 */
import { describe, expect, test } from 'bun:test';
import { MIGRATIONS, LATEST_VERSION } from '../src/core/migrate.ts';
import { FORK_MIGRATION_FLOOR } from '../src/core/fork-migrations.ts';

describe('fork migration registry seam', () => {
  test('LATEST_VERSION is computed AFTER the fork migrations are pushed', () => {
    // The failure this catches is LATEST_VERSION === max(upstream) while the
    // array already holds higher fork versions.
    expect(LATEST_VERSION).toBe(Math.max(...MIGRATIONS.map(m => m.version)));
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(FORK_MIGRATION_FLOOR);
  });

  test('the fork migrations are present and contiguous from the floor', () => {
    const forkVersions = MIGRATIONS
      .filter(m => m.version >= FORK_MIGRATION_FLOOR)
      .map(m => m.version)
      .sort((a, b) => a - b);

    expect(forkVersions.length).toBeGreaterThan(0);
    // Contiguous: a gap means a migration was dropped during a renumber.
    const expected = Array.from(
      { length: forkVersions.length },
      (_, i) => FORK_MIGRATION_FLOOR + i,
    );
    expect(forkVersions).toEqual(expected);
  });

  test('no duplicate version numbers anywhere in the registry', () => {
    // A duplicate is not a numbering-hygiene nit: runMigrations gates on a
    // single high-water integer, so the second entry under a shared number is
    // masked permanently. That is how upstream v125 went unapplied for weeks
    // while the brain reported schema_version 136 (ADR-087 补充).
    const versions = MIGRATIONS.map(m => m.version);
    const duplicates = versions.filter((v, i) => versions.indexOf(v) !== i);
    expect(duplicates).toEqual([]);
  });

  test('every fork migration declares idempotent: true', () => {
    // Renumbering on each upstream sync means a brain that already ran one of
    // these under an older number runs the same DDL again under the new one.
    // ADR-087 ③ makes real idempotency the precondition for the whole scheme.
    const notIdempotent = MIGRATIONS
      .filter(m => m.version >= FORK_MIGRATION_FLOOR && m.idempotent !== true)
      .map(m => `${m.version}:${m.name}`);
    expect(notIdempotent).toEqual([]);
  });
});

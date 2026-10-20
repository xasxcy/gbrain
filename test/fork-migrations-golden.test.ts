/**
 * FORK-ONLY. Full-record golden for the fork's own migrations (FORK_MIGRATIONS, counter `fork_schema_version`).
 *
 * Protects: the published fork migrations are frozen. Their number, name, SQL, flags and normalized handler/verify
 * source (with the helpers they reach) must never change once a brain may have run them; new fork migrations only
 * append. The upstream golden (test/migrations-golden.test.ts) covers MIGRATIONS and stays byte-for-byte upstream's
 * apart from the fork's edits to upstream migrations.
 * Fails when: a fork migration is edited, renumbered, dropped or reordered, or one is appended without
 * regenerating this golden (GBRAIN_TEST_UPDATE_GOLDENS=1).
 */

import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { FORK_MIGRATIONS } from '../src/core/migrate.ts';
import { FORK_LATEST_VERSION } from '../src/core/fork-migrations.ts';
import { defineNormalizer, expectGolden, expectNormalizerStable } from './helpers/golden.ts';
import { buildMigrationsGolden, type MigrationsGolden } from './helpers/migration-records.ts';

const FORK_MIGRATIONS_TS = resolve(import.meta.dir, '..', 'src/core/fork-migrations.ts');
const normalizer = defineNormalizer('fork-migrations-record-v1', (g: MigrationsGolden) => g);

describe('fork migrations full-record golden', () => {
  test('all FORK_MIGRATIONS records match the golden', async () => {
    const golden = await expectNormalizerStable(
      () => buildMigrationsGolden(FORK_MIGRATIONS, [FORK_MIGRATIONS_TS]),
      normalizer,
    );
    expect(golden.count).toBe(FORK_MIGRATIONS.length);
    expect(golden.latest).toBe(FORK_LATEST_VERSION);
    expect(golden.gaps).toEqual([]);
    expectGolden('migrations/fork-records', golden, normalizer);
  }, 60_000);
});

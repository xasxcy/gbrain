import type { BrainEngine } from './engine.ts';
import { LATEST_SCHEMA_VERSION } from './schema-migrations/latest.generated.ts';
// FORK: fork migrations run on their own counter (fork-migrations.ts), so both counters gate "pending".
import { FORK_COUNTER_KEY, FORK_LATEST_VERSION } from './fork-migrations.ts';

/**
 * Cheap probe: does this engine have schema migrations pending?
 *
 * Reads the `version` config row in a single round-trip (no schema replay,
 * no migration apply) and compares it with the generated latest version, so
 * it never loads the migration modules themselves (migrate.ts does; it
 * re-exports this). Used by `connectEngine` to gate `initSchema()` so
 * short-lived CLI invocations on already-migrated brains don't pay the
 * full bootstrap-probe + SCHEMA_SQL replay + ledger-check cost on every
 * `gbrain stats` / `gbrain query` / `gbrain doctor`.
 *
 * Defensive: treats a getConfig failure (config table missing, query error)
 * as "yes pending" so the caller falls through to the full initSchema path.
 * Worst case on a wedged brain is one extra schema replay — same as before.
 *
 * Closes #651 in cooperation with the post-upgrade auto-apply hook (X1)
 * without the perf cost #652 would have introduced on every CLI call.
 */
export async function hasPendingMigrations(engine: BrainEngine): Promise<boolean> {
  try {
    const currentStr = await engine.getConfig('version');
    const current = parseInt(currentStr || '1', 10);
    if (current < LATEST_SCHEMA_VERSION) return true;
    // FORK: a missing fork key is a brain the counter has not adopted yet (adoption runs inside runMigrations).
    const forkStr = await engine.getConfig(FORK_COUNTER_KEY);
    return forkStr === null || parseInt(forkStr, 10) < FORK_LATEST_VERSION;
  } catch {
    return true;
  }
}

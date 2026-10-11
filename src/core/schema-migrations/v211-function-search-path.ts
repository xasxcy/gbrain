import { FACT_FINGERPRINT_FUNCTION_STATEMENTS } from '../facts/withdrawal-schema.ts';
import type { Migration } from './types.ts';
import { migrationNotice } from './helpers.ts';
import type { BrainEngine } from '../engine.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #5190: every gbrain plpgsql function pins `search_path = pg_catalog, public`,
// so an unqualified reference in its body never resolves through a caller's
// search_path. Existing brains are ALTERed by regprocedure (functions with
// arguments included) wherever no setting is pinned yet; the definition
// sources carry the same SET for fresh installs and CREATE OR REPLACE
// re-applies. The fact fingerprint SQL functions stay inlinable for their
// index expression, so they are re-created with schema-qualified built-ins
// instead (byte-identical results). Re-running finds nothing left to change.
/** Reports an `auto_enable_rls` the loop below could not pin (it is owned by another role); `notice` is injectable for tests. */
export async function noticeUnpinnedAutoEnableRls(engine: BrainEngine, notice: (line: string) => void = migrationNotice): Promise<void> {
  const rows = await engine.executeRaw<{ fn: string }>(
    `SELECT format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS fn FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'auto_enable_rls' AND p.proconfig IS NULL
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`);
  for (const row of rows) {
    notice(`  v211: ${row.fn} still has no pinned search_path (it is owned by a role other than the one running this migration). As a superuser run: ALTER FUNCTION ${row.fn} SET search_path = pg_catalog, public;\n`);
  }
}

export const v211: Migration = {
  version: 211,
  name: 'function_search_path',
  idempotent: true,
  sql: FACT_FINGERPRINT_FUNCTION_STATEMENTS.join(';\n') + `;
DO $search_path$
DECLARE fn regprocedure; fn_name name;
BEGIN
  FOR fn, fn_name IN
    SELECT p.oid::regprocedure, p.proname FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public' AND l.lanname = 'plpgsql' AND p.proconfig IS NULL
      AND (p.proname LIKE 'gbrain\\_%' OR p.proname = 'auto_enable_rls')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
  LOOP
    BEGIN
      EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public', fn);
    EXCEPTION WHEN insufficient_privilege THEN
      -- Fork: auto_enable_rls backs a superuser-created event trigger, so a non-superuser runtime role
      -- cannot ALTER it; leave it as it was (the handler below reports it). Any OTHER gbrain function
      -- the role cannot alter means its owner really drifted: that still aborts the migration.
      IF fn_name IS DISTINCT FROM 'auto_enable_rls' THEN RAISE; END IF;
    END;
  END LOOP;
END
$search_path$;
`,
  // Fork (R6-6): the default pool drops RAISE WARNING, so the skipped function is reported by the migration
  // itself on stderr, with the one statement a superuser has to run. Nothing to report on PGLite or when pinned.
  handler: async (engine) => { await noticeUnpinnedAutoEnableRls(engine); },
};

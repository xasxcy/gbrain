/**
 * Fork-only migrations for `feature/pgroonga-chinese-fts`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `migrate.ts` is upstream-owned and is replaced wholesale on every upstream
 * sync. The fork's migrations used to be re-injected into that file by the
 * sync script, which carried their bodies as Python string literals inside a
 * shell heredoc — three quoting layers deep. On 2026-08-16 that pipeline
 * silently corrupted an escape (a literal `\n` became a real newline inside a
 * single-quoted TypeScript string) and produced a file that did not parse.
 * Silently: nothing in the injector could detect it.
 *
 * Holding the bodies here instead means the injector's whole job is three
 * fixed edits to `migrate.ts` — an import, a push, and one `export` keyword —
 * with no migration text passing through the quoting layers at all. And the
 * bodies now sit in a normal TypeScript file, so `typecheck` and the test
 * suite cover them.
 *
 * NUMBERING (ADR-087)
 * -------------------
 * Fork migrations are appended at `max(upstream) + 1` and are RENUMBERED on
 * every upstream sync that adds migrations. Upstream's numbers are kept
 * byte-identical so they can never be masked. That renumbering is only safe
 * because every migration below is genuinely idempotent: a brain that already
 * ran one of these under its old number will run the same DDL again under the
 * new one. `idempotent: true` is a claim the SQL itself has to earn.
 *
 * `runMigrations` gates on a single high-water integer, not an applied-set, so
 * an upstream migration that ever shares a number with a fork migration is
 * skipped forever, silently. v136 and v137 repair four such migrations. They
 * look their targets up in the live registry rather than copying DDL, which is
 * why this module takes them as injected dependencies instead of importing
 * `migrate.ts` (that would be a runtime cycle).
 */
import type { BrainEngine } from './engine.ts';
import type { Migration } from './migrate.ts';
// v135 interpolates the configured FTS config name straight into DDL; this is
// the same validated accessor migrate.ts uses for upstream's v123/v124.
import { getFtsLanguage } from './fts-language.ts';

export interface ForkMigrationDeps {
  /** The live MIGRATIONS registry. A getter, not the array: it is still being
   *  built when buildForkMigrations is called. */
  allMigrations: () => Migration[];
  applyOneMigration: (engine: BrainEngine, m: Migration) => Promise<void>;
  migrationNotice: (line: string) => void;
}

/** Lowest version number owned by the fork. Everything below belongs to
 *  upstream and must stay byte-identical to it. */
export const FORK_MIGRATION_FLOOR = 146;

export function buildForkMigrations(deps: ForkMigrationDeps): Migration[] {
  return [
    {
      version: 146,
      name: 'pgroonga_fts_chinese',
      // Postgres-only Chinese and mixed CJK keyword search. PGLite cannot load
      // extensions, so it keeps the existing tsvector / CJK ILIKE fallback path.
      idempotent: true,
      sql: '',
      sqlFor: {
        postgres: `
          CREATE EXTENSION IF NOT EXISTS pgroonga;
          CREATE INDEX IF NOT EXISTS idx_content_chunks_pgroonga
            ON content_chunks
            USING pgroonga (chunk_text)
            WITH (tokenizer='TokenBigram("unify_alphabet", true)');
        `,
        pglite: ``,
      },
    },
    {
      version: 147,
      name: 'files_source_id_storage_path_unique',
      // FORK-FIX: files had UNIQUE(storage_path) which is global across sources.
      // Two sources importing the same relative path would fight over one row,
      // causing cross-source metadata misassociation. Replace with composite key.
      idempotent: true,
      sql: '',
      sqlFor: {
        postgres: `
          DO $$ BEGIN
            ALTER TABLE files DROP CONSTRAINT IF EXISTS files_storage_path_key;
            ALTER TABLE files DROP CONSTRAINT IF EXISTS files_source_storage_key;
            ALTER TABLE files ADD CONSTRAINT files_source_storage_key
              UNIQUE (source_id, storage_path);
          EXCEPTION WHEN duplicate_table THEN NULL;
                   WHEN duplicate_object THEN NULL;
          END $$;
        `,
        pglite: `
          ALTER TABLE files DROP CONSTRAINT IF EXISTS files_storage_path_key;
          ALTER TABLE files DROP CONSTRAINT IF EXISTS files_source_storage_key;
          ALTER TABLE files ADD CONSTRAINT files_source_storage_key
            UNIQUE (source_id, storage_path);
        `,
      },
    },
    {
      version: 148,
      name: 'repair_code_edges_source_backfill_skipped_by_fork_renumber',
      // Fork DBs stamped at v116 (pgroonga) skipped upstream v116
      // (code_edges_source_backfill_and_callee_index). This repair applies
      // the same idempotent DDL to preserve full gbrain call-graph functionality.
      idempotent: true,
      sql: `
        UPDATE code_edges_symbol e
           SET source_id = COALESCE(p.source_id, 'default')
          FROM content_chunks c
          JOIN pages p ON p.id = c.page_id
         WHERE c.id = e.from_chunk_id
           AND e.source_id IS NULL;

        UPDATE code_edges_chunk e
           SET source_id = COALESCE(p.source_id, 'default')
          FROM content_chunks c
          JOIN pages p ON p.id = c.page_id
         WHERE c.id = e.from_chunk_id
           AND e.source_id IS NULL;

        CREATE INDEX IF NOT EXISTS idx_code_edges_symbol_from_symbol
          ON code_edges_symbol (from_symbol_qualified);

        CREATE INDEX IF NOT EXISTS idx_code_edges_chunk_from_symbol
          ON code_edges_chunk (from_symbol_qualified);
      `,
    },
    {
      version: 149,
      name: 'embed_failures_ledger',
      // Current-state retry ledger for partial stale embedding. The DDL is
      // intentionally identical to the fresh schemas and safe to replay.
      idempotent: true,
      sql: `
        CREATE TABLE IF NOT EXISTS embed_failures (
          source_id           TEXT NOT NULL,
          page_id             BIGINT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
          slug                TEXT NOT NULL,
          chunk_index         INT NOT NULL,
          embedding_signature TEXT NOT NULL,
          chunk_hash          TEXT NOT NULL,
          error_class         TEXT NOT NULL,
          error_fingerprint   TEXT NOT NULL,
          attempt_count       INT NOT NULL DEFAULT 1,
          first_seen          TIMESTAMPTZ NOT NULL,
          last_seen           TIMESTAMPTZ NOT NULL,
          next_retry_at       TIMESTAMPTZ NOT NULL,
          quarantined_at      TIMESTAMPTZ,
          quarantine_reason   TEXT,
          PRIMARY KEY (source_id, page_id, chunk_index, embedding_signature, chunk_hash)
        );
        CREATE INDEX IF NOT EXISTS embed_failures_active_idx
          ON embed_failures (page_id, chunk_index, embedding_signature, chunk_hash);
      `,
      verify: async (engine) => {
        const rows = await engine.executeRaw<{ table_exists: boolean; index_exists: boolean }>(
          `SELECT to_regclass('public.embed_failures') IS NOT NULL AS table_exists,
                  to_regclass('public.embed_failures_active_idx') IS NOT NULL AS index_exists`,
        );
        return rows[0]?.table_exists === true && rows[0]?.index_exists === true;
      },
    },
    {
      version: 150,
      name: 'fork_page_search_vector_final_trigger_and_batched_backfill',
      idempotent: true,
      sql: '',
      handler: async (engine) => {
        // Fork-only. Upstream's v123/v124 pair leaves two defects that upstream
        // has not fixed: v123 still builds search_vector from compiled_truth (an
        // unbounded whole-page body) and full-table-backfills it for non-English
        // languages, which overflows Postgres's 1MB tsvector cap on large pages
        // ('string is too long for tsvector') and aborts the migration; and v124
        // only does CREATE OR REPLACE, never touching existing rows, so upgraded
        // brains keep compiled_truth baked into search_vector forever.
        //
        // This migration is the fork's standing repair for both. It lives here
        // rather than as an edit to v123/v124 so the upstream half of this file
        // stays byte-identical and the automated sync stops conflicting on it.
        const lang = getFtsLanguage();
        await engine.executeRaw(`
          CREATE OR REPLACE FUNCTION update_page_search_vector() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
          DECLARE timeline_text TEXT;
          BEGIN
            SELECT coalesce(string_agg(summary || ' ' || detail, ' '), '') INTO timeline_text FROM timeline_entries WHERE page_id = NEW.id;
            NEW.search_vector := setweight(to_tsvector('${lang}', coalesce(NEW.title, '')), 'A') || setweight(to_tsvector('${lang}', coalesce(NEW.timeline, '')), 'C') || setweight(to_tsvector('${lang}', coalesce(timeline_text, '')), 'C');
            RETURN NEW;
          END;
          $fn$ LANGUAGE plpgsql;
        `);
        // Explicit, batched backfill of every existing row whose search_vector
        // is non-null — regardless of language. Pre-fix, this step only did
        // CREATE OR REPLACE and never touched existing rows, so upgraded
        // brains kept compiled_truth baked into search_vector forever (page/
        // title-arm hits on body text, double-counted against the chunk arm
        // in RRF) while freshly created brains never had it. Batched by id
        // range (SERIAL PK) so a huge pages table can't hold one giant
        // transaction/lock for the whole backfill.
        const batchSize = 500;
        let lastId = 0;
        let totalBackfilled = 0;
        for (;;) {
          const rows = await engine.executeRaw<{ id: number }>(
            `UPDATE pages SET id = id
               WHERE id IN (
                 SELECT id FROM pages
                  WHERE id > $1 AND search_vector IS NOT NULL
                  ORDER BY id
                  LIMIT $2
               )
             RETURNING id`,
            [lastId, batchSize],
          );
          if (rows.length === 0) break;
          totalBackfilled += rows.length;
          lastId = Math.max(...rows.map((r) => r.id));
          if (rows.length < batchSize) break;
        }
        deps.migrationNotice(`  v135: compiled_truth dropped from pages trigger (was overflowing tsvector on large pages, #2704); backfilled ${totalBackfilled} existing row(s)\n`);
      },
    },
    {
      version: 151,
      name: 'repair_masked_upstream_126_127_128',
      // One-time repair for the fork-renumber masking class (#2038 in this
      // file's own history). runMigrations gates on a single high-water
      // integer (`m.version > current`), not an applied-set. The fork used to
      // occupy 123-126 with its own migrations and pushed upstream's 123/124
      // to 127/128, so a brain stamped at 128 skips upstream's REAL 126/127/128
      // forever once this merge restores upstream numbering. Verified absent on
      // the production brain at merge time: session_context_state (missing),
      // oauth_clients.surface/surface_set_by (missing), and
      // idx_minion_jobs_queue_status_updated (missing).
      //
      // Re-applies those three by looking them up in MIGRATIONS rather than
      // duplicating their DDL, so this can never drift from the definitions it
      // repairs. All three are declared idempotent upstream, so re-running them
      // on a brain that already applied them normally is a no-op.
      idempotent: true,
      sql: '',
      handler: async (engine) => {
        for (const version of [126, 127, 128]) {
          const masked = deps.allMigrations().find(m => m.version === version);
          if (!masked) continue;
          await deps.applyOneMigration(engine, masked);
        }
        deps.migrationNotice('  v136: re-applied upstream migrations 126/127/128 masked by the fork renumber\n');
      },
    },
    {
      version: 152,
      name: 'repair_masked_upstream_125',
      // Fourth masked migration, missed by v136. v136 was derived by diffing
      // fork-vs-upstream for SAME NUMBER, DIFFERENT NAME — but upstream's v125
      // (take_proposals_per_claim_idempotency) was masked a different way: the
      // pre-merge MIGRATIONS array carried v125 TWICE. The fork's
      // repair_code_edges_... sat at v125 ahead of upstream's entry, so the
      // runner stamped the high-water at 125 after the first one and upstream's
      // never became pending. A duplicate version IS a masking instance, not
      // merely a numbering-hygiene defect.
      //
      // Confirmed on the production brain (stamped 136) before writing this:
      //   take_proposals_idempotency_idx = (source_id, page_slug, content_hash,
      //   prompt_version) — md5(claim_text) absent, i.e. upstream v125's DDL
      //   never ran. Effect: every claim after the first on a page is silently
      //   dropped by ON CONFLICT. (take_proposals was empty, so nothing was lost
      //   yet — this is a latent defect, repaired here before the feature is used.)
      //
      // Same lookup-don't-copy shape as v136. Unlike v136 this one carries a
      // verify hook: the repair has a cheap, exact server-side postcondition
      // (the index expression), so there is no reason to accept a silent no-op.
      idempotent: true,
      sql: '',
      handler: async (engine) => {
        const masked = deps.allMigrations().find(m => m.version === 125);
        if (masked) await deps.applyOneMigration(engine, masked);
        deps.migrationNotice('  v137: re-applied upstream migration 125 masked by the duplicate v125 entry\n');
      },
      verify: async (engine) => {
        const rows = await engine.executeRaw<{ def: string | null }>(
          `SELECT pg_get_indexdef(oid) AS def FROM pg_class
            WHERE relname = 'take_proposals_idempotency_idx'`,
        );
        // No index at all means take_proposals predates the idempotency work on
        // this brain; the repair has nothing to assert. A present index MUST
        // carry the per-claim term.
        if (rows.length === 0) return true;
        return (rows[0]?.def ?? '').includes('md5(claim_text)');
      },
    },
    {
      version: 153,
      name: 'repair_masked_upstream_131_137',
      // Third instance of the masking class this file's header describes, from
      // the 2026-08-25 upstream sync (v0.46.16.0 → v0.46.29.0).
      //
      // Before that merge upstream's high-water was 130 and the fork occupied
      // 131-137. Upstream then claimed 131-141 for its own migrations, so the
      // fork renumbered to 142-148 per ADR-087 — but renumbering only moves the
      // fork's DEFINITIONS. runMigrations gates on a single high-water integer,
      // and this brain's counter was already stamped 137 by the FORK's old
      // 131-137. Upstream's real 131-137 are therefore `m.version > current`
      // false forever: skipped silently, exactly as v147/v148 above describe.
      //
      // Verified on the production brain before writing this (2026-08-26,
      // counter at 140, i.e. upstream's 138/139/140 had already run):
      //   131 subagent_tool_use_id unique index ... absent (drop-only; no-op)
      //   132 session_context_state.checkpoint_manifest .. MISSING
      //   133 content_chunks.embedded_text_hash ......... MISSING
      //   135 facts event_time index .................... MISSING
      //   136 minion_jobs private-queue columns ......... unverified at probe
      //       time (the pre-check queried the wrong column names; the real
      //       ones are private_queue_owner_job_id / _token / _lease_until).
      //       Confirmed PRESENT after this repair ran — it is declared
      //       idempotent, so re-applying it was a no-op either way.
      //   137 entity_identities table ................... MISSING
      //
      // 133 is load-bearing for this merge: the fork's persistEmbedOutcome now
      // stamps embedded_text_hash (upstream #4246 adds the stamp inside
      // _upsertChunksOnce, which that path bypasses), so the merged code cannot
      // commit a vector on a brain missing the column.
      //
      // masking-exempt: 134 — see the paragraph below. The sync script's
      // check_fork_migration_masking() reads this marker; without it the guard
      // would demand a repair for 134 on every future run and block a state
      // that is already correct.
      //
      // 134 is deliberately EXCLUDED. It is the one migration in the range
      // upstream does not declare `idempotent: true`, and it is provably
      // already satisfied here: both partial indexes it restores
      // (idx_chunks_embedding_null, content_chunks_stale_idx) were present at
      // probe time. Re-applying an undeclared migration to reach a state the
      // brain is already in buys nothing and costs the ADR-087 guarantee.
      //
      // Same lookup-don't-copy shape as v147/v148: the DDL is read out of the
      // live MIGRATIONS registry, so this can never drift from what it repairs.
      idempotent: true,
      sql: '',
      handler: async (engine) => {
        for (const version of [131, 132, 133, 135, 136, 137]) {
          const masked = deps.allMigrations().find(m => m.version === version);
          if (!masked) continue;
          await deps.applyOneMigration(engine, masked);
        }
        deps.migrationNotice(
          '  repair: re-applied upstream migrations 131/132/133/135/136/137 masked by the 2026-08-25 fork renumber\n',
        );
      },
      // The repair has a cheap, exact postcondition and one of its targets is a
      // hard dependency of the merged embed path, so assert rather than accept
      // a silent no-op. Postgres-only shape check; PGLite reports its own
      // catalog, so gate on the engine kind.
      verify: async (engine) => {
        if (engine.kind !== 'postgres') return true;
        const rows = await engine.executeRaw<{ n: number }>(
          `SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_name = 'content_chunks' AND column_name = 'embedded_text_hash'`,
        );
        return (rows[0]?.n ?? 0) > 0;
      },
    },
    {
      version: 154,
      name: 'repair_masked_upstream_142_145',
      // Fourth instance of the masking class this file's header describes, from
      // the 2026-09-06 upstream sync (v0.46.29.0 → v0.48.2.0).
      //
      // Before that merge upstream's high-water was 141 and the fork occupied
      // 142-149. Upstream then claimed 142-145 for its own migrations, so the
      // fork renumbered to 146-153 per ADR-087 — but renumbering only moves the
      // fork's DEFINITIONS. runMigrations gates on a single high-water integer,
      // and a brain stamped 149 by the FORK's old 142-149 has `m.version > current`
      // false for upstream's real 142-145 forever: skipped silently, exactly as
      // v151/v152/v153 above describe.
      //
      // Verified read-only on the production brain before writing this
      // (2026-09-06, counter at 153 — the postinstall hook had already replayed
      // the renumbered fork migrations 150-153):
      //   142 takes_embedding_dimension_matches_config .. extract_rollup_7d
      //       .expected_limit_count PRESENT; takes.embedding was vector(1536)
      //       vs config embedding_dimensions = 2000 — MISMATCH, but `takes` is
      //       EMPTY (0 rows), so the migration's `UPDATE takes SET embedding =
      //       NULL` is a no-op and the DROP/ADD COLUMN + HNSW rebuild run on an
      //       empty table: zero data loss, aligns the column to config.
      //   143 dream_verdicts.expires_at ................. MISSING
      //   144 open_loops table + v143 skew re-apply ..... MISSING
      //   145 facts_kind_check allows kind='idea' ....... MISSING (constraint
      //       was event/preference/commitment/belief/fact)
      //
      // All four declare `idempotent: true`; none is excluded.
      //
      // Same lookup-don't-copy shape as v151/v152/v153: the DDL is read out of
      // the live MIGRATIONS registry, so this can never drift from what it
      // repairs.
      idempotent: true,
      sql: '',
      handler: async (engine) => {
        for (const version of [142, 143, 144, 145]) {
          const masked = deps.allMigrations().find(m => m.version === version);
          if (!masked) continue;
          await deps.applyOneMigration(engine, masked);
        }
        deps.migrationNotice(
          '  repair: re-applied upstream migrations 142/143/144/145 masked by the 2026-09-06 fork renumber\n',
        );
      },
      // Exact postcondition for all four targets. Postgres-only shape check;
      // PGLite reports its own catalog, so gate on the engine kind.
      verify: async (engine) => {
        if (engine.kind !== 'postgres') return true;
        const rows = await engine.executeRaw<{
          rollup_col: number;
          takes_dim: string | null;
          dv_col: number;
          open_loops: string | null;
          facts_idea: number;
        }>(
          `SELECT
             (SELECT count(*)::int FROM information_schema.columns
               WHERE table_name = 'extract_rollup_7d' AND column_name = 'expected_limit_count') AS rollup_col,
             (SELECT format_type(a.atttypid, a.atttypmod)
                FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
               WHERE c.relname = 'takes' AND a.attname = 'embedding' AND NOT a.attisdropped) AS takes_dim,
             (SELECT count(*)::int FROM information_schema.columns
               WHERE table_name = 'dream_verdicts' AND column_name = 'expires_at') AS dv_col,
             to_regclass('public.open_loops')::text AS open_loops,
             (SELECT count(*)::int FROM pg_constraint
               WHERE conname = 'facts_kind_check' AND conrelid = 'facts'::regclass
                 AND pg_get_constraintdef(oid) LIKE '%''idea''%') AS facts_idea`,
        );
        const r = rows[0];
        if (!r) return false;
        return (
          r.rollup_col > 0 &&
          r.takes_dim === 'vector(2000)' &&
          r.dv_col > 0 &&
          r.open_loops === 'open_loops' &&
          r.facts_idea > 0
        );
      },
    },
  ];
}

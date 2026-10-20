/**
 * FORK: the embed_failures retry ledger's engine methods, written once.
 *
 * `persistEmbedOutcome` commits a batch's vectors and its per-chunk failure
 * rows in one transaction; `listEmbedFailures` / `releaseEmbedFailures` read
 * and clear the ledger; `getEmbedFailureSummary` partitions the stale chunks by
 * ledger state. Both engines delegate here in one line, so an upstream
 * engine change no longer collides with the fork's ledger SQL. Only the
 * BrainEngine surface (`executeRaw`, `transaction`) is used: the SQL is the
 * same on both engines.
 */
import type { BrainEngine, EmbedFailureRecord, EmbedFailureSummary, PersistEmbedOutcomeRequest, PersistEmbedOutcomeResult } from './engine.ts';
import { quoteIdentifier, resolveActiveEmbeddingColumnFromEngine, vectorCastSuffix } from './search/embedding-column.ts';
import { splitEmbeddingSignature } from './embedding-invalidation.ts';
import { chunkGenerationFilter } from './search/safe-chunks.ts';
import { pageBudgetLimitedFilter } from './page-size-policy.ts';

export async function persistEmbedOutcome(engine: BrainEngine, request: PersistEmbedOutcomeRequest): Promise<PersistEmbedOutcomeResult> {
  // The registry-active plane, not a hard-coded legacy column: stale discovery,
  // invalidation and the current-space predicate all resolve it the same way.
  const activeColumn = request.column ?? await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true });
  const activeColId = quoteIdentifier(activeColumn.name);
  const guardCorpusGeneration = request.expectedCorpusGeneration !== undefined;
  return engine.transaction(async (tx) => {
    const result: PersistEmbedOutcomeResult = {
      committedChunks: 0,
      vectorCommittedChunks: 0,
      staleSkippedChunks: 0,
      ledgerUpserts: 0,
      ledgerDeletes: 0,
    };

    for (const entry of request.entries) {
      const outcome = entry.outcome;
      const isSuccess = 'vector' in outcome;
      let matched = false;

      if ('vector' in outcome) {
        const vector = '[' + Array.from(outcome.vector).join(',') + ']';
        const rows = await tx.executeRaw(
          `UPDATE content_chunks cc
              -- #4246 (2026-08-25 upstream merge): upstream stamps
              -- embedded_text_hash inside _upsertChunksOnce, but the fork's
              -- persistEmbedOutcome commits vectors WITHOUT going through
              -- upsertChunks — the stamp never landed, so every chunk this
              -- path embedded looked content-drifted forever. Hashed in SQL
              -- (not JS) so stamp and drift comparison share one md5, per
              -- upstream's own note at the upsert site.
              SET ${activeColId} = $1${vectorCastSuffix(activeColumn)}, embedded_at = now(),
                  embedded_text_hash = md5(cc.chunk_text),
                  -- v0.60 embedding_pending_since (v221): NULL once a vector lands,
                  -- exactly as engine-sql/chunks.ts upsertChunksOnce maintains it.
                  embedding_pending_since = NULL,
                  model = COALESCE($6, cc.model),
                  -- R6: provenance of the exact input, written atomically with the vector.
                  embedding_input_hash = $9
             FROM pages p
            WHERE cc.page_id = $2
              AND p.id = cc.page_id
              AND p.source_id = $3
              AND cc.chunk_index = $4
              AND md5(cc.chunk_text) = $5
              AND ($7::boolean IS NOT TRUE OR p.corpus_generation IS NOT DISTINCT FROM $8::text)
              AND EXISTS (SELECT 1 FROM sources s WHERE s.id = p.source_id AND NOT s.archived) -- archive-wins final-installation fence
            RETURNING cc.id`,
          [vector, request.pageId, request.sourceId, entry.chunkIndex, entry.chunkHash,
            // v0.51: the installed-model label rides with the vector so the
            // current-space predicate (signature invalidation, provenance
            // stamping) recognizes chunks this path embedded.
            request.embeddingSignature && request.embeddingSignature !== 'legacy' ? splitEmbeddingSignature(request.embeddingSignature).model : null,
            guardCorpusGeneration, request.expectedCorpusGeneration ?? null, entry.inputHash ?? null],
        );
        matched = rows.length > 0;
      } else {
        const failure = outcome.failure;
        const rows = await tx.executeRaw(
          // chunk-visibility-ok: ledger write keyed to the chunk row this outcome just embedded (index + text hash)
          `INSERT INTO embed_failures (
             source_id, page_id, slug, chunk_index, embedding_signature, chunk_hash,
             error_class, error_fingerprint, first_seen, last_seen, next_retry_at
           )
           SELECT $1, $2::bigint, $3, $4, $5, $6, $7, $8, now(), now(), now() + INTERVAL '15 minutes'
             FROM content_chunks cc
             JOIN pages p ON p.id = cc.page_id
            WHERE cc.page_id = $2::integer
              AND p.source_id = $1
              AND cc.chunk_index = $4
              AND md5(cc.chunk_text) = $6
           ON CONFLICT (source_id, page_id, chunk_index, embedding_signature, chunk_hash)
           DO UPDATE SET
             error_class = EXCLUDED.error_class,
             error_fingerprint = EXCLUDED.error_fingerprint,
             attempt_count = embed_failures.attempt_count + 1,
             last_seen = now(),
             next_retry_at = now() + LEAST(
               INTERVAL '24 hours',
               INTERVAL '15 minutes' * POWER(2, embed_failures.attempt_count)
             ),
             quarantined_at = CASE
               WHEN embed_failures.attempt_count + 1 >= 5 THEN COALESCE(embed_failures.quarantined_at, now())
               ELSE NULL
             END,
             quarantine_reason = CASE
               WHEN embed_failures.attempt_count + 1 >= 5 THEN EXCLUDED.error_class
               ELSE NULL
             END
           RETURNING attempt_count`,
          [
            request.sourceId, request.pageId, request.slug, entry.chunkIndex,
            request.embeddingSignature, entry.chunkHash, failure.errorClass, failure.errorFingerprint,
          ],
        );
        matched = rows.length > 0;
        if (matched) result.ledgerUpserts++;
      }

      if (!matched) {
        result.staleSkippedChunks++;
        (result.staleSkippedChunkIndexes ??= []).push(entry.chunkIndex);
        continue;
      }

      const staleGenerationDeletes = await tx.executeRaw(
        `DELETE FROM embed_failures
          WHERE source_id = $1
            AND page_id = $2
            AND chunk_index = $3
            AND (embedding_signature <> $4 OR chunk_hash <> $5)
          RETURNING 1`,
        [request.sourceId, request.pageId, entry.chunkIndex, request.embeddingSignature, entry.chunkHash],
      );
      result.ledgerDeletes += staleGenerationDeletes.length;

      if (isSuccess) {
        const successDeletes = await tx.executeRaw(
          `DELETE FROM embed_failures
            WHERE source_id = $1
              AND page_id = $2
              AND chunk_index = $3
              AND embedding_signature = $4
              AND chunk_hash = $5
            RETURNING 1`,
          [request.sourceId, request.pageId, entry.chunkIndex, request.embeddingSignature, entry.chunkHash],
        );
        result.ledgerDeletes += successDeletes.length;
      }
      if (isSuccess) {
        result.committedChunks++;
        result.vectorCommittedChunks++;
      }
    }
    return result;
  });
}

export async function listEmbedFailures(engine: BrainEngine, opts: { sourceId?: string; slug?: string } = {}): Promise<EmbedFailureRecord[]> {
  const predicates: string[] = [];
  const params: unknown[] = [];
  if (opts.sourceId !== undefined) {
    params.push(opts.sourceId);
    predicates.push(`source_id = $${params.length}`);
  }
  if (opts.slug !== undefined) {
    params.push(opts.slug);
    predicates.push(`slug = $${params.length}`);
  }
  const where = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : '';
  return engine.executeRaw<EmbedFailureRecord>(
    `SELECT source_id, page_id, slug, chunk_index, embedding_signature, chunk_hash,
            error_class, error_fingerprint, attempt_count, first_seen, last_seen,
            next_retry_at, quarantined_at, quarantine_reason
       FROM embed_failures
       ${where}
       ORDER BY last_seen DESC, source_id, page_id, chunk_index`,
    params,
  );
}

export async function releaseEmbedFailures(engine: BrainEngine, opts: { sourceId?: string; slug: string; chunkIndex?: number }): Promise<number> {
  const predicates = ['slug = $1'];
  const params: unknown[] = [opts.slug];
  if (opts.sourceId !== undefined) {
    params.push(opts.sourceId);
    predicates.push(`source_id = $${params.length}`);
  }
  if (opts.chunkIndex !== undefined) {
    params.push(opts.chunkIndex);
    predicates.push(`chunk_index = $${params.length}`);
  }
  const rows = await engine.executeRaw(
    `DELETE FROM embed_failures WHERE ${predicates.join(' AND ')} RETURNING 1`,
    params,
  );
  return rows.length;
}

/** Appends the active retry-ledger anti-join (`$N` placeholders) for a current signature. */
function appendEmbedFailureEligibility(
  conds: string[],
  params: unknown[],
  signature: string | undefined,
  ignoreBackoff?: boolean,
): void {
  if (signature === undefined || ignoreBackoff) return;
  params.push(signature);
  const signatureParam = params.length;
  conds.push(`NOT EXISTS (
    SELECT 1 FROM embed_failures l
     WHERE l.page_id = cc.page_id
       AND l.chunk_index = cc.chunk_index
       AND l.embedding_signature = $${signatureParam}
       AND l.chunk_hash = md5(cc.chunk_text)
       AND (l.quarantined_at IS NOT NULL OR l.next_retry_at > now())
  )`);
}

/**
 * The stale-chunk candidate predicate the summary partitions (`cc`/`p` aliases, `$N` placeholders). Exported for
 * the Postgres EXPLAIN test, which plans the summary's statements from this builder.
 */
export function buildListStaleChunkWhere(column: string, opts?: { sourceId?: string; signature?: string; ignoreBackoff?: boolean }): { where: string; params: unknown[] } {
  const params: unknown[] = [];
  const conds = [
    `cc.${quoteIdentifier(column)} IS NULL`,
    'p.deleted_at IS NULL',
    // The same visibility and budget gates as listStaleChunks (engine-sql/chunks.ts staleChunkWhere), so the
    // summary counts exactly the rows the drain can list: no staged/retired generations, no held large pages.
    chunkGenerationFilter('p', 'cc'),
    `NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')`,
    `NOT ${pageBudgetLimitedFilter('p')}`,
  ];
  appendEmbedFailureEligibility(conds, params, opts?.signature, opts?.ignoreBackoff);
  if (opts?.sourceId !== undefined) {
    params.push(opts.sourceId);
    conds.push(`p.source_id = $${params.length}`);
  }
  return { where: conds.join(' AND '), params };
}

export async function getEmbedFailureSummary(engine: BrainEngine, opts: { sourceId?: string; signature: string }): Promise<EmbedFailureSummary> {
  // Every summary branch starts from the same registry-active/live-page
  // candidate set as count/list stale. Ledger state is the only distinction.
  const activeColumn = await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true });
  const candidate = buildListStaleChunkWhere(activeColumn.name, opts.sourceId === undefined ? undefined : { sourceId: opts.sourceId });
  const totalRows = await engine.executeRaw(
    // chunk-visibility-ok: the WHERE comes from buildListStaleChunkWhere, which applies chunkGenerationFilter
    `SELECT count(*)::int AS count
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE ${candidate.where}`,
    candidate.params,
  );
  const total_null = Number((totalRows[0] as { count?: number } | undefined)?.count ?? 0);
  const eligible = buildListStaleChunkWhere(activeColumn.name, opts);
  const eligibleRows = await engine.executeRaw(
    // chunk-visibility-ok: the WHERE comes from buildListStaleChunkWhere, which applies chunkGenerationFilter
    `SELECT count(*)::int AS count
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE ${eligible.where}`,
    eligible.params,
  );
  const eligible_now = Number((eligibleRows[0] as { count?: number } | undefined)?.count ?? 0);

  // The remaining branches use the same NULL/embed-skip/source candidate
  // set; only the ledger state differs. This preserves the four metrics as
  // a partition of total_null for the current embedding generation.
  const base = candidate;
  const params = [...base.params, opts.signature];
  const signatureParam = params.length;
  const ledgerJoin = `l.source_id = p.source_id
    AND l.page_id = cc.page_id
    AND l.chunk_index = cc.chunk_index
    AND l.embedding_signature = $${signatureParam}
    AND l.chunk_hash = md5(cc.chunk_text)`;
  const stateRows = await engine.executeRaw(
    // chunk-visibility-ok: the WHERE comes from buildListStaleChunkWhere, which applies chunkGenerationFilter
    `SELECT
       count(*) FILTER (WHERE l.quarantined_at IS NULL AND l.next_retry_at > now())::int AS backoff_deferred,
       count(*) FILTER (WHERE l.quarantined_at IS NOT NULL)::int AS quarantined,
       min(l.next_retry_at) FILTER (WHERE l.quarantined_at IS NULL AND l.next_retry_at > now()) AS earliest_retry_at
     FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
     LEFT JOIN embed_failures l ON ${ledgerJoin}
     WHERE ${base.where}`,
    params,
  );
  const state = stateRows[0] as { backoff_deferred?: number; quarantined?: number; earliest_retry_at?: Date | string | null } | undefined;
  const by_error_class = (await engine.executeRaw(
    // chunk-visibility-ok: the WHERE comes from buildListStaleChunkWhere, which applies chunkGenerationFilter
    `SELECT l.error_class, count(*)::int AS count
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
       JOIN embed_failures l ON ${ledgerJoin}
      WHERE ${base.where}
      GROUP BY l.error_class
      ORDER BY count DESC, l.error_class ASC`,
    params,
  )).map((row) => ({
    error_class: row.error_class as EmbedFailureSummary['by_error_class'][number]['error_class'],
    count: Number(row.count),
  }));
  const quarantined_top = (await engine.executeRaw(
    // chunk-visibility-ok: the WHERE comes from buildListStaleChunkWhere, which applies chunkGenerationFilter
    `SELECT p.slug, cc.chunk_index, l.error_class, l.attempt_count
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
       JOIN embed_failures l ON ${ledgerJoin}
      WHERE ${base.where} AND l.quarantined_at IS NOT NULL
      ORDER BY l.attempt_count DESC, l.last_seen DESC, p.slug ASC, cc.chunk_index ASC
      LIMIT 5`,
    params,
  )).map((row) => ({
    slug: String(row.slug),
    chunk_index: Number(row.chunk_index),
    error_class: row.error_class as EmbedFailureSummary['quarantined_top'][number]['error_class'],
    attempt_count: Number(row.attempt_count),
  }));
  return {
    counts: {
      total_null,
      eligible_now,
      backoff_deferred: Number(state?.backoff_deferred ?? 0),
      quarantined: Number(state?.quarantined ?? 0),
    },
    earliest_retry_at: state?.earliest_retry_at == null ? null : new Date(state.earliest_retry_at),
    by_error_class,
    quarantined_top,
  };
}

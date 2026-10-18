import { readProjectionSnapshot, installPageEmbeddings } from './page-state/projections.ts';
import { prepareEmbeddingProjections, countArchivedEmbeddingWork } from './embedding-readiness.ts';
import { readContentChunksEmbeddingDim } from './embedding-dim-check.ts';
/**
 * Stale-chunk embedding loop, extracted from `src/commands/embed.ts:embedAllStale`
 * for reuse by the v0.40 `embed-backfill` Minion handler (D15.2 — codex
 * outside-voice catch).
 *
 * Single source of truth for the cursor-paginated, source-grouped, rate-limit-
 * aware embedding pipeline. The `embed-backfill` job (Minion) calls this
 * helper, and the foreground stale path shares its fallback state machine.
 * Keyset pagination, grouping by `source_id::slug`, merge-with-existing via
 * `getChunks` + `upsertChunks`, and AbortSignal threading into HTTP all live
 * here. Foreground-only aggregation and CLI logging deliberately remain in
 * `embed.ts`.
 */
import type { BrainEngine } from './engine.ts';
import type { Chunk, ChunkInput, StaleChunkRow } from './types.ts';
import { embedBatchWithBackoff, restampIfDemotedToTitleTier, readCorpusGeneration } from './embed-retry.ts';
import { wrapChunkTextsForStoredMode } from './embedding-context.ts';
import { healOversizedPageChunks, healedChunksToStaleRows } from './embed-oversize-heal.ts';
import { healAndReportOverLength } from './embed-overlength-heal.ts';
import { invalidateStaleSignatureEmbeddingsGuarded, countSignatureDriftedEmbeddings, splitEmbeddingSignature, currentInputChunkPredicate } from './embedding-invalidation.ts';
import {
  resolveActiveEmbeddingColumnFromEngine,
  quoteIdentifier,
} from './search/embedding-column.ts';
import { type DbPacer, createNoopPacer, observed } from './db-pacer.ts';
import { resolveStaleEmbedConcurrency } from './embed-concurrency.ts';
import { AbortError } from './abort-check.ts';
import { persistStaleSlice, throwIfPersistenceStopped } from './embed-slice-persist.ts';
import { LockStolenError } from './db-lock.ts';
import { resolveEmbedSubBatchSize } from './embed-slices.ts';
import { meterPageBatch, spendGrant } from './page-embedding-budget.ts';
import { chunkGenerationFilter, chunkVisibleFilter } from './search/safe-chunks.ts';
import { embedSegmentedPage, embedSegmentedRows, readSegmentedEmbedPage, type SegmentedEmbedOpts } from './page-body/segmented-embedding.ts';

/**
 * W0 fix-wave (Tier-1 #3, CONFIRMED): the ONE carry-through field list for
 * re-embed upserts. upsertChunks writes these columns as EXCLUDED.<col>
 * (overwrite, not COALESCE), so any re-embed path that omits a field resets
 * it — omitting `modality` flipped every image chunk to modality='text',
 * silently zeroing the image search arm (filter `cc.modality = 'image'`).
 * Pre-fix this list existed twice: here (correct, with modality) and in
 * commands/embed.ts preserveCodeMetadata (missing modality — the bug). Both
 * consumers now share THIS list; embedding_image is deliberately NOT carried
 * (the upsert COALESCEs it, and getChunks returns the pgvector as a string
 * which upsertChunks would mis-serialize).
 */
export function carryChunkMetadata(
  loaded: Pick<Partial<Chunk>,
    'modality' | 'language' | 'symbol_name' | 'symbol_type' | 'start_line'
    | 'end_line' | 'parent_symbol_path' | 'doc_comment' | 'symbol_name_qualified'>,
  base: ChunkInput,
): ChunkInput {
  return {
    ...base,
    modality: loaded.modality ?? undefined,
    language: loaded.language ?? undefined,
    symbol_name: loaded.symbol_name ?? undefined,
    symbol_type: loaded.symbol_type ?? undefined,
    start_line: loaded.start_line ?? undefined,
    end_line: loaded.end_line ?? undefined,
    parent_symbol_path: loaded.parent_symbol_path ?? undefined,
    doc_comment: loaded.doc_comment ?? undefined,
    symbol_name_qualified: loaded.symbol_name_qualified ?? undefined,
  };
}

/** Last visited (page_id, chunk_index) for keyset-resume across runs. */
export interface StaleCursor {
  afterPageId: number;
  afterChunkIndex: number;
}

export interface EmbedStaleOpts {
  /** Chunks per cursor page. Default 2000 (matches the legacy CLI default). */
  batchSize?: number;
  /** Max parallel slug-keys embedded inside a single batch. Default: half the engine pool, at most 20 (`resolveStaleEmbedConcurrency`, #5902). */
  concurrency?: number;
  /** Resume cursor from a prior run. Default: from start. */
  cursor?: StaleCursor;
  /** AbortSignal honored at batch claim, retry sleep, and HTTP body. */
  signal?: AbortSignal;
  deadline?: number;
  assertOwned?: (tx?: BrainEngine) => Promise<void>;
  /** Fired after each completed batch for crash-resumable Minion progress. */
  onProgress?: (state: { embedded: number; chunksProcessed: number; cursor: StaleCursor }) => void;
  /** Optional deterministic test seam; production uses embedBatchWithBackoff. */
  embedFn?: (texts: string[], opts: { abortSignal?: AbortSignal }) => Promise<Float32Array[]>;
  /**
   * Current embedding provenance signature (`<provider:model>:<dims>`). When
   * set, embeddings from a different signature are invalidated before the
   * NULL cursor walks them; omit for legacy NULL-only stale mode.
   */
  embeddingSignature?: string;
  /**
   * Optional DB-contention pacer. It observes DB latency and paces between
   * keys, but never acquires an additional permit on this worker pool.
   */
  pacer?: DbPacer;
}

export interface EmbedStaleResult {
  blocked?: number;
  remaining?: number;
  failures?: number;
  complete?: boolean;
  failureSummary?: import('./engine.ts').EmbedFailureSummary;
  /** No chunk can run now; caller should defer rather than retry as a failure. */
  deferred?: boolean;
  /** Chunks newly embedded in this call. */
  embedded: number;
  /** Total chunks pulled across all batches (including ones that errored). */
  chunksProcessed: number;
  /** Pages whose partial/full vectors landed. */
  pagesProcessed: number;
  /**
   * #4283: chunks whose embeddings THIS run set to NULL (signature drift +
   * content drift). Callers use `invalidated > 0 && embedded === 0` as the
   * mass-null-without-replacement failure signal.
   */
  invalidated: number;
  /**
   * #4283: set when signature-drifted chunks existed but the pre-invalidation
   * embedder probe failed, so nothing was NULLed. The run degrades to
   * NULL-embedding-only staleness instead of destroying working vectors.
   */
  invalidationSkipped?: 'embedder_probe_failed';
  /** Last cursor reached. null iff zero stale chunks existed at start. */
  lastCursor: StaleCursor | null;
  /** True iff the loop exited because every stale chunk was processed. */
  done: boolean;
  /** True iff the supplied signal fired. */
  aborted: boolean;
  /**
   * Atomic DB checkpoint attempts that rolled back; never enter the ledger.
   * Also counts a #3507 contextual-retrieval restamp that failed AFTER its
   * page's vectors already committed (codex review round 2) — not itself a
   * rolled-back checkpoint, but reusing this counter (rather than crashing
   * the whole `embedStaleForSource` call, its pre-existing behavior) is the
   * cheapest way to surface it without a re-embed-triggering false failure.
   */
  persistFailures?: number;
}

/** Per-drain stamp context: the signature plus the registry-active column
 *  it is judged against. Resolved ONCE per drain by `resolveProvenanceStamp`
 *  — resolving inside the stamp helper cost a config round-trip per stamped
 *  page per batch, from both keyset drains. */
export interface ProvenanceStamp { signature: string; column: string }

/** Undefined when no signature is known (gateway unconfigured): nothing to stamp. */
export async function resolveProvenanceStamp(
  engine: BrainEngine,
  signature: string | undefined,
): Promise<ProvenanceStamp | undefined> {
  if (!signature) return undefined;
  const column = (await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name;
  return { signature, column };
}

/**
 * Stamp `pages.embedding_signature` once EVERY chunk on the page carries an
 * active-column vector written by the signature's model against the CURRENT
 * chunk_text (`embedded_text_hash = md5(chunk_text)`) at the signature's vector
 * width. Judged from DB state,
 * not from the caller's batch: `listStaleChunks` pages by ROW with no page
 * alignment, so a page straddling a batch boundary is never wholly in one
 * batch — the batch that lands its last chunk stamps it here. A partially
 * stale page whose preserved chunks carry another model (or a NULL model or
 * hash) stays unstamped. Both keyset drains (`embed --stale` and the minion
 * `embed-backfill` handler via `embedStaleForSource`) route through this.
 * Returns whether the stamp landed.
 */
export async function stampIfPageProvenanceComplete(
  engine: BrainEngine,
  slug: string,
  sourceId: string,
  { signature, column }: ProvenanceStamp,
  opts: {
    prepared?: Awaited<ReturnType<typeof readProjectionSnapshot>>;
    assertOwned?: (tx: BrainEngine) => Promise<void>;
    /** Stop fence (checked after ownership, and again right before the stamp commits). */
    signal?: AbortSignal;
    deadline?: number;
  } = {},
): Promise<boolean> {
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    await opts.assertOwned?.(tx);
    throwIfPersistenceStopped(opts.signal, opts.deadline, 'embedding stamp fence aborted');
    if (opts.prepared) {
      const current = await tx.readPageSnapshot(slug, { sourceId });
      if (!current || current.page.deleted_at || current.revision !== opts.prepared.snapshot.revision
        || current.sourceIncarnation !== opts.prepared.snapshot.sourceIncarnation || current.page.id !== opts.prepared.snapshot.page.id
        || current.page.text_projection_revision !== current.revision) return false;
      // Re-read the installer snapshot while holding the same page lock. The
      // provider result may have landed just before an active-plane/config
      // change; a signature is a whole-page claim and must never bridge that
      // change merely because model and dimensions happen to match.
      const fresh = await readProjectionSnapshot(tx, slug, sourceId, { requireLiveSource: true });
      if (!fresh || fresh.indexingContext !== opts.prepared.indexingContext
        || fresh.embeddingColumn.name !== column
        || fresh.embeddingColumn.name !== opts.prepared.embeddingColumn.name
        || fresh.embeddingColumn.dimensions !== opts.prepared.embeddingColumn.dimensions) return false;
    }
    // Signature is `<provider:model>:<dims>`; the model part is what
    // upsertChunks records in content_chunks.model.
    const { model, dims } = splitEmbeddingSignature(signature);
    const colId = quoteIdentifier(column);
    const rows = await tx.executeRaw<{ complete: boolean }>(
      // Input provenance follows page-state/projections.ts: a NULL hash (legacy
      // vector or an honest "unknown" truncated vector) is a legitimate current
      // input only on a page without a contextual-retrieval mode.
      `SELECT count(*) > 0
              AND bool_and(${currentInputChunkPredicate(colId, 1, 4)}) AS complete
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = $2 AND p.source_id = $3 AND ${chunkVisibleFilter('p', 'cc')}
          AND EXISTS (SELECT 1 FROM sources s WHERE s.id=p.source_id AND NOT s.archived)`,
      [model, slug, sourceId, dims],
    );
    if (rows[0]?.complete !== true) return false;
    await tx.setPageEmbeddingSignature(slug, { sourceId, signature });
    throwIfPersistenceStopped(opts.signal, opts.deadline, 'embedding stamp fence expired before commit');
    return true;
  });
}

/**
 * Settle the drain's remaining-work verdict from the chunk gap only (NULL
 * vectors in the active column), split into eligible / backoff-deferred /
 * quarantined by the retry ledger. Completed sibling chunks of a page whose
 * signature is not stamped yet are never counted. When the only gap left is
 * deferred or quarantined (and nothing is blocked) the drain is `deferred`:
 * neither success nor an ordinary failure to retry.
 *
 * `driftUnresolved` (the drift probe failed or the invalidation threw) keeps
 * the signature-wide count: un-invalidated drifted vectors are unfinished work,
 * so such a run is never complete and never deferred (#4283 honesty gate).
 */
async function settleRemaining(
  engine: BrainEngine, sourceId: string, signature: string | undefined,
  result: EmbedStaleResult, always: boolean, driftUnresolved: boolean,
): Promise<void> {
  const summary = signature && !driftUnresolved ? await engine.getEmbedFailureSummary({ sourceId, signature }) : undefined;
  const remaining = summary ? summary.counts.total_null
    : await engine.countStaleChunks({ sourceId, ...(signature && { signature }), ignoreBackoff: true });
  if (!(always || remaining || result.chunksProcessed || result.blocked)) return;
  result.remaining = remaining;
  result.complete = remaining === 0 && !result.blocked;
  if (summary && remaining > 0 && summary.counts.eligible_now === 0 && !result.blocked) {
    result.deferred = true;
    result.failureSummary = summary;
  }
}

/** Probe input for `probeEmbedder`. Exported so tests can detect probe calls. */
export const EMBED_PROBE_TEXT = 'gbrain embedder preflight probe';

/**
 * #4283: live embedder health check, run BEFORE any signature-drift
 * invalidation NULLs working vectors. A misresolved worker config (e.g. a
 * temp GBRAIN_HOME resolving the compile-time default model with no API key)
 * yields a signature that mismatches 100% of the corpus AND an embedder that
 * cannot write a single vector — pre-probe, that combination stripped every
 * embedding and reported success. The probe embeds one short string; when
 * `signature` carries a parseable trailing `:<dims>`, the returned vector
 * must match it (a wrong-dims vector would fail every upsert AFTER the
 * NULLing). Any throw or malformed result → false.
 */
export async function probeEmbedder(
  embedFn: (texts: string[], opts: { abortSignal?: AbortSignal }) => Promise<Float32Array[]>,
  signature?: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const vecs = await embedFn([EMBED_PROBE_TEXT], { abortSignal: signal });
    const vec = vecs?.[0];
    if (vecs.length !== 1 || !vec || vec.length === 0 || !vec.every(Number.isFinite)) return false;
    const dims = signature ? Number(signature.split(':').pop()) : NaN;
    if (Number.isFinite(dims) && dims > 0 && vec.length !== dims) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Embed every stale (`embedding IS NULL`) chunk for one source.
 *
 * Re-entrancy contract: if interrupted, a later call resumes from the next
 * stale row. The cursor is a progress optimization, not a correctness
 * mechanism: completed vectors are naturally excluded on a later NULL-only
 * pass. Ordinary per-page failures do not poison the run; partial successes
 * persist before return or a typed must-abort is propagated to the handler.
 */

/**
 * #4216 phase-end closure: embed the NULL-embedding chunks of an EXPLICIT
 * page list (pages a synthesis phase just wrote with deferEmbeds).
 * Deliberately NOT a source-wide sweep: no cursor walk over the backlog, no
 * global signature-invalidation pass (both belong to the budget-tracked
 * embed-backfill job) — the spend here is exactly the deferred cost of the
 * caller's own writes. Per-page mechanics mirror embedStaleForSource's
 * worker: stored-CR-mode wrapping, metadata carry, full-restale signature
 * stamp, title-tier restamp.
 */
/**
 * Wave B: when the batch's page is segmented, embed these rows by keyset
 * (`embedSegmentedRows`, never through its body or every chunk), stamp the
 * page's provenance when it is complete, and return true; false for an inline page.
 */
async function embedSegmentedStaleRows(engine: BrainEngine, stale: readonly StaleChunkRow[], result: { embedded: number; pagesProcessed: number },
  opts: Omit<SegmentedEmbedOpts, 'beforeInstall'> & { stamp?: ProvenanceStamp; pacer: DbPacer; assertOwned?: (tx?: BrainEngine) => Promise<void>; stopped: () => boolean }): Promise<boolean> {
  const page = await observed(opts.pacer, () => readSegmentedEmbedPage(engine, { id: stale[0]!.page_id }));
  if (!page) return false;
  const installed = await embedSegmentedRows(engine, page, stale, { ...opts,
    beforeInstall: async tx => { await opts.assertOwned?.(tx); if (opts.stopped()) throw new AbortError(); } });
  if (opts.stamp && installed) await stampIfPageProvenanceComplete(engine, page.slug, page.source_id, opts.stamp);
  result.embedded += installed ?? 0;
  if (installed) result.pagesProcessed += 1;
  return true;
}

export async function embedStalePages(
  engine: BrainEngine,
  slugs: string[],
  sourceId: string,
  opts: {
    signal?: AbortSignal;
    embedFn?: (texts: string[], o: { abortSignal?: AbortSignal }) => Promise<Float32Array[]>;
    embeddingSignature?: string;
  } = {},
): Promise<{ embedded: number; pagesProcessed: number; aborted: boolean }> {
  const embedFn = opts.embedFn ?? (async (texts: string[], fnOpts: { abortSignal?: AbortSignal }) =>
    embedBatchWithBackoff(texts, { abortSignal: fnOpts.abortSignal }));
  const result = { embedded: 0, pagesProcessed: 0, aborted: false };
  // S2: stale = NULL in the registry-ACTIVE column (the one upsertChunks
  // writes) — the literal legacy `embedding` stays NULL forever on a
  // registry-routed brain, which would re-embed every chunk on every phase
  // end. Resolved once per call; fallback keeps the per-page log+skip
  // contract (a broken registry surfaces at the upsert, loudly).
  const staleColId = quoteIdentifier(
    (await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name,
  );
  for (const slug of slugs) {
    if (opts.signal?.aborted) {
      result.aborted = true;
      return result;
    }
    try {
      const segmented = await readSegmentedEmbedPage(engine, { sourceId, slug });
      if (segmented) {
        const page = await embedSegmentedPage(engine, segmented, { embedFn, signal: opts.signal, signature: opts.embeddingSignature });
        const stamp = page.complete ? await resolveProvenanceStamp(engine, opts.embeddingSignature) : undefined;
        if (stamp) await stampIfPageProvenanceComplete(engine, slug, sourceId, stamp);
        result.embedded += page.embedded;
        if (page.embedded) result.pagesProcessed += 1;
        continue;
      }
      // SUP-3874: split legacy oversized rows before embedding so a single
      // pre-cap chunk cannot permanently fail the page.
      await healOversizedPageChunks(engine, slug, { sourceId });
      const prepared = await readProjectionSnapshot(engine, slug, sourceId, { requireLiveSource: true });
      if (!prepared) continue;
      const existing = prepared.chunks;
      const staleIdx = new Set(
        (await engine.executeRaw<{ chunk_index: number }>(
          `SELECT cc.chunk_index
             FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
            WHERE p.slug = $1 AND p.source_id = $2 AND cc.${staleColId} IS NULL AND ${chunkGenerationFilter('p', 'cc')}
            ORDER BY cc.chunk_index`,
          [slug, sourceId],
        )).map(r => r.chunk_index),
      );
      if (staleIdx.size === 0) continue;
      const pageRow = prepared.snapshot.page;
      const metered = await meterPageBatch(engine, pageRow, existing.filter(c => staleIdx.has(c.chunk_index)), { signature: opts.embeddingSignature ?? null });
      if (!metered) continue;
      const stale = metered.chunks;
      const embeddings = await spendGrant(metered.grant, () => embedFn(
        wrapChunkTextsForStoredMode(pageRow, stale),
        { abortSignal: opts.signal },
      ));
      const staleIdxToEmbedding = new Map<number, Float32Array>();
      for (let j = 0; j < stale.length; j++) {
        staleIdxToEmbedding.set(stale[j].chunk_index, embeddings[j]);
      }
      const merged: ChunkInput[] = existing.map((c) => carryChunkMetadata(c, {
        chunk_index: c.chunk_index,
        chunk_text: c.chunk_text,
        chunk_source: c.chunk_source,
        embedding: staleIdxToEmbedding.get(c.chunk_index) ?? undefined,
        token_count: c.token_count || Math.ceil(c.chunk_text.length / 4),
      }));
      const install = await engine.transaction(async tx => {
        const installed = await installPageEmbeddings(tx, prepared, merged,
          opts.embeddingSignature && stale.length === existing.length ? opts.embeddingSignature : undefined);
        if (stale.length === existing.length && installed.complete) await restampIfDemotedToTitleTier(tx, prepared.snapshot.page, slug, sourceId);
        return installed;
      });
      if (!install.complete && install.installed === 0) continue;
      result.embedded += install.installed;
      result.pagesProcessed += 1;
    } catch (e) {
      if (opts.signal?.aborted) {
        result.aborted = true;
        return result;
      }
      process.stderr.write(`\n  [embed-stale] error on ${sourceId}/${slug}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  return result;
}

export async function embedStaleForSource(
  engine: BrainEngine,
  sourceId: string,
  opts: EmbedStaleOpts = {},
): Promise<EmbedStaleResult> {
  const batchSize = opts.batchSize ?? 2000;
  const concurrency = opts.concurrency ?? resolveStaleEmbedConcurrency(engine);
  const signal = opts.signal;
  const embedFn = opts.embedFn ?? ((texts, fnOpts) =>
    embedBatchWithBackoff(texts, { abortSignal: fnOpts.abortSignal }));
  const pacer = opts.pacer ?? createNoopPacer();
  let afterPageId = opts.cursor?.afterPageId ?? 0;
  let afterChunkIndex = opts.cursor?.afterChunkIndex ?? -1;
  const result: EmbedStaleResult = {
    embedded: 0,
    chunksProcessed: 0,
    pagesProcessed: 0,
    invalidated: 0,
    lastCursor: null,
    done: false,
    aborted: false,
    persistFailures: 0,
  };
  const committedPages = new Set<string>();
  const subBatchSize = resolveEmbedSubBatchSize();
  const signature = opts.embeddingSignature;
  const write = (message: string): void => { process.stderr.write(`\n  ${message}\n`); };
  let signatureInvalidationFailed = false;
  const stopped = () => !!signal?.aborted || Date.now() >= (opts.deadline ?? Infinity);
  // Lease loss is never reported as an abort: each catch re-raises it first, from the caught error itself, else from the
  // stop signal's reason (the handler's assertOwned aborts with it). The signal alone is not trusted: an abort can lose its reason.
  const throwIfLeaseLost = (error?: unknown): void => { if (error instanceof LockStolenError) throw error; if (signal?.reason instanceof LockStolenError) throw signal.reason; };
  if (stopped()) return { ...result, aborted: true };
  await opts.assertOwned?.();
  if (stopped()) return { ...result, aborted: true };
  const archivedWork = await countArchivedEmbeddingWork(engine, { sourceId, signature });
  if (archivedWork) return { ...result, blocked: archivedWork, failures: archivedWork, complete: false, done: true,
    remaining: await engine.countStaleChunks({ sourceId, ...(signature && { signature }) }) };
  const readinessOptions = { sourceId, existingChunksOnly: true, activeSourcesOnly: true, stale: { signature }, signal,
    deadline: opts.deadline, assertOwned: opts.assertOwned };
  let readiness = await prepareEmbeddingProjections(engine, readinessOptions);
  if (stopped()) return { ...result, aborted: true };
  if (readiness.blocked) {
    await opts.assertOwned?.();
    if (stopped()) return { ...result, aborted: true };
    const probeOk = await probeEmbedder(embedFn, signature, signal);
    if (stopped()) return { ...result, aborted: true };
    await opts.assertOwned?.();
    if (!probeOk) {
      return { ...result, blocked: readiness.blocked, complete: false, done: true,
        remaining: await engine.countStaleChunks({ sourceId }), invalidationSkipped: 'embedder_probe_failed' };
    }
    readiness = await prepareEmbeddingProjections(engine, { ...readinessOptions, repair: true });
    if (stopped()) return { ...result, aborted: true };
  }
  // #6223: pages still waiting for a projection never block the rest of the
  // source; the drain skips their unsealed snapshots and the result stays
  // incomplete with them counted in `blocked`.
  const projectionBlocked = readiness.blocked;
  const stamp = await resolveProvenanceStamp(engine, signature); // column resolved once per drain, not per page
  if (stopped()) return { ...result, aborted: true };
  await opts.assertOwned?.();

  // v0.41.31: invalidate embeddings stamped under a prior model signature so
  // the NULL cursor below re-embeds them. GRANDFATHER: NULL signature
  // untouched. Best-effort — a failure here must not abort the backfill.
  //
  // #4283: NULLing is conditional on a WORKING embedder. The drift pre-count
  // (two cheap COUNTs; probe only fires when drift exists) keeps the probe's
  // one embed call off the no-drift common path; a failed probe skips the
  // invalidation entirely so a misresolved worker can't strip a corpus it
  // can never re-embed.
  if (signature) {
    try {
      const wide = await engine.countStaleChunks({ sourceId, signature });
      const nullOnly = await engine.countStaleChunks({ sourceId });
      // Ledgered NULL chunks lower `wide` (anti-join) but not `nullOnly`, so they can offset real
      // drift of equal or smaller size in the difference; the exact count closes that gap.
      const drifted = Math.max(wide - nullOnly, await countSignatureDriftedEmbeddings(engine, { signature, sourceId }));
      if (drifted > 0) {
        await opts.assertOwned?.();
        if (stopped()) return { ...result, aborted: true };
        const probeOk = await probeEmbedder(embedFn, signature, signal);
        if (stopped()) return { ...result, aborted: true };
        await opts.assertOwned?.();
        if (probeOk) {
          // #4306: guarded wrapper — never NULL embed_skip pages the stale
          // selectors below can't re-embed.
          result.invalidated += opts.assertOwned ? await engine.transaction(async tx => {
            await opts.assertOwned!(tx);
            if (stopped()) throw new AbortError();
            const invalidated = await invalidateStaleSignatureEmbeddingsGuarded(tx, { signature, sourceId });
            await opts.assertOwned!(tx);
            if (stopped()) throw new AbortError();
            return invalidated;
          }) : await invalidateStaleSignatureEmbeddingsGuarded(engine, { signature, sourceId });
        } else {
          result.invalidationSkipped = 'embedder_probe_failed';
          process.stderr.write(
            `\n  [embed-stale] ${drifted} chunk(s) drifted from signature ${signature} but the embedder probe failed — ` +
            `SKIPPING invalidation (existing vectors preserved). Check embedding provider config/credentials.\n`,
          );
        }
      }
    } catch (error) {
      throwIfLeaseLost(error);
      if (stopped()) return { ...result, aborted: true };
      await opts.assertOwned?.();
      // Non-fatal: fall through to the NULL-only stale loop. FORK: the failure
      // is recorded so the caller can tell a degraded run from a clean one.
      signatureInvalidationFailed = true;
      write(`[embed-signature-invalidation-fail] source_id=${sourceId} err=${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // #4246: invalidate chunks whose embedding was computed from a PREVIOUS
  // chunk_text revision (embedded_text_hash <> md5(chunk_text)) so content
  // edits flow through the NULL cursor. NOT probe-gated: the blast radius is
  // bounded by real content edits (config-independent, unlike signature
  // drift) and those vectors point at stale text either way. NULL hash
  // (pre-v133 rows) is grandfathered.
  try {
    if (stopped()) return { ...result, aborted: true };
    result.invalidated += opts.assertOwned ? await engine.transaction(async tx => {
      await opts.assertOwned!(tx);
      if (stopped()) throw new AbortError();
      const invalidated = await tx.invalidateContentDriftEmbeddings({ sourceId });
      await opts.assertOwned!(tx);
      if (stopped()) throw new AbortError();
      return invalidated;
    }) : await engine.invalidateContentDriftEmbeddings({ sourceId });
  } catch (error) {
    throwIfLeaseLost(error);
    if (stopped()) return { ...result, aborted: true };
    await opts.assertOwned?.();
    // Non-fatal: fall through to the NULL-only stale loop.
  }

  for (;;) {
    if (stopped()) {
      result.aborted = true;
      return result;
    }
    const batch = await observed(pacer, () => engine.listStaleChunks({
      batchSize,
      afterPageId,
      afterChunkIndex,
      sourceId,
      ...(signature && { signature }),
    }));
    if (batch.length === 0) {
      const blocked = await countArchivedEmbeddingWork(engine, { sourceId, signature });
      if (blocked) { result.blocked = blocked; result.failures = (result.failures ?? 0) + blocked; }
      if (projectionBlocked) result.blocked = (result.blocked ?? 0) + projectionBlocked;
      // Eligibility skips backed-off/quarantined rows; completion must not.
      // Deferred-only is decided here, after every maintenance step ran.
      await settleRemaining(engine, sourceId, signature, result, false, !!result.invalidationSkipped || signatureInvalidationFailed);
      result.done = true;
      return result;
    }

    result.chunksProcessed += batch.length;
    const last = batch[batch.length - 1]!;
    afterPageId = last.page_id;
    afterChunkIndex = last.chunk_index;
    result.lastCursor = { afterPageId, afterChunkIndex };

    const byKey = new Map<string, typeof batch>();
    for (const row of batch) {
      const key = `${row.source_id}::${row.slug}`;
      const list = byKey.get(key);
      if (list) list.push(row);
      else byKey.set(key, [row]);
    }
    const keys = Array.from(byKey.keys());
    let nextIdx = 0;

    async function embedOneKey(key: string): Promise<void> {
      let stale = byKey.get(key)!;
      const keySourceId = stale[0]?.source_id ?? sourceId;
      const slug = stale[0].slug;
      // Lease loss is control flow: it must reject the drain, never be counted
      // as this page's failure.
      let healOwnershipFailure: { error: unknown } | undefined;
      const assertHealOwned = async (tx?: BrainEngine): Promise<void> => {
        try { await opts.assertOwned?.(tx); } catch (error) { healOwnershipFailure = { error }; throw error; }
      };
      try {
        await assertHealOwned();
        if (stopped() || await embedSegmentedStaleRows(engine, stale, result, { embedFn, signal, signature, stamp, pacer, assertOwned: opts.assertOwned, stopped })) return;
        // SUP-3874: split legacy oversized chunk_text before embedding.
        const healed = await observed(pacer, () => engine.transaction(async tx => {
          await assertHealOwned(tx);
          if (stopped()) throw new AbortError();
          const healed = await healOversizedPageChunks(tx, slug, { sourceId: keySourceId });
          await assertHealOwned(tx);
          if (stopped()) throw new AbortError();
          return healed;
        }));
        if (healed.changed) {
          stale = healedChunksToStaleRows(healed.chunks, slug, keySourceId);
          if (stale.length === 0) {
            result.pagesProcessed += 1;
            return;
          }
        }
      } catch (e: unknown) {
        if (healOwnershipFailure) throw healOwnershipFailure.error;
        throwIfLeaseLost(e);
        result.failures = (result.failures ?? 0) + stale.length;
        if (stopped()) return;
        process.stderr.write(
          `\n  [embed-stale] error on ${keySourceId}/${slug}: ${
            e instanceof Error ? e.message : String(e)
          }\n`,
        );
        await healAndReportOverLength(engine, slug, keySourceId, e, stale.map(c => c.chunk_text), line => process.stderr.write(`${line}\n`));
        return;
      }
      // Generation BEFORE the projection snapshot (see commands/embed.ts): a contextual run landing in between must
      // surface as a generation change, not be absorbed into the baseline.
      const observedCorpusGeneration = await observed(pacer, () => readCorpusGeneration(engine, slug, keySourceId));
      // #3507: the page row (title + stored CR mode) comes from the live projection snapshot.
      const prepared = await observed(pacer, () => readProjectionSnapshot(engine, slug, keySourceId, { requireLiveSource: true }));
      if (!prepared) return;
      {
        const selected = new Map(stale.map(c => [c.chunk_index, c]));
        stale = prepared.chunks.filter(c => selected.get(c.chunk_index)?.chunk_text === c.chunk_text)
          .map(c => ({ ...selected.get(c.chunk_index)!, ...c }));
        if (!stale.length) return;
      }
      const pageRow = prepared.snapshot.page;
      // Upstream's per-page spend cap (page-embedding-budget.ts): meter the page's vector-less chunks once and
      // narrow `stale` to the grant; the reservation settles after the slices (spent once a provider call landed).
      // Only this batch's rows are metered: they passed the fork's embed_failures eligibility (backoff /
      // quarantine), which a page-wide vector-less set would bypass (upstream's embedStalePages meters the same way).
      const batchIdx = new Set(stale.map(c => c.chunk_index));
      const metered = await meterPageBatch(engine, pageRow, prepared.chunks.filter(c => !c.embedded_at && batchIdx.has(c.chunk_index)), { signature });
      if (!metered) return;
      if (metered.grant) {
        const selected = new Map(stale.map(c => [c.chunk_index, c]));
        stale = metered.chunks.map(c => ({ ...(selected.get(c.chunk_index) ?? { source_id: keySourceId, slug, page_id: pageRow.id }), ...c }));
      }
      const wrappedTexts = wrapChunkTextsForStoredMode(pageRow, stale);
      const slices = Math.ceil(stale.length / subBatchSize);
      let pageHadFailure = false;
      // codex review finding #5: a CAS stale-skip is not a failure, but it
      // also means those chunks weren't freshly committed THIS pass —
      // restamping on top of a skip would claim coverage the run didn't
      // actually verify.
      let pageStaleSkipped = 0;
      let grantSpent = false;
      let overLengthError: unknown;
      try {
        for (let offset = 0; offset < stale.length; offset += subBatchSize) {
          if (stopped()) return;
          await opts.assertOwned?.(); // ownership re-check before each slice commit (persistStaleSlice has no tx hook)
          const sliceRows = stale.slice(offset, offset + subBatchSize);
          let checkpoint: Awaited<ReturnType<typeof persistStaleSlice>>;
          try {
            checkpoint = await persistStaleSlice({
              engine,
              embedTexts: wrappedTexts.slice(offset, offset + subBatchSize),
              rows: sliceRows,
              embeddingSignature: signature,
              signatureInvalidationFailed,
              activeColumn: stamp ? quoteIdentifier(stamp.column) : undefined,
              expectedCorpusGeneration: observedCorpusGeneration,
              prepared,
              assertOwned: opts.assertOwned,
              // A provider call that returned may have been billed, even if the slice's commit then fails.
              embedFn: async (texts, fnOpts) => { const vectors = await embedFn(texts, fnOpts); grantSpent = true; return vectors; },
              signal,
              deadline: opts.deadline,
              slice: { index: (offset / subBatchSize) + 1, total: slices },
              write,
            });
          } catch (error) {
            // The transaction fence deliberately throws cancellation rather
            // than recording it as a page failure. Preserve earlier slices and
            // surface the drain's resumable aborted state to its caller.
            // Only a genuine stop (signal fired or deadline reached) maps to
            // aborted; lease loss recorded as the signal reason stays an error.
            throwIfLeaseLost(error);
            if (error instanceof Error && error.name === 'AbortError' && stopped()) {
              result.aborted = true;
              return;
            }
            throw error;
          }
          result.embedded += checkpoint.embedded;
          grantSpent = true; // a returned slice may have been billed (upstream: settled = spent, released only when the call throws)
          if (checkpoint.failureCount > 0 && overLengthError === undefined) overLengthError = checkpoint.firstFailureError;
          if (checkpoint.failureCount > 0) { pageHadFailure = true; result.failures = (result.failures ?? 0) + checkpoint.failureCount; } // ledgered chunk failures still count as run failures (upstream contract)
          if (checkpoint.persistFailed) {
            result.persistFailures = (result.persistFailures ?? 0) + 1;
            pageHadFailure = true;
          }
          pageStaleSkipped += checkpoint.outcome?.staleSkippedChunks ?? 0;
          const pageKey = `${sliceRows[0]!.source_id}:${sliceRows[0]!.page_id}`;
          if (checkpoint.pageCommitted && !committedPages.has(pageKey)) {
            committedPages.add(pageKey);
            result.pagesProcessed++;
          }
          if (checkpoint.aborted) {
            result.aborted = true;
            return;
          }
          // SPEC V4: any run-global terminal error must still propagate and
          // reject the whole embedStaleForSource call — persistStaleSlice
          // RETURNS fatalError (instead of throwing) so the accounting above
          // is never lost, but this call site's pre-existing contract has no
          // #3037 cost-bounding carve-out: rethrow unconditionally.
          if (checkpoint.fatalError !== undefined) throw checkpoint.fatalError;
        }
      } finally {
        await metered.grant?.settle({ ok: grantSpent }).catch(() => {});
      }
      // Upstream [R13]: an over-length rejection splits the page's stored chunks; the pieces embed next pass.
      if (overLengthError !== undefined) await healAndReportOverLength(engine, slug, keySourceId, overLengthError, stale.map(c => c.chunk_text), line => write(line));
      // #3507: a FULLY re-embedded per_chunk_synopsis page landed at the
      // title tier — keep the stamped mode honest (mixed pages stay as-is).
      if (!pageHadFailure && pageStaleSkipped === 0) {
        const existing = await observed(pacer, () =>
          engine.getChunks(slug, { sourceId: keySourceId }),
        );
        // 2026-09-14 upstream sync (#4825): chunk merge/upsert for this page
        // already happened per-slice inside persistStaleSlice above — the
        // fork's sub-batch restructuring (codex review finding #5) moved that
        // work out of this post-loop block, so base/upstream's inline
        // merge+upsert here is now dead code and is NOT ported. What upstream
        // v0.50.0.0 added on top — stamping provenance from DB state rather
        // than per-batch alignment, because the keyset drain has no page
        // alignment and a page straddling a batch boundary is never wholly in
        // one batch — is still a real fix and IS ported: the batch that lands
        // this page's last chunk stamps it; preserved chunks of other
        // provenance keep it unstamped.
        if (stamp) {
          let ownershipFailure: { error: unknown } | undefined;
          try {
            await observed(pacer, () =>
              stampIfPageProvenanceComplete(engine, slug, keySourceId, stamp, {
                prepared,
                signal,
                deadline: opts.deadline,
                assertOwned: opts.assertOwned && (async tx => {
                  try { await opts.assertOwned!(tx); } catch (error) { ownershipFailure = { error }; throw error; }
                }),
              }),
            );
          } catch (error) {
            // Lease loss/cancellation is control flow; a signature write
            // failure leaves committed vectors in place and is only reported.
            if (ownershipFailure) throw ownershipFailure.error;
            throwIfLeaseLost(error);
            if (stopped() || signal?.aborted) return;
            result.failures = (result.failures ?? 0) + 1;
            write(`[embed-signature-fail] slug=${slug} err=${error instanceof Error ? error.message : String(error)}`);
          }
        }
        // #3507: a FULLY re-embedded per_chunk_synopsis page landed at the
        // title tier — keep the stamped mode honest (mixed pages stay as-is).
        if (stale.length === existing.length) {
          // codex review round 2 finding #1: a restamp failure here is AFTER
          // vectors already committed successfully. Left unguarded, it
          // propagates through this file's Promise.all worker loop (no pool
          // absorption here, unlike embed.ts) and rejects the whole
          // embedStaleForSource call — crashing an otherwise-successful
          // Minion run and getting retried for the wrong reason (the retry's
          // own listStaleChunks finds nothing stale, since the vectors did
          // land; only the mode stamp is behind). Record it instead of
          // crashing the run.
          try {
            await observed(pacer, () =>
              restampIfDemotedToTitleTier(engine, pageRow, slug, keySourceId, observedCorpusGeneration),
            );
          } catch (error) {
            throwIfLeaseLost(error);
            if (signal?.aborted) return;
            result.persistFailures = (result.persistFailures ?? 0) + 1;
            write(`[embed-restamp-fail] slug=${slug} err=${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }

    async function worker(): Promise<void> {
      while (nextIdx < keys.length && !stopped()) {
        const index = nextIdx++;
        await embedOneKey(keys[index]!);
        try {
          await pacer.pace(signal);
        } catch (error) {
          if (error instanceof AbortError) return;
          throw error;
        }
      }
    }

    const numWorkers = Math.min(concurrency, keys.length);
    await Promise.all(Array.from({ length: numWorkers }, () => worker()));
    throwIfLeaseLost();
    if (stopped()) return { ...result, aborted: true };

    // A final short batch can be aborted inside its embedFn. Check before the
    // short-batch done path so the Minion handler cannot report false success.
    if (signal?.aborted) {
      result.aborted = true;
      return result;
    }
    opts.onProgress?.({
      embedded: result.embedded,
      chunksProcessed: result.chunksProcessed,
      cursor: { afterPageId, afterChunkIndex },
    });
    if (batch.length < batchSize) {
      const blocked = await countArchivedEmbeddingWork(engine, { sourceId, signature });
      if (blocked) { result.blocked = blocked; result.failures = (result.failures ?? 0) + blocked; }
      if (projectionBlocked) result.blocked = (result.blocked ?? 0) + projectionBlocked;
      // A deferred ledger row is incomplete work, never a successful drain.
      await settleRemaining(engine, sourceId, signature, result, true, !!result.invalidationSkipped || signatureInvalidationFailed);
      result.done = true;
      return result;
    }
  }
}

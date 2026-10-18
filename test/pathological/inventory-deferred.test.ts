/**
 * GBRA-130: every inventory row not fixed in this suite yet is a named
 * test.todo here (reports/GBRA-130-inventory.md in the crew drive), so a row
 * can't drop out of sight. When a row is fixed, delete it from DEFERRED and add
 * its probe file; ./sites.test.ts and the guard below keep the two lists apart.
 */
import { describe, expect, test } from 'bun:test';
import { ISOLATE_SITES } from '../../src/core/item-failure.ts';

/** [row id, owner or disposition, what goes wrong] */
export const DEFERRED: ReadonlyArray<readonly [string, string, string]> = [
  ['A-5', 'GBRA-101 (4b)', 'A publication whose transaction **always** hits 57014 or 55P03 is released as database_contention without charging an attempt'],
  ['A-6', 'GBRA-101 (4b)', 'Managed sync drain'],
  ['A-7', 'GBRA-101 (4b)', 'Managed freeze of one entry'],
  ['A-8', 'GBRA-129', 'Managed discovery: two pages claim one source_path, or the page at the file\'s slug records another origin'],
  ['A-11', 'GBRA-130 PR 2', 'A links or facts-backstop effect that fails the same way every time (examples: page_body_segmented from extractSegmentedPageLinks on a block over B...'],
  ['A-12', 'GBRA-130 PR 2', 'A withdrawal-mirror effect that ends failed gates its request\'s git and embedding effects forever'],
  ['A-13', 'GBRA-130 PR 2', 'A targeted (v2 withdrawal) or scan embedding effect: one page whose provider call fails every time (a chunk the provider rejects with a non-config...'],
  ['A-14', 'GBRA-101 (journal.ts is 4b-touched)', 'Compaction selects the 100 oldest eligible receipts, but it does not filter out each worktree\'s newest committed sync receipt there'],
  ['A-15', 'GBRA-130 PR 2', 'Deactivate blocks on every effect with state<>\'committed\', terminal failures included'],
  ['A-16', 'GBRA-130 PR 2', 'A withdrawal-mirror **effect** recovery, a staging-bytes recovery, or a terminal request that still holds a recovery record blocks every write and...'],
  ['A-17', 'GBRA-101 (4b)', 'Managed discovery'],
  ['A-18', 'GBRA-130 PR 2', 'Legacy incremental/full sync gate'],
  ['A-19', 'deferred (intentional gate; narrow later)', 'Legacy rename reconcile'],
  ['A-20', 'GBRA-101 (4b)', 'Managed screen'],
  ['A-24', 'GBRA-130 PR 2', 'extract_facts phantom pass'],
  ['A-25', 'GBRA-130 PR 2', 'propose_takes'],
  ['A-28', 'GBRA-101 (4b)', 'gbrain sync unblock --source <id> --apply (the documented operator exit for held files) calls runContentLane for fence and slug-conflict holds with...'],
  ['A-29', 'deferred (intentional gate; narrow later)', 'One live job (waiting/active/delayed/waiting-children/paused) whose submission_authority is SQL NULL, malformed, or a future version written by a n...'],
  ['A-30', 'GBRA-130 PR 2', 'Inline isolation (the default, worker.ts:325)'],
  ['A-31', 'GBRA-130 PR 2', 'gbrain migrate --to … copies open_loops/loop_suppressions row by row'],
  ['A-32', 'deferred: next wave (test.todo)', 'Legacy un-syncable sweep'],
  ['A-33', 'deferred: next wave (test.todo)', 'Full sync reconcile delete'],
  ['A-34', 'GBRA-101 (4b)', 'Owner-startup refresh recovery: rows ordered by created_at LIMIT 16 with no rotation'],
  ['A-35', 'deferred: next wave (test.todo)', 'drainEffects runs the noop-settle loop first'],
  ['A-36', 'GBRA-60', 'A facts batch with one entity request that ended terminal on a code other than source_changed or withdrawal (revision_conflict, invalid_fence, page...'],
  ['A-37', 'deferred: next wave (test.todo)', 'extract_atoms, unmanaged'],
  ['A-38', 'deferred: next wave (test.todo)', 'Managed extract_facts on a connector source (always windowed by sourceChangedSince)'],
  ['A-39', 'deferred: next wave (test.todo)', 'chronicle'],
  ['A-40', 'deferred: next wave (test.todo)', 'edge_contradictions with dream.single_value.mode=apply'],
  ['A-42', 'GBRA-60', 'Managed extract_atoms: one atom titled .example '],
  ['A-43', 'deferred (intentional gate; narrow later)', 'synthesize'],
  ['A-47b', 'next wave (found by the A-47 lane)', 'Orchestrator v0.29.1 backfill_effective_date (src/core/backfill-effective-date.ts) runs each batch in one transaction with no per-row isolation, the shape A-47 fixed in backfill-base'],
  ['A-48', 'deferred: next wave (test.todo)', 'gbrain repair-jsonb / orchestrator v0.12.2: for the five non-jsonPayloadOnly targets (pages.frontmatter, raw_data.data, ingest_log.pages_updated, f...'],
  ['A-51', 'GBRA-60', 'Managed conversation-facts publication sends a batch of pages as one request'],
  ['A-52', 'deferred: next wave (test.todo)', 'Unmanaged extraction (cycle incremental pass and full fs walk)'],
  ['A-53', 'GBRA-101 (4b)', 'Managed import batches (IMPORT_BATCH_MAX_PAGES) admit every member in one transaction'],
  ['A-54', 'deferred: next wave (test.todo)', 'One link whose addLink throws on the target (a target page absent for any reason other than a known failed/vanished page, or a link-type constraint...'],
  ['A-55', 'deferred: next wave (test.todo)', 'Full sync re-export of DB-only pages: one try around the loop, so the first writePageThrough throw stops re-export of all remaining pages, silently...'],
  ['A-56', 'deferred: next wave (test.todo)', 'Legacy facts backstop per page: catch { /* per-page enqueue is best-effort */ } with no counter'],
  ['A-57', 'GBRA-101 (4b)', 'Managed per-file prepare/screen: loadActivePackForEngine(...).catch(() => null)'],
  ['A-58', 'deferred: next wave (test.todo)', 'Legacy import, file gone from disk branch: clearLegacyHold is outside any try, so a DB error there escapes importOnePath and aborts the whole drain...'],
  ['A-59', 'GBRA-101 (4b)', 'If the movement read fails, writer status shows movement: [], which looks the same as "no movement"'],
  ['A-60', 'GBRA-60', 'A failed belief-commit mark is swallowed with no counter or receipt'],
  ['A-61', 'deferred: next wave (test.todo)', 'The comment says "the next settlement retries"'],
  ['A-62', 'deferred: next wave (test.todo)', 'doctor --remediate --resume with pending_embed_sources from a budget-exhausted checkpoint: one source\'s embed error aborts the run before any job s...'],
  ['A-63', 'deferred: next wave (test.todo)', 'gbrain repair file-drift --source <id> --all-drifted preview: a plain Error for one slug (fs EACCES/ENAMETOOLONG on the canonical path, a YAML or d...'],
  ['A-64', 'deferred: next wave (test.todo)', 'Fences\' managed write rethrows codes other than the changed/sync_in_progress set'],
  ['A-65', 'GBRA-60', 'repair captured-facts classifies paste-only facts by reading the session corpus'],
  ['A-66', 'GBRA-101 (4b)', 'In the per-file catch branch, await opts.onFileResult?.(…) sits outside any try, so a throw from sync\'s ledger callback escapes and aborts the whol...'],
  ['A-67', 'deferred (intentional gate; narrow later)', 'Jobs fail as a whole when any single page or file was refused (#5904, #6273 intent: never report success over unwritten rows)'],
  ['B-1', 'GBRA-129', 'Two live pages record one source_path'],
  ['B-2', 'GBRA-101 (4b)', 'One page in the source whose stored source_path is empty, absolute or contains ../'],
  ['B-3', 'GBRA-101 (4b)', 'Two origins for one slug differ only by case or backslash spelling (People/X.md recorded, plus a new people/x.md in the tree)'],
  ['B-4', 'GBRA-101 (4b)', 'A file takes over the page at its slug whose explicit frontmatter id differs'],
  ['B-5', 'GBRA-130 PR 2', 'put_page and entity stubs accept slugs that gbrain export refuses'],
  ['B-7', 'GBRA-60', 'Facts are minted on an entity_slug that has no page'],
  ['B-8', 'deferred: next wave (test.todo)', 'Rename A→B leaves alias A→B; a later put_page, import, restore or sync creates a live page at A'],
  ['B-9', 'GBRA-60', 'A retired alias page (canonical: false, superseded_by) gets enrichment timeline entries and backlinks'],
  ['B-10', 'GBRA-60', 'Re-keying entity_slug (rename, phantom redirect, relink) does not dedupe ontology rows'],
  ['B-11', 'deferred: next wave (test.todo)', 'NFD and NFC spellings are accepted as two different slugs (probe: validateSlug of people/jose + U+0301 is not equal to the NFC people/josé)'],
  ['B-12', 'GBRA-130 PR 2', 'A slug segment of ≥85 CJK chars passes put_page, then lstat fails ENAMETOOLONG'],
  ['B-13', 'deferred: next wave (test.todo)', 'Frontmatter id is not unique per source'],
  ['B-14', 'GBRA-95', 'Streamed (segmented) sync refuses revision_conflict "A different page already owns this file identity"'],
  ['B-15', 'GBRA-129', 'sources reconcile refuses per page when several live pages claim the recorded file'],
  ['B-16', 'GBRA-101 (4b)', 'legacy_slug_conflict (#6727): several legacy pages fold to one file slug'],
  ['C-1', 'GBRA-130 PR 2', 'A withdrawal-mirror effect holds a recovery record and the file on disk was edited so it matches neither recorded version'],
  ['C-2', 'GBRA-130 PR 2', 'Sync-time fact capture appends a ## Facts fence into a gbrain-owned sources add --url clone'],
  ['C-3', 'GBRA-130 PR 2', 'First kernel-v1 acquisition on a PGLite brain whose .gbrain-lock/ was left by a crashed pre-kernel process, when its lock metadata is torn or missi...'],
  ['C-4', 'GBRA-130 PR 2', 'A shared-skill bundle publication (recovery version: 2) is stuck in recovery, which "stops every write on its worktree" (repair.md:138)'],
  ['C-5', 'GBRA-130 PR 2', 'sources writer transfer prepare leaves the worktree draining until accept'],
  ['C-7', 'GBRA-130 PR 2', 'After a cross-host writer transfer (or relocation) of a gbrain-owned content-directory source, the shared-skills content receipt keeps the old host...'],
  ['C-8', 'deferred (intentional gate; narrow later)', 'One live job row with a missing or unsupported submission_authority (a pre-v0.50 row, or one written by a newer build) stops every worker from star...'],
  ['C-9', 'GBRA-60', 'A put_page\'s facts-absorb job dies after 5 attempts (provider outage, or bad config as in #6113)'],
  ['C-10', 'deferred: next wave (test.todo)', 'A projection job that fails deterministically (a code page missing source_path, an unreadable segment) is retried every 30 s forever'],
  ['C-11', 'deferred: next wave (test.todo)', 'One transcript with real drift keeps --since last from ever advancing, so every run rescans all sessions'],
  ['C-12', 'deferred: next wave (test.todo)', 'A crash during writeState truncates .github-source.json'],
  ['C-13', 'deferred: next wave (test.todo)', 'A crashed skillpack install leaves .gbrain-skillpack.lock behind'],
  ['C-14', 'deferred: next wave (test.todo)', 'A holder hung inside its body (awaiting a statement the pooler never returns, the #6366 shape) keeps refreshing, so the TTL, the steal grace and --...'],
  ['C-15', 'deferred: next wave (test.todo)', 'When the vault lock is busy for more than 5 s, the writer proceeds without it (the code comment admits a deleted credential can be resurrected)'],
  ['C-16', 'GBRA-129', 'Duplicate-origin twins abort all managed sync'],
  ['C-17', 'GBRA-128', 'A 0-byte index.lock parks every git effect'],
  ['C-18', 'GBRA-101 (4b)', 'One resolved page write leaves the run blocked_by_failures, and every autopilot sync job "completes" with the parked result'],
  ['C-19', 'GBRA-101 (4b)', 'Generic invalid_params refusal, and a writer queue with a null heartbeat'],
  ['C-20', 'GBRA-101 (4b)', 'Holds survive an authorized DB-only delete (#6600)'],
  ['C-21', 'GBRA-101 (4b)', 'On macOS, case-colliding paths: refresh_dirty has no safe recovery'],
  ['C-22', 'GBRA-95', 'stuck-recovery refuses a large-file recovery: "resolve it by hand"'],
  ['C-23', 'GBRA-60', 'quarantine clear --force and an owner confirm are stripped by the next working-tree sync (#6919)'],
];

describe('GBRA-130 inventory rows not yet fixed here', () => {
  test('row ids are unique and none is already fixed at an ISOLATE_SITES site', () => {
    const ids = DEFERRED.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    const fixed = new Set<string>(Object.values(ISOLATE_SITES));
    expect(ids.filter((id) => fixed.has(id))).toEqual([]);
  });
  for (const [id, owner, what] of DEFERRED) test.todo(`${id} (${owner}): ${what}`, () => {});
});

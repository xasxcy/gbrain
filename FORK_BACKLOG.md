# FORK_BACKLOG

Fork-owned backlog for `feature/pgroonga-chinese-fts`. **New file, fork-only** — it
does not exist upstream, so it never conflicts on a merge.

It lives here rather than in the operator's vault so that an upstream-sync session,
which works inside this repository, actually sees it. Anything recorded here must
carry an explicit **trigger condition**: the criterion under which it stops being
"latent" and becomes work. A backlog entry without a trigger is a note nobody
re-evaluates.

Scope, so the three places don't drift into each other:

- **this file** — deferred fork *defects*, each with a trigger condition
- **`FORK_RUNTIME.md`** — runtime topology and environment traps (which host serves
  what, Surge Ponte behaviour, cron guards, how to tell a real outage from a fake one)
- **`DECISIONS.md`** in the operator's vault (`01-raw/PARA/1. 项目/PKM-OB_Hermes秘书系统/`)
  — the ADR single source of truth. Architectural decisions go there, not here.

---

## FB-001 · `files` is keyed per-source but three operations are still source-blind

- **Recorded**: 2026-08-16 (upstream batch 3, v0.42.72.1 → v0.46.6.0)
- **Status**: latent — code defect confirmed by reading; zero occurrences in production today
- **Origin**: pre-existing; NOT introduced by batch 3. Found during adversarial review of that batch.

### What is wrong

Fork migration `files_source_id_storage_path_unique` (v132, originally v124) replaced
the global `UNIQUE(storage_path)` on `files` with the composite
`UNIQUE(source_id, storage_path)`. The engines honour it — both
`PostgresEngine.getFile` and `PGLiteEngine.getFile` require `sourceId + storagePath`.
Three operations in `src/core/operations.ts` did not follow:

| Site | Problem |
|---|---|
| `file_upload` (~`:3506`) | `storagePath = ${pageSlug}/${filename}` — **no source component**. Two sources uploading the same filename under the same page slug get two DB rows pointing at one storage key. |
| `file_list` (~`:3461`) | No `ctx.sourceId` filter, and `source_id` is not in the projection. Callers cannot tell which source an attachment belongs to. |
| `file_url` (~`:3569`) | Selects on `storage_path` alone. With rows from two sources, which row is returned is not deterministic. |

The composite key is therefore declared but not honoured above the engine layer.

### Why it is not urgent yet (production, measured 2026-08-16)

```
sources with rows in files        lifeos-vault = 1975, chonghe-writing = 29
storage_path duplicated across sources    0 groups
page_slug duplicated across sources       0 groups
object storage configured                 NO  (~/.gbrain/config.json has no `storage` key)
```

The last line matters most: `file_upload` wraps the actual object write in
`if (ctx.config.storage)`. With no storage backend configured, **no bytes are written
at all**, so the worst symptom — source B overwriting source A's file while A's row
still advertises A's hash and size — is structurally impossible on this deployment.
`files` here is metadata only.

### Trigger conditions — promote to active work when EITHER holds

1. **A second source attaches a same-named file to a same-named page slug.** Detect with:
   ```sql
   SELECT storage_path FROM files GROUP BY storage_path HAVING count(DISTINCT source_id) > 1;
   SELECT page_slug   FROM files WHERE page_slug IS NOT NULL
     GROUP BY page_slug HAVING count(DISTINCT source_id) > 1;
   ```
   Both must stay at 0. Non-zero on the first query means rows already collide.
2. **Object storage gets configured** (a `storage` key appears in `~/.gbrain/config.json`).
   This one is a *pre*-condition, not a symptom: enable storage and the byte-overwrite
   path goes live immediately, silently, with no error at either end.

### Shape of the fix, when it is taken

Give the storage key a source component (`${sourceId}/${pageSlug}/${filename}`), scope
`file_list`/`file_url` by `ctx.sourceId`, and return `source_id` from `file_list`.
Note that changing the key changes existing objects' addresses — if any objects exist by
then, the change needs a migration for the stored paths, not just a code edit.

Existing coverage is insufficient to catch a regression here:
`test/file-upload-engine-context.test.ts` only exercises the single `default` source.
Any fix must add a genuinely two-source case.

---

## FB-002 · The `embed_failures` retry ledger is unreachable for transient provider failures

- **Recorded**: 2026-08-17, after an overnight incident
- **Status**: confirmed defect, unfixed. Fork-only — `embed-slice-persist.ts`,
  `embed-failure.ts` and `embed-fallback.ts` are all absent upstream.
- **Severity**: this is an unbounded retry loop that leaves no trace. It burned a
  GPU all night for zero embedded chunks and nothing in the database recorded it.

### What happened

366 chunks (one page: a long imported nacos article, avg 2683 chars/chunk) failed to
embed. Cron rounds ran back-to-back from 19:30 to past 04:00, each round retrying all
366 from scratch, each failing on `[embed(ollama:qwen3-embedding:4b)] The operation
timed out`. Every round reported `backoff_deferred=0; quarantined=0`.

Afterwards `embed_failures` held **zero rows**. Not stale rows — none, ever.

### Why: the ledger write is structurally unreachable on this path

```
ai/errors.ts:69       "Everything else (5xx, timeouts, network) = transient"
                        -> new AITransientError
isTransientEmbedError   -> instanceof AITransientError -> true
isPartialStaleSplitWorthyError -> false   (#3037: don't fan a rate-limit/outage
                                           out into N single-chunk requests)
embed-fallback.ts:191   terminalResult(vectors, failures=[], ..., error, allIndexes)
                        -> fatalError set, `failures` EMPTY
embed-slice-persist.ts:75  for (const failure of partial.failures)  -> 0 iterations
                        -> entries.length === 0
                        -> persistEmbedOutcome never called
                        -> no ledger row
next round              listStaleChunks sees 366 chunks, no ledger -> all eligible
```

`partial.fatalError` is only passed to `write()` as a log line; it never becomes a
ledger entry. So `backoff_deferred` and `quarantined` can never be non-zero for this
failure class — the counters are structurally pinned at 0.

The `if (classified.kind === 'fatal') continue` at `embed-slice-persist.ts:79` is a
different and correct skip (`AIConfigError`, where retrying is pointless). Transient
errors never reach that loop at all.

The irony worth keeping: the ledger (fork migration `embed_failures_ledger`) exists
precisely to back off and quarantine failing chunks, and it is unreachable for the
single most likely reason to need it — the provider being down or slow.

### Trigger condition

Already met, and it will recur on the next provider outage. Treat the next
`Embedded 0 chunks ... eligible_now=N` repeated across rounds as this bug, not as a
provider problem to chase.

### Shape of the fix

Turn `partial.fatalError` + `partial.fatalIndexes` into ledger entries in
`persistStaleSlice` — classified (`provider_timeout` / `provider_conn`), so the
existing backoff and quarantine machinery applies. Keep the #3037 property that
transient errors do NOT fan out into per-chunk retries: recording a failure is not
the same as retrying it. A regression test should assert that a batch failing with a
transient error leaves N ledger rows rather than zero.

Note the endpoint itself was healthy when checked the next morning: a 32-chunk
batch of ~2700-char texts returned HTTP 200 in 11.6s against a 180s timeout. So the
outage was real but transient — the defect is that nothing bounded the retrying.

---

## FB-003 · `db-lock-fencing` LockStolenError case is an unreproduced CI flake

- **Recorded**: 2026-08-17
- **Status**: root cause NOT established. Recorded so the next person does not
  re-derive it from scratch — and does not mistake a green run for a fix.
- **Origin**: upstream code, new in the v0.42.72.1 -> v0.46.6.0 merge. Not a fork
  regression: neither `test/db-lock-fencing.test.ts` nor `startCycleLockRefresher`
  existed at the pre-merge anchor `cdcc5903`, and `cycle.ts` never conflicted.

### The failure

`startCycleLockRefresher (Tier-1 #1 + D5.11) > aborts the controller with
LockStolenError when a fenced refresh returns false` — failed once in CI shard 9.

### What has been ruled out

- Reproduction attempts: single file 10/10 pass; 5 consecutive loops all pass;
  running it in the same process as the two other then-failing files also passes.
- 100,000 iterations of `controller.abort(new LockStolenError(...))` preserved
  `signal.reason` object identity and `instanceof` every time — so the "AbortController
  loses the reason" hypothesis is dead. (An earlier hand-rolled probe gave
  self-contradictory results across two runs; it was wrong, and was discarded rather
  than used to support a conclusion.)
- The interval clears `inFlight` in a `finally`, and the test calls `stop()` in a
  `finally`. No test was found that mutates a global AbortController or timer.

### What has NOT been ruled out

The full 130-file shard 9 has not been run locally, so timer starvation under shard
load, a Bun runner isolation issue, or cross-file pollution from a file not yet
identified all remain open. The raw CI failure assertion/log was never captured.

**A later green CI run is not evidence this is fixed.** It reproduces rarely; absence
of failure across a handful of runs is what a flake looks like. Next occurrence:
capture the failing assertion text and the shard's file list before anything else.

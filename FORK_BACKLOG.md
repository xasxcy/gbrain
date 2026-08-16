# FORK_BACKLOG

Fork-owned backlog for `feature/pgroonga-chinese-fts`. **New file, fork-only** — it
does not exist upstream, so it never conflicts on a merge.

It lives here rather than in the operator's vault so that an upstream-sync session,
which works inside this repository, actually sees it. Anything recorded here must
carry an explicit **trigger condition**: the criterion under which it stops being
"latent" and becomes work. A backlog entry without a trigger is a note nobody
re-evaluates.

Architectural decisions are NOT recorded here — the ADR single source of truth is
`DECISIONS.md` in the operator's vault (`01-raw/PARA/1. 项目/PKM-OB_Hermes秘书系统/`).
This file only tracks deferred fork defects.

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

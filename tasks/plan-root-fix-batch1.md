# Root embed fix — batch 1 implementation plan

Source of truth: `SPEC-root-fix-v3.md` v3.1 in the dispatched work-order directory.

## Scope

- Implement batch 1 only: slice checkpoints, atomic outcome persistence, failure
  ledger, partial-only error classification, cooperative shutdown, eligibility,
  CLI observability, and the required regression coverage.
- Do not implement batch 2 page budget/fairness behavior, operate production
  migrations, modify `.agents/**`, or create commits.

## Delivery slices

1. Record public seams and baseline tests; add red tracer tests for the first
   persistence/ledger contract before implementation.
2. Add the schema, append-only migration, engine contract, and Postgres/PGLite
   atomic `persistEmbedOutcome` parity. Cover ledger generation cleanup and
   eligibility/count semantics.
3. Move only stale foreground/Minion pipelines to bounded outer slices; persist
   each completed slice, preserve V4 legacy callers, counters, signatures, and
   abort identity.
4. Add the shutdown registry and compose the Minion shutdown signal without
   changing SIGPIPE/uncaught-exception fast paths.
5. Add CLI ledger release/list, doctor/summary/stderr observability; finish the
   full batch-1 test matrix and rerun V4 regressions.
6. Synchronize docs and write the requested implementation report with actual
   red-to-green and verification evidence; do not commit.

## Status

- [x] Read brief, v3.1 specification, and D2/D2R2/D2R3 convergence records.
- [x] Capture baseline and add first red tests (sub-batch bounds, partial-only
  ECONNRESET salvage, failure classification, and checkpoint slicing).
- [x] Implement the atomic outcome v126, stale slices, shutdown registry,
  eligibility wiring, and CLI list/release surface, with vertical tests.
- [x] Run typecheck, verify, targeted persistence/slice/ledger tests, and the
  seven V4-related regression files; write the implementation report.
- [ ] Remaining acceptance gaps deliberately recorded in the report: no doctor
  four-metric summary, no Postgres EXPLAIN structural assertion, and no
  Docker-backed Postgres E2E in this environment. Batch 2 page budgeting is
  intentionally out of scope.

## F1 follow-up (2026-07-20)

- [x] Add red tests for the shared embed-failure four-metric summary, doctor
  rendering, and stale-run summary line.
- [x] Implement the shared engine summary in both engines; doctor consumes it
  with explicit `--source` scoping and stale runs emit `persistFailures` plus
  the four metrics.
- [x] Add DATABASE_URL-gated Postgres EXPLAIN JSON structural assertions and
  record the existing PGLite cursor-pagination functional coverage.
- [x] Run the requested typecheck/verify/new-test/V4 command set, then append
  only evidenced findings to `F1-followup-REPORT.md`. No commit or production
  database operations.

## F2 correction (2026-07-20)

- [x] Preserve must-abort identity across a failed slice checkpoint; restore
  V4's signature three-way rule and separate signature-write accounting.
- [x] Add partial-only invalid-input bisection and its run-global/failure
  accounting boundaries, without widening legacy callers.
- [x] Extend inline-import shutdown registration through its write transaction;
  add the required shutdown-order and signal/deadline coverage.
- [x] Make the v126 migration and production selector/summary SQL the actual
  acceptance subjects; run the requested isolated local Postgres gate.
- [x] Add slice and per-chunk stale-skip structured stderr assertions; execute
  the requested final checks and write `F2-correction-REPORT.md` (no commit,
  no production DB, no Batch 2).

#!/usr/bin/env bash
# FORK: run after `git merge <upstream release tag>` (conflicts resolved, before committing).
# Regenerates every file the `fork-theirs` driver took from upstream, re-runs the ratchet
# checks, and lists what a human still has to look at. Never commits.
#
#   bash scripts/fork/merge/after-merge.sh            # offline goldens only
#   DATABASE_URL=postgresql://…/gbrain_test_x bash scripts/fork/merge/after-merge.sh   # + Postgres goldens
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
log="${TMPDIR:-/tmp}/fork-after-merge-$$.log"
step() { printf '\n== %s\n' "$*"; }
fail=0

step "files still holding conflict markers"
markers="$(git diff --name-only --diff-filter=U; git grep -lE '^(<<<<<<<|>>>>>>>) ' -- ':!*.md' 2>/dev/null)"
if [ -n "${markers}" ]; then printf '%s\n' "${markers}" | sort -u; fail=1; else echo "none"; fi

step "regen:all"
bun run regen:all >"${log}" 2>&1 || { echo "regen:all failed (log ${log})"; fail=1; }

step "offline contract goldens"
n=0
while IFS= read -r t; do
  n=$((n + 1))
  if ! GBRAIN_TEST_UPDATE_GOLDENS=1 bun test --timeout=60000 "${t}" >>"${log}" 2>&1; then echo "golden refresh failed: ${t}"; fail=1; fi
done < <(git grep -lE 'GBRAIN_TEST_UPDATE_GOLDENS|helpers/golden' -- 'test/*.test.ts' 'test/**/*.test.ts' ':!test/e2e/**')
echo "${n} golden test file(s) refreshed"

if [ -n "${DATABASE_URL:-}" ]; then
  step "Postgres goldens"
  n=0
  while IFS= read -r t; do
    n=$((n + 1))
    if ! GBRAIN_TEST_ALLOW_DATABASE_URL=1 GBRAIN_TEST_UPDATE_GOLDENS=1 bun test --timeout=60000 "${t}" >>"${log}" 2>&1; then echo "golden refresh failed: ${t}"; fail=1; fi
  done < <(git grep -lE 'GBRAIN_TEST_UPDATE_GOLDENS|helpers/golden' -- 'test/e2e/*.test.ts')
  echo "${n} Postgres golden test file(s) refreshed"
else
  echo; echo "(no DATABASE_URL: Postgres goldens not refreshed; run again with a test database URL)"
fi

step "regen:all (again: llms inlines regenerated docs)"
bun run regen:all >>"${log}" 2>&1 || { echo "regen:all failed (log ${log})"; fail=1; }

step "ratchets"
for c in check:module-size check:function-size check:chunk-visibility check:engine-sql-ratchet; do
  if bun run "${c}" >>"${log}" 2>&1; then echo "ok   ${c}"; else echo "FAIL ${c} (log ${log})"; fail=1; fi
done

if git rev-parse -q --verify ORIG_HEAD >/dev/null; then
  step "goldens that now differ from the fork's pre-merge version (review each)"
  git diff --stat ORIG_HEAD -- test/fixtures/goldens | tail -n 15
fi
echo; echo "log: ${log}"
exit "${fail}"

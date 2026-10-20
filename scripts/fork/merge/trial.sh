#!/usr/bin/env bash
# FORK: read-only trial merge. Merges <ref> (default: the newest upstream release tag) into
# HEAD inside a throwaway worktree, with the fork's merge drivers and rerere, and reports the
# files a human would still have to resolve. Nothing in the current worktree or any branch changes.
#
#   bash scripts/fork/merge/trial.sh [--keep] [ref]
#
# --keep leaves the trial worktree (merge in progress) for inspection; remove it with
# `git worktree remove --force <path>`.
set -euo pipefail
keep=0
if [ "${1:-}" = "--keep" ]; then keep=1; shift; fi
cd "$(git rev-parse --show-toplevel)"
fail() { echo "trial.sh: $*" >&2; exit 1; }
# Only master and the release tags: a moving upstream tag (latest-stable) would make a plain
# `--tags` fetch refuse the update and exit non-zero.
git fetch --quiet upstream '+refs/heads/master:refs/remotes/upstream/master' 'refs/tags/v*:refs/tags/v*' \
  || fail "git fetch upstream failed"
ref="${1:-$(git tag -l 'v*' --sort=-v:refname --merged upstream/master | head -n 1)}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/fork-trial.XXXXXX")"
cleanup() { [ "${keep}" = 1 ] && return 0; git -C "${tmp}" merge --abort >/dev/null 2>&1 || true; git worktree remove --force "${tmp}" >/dev/null 2>&1 || true; rm -rf "${tmp}"; }
trap cleanup EXIT
git worktree add --detach "${tmp}" HEAD >/dev/null 2>&1 || fail "git worktree add ${tmp} failed"
git rev-parse -q --verify "${ref}^{commit}" >/dev/null || fail "unknown ref: ${ref}"
cd "${tmp}"
behind="$(git rev-list --count "HEAD..${ref}")"
merge_rc=0
merge_out="$(git -c core.hooksPath=/dev/null merge --no-commit --no-ff "${ref}" 2>&1)" || merge_rc=$?
unmerged="$(git diff --name-only --diff-filter=U | sort -u)"
# A conflicted merge exits 1 with unmerged paths; anything else that failed is not a result.
if [ "${merge_rc}" != 0 ] && [ -z "${unmerged}" ]; then
  printf '%s\n' "${merge_out}" >&2
  fail "git merge ${ref} failed (exit ${merge_rc}) without leaving conflicts"
fi
remaining="$(git rerere remaining 2>/dev/null | sort -u)"
n_unmerged="$(printf '%s' "${unmerged}" | grep -c . || true)"
n_remaining="$(printf '%s' "${remaining}" | grep -c . || true)"
echo "trial merge of ${ref} (${behind} upstream commit(s) ahead of HEAD)"
echo "conflicted after merge drivers: ${n_unmerged}"
echo "still to resolve by hand after rerere: ${n_remaining}"
hunks=0
while IFS= read -r f; do
  [ -n "${f}" ] || continue
  n="$(grep -c '^<<<<<<< ' "${f}" 2>/dev/null || true)"
  hunks=$((hunks + ${n:-0}))
  printf '  %s (%s hunk(s))\n' "${f}" "${n:-0}"
done <<< "${unmerged}"
echo "conflict hunks left in the working tree: ${hunks}"
[ "${keep}" = 1 ] && echo "kept trial worktree: ${tmp}"
exit 0

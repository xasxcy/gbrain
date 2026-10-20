#!/usr/bin/env bash
# FORK: read-only trial merge. Merges <ref> (default: the newest upstream release tag) into
# HEAD inside a throwaway worktree, with the fork's merge drivers and rerere, and reports the
# files a human would still have to resolve. Nothing in the current worktree or any branch changes.
#
#   bash scripts/fork/merge/trial.sh [ref]
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
fail() { echo "trial.sh: $*" >&2; exit 1; }
# Only master and the release tags: a moving upstream tag (latest-stable) would make a plain
# `--tags` fetch refuse the update and exit non-zero.
git fetch --quiet upstream '+refs/heads/master:refs/remotes/upstream/master' 'refs/tags/v*:refs/tags/v*' \
  || fail "git fetch upstream failed"
ref="${1:-$(git tag -l 'v*' --sort=-v:refname --merged upstream/master | head -n 1)}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/fork-trial.XXXXXX")"
cleanup() { git -C "${tmp}" merge --abort >/dev/null 2>&1 || true; git worktree remove --force "${tmp}" >/dev/null 2>&1 || true; rm -rf "${tmp}"; }
trap cleanup EXIT
git worktree add --detach "${tmp}" HEAD >/dev/null 2>&1 || fail "git worktree add ${tmp} failed"
git rev-parse -q --verify "${ref}^{commit}" >/dev/null || fail "unknown ref: ${ref}"
cd "${tmp}"
behind="$(git rev-list --count "HEAD..${ref}")"
git -c core.hooksPath=/dev/null merge --no-commit --no-ff "${ref}" >/dev/null 2>&1 || true
unmerged="$(git diff --name-only --diff-filter=U | sort -u)"
remaining="$(git rerere remaining 2>/dev/null | sort -u)"
n_unmerged="$(printf '%s' "${unmerged}" | grep -c . || true)"
n_remaining="$(printf '%s' "${remaining}" | grep -c . || true)"
echo "trial merge of ${ref} (${behind} upstream commit(s) ahead of HEAD)"
echo "conflicted after merge drivers: ${n_unmerged}"
echo "still to resolve by hand after rerere: ${n_remaining}"
[ -n "${remaining}" ] && printf '  %s\n' ${remaining}
exit 0

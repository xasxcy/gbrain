#!/usr/bin/env bash
# FORK: install the fork's merge drivers and rerere for this clone (all worktrees share it).
# Idempotent. Run from anywhere inside the repository.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
common="$(git rev-parse --git-common-dir)"
case "${common}" in /*) ;; *) common="${root}/${common}" ;; esac
mkdir -p "${common}/info"
src="${root}/scripts/fork/merge/attributes"
dst="${common}/info/attributes"
begin='# >>> fork merge drivers >>>'
end='# <<< fork merge drivers <<<'
tmp="$(mktemp)"
if [ -f "${dst}" ]; then awk -v b="${begin}" -v e="${end}" '$0==b{skip=1} !skip{print} $0==e{skip=0}' "${dst}" > "${tmp}"; fi
{ cat "${tmp}"; echo "${begin}"; cat "${src}"; echo "${end}"; } > "${dst}"
rm -f "${tmp}"
# Drivers run with the worktree top as cwd, so the relative script path resolves in every worktree.
git config merge.fork-theirs.name 'fork: take upstream, regenerate after the merge'
git config merge.fork-theirs.driver 'bun scripts/fork/merge/driver.ts theirs %O %A %B %P'
git config merge.fork-tsv.name 'fork: keyed three-way merge of ratchet TSVs'
git config merge.fork-tsv.driver 'bun scripts/fork/merge/driver.ts tsv %O %A %B %P'
git config merge.fork-json-union.name 'fork: upstream shard weights plus fork-only keys'
git config merge.fork-json-union.driver 'bun scripts/fork/merge/driver.ts json-union %O %A %B %P'
git config rerere.enabled true
echo "installed fork merge drivers into ${dst} (and rerere.enabled=true)"

#!/usr/bin/env bash
# check-fork-migration-masking.sh
#
# Fork-specific CI guard: catches upstream migrations that the fork's numbering
# will mask on brains already stamped at the old numbers.
#
# THE FAILURE MODE
#
#   `runMigrations` gates on a single high-water INTEGER (`m.version > current`),
#   not on an applied-set. ADR-087 therefore renumbers fork migrations above
#   upstream's maximum on every sync, so upstream's numbers stay byte-identical.
#
#   But renumbering only moves the fork's DEFINITIONS. A brain whose counter was
#   already stamped by the fork's OLD numbers treats every upstream migration now
#   occupying those numbers as applied — and skips it forever. Silently: no
#   conflict, no error, no drift the version counter can see.
#
#   This has happened three times. fork-migrations.ts carries the repairs:
#     v147  re-applies upstream 126/127/128
#     v148  re-applies upstream 125
#     v149  re-applies upstream 131/132/133/135/136/137   (ADR-095)
#
#   The third one got through because the renumber used to run ONLY on the
#   migrate.ts-conflict path. The 2026-08-25 sync merged migrate.ts cleanly, so
#   nothing renumbered and fork 131-137 collided head-on with upstream's new
#   131-141. The sync script now renumbers on every path and calls this lint
#   (ADR-096) — and this lint exists as a standalone so the HAND-RESOLVED merge
#   path, which the sync script aborts out of, is covered too.
#
# WHAT IT CHECKS
#
#   1. ADR-087 floor — every fork migration sits strictly above upstream's max.
#   2. Masking — for every upstream version inside the fork's PREVIOUS range,
#      fork-migrations.ts must either re-apply it in a repair migration or carry
#      an explicit `// masking-exempt: <N> — <reason>` marker.
#
#   The "previous range" comes from git: during a merge that is HEAD (the fork's
#   pre-merge commit); otherwise pass a baseline ref explicitly. Check 2 is
#   skipped, loudly, when no baseline is available — it is a comparison, and a
#   comparison without a baseline is not a weaker check, it is no check.
#
# EXEMPTIONS
#
#   A repair is the default. An exemption has to be written next to the
#   migrations it concerns, with its reason, e.g.
#
#     // masking-exempt: 134 — already present on the live brain, and upstream
#     //   does not declare it idempotent, so re-applying it buys nothing.
#
#   Deliberately noisy to write and trivial to grep: this guard exists to
#   prevent silence, so an exemption must be a visible, reviewable artifact
#   rather than an implicit gap.
#
# Run: bash scripts/check-fork-migration-masking.sh [baseline-ref]
# Exit 0 = all clear; non-zero = at least one violation (details on stderr).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MIGRATE='src/core/migrate.ts'
FORK='src/core/fork-migrations.ts'
LABEL='[check-fork-migration-masking]'

for f in "$MIGRATE" "$FORK"; do
  if [ ! -f "$f" ]; then
    echo "$LABEL ERROR: $f not found (run from a gbrain checkout)" >&2
    exit 1
  fi
done

# Baseline for the "previous fork range". Explicit arg wins; otherwise HEAD is
# the right answer during a merge (HEAD is still the pre-merge fork commit) and
# also the right answer for a post-merge audit of an uncommitted resolution.
BASELINE="${1:-}"
if [ -z "$BASELINE" ]; then
  if git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
    BASELINE=HEAD
  elif git rev-parse -q --verify HEAD >/dev/null 2>&1; then
    BASELINE=HEAD
  fi
fi

# The baseline copy goes to a temp FILE, not a pipe: this script feeds python
# its program on stdin via the heredoc below, so piping data there too silently
# leaves the reader empty — which made an early version print OK while the
# masking check never ran at all.
BASELINE_FILE="$(mktemp -t gbrain-masking-baseline)"
trap 'rm -f "$BASELINE_FILE"' EXIT
if [ -n "$BASELINE" ]; then
  git show "$BASELINE":"$FORK" > "$BASELINE_FILE" 2>/dev/null || : > "$BASELINE_FILE"
fi

python3 - "$MIGRATE" "$FORK" "${BASELINE:-<none>}" "$BASELINE_FILE" <<'PYEOF'
import re, sys

migrate_path, fork_path, baseline_ref, baseline_file = sys.argv[1:5]
baseline_fork = open(baseline_file).read()
migrate = open(migrate_path).read()
fork = open(fork_path).read()

LABEL = '[check-fork-migration-masking]'
def fail(msg):
    print(f'{LABEL} {msg}', file=sys.stderr)

def versions(text):
    return [int(v) for v in re.findall(r'^\s+version:\s*(\d+),', text, re.M)]

upstream = versions(migrate)
fork_versions = versions(fork)
if not upstream:
    fail(f'ERROR: no version numbers found in {migrate_path}')
    raise SystemExit(1)
if not fork_versions:
    fail(f'ERROR: no fork migrations found in {fork_path} — refusing to pass a '
         'fork with none (that shape has meant a mangled injection before)')
    raise SystemExit(1)

upstream_max = max(upstream)
violations = 0

# ── Check 1: ADR-087 floor ──────────────────────────────────────────────────
floor_decl = re.search(r'export const FORK_MIGRATION_FLOOR = (\d+);', fork)
if not floor_decl:
    fail(f'ERROR: FORK_MIGRATION_FLOOR not found in {fork_path}')
    raise SystemExit(1)
floor = int(floor_decl.group(1))

below = sorted(v for v in fork_versions if v <= upstream_max)
if below:
    fail(f'FAIL (ADR-087 floor): fork migration(s) {",".join(map(str, below))} '
         f'sit at or below upstream max {upstream_max}.')
    fail('      Fork numbers must move so upstream\'s stay byte-identical. '
         'Renumber above the upstream high-water, then re-run.')
    violations += 1
if floor <= upstream_max:
    fail(f'FAIL (ADR-087 floor): FORK_MIGRATION_FLOOR={floor} is not above '
         f'upstream max {upstream_max}.')
    violations += 1
if floor != min(fork_versions):
    fail(f'FAIL: FORK_MIGRATION_FLOOR={floor} does not match the lowest fork '
         f'migration ({min(fork_versions)}) — the floor is what the registry '
         'test and the idempotency claim are keyed on.')
    violations += 1

# ── Check 2: masking ────────────────────────────────────────────────────────
if not baseline_fork.strip():
    print(f'{LABEL} NOTE: no baseline copy of {fork_path} at "{baseline_ref}" — '
          'masking check SKIPPED (it is a comparison; without a baseline there '
          'is nothing to compare). Pass a ref explicitly to run it.')
else:
    prev = versions(baseline_fork)
    prev_floor_decl = re.search(r'export const FORK_MIGRATION_FLOOR = (\d+);', baseline_fork)
    if not prev or not prev_floor_decl:
        fail(f'ERROR: baseline {fork_path} at "{baseline_ref}" has no readable '
             'migration numbering')
        raise SystemExit(1)
    prev_lo, prev_hi = min(prev), max(prev)

    masked = sorted(v for v in set(upstream) if prev_lo <= v <= prev_hi)
    if not masked:
        print(f'{LABEL} masking: none — upstream claims nothing in the fork\'s '
              f'former range {prev_lo}-{prev_hi} (baseline {baseline_ref}).')
    else:
        covered = set()
        # Both shapes the fork's repair migrations use to name their targets.
        for arr in re.findall(r'for \(const version of \[([0-9,\s]+)\]\)', fork):
            covered.update(int(n) for n in re.findall(r'\d+', arr))
        covered.update(int(n) for n in re.findall(r'm\.version === (\d+)', fork))
        exempt = set(int(n) for n in re.findall(r'//\s*masking-exempt:\s*(\d+)', fork))

        missing = [v for v in masked if v not in covered and v not in exempt]
        if missing:
            fail(f'FAIL (masking): upstream migration(s) '
                 f'{",".join(map(str, missing))} have no repair and no exemption.')
            fail(f'      They now occupy numbers the fork previously used '
                 f'({prev_lo}-{prev_hi}, baseline {baseline_ref}), so any brain '
                 'stamped at the old fork high-water will skip them FOREVER —')
            fail('      runMigrations gates on one high-water integer, not an '
                 'applied-set. Renumbering alone does NOT unmask them.')
            fail('      Fix: add a repair migration to src/core/fork-migrations.ts '
                 'following the v147/v148/v149 shape (look each target up in the '
                 'live MIGRATIONS registry rather than copying its DDL).')
            fail('      Verify against the live brain which of them are actually '
                 'absent, and check each declares idempotent: true. If one '
                 'genuinely needs no repair, record why:')
            fail('        // masking-exempt: <N> — <reason>')
            violations += 1
        else:
            detail = []
            if covered & set(masked):
                detail.append('repaired ' + ','.join(map(str, sorted(covered & set(masked)))))
            if exempt & set(masked):
                detail.append('exempt ' + ','.join(map(str, sorted(exempt & set(masked)))))
            print(f'{LABEL} masking: {",".join(map(str, masked))} masked — '
                  f'{"; ".join(detail)}.')

if violations:
    fail(f'{violations} violation(s) — see above.')
    raise SystemExit(1)

print(f'{LABEL} OK — {len(fork_versions)} fork migration(s) at v{floor}+, '
      f'upstream max v{upstream_max}.')
PYEOF

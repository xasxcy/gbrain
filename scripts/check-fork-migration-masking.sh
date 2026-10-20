#!/usr/bin/env bash
# check-fork-migration-masking.sh
#
# Fork-specific CI guard: keeps the fork's migrations on their own counter, so no
# upstream migration can be masked by a fork number again.
#
# BACKGROUND
#
#   `runMigrations` gates on one high-water integer (`m.version > current`), not
#   on an applied-set. While fork migrations shared `config.version` with
#   upstream, every upstream sync that claimed numbers a brain had already been
#   stamped with by the fork made the runner skip those upstream migrations
#   forever, and ten `repair_masked_upstream_*` migrations exist because of it.
#
#   Fork migrations now run in a separate pass gated on
#   `config.fork_schema_version` (src/core/fork-migrations.ts, "NUMBERING: A
#   COUNTER OF ITS OWN"). Neither counter can mask the other, as long as the
#   layout below holds.
#
# WHAT IT CHECKS
#
#   1. Contiguous — fork migration numbers run 1..N with no gap or duplicate.
#   2. Separate — migrate.ts never pushes fork migrations into MIGRATIONS (that
#      would put them back on upstream's counter).
#   3. Append-only — against a baseline ref, the baseline's fork migration names,
#      in order, are a prefix of the current ones. A published fork migration is
#      never renamed, renumbered, reordered or dropped. Compared by name order,
#      so it also accepts the one-time move from the legacy 261..275 numbering.
#
#   The baseline is HEAD (during a merge that is the fork's pre-merge commit);
#   pass a ref explicitly otherwise. Check 3 is skipped, loudly, without one.
#   test/fork-migrations-golden.test.ts pins each record's content as well.
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

BASELINE="${1:-}"
if [ -z "$BASELINE" ] && git rev-parse -q --verify HEAD >/dev/null 2>&1; then
  BASELINE=HEAD
fi

# The baseline copy goes to a temp FILE, not a pipe: python reads its program
# from the heredoc on stdin, so piping data there too leaves the reader empty.
BASELINE_FILE="$(mktemp -t gbrain-fork-baseline.XXXXXX)"
trap 'rm -f "$BASELINE_FILE"' EXIT
if [ -n "$BASELINE" ]; then
  git show "$BASELINE":"$FORK" > "$BASELINE_FILE" 2>/dev/null || : > "$BASELINE_FILE"
fi

python3 - "$MIGRATE" "$FORK" "${BASELINE:-<none>}" "$BASELINE_FILE" <<'PYEOF'
import re, sys

migrate_path, fork_path, baseline_ref, baseline_file = sys.argv[1:5]
migrate = open(migrate_path).read()
fork = open(fork_path).read()
baseline_fork = open(baseline_file).read()

LABEL = '[check-fork-migration-masking]'
def fail(msg):
    print(f'{LABEL} {msg}', file=sys.stderr)

# A migration literal is `version: N,` directly followed by `name: '...'`
# (the drift probes carry a version but no name, so they never match).
RECORD = re.compile(r"^\s*version:\s*(\d+),\s*\n\s*name:\s*'([^']+)'", re.M)
def records(text):
    return [(int(v), n) for v, n in RECORD.findall(text)]

current = records(fork)
if not current:
    fail(f'ERROR: no fork migrations found in {fork_path}; refusing to pass a '
         'fork with none (that shape has meant a mangled file before)')
    raise SystemExit(1)

violations = 0

# Check 1: contiguous from 1.
versions = [v for v, _ in current]
if sorted(versions) != list(range(1, len(versions) + 1)):
    fail(f'FAIL (contiguous): fork migration numbers are {versions}; they must '
         f'be exactly 1..{len(versions)}. Append new ones at the end with the '
         'next number; never renumber.')
    violations += 1

# Check 2: never on upstream's counter.
if re.search(r'MIGRATIONS\.push\(', migrate):
    fail(f'FAIL (separate): {migrate_path} pushes into MIGRATIONS. Fork '
         'migrations belong in FORK_MIGRATIONS on the fork_schema_version '
         'counter; on config.version they mask upstream migrations again.')
    violations += 1

# Check 3: append-only against the baseline.
if not baseline_fork.strip():
    print(f'{LABEL} NOTE: no baseline copy of {fork_path} at "{baseline_ref}"; '
          'append-only check SKIPPED. Pass a ref explicitly to run it.')
else:
    prev = [n for _, n in records(baseline_fork)]
    now = [n for _, n in sorted(current)]
    if not prev:
        fail(f'ERROR: baseline {fork_path} at "{baseline_ref}" has no readable '
             'fork migrations')
        raise SystemExit(1)
    if now[:len(prev)] != prev:
        first = next((i for i, (a, b) in enumerate(zip(prev, now)) if a != b), len(now))
        fail(f'FAIL (append-only): fork migration #{first + 1} was '
             f'"{prev[first] if first < len(prev) else "?"}" at {baseline_ref} '
             f'and is now "{now[first] if first < len(now) else "(missing)"}". '
             'Brains have already run the published ones under these numbers; '
             'only append.')
        violations += 1
    else:
        print(f'{LABEL} append-only: {len(prev)} published, '
              f'{len(now) - len(prev)} appended (baseline {baseline_ref}).')

if violations:
    fail(f'{violations} violation(s), see above.')
    raise SystemExit(1)

print(f'{LABEL} OK: {len(current)} fork migration(s) numbered 1..{len(current)} '
      'on fork_schema_version.')
PYEOF

#!/usr/bin/env bash
# check-fork-migration-engine-parity.sh
#
# Fork-specific CI guard: verifies that engine ON CONFLICT targets stay in
# sync with fork migration constraint definitions.
#
# Two failure modes caught:
#   A) A migration adds UNIQUE(col_a, col_b) to table T but an engine file
#      still has ON CONFLICT (col_a) for an INSERT INTO T — a strict subset.
#      After the migration runs every upsert against that table fails with
#      Postgres error 42P10.
#   B) A fork migration's sqlFor.postgres or sqlFor.pglite adds a constraint
#      via ADD CONSTRAINT <name> without ANY idempotency guard that precedes
#      the ADD (or an exception handler that follows it):
#        - DROP CONSTRAINT IF EXISTS <name>  BEFORE the ADD  (our pre-DROP style)
#        - SELECT ... pg_constraint WHERE conname='<name>'   BEFORE the ADD
#        - WHEN duplicate_object THEN NULL                   (exception handler)
#      Non-idempotent DDL crashes on migration replay / interrupted stamp.
#
# Run: bash scripts/check-fork-migration-engine-parity.sh
# Exit 0 = all clear; non-zero = at least one violation (stderr has details).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 - "$REPO_ROOT" <<'PYEOF'
import re, sys, os

repo = sys.argv[1]
migrate_ts = os.path.join(repo, 'src', 'core', 'migrate.ts')
engine_files = [
    os.path.join(repo, 'src', 'core', 'postgres-engine.ts'),
    os.path.join(repo, 'src', 'core', 'pglite-engine.ts'),
]

with open(migrate_ts) as f:
    migrate_src = f.read()

# ---------------------------------------------------------------------------
# Extract all migrations that have sqlFor (engine-split SQL).
#
# SQLFPR uses a tempered greedy token `(?:(?!name:\s*')[\s\S])*?` instead of
# plain `.*?` to prevent cross-object attribution: without it, a migration
# without its own sqlFor would match the nearest sqlFor in a *later* object.
#
# BRANCH_RE may still fail to extract branches when the SQL between backticks
# contains '}' characters (TypeScript template expressions or PL/pgSQL blocks),
# causing branches_raw to be truncated by SQLFPR's `}` stop.  Those are put
# in `skipped`.  We fail closed if any skipped migration contains ADD CONSTRAINT
# UNIQUE — that would be a real gap in coverage.
# ---------------------------------------------------------------------------
SQLFPR = re.compile(
    r"name:\s*'([^']+)'(?:(?!name:\s*')[\s\S])*?sqlFor:\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}",
    re.DOTALL,
)
BRANCH_RE = re.compile(r"(postgres|pglite)\s*:\s*`([^`]*)`", re.DOTALL)

all_migrations = []
skipped = []
for m in SQLFPR.finditer(migrate_src):
    name = m.group(1)
    branches_raw = m.group(2)
    branches = {}
    for bm in BRANCH_RE.finditer(branches_raw):
        branches[bm.group(1)] = bm.group(2)
    if branches:
        all_migrations.append({'name': name, 'sqlFor': branches})
    else:
        skipped.append((name, m.group(0)))  # keep full match for safety check

# Fail closed: if a skipped migration has ADD CONSTRAINT … UNIQUE in its full
# match block, we can't safely skip it — the check has a coverage gap.
for sname, sblock in skipped:
    if re.search(r'ADD\s+CONSTRAINT.*?UNIQUE', sblock, re.IGNORECASE | re.DOTALL):
        print(
            f'[check-fork-migration-engine-parity] FAILED: migration \'{sname}\' '
            f'has ADD CONSTRAINT UNIQUE but its sqlFor branches could not be parsed '
            f'(SQL contains }} chars that truncate the regex). '
            f'Extract via a TS AST parser or rewrite the SQL to avoid }} inside template literals.',
            file=sys.stderr,
        )
        sys.exit(1)

skipped_names = [n for n, _ in skipped]

if not all_migrations and not skipped_names:
    print('[check-fork-migration-engine-parity] No sqlFor migrations found — skipping checks.')
    sys.exit(0)

errors = []

# ---------------------------------------------------------------------------
# Check A: ON CONFLICT targets in engine files vs composite unique constraints.
#
# Table-scoped: we extract the table name from ALTER TABLE <table> ADD CONSTRAINT
# by looking back from each ADD CONSTRAINT to the nearest ALTER TABLE in the
# same SQL block.  We then look back from each ON CONFLICT in the engine file
# to the nearest INSERT INTO, using the table name to scope the comparison.
# ---------------------------------------------------------------------------
engine_contents = {}
for ef in engine_files:
    if os.path.exists(ef):
        with open(ef) as f:
            engine_contents[os.path.basename(ef)] = f.read()

def preceding_alter_table(sql: str, add_pos: int) -> str | None:
    """Return lowercase table name from the ALTER TABLE nearest before add_pos."""
    preceding = sql[:add_pos]
    last = None
    for m in re.finditer(r'ALTER\s+TABLE\s+(\w+)', preceding, re.IGNORECASE):
        last = m
    return last.group(1).lower() if last else None

def table_for_on_conflict(content: str, oc_pos: int) -> str | None:
    """Return lowercase table name from the INSERT INTO nearest before oc_pos."""
    preceding = content[max(0, oc_pos - 2000):oc_pos]
    last = None
    for m in re.finditer(r'INSERT\s+INTO\s+(\w+)', preceding, re.IGNORECASE):
        last = m
    return last.group(1).lower() if last else None

UNIQUE_CONSTR_RE = re.compile(
    r'ADD\s+CONSTRAINT\s+\S+\s+UNIQUE\s*\(\s*([^)]+)\s*\)',
    re.IGNORECASE,
)
ON_CONFLICT_RE = re.compile(r'ON\s+CONFLICT\s*\(\s*([^)]+)\s*\)', re.IGNORECASE)

for mig in all_migrations:
    for engine, sql in mig['sqlFor'].items():
        if not sql.strip():
            continue
        for cm in UNIQUE_CONSTR_RE.finditer(sql):
            cols = [c.strip() for c in cm.group(1).split(',')]
            if len(cols) <= 1:
                continue  # single-column key — no composite parity issue
            mig_table = preceding_alter_table(sql, cm.start())
            for fname, content in engine_contents.items():
                for ocm in ON_CONFLICT_RE.finditer(content):
                    eng_table = table_for_on_conflict(content, ocm.start())
                    if mig_table and eng_table and eng_table != mig_table:
                        continue  # different table — not a parity violation
                    oc_cols = [c.strip() for c in ocm.group(1).split(',')]
                    if set(oc_cols) < set(cols):  # strict subset = stale target
                        lineno = content[: ocm.start()].count('\n') + 1
                        table_note = f"table '{mig_table}'" if mig_table else 'unknown table'
                        errors.append(
                            f"[A] {fname}:{lineno}: ON CONFLICT ({', '.join(oc_cols)}) "
                            f"is a stale subset of UNIQUE ({', '.join(cols)}) "
                            f"added by migration '{mig['name']}' [{engine}] on {table_note}.\n"
                            f"    Update to: ON CONFLICT ({', '.join(cols)})"
                        )

# ---------------------------------------------------------------------------
# Check B: ADD CONSTRAINT <name> without any idempotency guard.
#
# Ordering matters for Guards 1 and 2 — they must appear BEFORE the ADD.
# Guard 3 (exception handler) runs after the ADD by design; ordering is fine.
#
# Accepted guards:
#   1. DROP CONSTRAINT IF EXISTS <name>           BEFORE add_pos
#   2. pg_constraint WHERE conname = '<name>'     BEFORE add_pos
#   3. WHEN duplicate_object THEN NULL            (anywhere — exception handler)
# ---------------------------------------------------------------------------
def has_idempotency_guard(name: str, sql: str, add_pos: int) -> bool:
    # Guard 1: pre-DROP — must appear before ADD
    m = re.search(
        rf'DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+{re.escape(name)}',
        sql, re.IGNORECASE,
    )
    if m and m.start() < add_pos:
        return True
    # Guard 2: catalog existence check (upstream style) — must appear before ADD
    m = re.search(
        rf"conname\s*=\s*'{re.escape(name)}'",
        sql, re.IGNORECASE,
    )
    if m and m.start() < add_pos:
        return True
    # Guard 3: exception handler — syntactically after ADD, so no position check
    if re.search(r'WHEN\s+duplicate_object\s+THEN', sql, re.IGNORECASE):
        return True
    return False

for mig in all_migrations:
    for engine, sql in mig['sqlFor'].items():
        if not sql.strip():
            continue
        for am in re.finditer(r'ADD\s+CONSTRAINT\s+(\S+)', sql, re.IGNORECASE):
            name = am.group(1)
            if not has_idempotency_guard(name, sql, am.start()):
                errors.append(
                    f"[B] Migration '{mig['name']}' [{engine}]: "
                    f"ADD CONSTRAINT {name} has no idempotency guard "
                    f"(no DROP IF EXISTS before ADD, no pg_constraint check before ADD, "
                    f"no duplicate_object handler).\n"
                    f"    Non-idempotent DDL will crash on migration replay/retry."
                )

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------
if errors:
    print('[check-fork-migration-engine-parity] FAILED:', file=sys.stderr)
    for e in errors:
        print(f'  {e}', file=sys.stderr)
    sys.exit(1)

skip_note = (
    f', {len(skipped_names)} skipped (unparseable branches: {", ".join(skipped_names)})'
    if skipped_names else ''
)
print(
    f'[check-fork-migration-engine-parity] OK — '
    f'{len(all_migrations)} sqlFor migration(s) checked (Check A + B){skip_note}.'
)
PYEOF

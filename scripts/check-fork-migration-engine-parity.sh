#!/usr/bin/env bash
# check-fork-migration-engine-parity.sh
#
# Fork-specific CI guard: verifies that engine ON CONFLICT targets stay in
# sync with fork migration constraint definitions.
#
# Two failure modes caught:
#   A) A migration adds UNIQUE(col_a, col_b) but an engine file still has
#      ON CONFLICT (col_a) — a strict subset. After the migration runs every
#      upsert against that table fails with Postgres error 42P10.
#   B) A fork migration's sqlFor.postgres or sqlFor.pglite adds a constraint
#      via ADD CONSTRAINT <name> without ANY idempotency guard:
#        - DROP CONSTRAINT IF EXISTS <name>        (our pre-DROP style)
#        - SELECT ... pg_constraint WHERE conname='<name>'  (upstream catalog check)
#        - WHEN duplicate_object THEN NULL         (exception handler)
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
# We inspect ALL of them for Check A (ON CONFLICT stale targets) because a
# stale target is a bug regardless of origin.
# For Check B (idempotency) we check all sqlFor migrations — but we accept
# multiple idempotency patterns so upstream-style guards also pass.
# ---------------------------------------------------------------------------
SQLFPR = re.compile(
    r"name:\s*'([^']+)'.*?sqlFor:\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}",
    re.DOTALL,
)
BRANCH_RE = re.compile(r"(postgres|pglite)\s*:\s*`([^`]*)`", re.DOTALL)

all_migrations = []
for m in SQLFPR.finditer(migrate_src):
    name = m.group(1)
    branches_raw = m.group(2)
    branches = {}
    for bm in BRANCH_RE.finditer(branches_raw):
        branches[bm.group(1)] = bm.group(2)
    if branches:
        all_migrations.append({'name': name, 'sqlFor': branches})

if not all_migrations:
    print('[check-fork-migration-engine-parity] No sqlFor migrations found — skipping checks.')
    sys.exit(0)

errors = []

# ---------------------------------------------------------------------------
# Check A: ON CONFLICT targets in engine files vs composite unique constraints
# ---------------------------------------------------------------------------
engine_contents = {}
for ef in engine_files:
    if os.path.exists(ef):
        with open(ef) as f:
            engine_contents[os.path.basename(ef)] = f.read()

for mig in all_migrations:
    for engine, sql in mig['sqlFor'].items():
        if not sql.strip():
            continue
        for cm in re.finditer(
            r'ADD\s+CONSTRAINT\s+\S+\s+UNIQUE\s*\(\s*([^)]+)\s*\)',
            sql, re.IGNORECASE,
        ):
            cols = [c.strip() for c in cm.group(1).split(',')]
            if len(cols) <= 1:
                continue  # single-column key — no composite parity issue
            for fname, content in engine_contents.items():
                for ocm in re.finditer(
                    r'ON\s+CONFLICT\s*\(\s*([^)]+)\s*\)', content, re.IGNORECASE
                ):
                    oc_cols = [c.strip() for c in ocm.group(1).split(',')]
                    if set(oc_cols) < set(cols):  # strict subset = stale target
                        lineno = content[: ocm.start()].count('\n') + 1
                        errors.append(
                            f"[A] {fname}:{lineno}: ON CONFLICT ({', '.join(oc_cols)}) "
                            f"is a stale subset of UNIQUE ({', '.join(cols)}) "
                            f"added by migration '{mig['name']}' [{engine}].\n"
                            f"    Update to: ON CONFLICT ({', '.join(cols)})"
                        )

# ---------------------------------------------------------------------------
# Check B: ADD CONSTRAINT <name> without any recognized idempotency guard.
#
# Accepted guards (any one is sufficient):
#   1. DROP CONSTRAINT IF EXISTS <name>            (our pre-DROP style)
#   2. pg_constraint WHERE conname = '<name>'      (upstream catalog check)
#   3. WHEN duplicate_object THEN NULL             (exception handler)
# ---------------------------------------------------------------------------
def has_idempotency_guard(name: str, sql: str) -> bool:
    # Guard 1: pre-DROP
    if re.search(
        rf'DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+{re.escape(name)}',
        sql, re.IGNORECASE,
    ):
        return True
    # Guard 2: catalog existence check (upstream style)
    if re.search(
        rf"conname\s*=\s*'{re.escape(name)}'",
        sql, re.IGNORECASE,
    ):
        return True
    # Guard 3: exception handler that catches duplicate_object
    if re.search(r'WHEN\s+duplicate_object\s+THEN', sql, re.IGNORECASE):
        return True
    return False

for mig in all_migrations:
    for engine, sql in mig['sqlFor'].items():
        if not sql.strip():
            continue
        for am in re.finditer(r'ADD\s+CONSTRAINT\s+(\S+)', sql, re.IGNORECASE):
            name = am.group(1)
            if not has_idempotency_guard(name, sql):
                errors.append(
                    f"[B] Migration '{mig['name']}' [{engine}]: "
                    f"ADD CONSTRAINT {name} has no idempotency guard "
                    f"(no DROP IF EXISTS, no pg_constraint check, no duplicate_object handler).\n"
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

print(
    f'[check-fork-migration-engine-parity] OK — '
    f'{len(all_migrations)} sqlFor migration(s) checked (Check A + B).'
)
PYEOF

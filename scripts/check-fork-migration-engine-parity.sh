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
#        - WHEN duplicate_object THEN NULL                   (after ADD in same DO block)
#      Non-idempotent DDL crashes on migration replay / interrupted stamp.
#
# Run: bash scripts/check-fork-migration-engine-parity.sh
# Exit 0 = all clear; non-zero = at least one violation (stderr has details).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 - "$REPO_ROOT" <<'PYEOF'
from __future__ import annotations
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
# Extract sqlFor objects with a small boundary-aware TypeScript scanner.
#
# Regex cannot safely delimit an object containing template strings: SQL may
# contain literal braces, `${...}` expressions, or text that looks like another
# `name:` property.  The scanner below skips comments and quoted strings while
# tracking object braces, then reads each sqlFor branch as one complete quoted
# value.  Any unsupported shape fails closed instead of silently reducing
# coverage to whichever branch happened to parse first.
# ---------------------------------------------------------------------------
class ParseError(ValueError):
    pass


def skip_trivia(src: str, pos: int) -> int:
    while pos < len(src):
        if src[pos].isspace() or src[pos] == ',':
            pos += 1
        elif src.startswith('//', pos):
            end = src.find('\n', pos + 2)
            pos = len(src) if end == -1 else end + 1
        elif src.startswith('/*', pos):
            end = src.find('*/', pos + 2)
            if end == -1:
                raise ParseError('unterminated block comment')
            pos = end + 2
        else:
            break
    return pos


def read_identifier(src: str, pos: int) -> tuple[str, int]:
    m = re.match(r'[A-Za-z_$][A-Za-z0-9_$]*', src[pos:])
    if not m:
        raise ParseError(f'expected identifier at offset {pos}')
    return m.group(0), pos + len(m.group(0))


def read_quoted(src: str, pos: int) -> tuple[str, int]:
    if pos >= len(src) or src[pos] not in "'\"`":
        raise ParseError(f'expected quoted string at offset {pos}')
    quote = src[pos]
    start = pos + 1
    pos = start
    while pos < len(src):
        if src[pos] == '\\':
            pos += 2
            continue
        if src[pos] == quote:
            return src[start:pos], pos + 1
        pos += 1
    raise ParseError(f'unterminated {quote} string at offset {start - 1}')


def find_migration_name(src: str, object_start: int, limit: int) -> str:
    pos = object_start + 1
    depth = 0
    while pos < limit:
        pos = skip_trivia(src, pos)
        if pos >= limit:
            break
        if src[pos] in "'\"`":
            _, pos = read_quoted(src, pos)
            continue
        if src[pos] in '([{':
            depth += 1
            pos += 1
            continue
        if src[pos] in ')]}':
            depth -= 1
            pos += 1
            continue
        if re.match(r'[A-Za-z_$]', src[pos]):
            key, end = read_identifier(src, pos)
            if depth == 0 and key == 'name':
                value_pos = skip_trivia(src, end)
                if value_pos >= limit or src[value_pos] != ':':
                    raise ParseError(f"migration name property lacks ':' at offset {pos}")
                value_pos = skip_trivia(src, value_pos + 1)
                value, _ = read_quoted(src, value_pos)
                return value
            pos = end
            continue
        pos += 1
    raise ParseError(f'could not find migration name before sqlFor at offset {limit}')


def parse_sql_for(src: str, object_start: int, sql_for_pos: int) -> tuple[dict, int]:
    pos = skip_trivia(src, sql_for_pos + len('sqlFor'))
    if pos >= len(src) or src[pos] != ':':
        raise ParseError(f"sqlFor lacks ':' at offset {sql_for_pos}")
    pos = skip_trivia(src, pos + 1)
    if pos >= len(src) or src[pos] != '{':
        raise ParseError(f'sqlFor value is not an object at offset {pos}')
    pos += 1
    branches = {}
    while True:
        pos = skip_trivia(src, pos)
        if pos >= len(src):
            raise ParseError(f'unterminated sqlFor object at offset {sql_for_pos}')
        if src[pos] == '}':
            if not branches:
                raise ParseError(f'empty sqlFor object at offset {sql_for_pos}')
            return branches, pos + 1
        key, pos = read_identifier(src, pos)
        pos = skip_trivia(src, pos)
        if pos >= len(src) or src[pos] != ':':
            raise ParseError(f"sqlFor branch '{key}' lacks ':' at offset {pos}")
        pos = skip_trivia(src, pos + 1)
        value, pos = read_quoted(src, pos)
        if key in branches:
            raise ParseError(f"duplicate sqlFor branch '{key}'")
        branches[key] = value


def extract_sql_for_migrations(src: str) -> list[dict]:
    migrations = []
    object_stack = []
    pos = 0
    while pos < len(src):
        if src.startswith('//', pos) or src.startswith('/*', pos) or src[pos].isspace():
            pos = skip_trivia(src, pos)
            continue
        if src[pos] in "'\"`":
            _, pos = read_quoted(src, pos)
            continue
        if src[pos] == '{':
            object_stack.append(pos)
            pos += 1
            continue
        if src[pos] == '}':
            if object_stack:
                object_stack.pop()
            pos += 1
            continue
        if re.match(r'[A-Za-z_$]', src[pos]):
            token, end = read_identifier(src, pos)
            if token == 'sqlFor':
                value_pos = skip_trivia(src, end)
                if value_pos >= len(src) or src[value_pos] != ':':
                    pos = end
                    continue
                value_pos = skip_trivia(src, value_pos + 1)
                if value_pos >= len(src) or src[value_pos] != '{':
                    if object_stack:
                        try:
                            name = find_migration_name(src, object_stack[-1], pos)
                        except ParseError:
                            pass  # Type/interface declaration or another non-migration use.
                        else:
                            raise ParseError(
                                f"migration '{name}' has a non-inline sqlFor value "
                                f'at offset {value_pos}'
                            )
                    pos = end
                    continue
                if not object_stack:
                    raise ParseError(f'sqlFor outside an object at offset {pos}')
                name = find_migration_name(src, object_stack[-1], pos)
                branches, pos = parse_sql_for(src, object_stack[-1], pos)
                migrations.append({'name': name, 'sqlFor': branches})
                continue
            pos = end
            continue
        pos += 1
    return migrations


try:
    all_migrations = extract_sql_for_migrations(migrate_src)
except ParseError as exc:
    print(
        f'[check-fork-migration-engine-parity] FAILED: cannot safely parse '
        f'src/core/migrate.ts: {exc}',
        file=sys.stderr,
    )
    sys.exit(1)

if not all_migrations:
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
#   3. WHEN duplicate_object THEN NULL            AFTER the ADD, in the same DO block
# ---------------------------------------------------------------------------
DO_BLOCK_RE = re.compile(
    r'DO\s+(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)(.*?)\1',
    re.IGNORECASE | re.DOTALL,
)


def has_scoped_duplicate_object_handler(sql: str, add_pos: int) -> bool:
    for block in DO_BLOCK_RE.finditer(sql):
        body_start, body_end = block.span(2)
        if body_start <= add_pos < body_end:
            return bool(re.search(
                r'WHEN\s+duplicate_object\s+THEN',
                sql[add_pos:body_end],
                re.IGNORECASE,
            ))
    return False


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
    # Guard 3: handler must protect this ADD in the same DO dollar-quoted block
    if has_scoped_duplicate_object_handler(sql, add_pos):
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

print(
    f'[check-fork-migration-engine-parity] OK — '
    f'{len(all_migrations)} sqlFor migration(s) checked (Check A + B).'
)
PYEOF

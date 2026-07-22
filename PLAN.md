# Upstream Batch 2 Conflict Resolution

## Objective

Resolve the in-progress upstream merge without losing fork-specific PGroonga/CJK,
transaction reentrancy, signature-invalidation, sync durability, or explicit
multi-source behavior. Do not commit.

## Steps

1. Inspect each conflict against its merge stages and the brief's invariants.
2. Resolve small command/document/test conflicts by retaining both independent changes.
3. Integrate fork capabilities into upstream `migrate.ts` and `postgres-engine.ts` refactors.
4. Run the five specified acceptance gates and write raw outputs to the dispatch report.

## Decision log

- 2026-07-22: upstream migrations 123/124 are renumbered to 127/128; fork
  migrations 123–126 remain unchanged, per dispatch brief.

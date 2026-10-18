/**
 * GBRA-60 stand-in for the GBRA-130 pathological harness (test/pathological/harness.ts on
 * capy/gbra130-item-isolation): the subset these row files use, under the same names, so the row files
 * switch to the harness import without touching a case. Remove it once that harness is on master.
 */
import { expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { OperationError } from '../../src/core/ops/contract.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { requirePostgresTestDatabase, testBackends, type TestBackend } from '../helpers/test-backends.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

/** The engine arms a pathological case runs on: PGLite, plus Postgres when the lane provides DATABASE_URL. */
export function pathologicalArms(): Array<{ backend: TestBackend; databaseUrl: string | undefined }> {
  return testBackends().map(backend => ({ backend, databaseUrl: backend === 'pglite' ? undefined : requirePostgresTestDatabase() }));
}

/** A fresh, migrated brain for one arm: in-memory PGLite, or an isolated Postgres schema. */
export async function openArm(arm: { backend: TestBackend; databaseUrl: string | undefined }): Promise<{ engine: BrainEngine; close: () => Promise<void> }> {
  if (arm.backend === 'pglite') {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    return { engine, close: () => engine.disconnect() };
  }
  const pg = await isolatedPersistencePostgres(arm.databaseUrl!);
  return { engine: pg.engine, close: pg.close };
}

export interface ItemSnapshotRow { slug: string; content_hash: string | null; updated_at: string; deleted_at: string | null; links: number; chunks: number }

/** Every page of a source with what a wedge could lose or change. */
export async function snapshotItems(engine: BrainEngine, sourceId: string): Promise<Map<string, ItemSnapshotRow>> {
  const rows = await engine.executeRaw<ItemSnapshotRow>(
    `SELECT p.slug, p.content_hash, p.updated_at::text AS updated_at, p.deleted_at::text AS deleted_at,
            (SELECT count(*)::int FROM links l WHERE l.from_page_id = p.id) AS links,
            (SELECT count(*)::int FROM content_chunks c WHERE c.page_id = p.id) AS chunks
       FROM pages p WHERE p.source_id = $1 ORDER BY p.slug`, [sourceId]);
  return new Map(rows.map(row => [row.slug, row]));
}

/** Pages outside `changed` are unchanged; each `expectProgress` page moved in at least one of `progressFields`. */
export function expectOthersUnchanged(before: Map<string, ItemSnapshotRow>, after: Map<string, ItemSnapshotRow>,
  opts: { changed?: Iterable<string>; expectProgress?: Iterable<string>; progressFields?: Array<keyof ItemSnapshotRow> } = {}): void {
  const skip = new Set([...(opts.changed ?? []), ...(opts.expectProgress ?? [])]);
  for (const [slug, row] of before) if (!skip.has(slug)) expect({ slug, row: after.get(slug) }).toEqual({ slug, row });
  const fields = opts.progressFields ?? ['content_hash', 'updated_at', 'links', 'chunks'];
  for (const slug of opts.expectProgress ?? []) {
    expect(after.get(slug)).toBeDefined();
    expect({ slug, moved: fields.some(field => before.get(slug)?.[field] !== after.get(slug)?.[field]) }).toEqual({ slug, moved: true });
  }
}

/** The unit returned instead of throwing. */
export async function expectUnitNotAborted<T>(run: () => Promise<T>): Promise<T> {
  let thrown: unknown;
  let result: T | undefined;
  try { result = await run(); } catch (error) { thrown = error; }
  expect({ aborted: thrown === undefined ? null : thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown) }).toEqual({ aborted: null });
  return result as T;
}

/** A recorded item failure names its item and a typed code; `fix`, when given, matches. */
export function expectItemFailure(failure: { key?: string; slug?: string; item?: string; code?: string; reason?: string; fix?: unknown } | undefined,
  want: { key: string; code: string; fix?: RegExp }): void {
  expect(failure).toBeDefined();
  expect({ key: failure!.key ?? failure!.item ?? failure!.slug, code: failure!.code ?? failure!.reason }).toEqual({ key: want.key, code: want.code });
  if (want.fix) expect(typeof failure!.fix === 'string' ? failure!.fix : JSON.stringify(failure!.fix)).toMatch(want.fix);
}

/** Run-scoped errors a negative case injects at a site: each must stop the unit and hold nothing. */
export function runScopedErrors(): Array<{ name: string; error: () => unknown }> {
  return [
    { name: 'connection lost', error: () => Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' }) },
    { name: 'abort', error: () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }) },
    { name: 'failed transaction (25P02)', error: () => Object.assign(new Error('current transaction is aborted, commands ignored until end of transaction block'), { code: '25P02' }) },
    { name: 'owner_unavailable', error: () => new OperationError('owner_unavailable', 'The canonical writer for this source is unavailable.') },
  ];
}

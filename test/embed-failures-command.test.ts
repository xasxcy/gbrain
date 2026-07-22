import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runEmbedFailures } from '../src/commands/embed-failures.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.putPage('ledger', { type: 'note', title: 'ledger', compiled_truth: '# ledger' });
  await engine.upsertChunks('ledger', [{ chunk_index: 1, chunk_text: 'bad', chunk_source: 'compiled_truth' }]);
  const [{ id: pageId }] = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE source_id = 'default' AND slug = 'ledger'`,
  );
  await engine.executeRaw(
    `INSERT INTO embed_failures
       (source_id, page_id, slug, chunk_index, embedding_signature, chunk_hash,
        error_class, error_fingerprint, first_seen, last_seen, next_retry_at)
     VALUES ('default', $1::bigint, 'ledger', 1, 'signature', 'hash',
             'provider_timeout', 'timeout', now(), now(), now())`,
    [pageId],
  );
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{}'::jsonb)`);
  await engine.putPage('ledger', { type: 'note', title: 'other ledger', compiled_truth: '# other' }, { sourceId: 'other' });
  await engine.upsertChunks('ledger', [{ chunk_index: 1, chunk_text: 'other bad', chunk_source: 'compiled_truth' }], { sourceId: 'other' });
  const [{ id: otherPageId }] = await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE source_id = 'other' AND slug = 'ledger'`,
  );
  await engine.executeRaw(
    `INSERT INTO embed_failures
       (source_id, page_id, slug, chunk_index, embedding_signature, chunk_hash,
        error_class, error_fingerprint, first_seen, last_seen, next_retry_at)
     VALUES ('other', $1::bigint, 'ledger', 1, 'signature', 'hash',
             'provider_timeout', 'timeout', now(), now(), now())`,
    [otherPageId],
  );
});

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore: () => { console.log = original; } };
}

describe('embed-failures operator command', () => {
  test('serializes native BigInt page ids from Postgres ledger rows', async () => {
    const captured = captureConsole();
    const postgresShapedEngine = {
      listEmbedFailures: async () => [{ page_id: 1n }],
    } as unknown as PGLiteEngine;

    try {
      await expect(runEmbedFailures(postgresShapedEngine, ['list'])).resolves.toBeUndefined();
    } finally {
      captured.restore();
    }

    expect(JSON.parse(captured.lines[0]!)).toEqual([{ page_id: '1' }]);
  });

  test('lists source-scoped ledger rows and releases the selected chunk', async () => {
    const captured = captureConsole();
    try {
      await runEmbedFailures(engine, ['list', '--source', 'default']);
      await runEmbedFailures(engine, ['release', 'ledger', '--chunk', '1', '--source', 'default']);
    } finally {
      captured.restore();
    }

    expect(JSON.parse(captured.lines[0]!)).toMatchObject([{
      source_id: 'default', slug: 'ledger', chunk_index: 1, attempt_count: 1,
    }]);
    expect(captured.lines[1]).toContain('Released 1 embed failure record');
    expect(await engine.executeRaw(`SELECT 1 FROM embed_failures WHERE source_id = 'default' AND slug = 'ledger'`)).toHaveLength(0);
    expect(await engine.executeRaw(`SELECT 1 FROM embed_failures WHERE source_id = 'other' AND slug = 'ledger'`)).toHaveLength(1);
  });
});

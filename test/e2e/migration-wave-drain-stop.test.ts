import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { runSchemaTransition } from '../../src/core/embedding-migration.ts';
import { executeMigrationFlow, planMigrationFlow } from '../../src/commands/migrate-embeddings.ts';
import { migrationWaveFixture } from '../helpers/migration-wave-fixture.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { withEnv } from '../helpers/with-env.ts';

// F4c CI fixes: a provider/config fault that stops the re-embed drain (the fork's run-global contract) is a
// resumable `incomplete` migration that names the fault, never an `apply_failed`, and installs nothing malformed.
const model = 'openai:text-embedding-3-small';
const dimensions = 8;
let fixture: Awaited<ReturnType<typeof migrationWaveFixture>>;
let engine: BrainEngine;
let home: string;
beforeAll(async () => {
  fixture = await migrationWaveFixture('pglite'); engine = fixture.engine;
  await runSchemaTransition(engine, dimensions);
  home = mkdtempSync(join(tmpdir(), 'migration-wave-drain-stop-home-'));
  mkdirSync(join(home, '.gbrain'));
  await engine.setConfig('embedding_model', model);
  await engine.setConfig('embedding_dimensions', String(dimensions));
  configureGateway({ embedding_model: model, embedding_dimensions: dimensions, env: { OPENAI_API_KEY: 'synthetic-only' } });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', embedding_model: model, embedding_dimensions: dimensions, openai_api_key: 'synthetic-only' }));
}, 60_000);
afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await fixture?.close(); rmSync(home, { recursive: true, force: true }); });

test('a drain stopped by a provider fault is an incomplete migration that carries the reason', async () => {
  await engine.putPage('synthetic-drain-stop', { type: 'note', title: 'synthetic-drain-stop', compiled_truth: 'synthetic-drain-stop one. synthetic-drain-stop two.' });
  await installFixtureChunks(engine, 'synthetic-drain-stop', [0, 1].map(i => ({ chunk_index: i, chunk_source: 'compiled_truth' as const, chunk_text: `synthetic-drain-stop ${i}` })));
  __setEmbedTransportForTests(async ({ values }) => ({
    values, warnings: [],
    embeddings: values.map(value => value.includes('synthetic-drain-stop') ? [0.25] : Array(dimensions).fill(0.25)),
    usage: { tokens: values.length * 8 },
  }));
  const opts = { to: model, dim: dimensions, reranker: 'off', maxCostUsd: 1, quiet: true };
  const result = await withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined },
    async () => executeMigrationFlow(engine, await planMigrationFlow(engine, opts), opts));
  expect(result.status).toBe('incomplete');
  if (result.status !== 'incomplete') throw new Error('unreachable');
  expect(result.stopped_reason).toContain('dim mismatch');
  expect(result.remaining).toBeGreaterThan(0);
  expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE embedding IS NOT NULL')).toEqual([]);
});

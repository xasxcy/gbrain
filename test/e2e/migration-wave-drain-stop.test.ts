import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
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
// resumable `incomplete` migration that names the fault, never an `apply_failed`, and installs nothing.
// F6 (advisor ruling 3): only a REAL configuration fault stops the drain. A malformed response (wrong width / count) is
// a per-item failure of its own page, so the pages after it are still embedded (upstream behavior).
const model = 'openai:text-embedding-3-small';
const dimensions = 8;
for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`migration wave drain stop (${kind})`, () => {
    let fixture: Awaited<ReturnType<typeof migrationWaveFixture>>;
    let engine: BrainEngine;
    let home: string;
    beforeAll(async () => {
      fixture = await migrationWaveFixture(kind); engine = fixture.engine;
      await runSchemaTransition(engine, dimensions);
      home = mkdtempSync(join(tmpdir(), 'migration-wave-drain-stop-home-'));
      mkdirSync(join(home, '.gbrain'));
      await engine.setConfig('embedding_model', model);
      await engine.setConfig('embedding_dimensions', String(dimensions));
      configureGateway({ embedding_model: model, embedding_dimensions: dimensions, env: { OPENAI_API_KEY: 'synthetic-only' } });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: kind, embedding_model: model, embedding_dimensions: dimensions, openai_api_key: 'synthetic-only' }));
    }, 60_000);
    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await fixture?.close(); rmSync(home, { recursive: true, force: true }); });
    beforeEach(async () => {
      await engine.executeRaw('TRUNCATE pages,facts,fact_withdrawals,page_projection_jobs CASCADE');
      await engine.executeRaw("DELETE FROM config WHERE key LIKE 'embedding_migration.%'");
      await engine.setConfig('embedding_model', model);
      await engine.setConfig('embedding_dimensions', String(dimensions));
    });

    async function seedPage(slug: string) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} one. ${slug} two.` });
      await installFixtureChunks(engine, slug, [0, 1].map(i => ({ chunk_index: i, chunk_source: 'compiled_truth' as const, chunk_text: `${slug} ${i}` })));
    }
    async function flow() {
      const opts = { to: model, dim: dimensions, reranker: 'off', maxCostUsd: 1, quiet: true };
      return withEnv({ GBRAIN_HOME: home, GBRAIN_EMBEDDING_MODEL: undefined, GBRAIN_EMBEDDING_DIMENSIONS: undefined, GBRAIN_EMBED_CONCURRENCY: '1' },
        async () => executeMigrationFlow(engine, await planMigrationFlow(engine, opts), opts));
    }

    test('a drain stopped by a real configuration fault is an incomplete migration that carries the reason', async () => {
      await seedPage('synthetic-drain-stop');
      // Rejected credentials on the page's embed calls only (the migration's own live probe uses other text).
      __setEmbedTransportForTests(async ({ values }) => {
        if (values.some(value => value.includes('synthetic-drain-stop'))) throw Object.assign(new Error('401 Unauthorized: invalid api key'), { status: 401 });
        return { values, warnings: [], embeddings: values.map(() => Array(dimensions).fill(0.25)), usage: { tokens: values.length * 8 } };
      });
      const result = await flow();
      expect(result.status).toBe('incomplete');
      if (result.status !== 'incomplete') throw new Error('unreachable');
      expect(result.stopped_reason).toContain('invalid api key');
      expect(result.remaining).toBeGreaterThan(0);
      expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE embedding IS NOT NULL')).toEqual([]);
    });

    for (const malformed of ['width', 'count'] as const) {
      test(`a malformed ${malformed} response fails only its own page: the pages after it are still embedded`, async () => {
        // The bad page is created first, so at concurrency 1 it is drained first (the shape that used to abort everything).
        await seedPage('synthetic-bad-page');
        for (const slug of ['synthetic-good-1', 'synthetic-good-2']) await seedPage(slug);
        __setEmbedTransportForTests(async ({ values }) => {
          let embeddings = values.map(() => Array(dimensions).fill(0.25) as number[]);
          if (values.some(value => value.includes('synthetic-bad-page'))) {
            if (malformed === 'width') embeddings = values.map(() => [0.25]);
            else embeddings = [...embeddings, Array(dimensions).fill(0.25)];
          }
          return { values, warnings: [], embeddings, usage: { tokens: values.length * 8 } };
        });
        const result = await flow();
        expect(result.status).toBe('incomplete');
        if (result.status !== 'incomplete') throw new Error('unreachable');
        expect(result.stopped_reason).toBeUndefined();
        expect(result.remaining).toBe(2); // exactly the bad page's two chunks
        const embedded = await engine.executeRaw<{ slug: string }>(
          `SELECT DISTINCT p.slug FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE c.embedding IS NOT NULL ORDER BY p.slug`);
        expect(embedded.map(row => row.slug)).toEqual(['synthetic-good-1', 'synthetic-good-2']);
      });
    }
  });
}

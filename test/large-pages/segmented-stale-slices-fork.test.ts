/**
 * Fork: `embed --stale` embeds a segmented page in slices of
 * GBRAIN_EMBED_SUBBATCH_SIZE rows and installs each slice before the next
 * provider call.
 *
 * 1. Protects: when the stale run's time budget (or any abort) fires partway
 *    through a large segmented page, the slices that finished keep their
 *    vectors, so the next cron run resumes instead of starting over.
 * 2. Fails when: the stale path sends a segmented page's rows to the provider
 *    in one SEGMENTED_EMBED_BATCH_ROWS (500) batch. A batch that cannot finish
 *    inside the budget is then discarded whole, every run, with nothing
 *    installed and nothing recorded (the 1069-chunk incident).
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { runEmbedCore } from '../../src/commands/embed.ts';
import { PAGE_EMBED_CAP_KEY } from '../../src/core/page-embedding-budget.ts';
import { resolveActiveEmbeddingColumnFromEngine } from '../../src/core/search/embedding-column.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentPage } from '../helpers/segmented-chunks-fixture.ts';
import { testBackends } from '../helpers/test-backends.ts';

const SLUG = 'notes/segmented-stale-slices';
const ROWS = 20;
const SLICE = 8;
const ROW_TEXT = (i: number) => `Row ${i}: an ordinary paragraph about herons wading in the marsh at dawn, `.padEnd(350, 'and the reeds bend in the wind. ');

for (const kind of testBackends()) {
  describe(`fork: segmented stale embedding installs per slice (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let dims: number;
    let savedSubBatch: string | undefined;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      dims = (await resolveActiveEmbeddingColumnFromEngine(engine)).dimensions;
    }, 120_000);
    afterAll(async () => { resetGateway(); await close?.(); });
    beforeEach(async () => {
      savedSubBatch = process.env.GBRAIN_EMBED_SUBBATCH_SIZE;
      process.env.GBRAIN_EMBED_SUBBATCH_SIZE = String(SLICE);
      await engine.executeRaw('DELETE FROM pages');
      await engine.executeRaw('DELETE FROM page_segment_texts');
      await engine.executeRaw('DELETE FROM page_embedding_budget');
      await engine.executeRaw(`DELETE FROM config WHERE key = $1`, [PAGE_EMBED_CAP_KEY]);
      await engine.setConfig('pages.segmented_storage', 'on');
      resetGateway();
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: dims, env: { OPENAI_API_KEY: 'sk-test' } });
    });
    afterEach(() => {
      __setEmbedTransportForTests(null);
      if (savedSubBatch === undefined) delete process.env.GBRAIN_EMBED_SUBBATCH_SIZE;
      else process.env.GBRAIN_EMBED_SUBBATCH_SIZE = savedSubBatch;
    });

    const vectoredRows = async () => (await engine.executeRaw<{ n: number | string }>(
      `SELECT count(*) AS n FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = $1 AND cc.embedding IS NOT NULL`, [SLUG]))[0]!.n;

    test('an abort after one slice keeps that slice\'s vectors', async () => {
      await segmentPage(engine, SLUG, { generation: 1,
        occurrences: [{ id: 1, byteStart: 0, genFrom: 1, chunks: Array.from({ length: ROWS }, (_, i) => ({ text: ROW_TEXT(i), chunkIndex: i })) }] });
      // The provider can embed one slice's worth of rows before the run's budget
      // expires: any request that would take the run past SLICE rows aborts it.
      const budget = new AbortController();
      let served = 0;
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
        if (served + values.length > SLICE) {
          budget.abort(new Error('time budget reached'));
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }
        served += values.length;
        return { embeddings: values.map(() => Array.from({ length: dims }, (_, j) => (j === 0 ? 1 : 0))), usage: { tokens: values.length } };
      }) as never);

      try { await runEmbedCore(engine, { stale: true, quiet: true, signal: budget.signal }); } catch { /* an aborted run may throw */ }

      expect(budget.signal.aborted).toBe(true);
      expect(Number(await vectoredRows())).toBe(SLICE);
    }, 120_000);
  });
}

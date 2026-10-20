/**
 * FORK: the `embed --stale` image sweep stays inside the run's time budget,
 * and rebuilding an unchanged image reuses its stored visual vector instead of
 * paying the multimodal provider again (only when the page's `visual_model`
 * stamp is the current model).
 *
 * PGLite in-memory; the Voyage provider is a fetch stub ($0) that returns a
 * different vector on every call, so a reused vector is distinguishable from a
 * fresh one. Every test works in its own source, so no test depends on pages
 * another test left behind.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importImageFile, _resetOcrRunBudgetForTests } from '../src/core/import-file.ts';
import { embedStaleImages } from '../src/core/embed-stale-images.ts';
import { runSources } from '../src/commands/sources.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { parseEmbedding } from '../src/core/utils.ts';
import { withEnv } from './helpers/with-env.ts';
import { runEmbed } from '../src/commands/embed.ts';
import { reusableVisualVector } from '../src/core/image-visual-reuse.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// The same 1x1 PNG with one extra trailing byte: different bytes, different content hash.
const PNG_CHANGED = Buffer.concat([PNG, Buffer.from([0])]);
const MODEL = 'voyage:voyage-multimodal-3';

let engine: PGLiteEngine;
let embedCalls = 0;
// Never reset: every provider call returns a vector no earlier call returned.
let vectorSeq = 0;
let sourceSeq = 0;
const origFetch = globalThis.fetch;

const configure = (multimodal = MODEL) => configureGateway({
  embedding_model: MODEL,
  embedding_multimodal_model: multimodal,
  embedding_dimensions: 1024,
  env: { VOYAGE_API_KEY: 'test-key', DASHSCOPE_API_KEY: 'test-key' },
});

beforeAll(async () => {
  // The schema is created at the configured width, so the CLI's width check passes.
  configure();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

beforeEach(() => {
  embedCalls = 0;
  _resetOcrRunBudgetForTests();
  globalThis.fetch = (async () => {
    embedCalls++;
    const v = ++vectorSeq / 1000;
    const embedding = Array.from({ length: 1024 }, () => v);
    // One body for both providers: Voyage reads `data`, DashScope's multimodal endpoint reads `output.embeddings`.
    return new Response(JSON.stringify({
      data: [{ embedding, index: 0 }], model: 'voyage-multimodal-3', output: { embeddings: [{ embedding }] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  configure();
});

afterEach(() => {
  globalThis.fetch = origFetch;
  resetGateway();
});

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

/** A fresh source with its own directory: `write` puts a file in it, `vector` reads a page's stored image vector. */
async function freshSource() {
  const id = `img${++sourceSeq}`;
  const dir = mkdtempSync(join(tmpdir(), `img-sweep-${id}-`));
  mkdirSync(join(dir, 'photos'));
  await runSources(engine, ['add', id, '--path', dir, '--no-federated', '--force']);
  const write = (rel: string, bytes: Buffer) => { writeFileSync(join(dir, rel), bytes); return join(dir, rel); };
  const vector = async (slug: string): Promise<number[] | null> => {
    const [row] = await engine.executeRaw<{ vec: string | null }>(
      `SELECT c.embedding_image::text AS vec FROM pages p JOIN content_chunks c ON c.page_id = p.id
        WHERE p.source_id = $1 AND p.slug = $2`, [id, slug]);
    const vec = parseEmbedding(row?.vec ?? null);
    return vec ? Array.from(vec) : null;
  };
  /** Image pages with no vector yet (`--no-embed` imports), each with its own bytes. */
  const seedVectorless = async (names: string[]) => {
    for (const n of names) {
      const rel = `photos/${n}.png`;
      await importImageFile(engine, write(rel, Buffer.concat([PNG, Buffer.from(n)])), rel, { noEmbed: true, sourceId: id });
    }
  };
  return { id, dir, write, vector, seedVectorless };
}

/** An OCR-wanted sweep: OCR has no model configured, so every unchanged image lacking OCR text is a candidate. */
const sweepWantingOcr = (sourceId: string) =>
  withEnv({ GBRAIN_EMBEDDING_IMAGE_OCR: 'true' }, () => embedStaleImages(engine, { sourceId, dryRun: false }));

describe('image rebuild reuses an unchanged visual vector', () => {
  test('an unchanged image swept for missing OCR text keeps its vector without a provider call', async () => {
    const s = await freshSource();
    await importImageFile(engine, s.write('photos/menu.png', PNG), 'photos/menu.png', { sourceId: s.id });
    expect(embedCalls).toBe(1);
    const before = await s.vector('photos/menu.png');
    expect(before).not.toBeNull();
    const page = await engine.getPage('photos/menu.png', { sourceId: s.id });
    expect((page?.frontmatter as Record<string, unknown>).visual_model).toBe(MODEL);

    embedCalls = 0;
    const swept = await sweepWantingOcr(s.id);
    expect(swept).toMatchObject({ candidates: 1, rebuilt: 1, failures: 0 });
    expect(embedCalls).toBe(0);
    expect(await s.vector('photos/menu.png')).toEqual(before);
  }, 60_000);

  test('after a multimodal model switch an unchanged image pays for a vector in the new model', async () => {
    const s = await freshSource();
    configure('dashscope:qwen3-vl-embedding');
    await importImageFile(engine, s.write('photos/old.png', PNG), 'photos/old.png', { sourceId: s.id });
    expect(embedCalls).toBe(1);
    const before = await s.vector('photos/old.png');
    expect((await engine.getPage('photos/old.png', { sourceId: s.id }))?.frontmatter).toMatchObject({ visual_model: 'dashscope:qwen3-vl-embedding' });

    configure(MODEL);
    embedCalls = 0;
    expect(await sweepWantingOcr(s.id)).toMatchObject({ candidates: 1, rebuilt: 1 });
    expect(embedCalls).toBe(1);
    expect(await s.vector('photos/old.png')).not.toEqual(before);
    expect((await engine.getPage('photos/old.png', { sourceId: s.id }))?.frontmatter).toMatchObject({ visual_model: MODEL });
  }, 60_000);

  test('a page without a visual_model stamp (written before the stamp existed) has nothing to reuse', async () => {
    const s = await freshSource();
    await importImageFile(engine, s.write('photos/legacy.png', PNG), 'photos/legacy.png', { sourceId: s.id });
    expect(await reusableVisualVector(engine, s.id, 'photos/legacy.png', { visual_model: MODEL })).not.toBeNull();
    expect(await reusableVisualVector(engine, s.id, 'photos/legacy.png', { mime_type: 'image/png' })).toBeNull();
    expect(await reusableVisualVector(engine, s.id, 'photos/legacy.png', null)).toBeNull();
    // Source-scoped: the same slug in another source has nothing to reuse.
    expect(await reusableVisualVector(engine, 'default', 'photos/legacy.png', { visual_model: MODEL })).toBeNull();

    // embedding_image_legacy_visual_model credits unstamped pages to a model; a stamp always wins over it.
    try {
      await engine.setConfig('embedding_image_legacy_visual_model', MODEL);
      expect(await reusableVisualVector(engine, s.id, 'photos/legacy.png', { mime_type: 'image/png' })).not.toBeNull();
      expect(await reusableVisualVector(engine, s.id, 'photos/legacy.png', { visual_model: 'dashscope:qwen3-vl-embedding' })).toBeNull();
      await engine.setConfig('embedding_image_legacy_visual_model', 'dashscope:qwen3-vl-embedding');
      expect(await reusableVisualVector(engine, s.id, 'photos/legacy.png', null)).toBeNull();
    } finally {
      await engine.executeRaw(`DELETE FROM config WHERE key = 'embedding_image_legacy_visual_model'`);
    }
  }, 60_000);

  test('changed bytes pay for a fresh vector', async () => {
    const s = await freshSource();
    const file = s.write('photos/poster.png', PNG);
    await importImageFile(engine, file, 'photos/poster.png', { sourceId: s.id });
    const before = await s.vector('photos/poster.png');

    embedCalls = 0;
    s.write('photos/poster.png', PNG_CHANGED);
    const res = await importImageFile(engine, file, 'photos/poster.png', { sourceId: s.id });
    expect(res.status).toBe('imported');
    expect(embedCalls).toBe(1);
    expect(await s.vector('photos/poster.png')).not.toEqual(before);
  }, 60_000);

  test('forceReembed pays for a fresh vector even when the bytes are unchanged', async () => {
    const s = await freshSource();
    const file = s.write('photos/sign.png', PNG);
    await importImageFile(engine, file, 'photos/sign.png', { sourceId: s.id });
    const before = await s.vector('photos/sign.png');

    embedCalls = 0;
    const res = await importImageFile(engine, file, 'photos/sign.png', { sourceId: s.id, forceReembed: true });
    expect(res.status).toBe('imported');
    expect(embedCalls).toBe(1);
    expect(await s.vector('photos/sign.png')).not.toEqual(before);
  }, 60_000);
});

describe('image sweep time budget', () => {
  const spent = () => ({ startedAt: Date.now() - 10_000, budgetMs: 1 });

  test('an exhausted budget stops the sweep after one image and defers the rest', async () => {
    const s = await freshSource();
    await s.seedVectorless(['b1', 'b2', 'b3']);
    expect((await embedStaleImages(engine, { sourceId: s.id, dryRun: true })).candidates).toBe(3);

    embedCalls = 0;
    const swept = await embedStaleImages(engine, { sourceId: s.id, dryRun: false, budget: spent() });
    expect(swept).toMatchObject({ candidates: 3, rebuilt: 1, time_budget: true, deferred: 2 });
    expect(embedCalls).toBe(1);
    expect((await embedStaleImages(engine, { sourceId: s.id, dryRun: true })).candidates).toBe(2);
  }, 60_000);

  test('a missing file first in order does not use up the one image an exhausted budget still allows', async () => {
    const s = await freshSource();
    await s.seedVectorless(['m0', 'm1', 'm2']);
    rmSync(join(s.dir, 'photos/m0.png'));

    const swept = await embedStaleImages(engine, { sourceId: s.id, dryRun: false, budget: spent() });
    expect(swept).toMatchObject({ candidates: 3, missingFile: 1, rebuilt: 1, time_budget: true, deferred: 1 });
  }, 60_000);

  test('no budget (null) sweeps every candidate', async () => {
    const s = await freshSource();
    await s.seedVectorless(['n1', 'n2', 'n3']);
    const swept = await embedStaleImages(engine, { sourceId: s.id, dryRun: false, budget: { startedAt: Date.now() - 10_000, budgetMs: null } });
    expect(swept).toMatchObject({ candidates: 3, rebuilt: 3 });
    expect(swept.time_budget).toBeUndefined();
  }, 60_000);

  type ImagesOut = { time_budget?: boolean; rebuilt: number; deferred?: number };
  const cli = (args: string[]) => withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true', GBRAIN_EMBED_TIME_BUDGET_MS: '0' }, async () => {
    // The 0 ms budget is spent before the second image.
    await new Promise(r => setTimeout(r, 5));
    return await runEmbed(engine, args);
  });

  test('embed --stale hands the sweep the run budget (GBRAIN_EMBED_TIME_BUDGET_MS)', async () => {
    const s = await freshSource();
    await s.seedVectorless(['c1', 'c2']);
    const res = await cli(['--stale', '--source', s.id, '--json']) as { images?: ImagesOut };
    expect(res.images).toMatchObject({ rebuilt: 1, time_budget: true, deferred: 1 });
  }, 60_000);

  test('embed --stale --images honors the same budget', async () => {
    const s = await freshSource();
    await s.seedVectorless(['i1', 'i2']);
    const res = await cli(['--stale', '--images', '--source', s.id, '--json']) as unknown as ImagesOut;
    expect(res).toMatchObject({ rebuilt: 1, time_budget: true, deferred: 1 });
  }, 60_000);

  test('embed --stale --catch-up sweeps every image despite a spent budget', async () => {
    const s = await freshSource();
    await s.seedVectorless(['u1', 'u2']);
    const res = await cli(['--stale', '--catch-up', '--source', s.id, '--json']) as { images?: ImagesOut };
    expect(res.images).toMatchObject({ rebuilt: 2 });
    expect(res.images?.time_budget).toBeUndefined();
  }, 60_000);
});

describe('OCR-only candidates after the run OCR cap', () => {
  test('a sealed image missing only OCR text waits once the OCR cap is spent; a vectorless image is still rebuilt', async () => {
    const s = await freshSource();
    await importImageFile(engine, s.write('photos/text.png', PNG), 'photos/text.png', { sourceId: s.id });
    await s.seedVectorless(['novec']);
    const revisionOf = async (slug: string) => (await engine.getPage(slug, { sourceId: s.id }))?.knowledge_revision;
    const before = await revisionOf('photos/text.png');

    // The default per-run cap is 200 OCR calls: preset it as spent.
    _resetOcrRunBudgetForTests({ images: 200 });
    embedCalls = 0;
    const swept = await sweepWantingOcr(s.id);
    expect(swept).toMatchObject({ candidates: 2, rebuilt: 1, ocr_deferred: 1, failures: 0 });
    expect(embedCalls).toBe(1);
    expect(await revisionOf('photos/text.png')).toBe(before);

    // After a multimodal model switch the same page is not deferred: the rebuild refreshes its vector.
    const t = await freshSource();
    configure('dashscope:qwen3-vl-embedding');
    await importImageFile(engine, t.write('photos/old.png', PNG), 'photos/old.png', { sourceId: t.id });
    configure(MODEL);
    _resetOcrRunBudgetForTests({ images: 200 });
    embedCalls = 0;
    expect(await sweepWantingOcr(t.id)).toMatchObject({ candidates: 1, rebuilt: 1 });
    expect(embedCalls).toBe(1);

    // A fresh run with OCR budget left rebuilds both (OCR is wanted, the text is still missing), reusing their vectors.
    _resetOcrRunBudgetForTests();
    embedCalls = 0;
    const next = await sweepWantingOcr(s.id);
    expect(next).toMatchObject({ candidates: 2, rebuilt: 2 });
    expect(embedCalls).toBe(0);
    expect(next.ocr_deferred).toBeUndefined();
  }, 60_000);
});

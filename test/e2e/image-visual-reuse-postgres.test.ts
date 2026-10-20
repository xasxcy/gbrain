/**
 * FORK-ONLY E2E. Rebuilding an unchanged image on real Postgres reuses its stored visual vector: the
 * `embedding_image::text` read + `parseEmbedding` round-trip returns the exact vector, so the rebuilt chunk keeps it
 * and the multimodal provider is not called again.
 *
 * Run: DATABASE_URL=postgresql://... bun run test:e2e test/e2e/image-visual-reuse-postgres.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { importImageFile } from '../../src/core/import-file.ts';
import { reusableVisualVector } from '../../src/core/image-visual-reuse.ts';
import { embedStaleImages } from '../../src/core/embed-stale-images.ts';
import { runSources } from '../../src/commands/sources.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';
import { parseEmbedding } from '../../src/core/utils.ts';
import { withEnv } from '../helpers/with-env.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const origFetch = globalThis.fetch;

const configure = () => configureGateway({
  embedding_model: 'voyage:voyage-multimodal-3',
  embedding_multimodal_model: 'voyage:voyage-multimodal-3',
  embedding_dimensions: 1024,
  env: { VOYAGE_API_KEY: 'test-key' },
});

describe.skipIf(!DATABASE_URL)('image visual vector reuse (Postgres E2E)', () => {
  let engine: PostgresEngine;
  let close: (() => Promise<void>) | undefined;
  let dir: string;
  let embedCalls = 0;
  let vectorSeq = 0;

  beforeAll(async () => {
    configure();
    const fixture = await isolatedPersistencePostgres(DATABASE_URL!, 'module');
    engine = fixture.engine;
    close = fixture.close;
    dir = mkdtempSync(join(tmpdir(), 'img-reuse-pg-'));
    mkdirSync(join(dir, 'photos'));
    await runSources(engine, ['add', 'img', '--path', dir, '--no-federated', '--force']);
  }, 60_000);

  beforeEach(() => {
    embedCalls = 0;
    globalThis.fetch = (async () => {
      embedCalls++;
      // Non-trivial per-dimension values so a lossy text round-trip would show.
      const seq = ++vectorSeq;
      return new Response(JSON.stringify({
        data: [{ embedding: Array.from({ length: 1024 }, (_, i) => Math.sin(seq * 1000 + i) / 3), index: 0 }],
        model: 'voyage-multimodal-3',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    configure();
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
    resetGateway();
  });

  afterAll(async () => {
    await close?.();
  }, 60_000);

  const storedVector = async (slug: string): Promise<number[] | null> => {
    const [row] = await engine.executeRaw<{ vec: string | null }>(
      `SELECT c.embedding_image::text AS vec FROM pages p JOIN content_chunks c ON c.page_id = p.id
        WHERE p.source_id = 'img' AND p.slug = $1`, [slug]);
    const vec = parseEmbedding(row?.vec ?? null);
    return vec ? Array.from(vec) : null;
  };

  test('the stored vector reads back exactly and an OCR-wanted rebuild keeps it without a provider call', async () => {
    const file = join(dir, 'photos/menu.png');
    writeFileSync(file, PNG);
    await importImageFile(engine, file, 'photos/menu.png', { sourceId: 'img' });
    expect(embedCalls).toBe(1);
    const before = await storedVector('photos/menu.png');
    expect(before).toHaveLength(1024);

    const fm = (await engine.getPage('photos/menu.png', { sourceId: 'img' }))?.frontmatter as Record<string, unknown>;
    const reused = await reusableVisualVector(engine, 'img', 'photos/menu.png', fm);
    expect(reused).not.toBeNull();
    expect(Array.from(reused!)).toEqual(before!);
    // Source-scoped: the same slug in another source has nothing to reuse.
    expect(await reusableVisualVector(engine, 'default', 'photos/menu.png', fm)).toBeNull();

    embedCalls = 0;
    await withEnv({ GBRAIN_EMBEDDING_IMAGE_OCR: 'true' }, async () => {
      const swept = await embedStaleImages(engine, { sourceId: 'img', dryRun: false });
      expect(swept.candidates).toBeGreaterThanOrEqual(1);
      expect(swept.failures).toBe(0);
    });
    expect(embedCalls).toBe(0);
    expect(await storedVector('photos/menu.png')).toEqual(before);
  }, 60_000);

  test('a writer role without SELECT on page_body_manifest still reads the vector (no segmented page)', async () => {
    // Postgres checks the privilege of every relation a statement names, so naming the manifest would fail with 42501.
    const role = 'gbrain_img_reuse_' + Math.random().toString(36).slice(2, 10);
    const file = join(dir, 'photos/role.png');
    writeFileSync(file, PNG);
    await importImageFile(engine, file, 'photos/role.png', { sourceId: 'img' });
    const fm = (await engine.getPage('photos/role.png', { sourceId: 'img' }))?.frontmatter as Record<string, unknown>;
    await engine.executeRaw(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    try {
      await engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${role}`);
      await engine.executeRaw(`GRANT SELECT ON pages, content_chunks TO ${role}`);
      for (const t of ['pages', 'content_chunks']) await engine.executeRaw(`CREATE POLICY ${role}_read ON ${t} FOR SELECT TO ${role} USING (true)`);
      const reused = await engine.transaction(async tx => {
        await tx.executeRaw(`SET LOCAL ROLE ${role}`);
        return reusableVisualVector(tx, 'img', 'photos/role.png', fm);
      });
      expect(reused).not.toBeNull();
      expect(Array.from(reused!)).toEqual((await storedVector('photos/role.png'))!);
    } finally {
      for (const t of ['pages', 'content_chunks']) await engine.executeRaw(`DROP POLICY IF EXISTS ${role}_read ON ${t}`);
      await engine.executeRaw(`DROP OWNED BY ${role}`).catch(() => undefined);
      await engine.executeRaw(`DROP ROLE IF EXISTS ${role}`);
    }
  }, 60_000);
});

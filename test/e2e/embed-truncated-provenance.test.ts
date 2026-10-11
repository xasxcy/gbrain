/**
 * R6-1: a fallback-truncated vector records an explicit, non-NULL TRUNCATION provenance (instead of an unknown NULL
 * hash, and never the hash of the full input). Closed loop on every wrapping mode and for non-BMP text:
 *   truncated fallback -> truncation hash recorded (non-NULL, != full-input hash) -> the strict stamp accepts it ->
 *   the next drains neither probe nor null it -> changing the text nulls it and the re-embed records the full hash.
 * R2-F4 still holds: a projection rebuild with unchanged text does NOT accept the truncated vector as the full input.
 *
 * E2E lane: the Postgres half runs when DATABASE_URL points at a (test) Postgres; PGLite always runs.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChunkInput } from '../../src/core/types.ts';
import { getEmbeddingModel } from '../../src/core/ai/gateway.ts';
import { embedStaleForSource } from '../../src/core/embed-stale.ts';
import { embeddingInputContext, embeddingWriteTarget, installPageProjection, readProjectionSnapshot, sealPageTextProjection } from '../../src/core/page-state/projections.ts';
import { embeddingInputHash, embeddingInputText, truncatedEmbeddingInputHash, type EmbeddingTier } from '../../src/core/embedding-input-hash.ts';

// The signature's model must equal the configured embedding model, otherwise a projection rebuild nulls every vector
// for the wrong reason (model mismatch) and the keep/null assertions below would be vacuous.
const NEW_SIG = `${getEmbeddingModel()}:1536`;
const OLD_SIG = 'old:model:1536';
const LIMIT = 5500; // the embed fallback's first truncation level

let pglite: PGLiteEngine;
let pg: PostgresEngine | null = null;

beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
  if (process.env.DATABASE_URL) {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL);
    pg = new PostgresEngine();
    await pg.connect({ database_url: process.env.DATABASE_URL });
    await pg.initSchema();
  }
}, 60_000);

afterAll(async () => {
  await pglite.disconnect();
  if (pg) await pg.disconnect();
});

async function reset(engine: BrainEngine): Promise<void> {
  if (engine === pglite) { await resetPgliteState(pglite); return; }
  await engine.executeRaw('DELETE FROM embed_failures');
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM pages');
}

beforeEach(async () => {
  await reset(pglite);
  if (pg) await reset(pg);
});

async function seedPendingPage(engine: BrainEngine, slug: string, mode: string, text: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
  await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', token_count: 4, embedding: undefined }]);
  await engine.executeRaw(`UPDATE pages SET contextual_retrieval_mode = $2 WHERE source_id='default' AND slug=$1`, [slug, mode]);
  await sealPageTextProjection(engine, slug, 'default');
  await engine.setPageEmbeddingSignature(slug, { signature: OLD_SIG });
}

/** Provider that cannot embed an input longer than the first truncation level (OOM-like error). */
function oomEmbedder() {
  const calls: string[][] = [];
  return {
    calls,
    embedFn: async (texts: string[]) => {
      calls.push([...texts]);
      if (texts.some(text => text.length > LIMIT)) throw new Error('EOF');
      return texts.map(() => { const v = new Float32Array(1536); v[0] = 1; return v; });
    },
  };
}

async function state(engine: BrainEngine, slug: string) {
  const [page] = await engine.executeRaw<{ sig: string | null; mode: string | null }>(
    `SELECT embedding_signature AS sig, contextual_retrieval_mode AS mode FROM pages WHERE source_id='default' AND slug=$1`, [slug]);
  const chunks = await engine.executeRaw<{ hash: string | null; has_vector: boolean }>(
    `SELECT cc.embedding_input_hash AS hash, cc.embedding IS NOT NULL AS has_vector FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id WHERE p.source_id='default' AND p.slug=$1 ORDER BY cc.chunk_index`, [slug]);
  return { sig: page!.sig, mode: page!.mode, chunks };
}

/** The canonical full-input hash and the expected truncation hash, derived from the page the way the installer does. */
async function expectedHashes(engine: BrainEngine, slug: string, tier: EmbeddingTier) {
  const target = await embeddingWriteTarget(engine);
  const stored = await engine.getChunks(slug, { sourceId: 'default', includeUnsealed: true });
  const [page] = await engine.executeRaw<{ title: string; corpus_generation: string | null }>(
    `SELECT title, corpus_generation FROM pages WHERE source_id='default' AND slug=$1`, [slug]);
  const ctx = embeddingInputContext(target, page!.title, page!.corpus_generation, stored);
  const chunk = stored[0]!;
  return {
    full: embeddingInputHash(ctx, tier, chunk),
    truncated: truncatedEmbeddingInputHash(ctx, tier, chunk, LIMIT),
    embeddedInput: embeddingInputText(ctx, tier, chunk),
  };
}

const CASES: { name: string; mode: string; tier: EmbeddingTier; text: string }[] = [
  { name: "mode='none'", mode: 'none', tier: 'none', text: 'x'.repeat(6000) },
  { name: "mode='title'", mode: 'title', tier: 'title', text: 'y'.repeat(6000) },
  // 5499 ASCII units + 30 astral characters (60 units): 5559 UTF-16 units but 5529 code points. The 5500-unit cut lands
  // between the two halves of the first surrogate pair, and SQL length() and JS length disagree about this text.
  { name: "mode='none' with non-BMP characters", mode: 'none', tier: 'none', text: `${'x'.repeat(5499)}${'\u{1F600}'.repeat(30)}` },
];

for (const kind of ['pglite', 'postgres'] as const) {
  describe(`R6-1 truncation provenance closed loop (${kind})`, () => {
    const engineOf = (): BrainEngine | null => (kind === 'pglite' ? pglite : pg);

    for (const c of CASES) {
      test(`${c.name}: truncated fallback -> truncation hash -> stamped -> no probe / no null -> text change nulls and re-embeds`, async () => {
        const engine = engineOf();
        if (!engine) { console.warn('[skip] DATABASE_URL not set; Postgres half of R6-1 not run'); return; }
        const slug = 'truncated-page';
        await seedPendingPage(engine, slug, c.mode, c.text);
        const expected = await expectedHashes(engine, slug, c.tier);

        // Round 1: the original attempt fails (OOM-like), the 5500-char truncation succeeds.
        const first = oomEmbedder();
        const r1 = await embedStaleForSource(engine, 'default', { embedFn: first.embedFn, embeddingSignature: NEW_SIG });
        const oversize = first.calls.flat().filter(text => text.length > LIMIT);
        expect(oversize).toHaveLength(1);
        const truncatedCall = first.calls.flat().filter(text => text.length === LIMIT);
        expect(truncatedCall).toHaveLength(1);
        // The recorded provenance names the text that was ACTUALLY embedded.
        expect(truncatedCall[0]).toBe(expected.embeddedInput.slice(0, LIMIT));
        expect(r1).toMatchObject({ embedded: 1, done: true, aborted: false });
        const afterFirst = await state(engine, slug);
        expect(afterFirst.chunks).toHaveLength(1);
        expect(afterFirst.chunks[0]!.has_vector).toBe(true);
        expect(afterFirst.chunks[0]!.hash).not.toBeNull();
        expect(afterFirst.chunks[0]!.hash).toBe(expected.truncated);
        expect(afterFirst.chunks[0]!.hash).not.toBe(expected.full); // never certified as the full input
        // The strict stamp accepts the recorded truncation provenance: no second round is needed to restamp.
        expect(afterFirst.sig).toBe(NEW_SIG);

        // Rounds 2 and 3: nothing to probe, null or embed.
        for (let round = 0; round < 2; round++) {
          const again = oomEmbedder();
          const r = await embedStaleForSource(engine, 'default', { embedFn: again.embedFn, embeddingSignature: NEW_SIG });
          expect(again.calls).toEqual([]);
          expect(r).toMatchObject({ embedded: 0, invalidated: 0, done: true, aborted: false });
          expect(await state(engine, slug)).toEqual(afterFirst);
        }

        // Changing the text nulls the vector (projection rebuild) and the ordinary drain re-embeds it with the
        // canonical full-input hash (the new text fits, no truncation).
        const snapshot = (await readProjectionSnapshot(engine, slug, 'default'))!;
        const changed: ChunkInput = { chunk_index: 0, chunk_text: `${c.text.slice(0, 40)} edited`, chunk_source: 'compiled_truth', token_count: 4 };
        await installPageProjection(engine, snapshot, [changed], { seal: true, preserveEmbeddings: true });
        const nulled = await state(engine, slug);
        expect(nulled.chunks[0]).toEqual({ hash: null, has_vector: false });
        await engine.setPageEmbeddingSignature(slug, { signature: OLD_SIG });
        const after = oomEmbedder();
        await embedStaleForSource(engine, 'default', { embedFn: after.embedFn, embeddingSignature: NEW_SIG });
        const reembedded = await state(engine, slug);
        expect(reembedded.chunks[0]!.has_vector).toBe(true);
        expect(reembedded.chunks[0]!.hash).toBe((await expectedHashes(engine, slug, c.tier)).full);
        expect(reembedded.chunks[0]!.hash).not.toBe(expected.truncated);
        expect(reembedded.sig).toBe(NEW_SIG);
      });

      test(`${c.name}: R2-F4 holds, a projection rebuild with unchanged text does not accept the truncated vector as the full input`, async () => {
        const engine = engineOf();
        if (!engine) return;
        const slug = 'truncated-rebuild';
        await seedPendingPage(engine, slug, c.mode, c.text);
        await embedStaleForSource(engine, 'default', { embedFn: oomEmbedder().embedFn, embeddingSignature: NEW_SIG });
        const expected = await expectedHashes(engine, slug, c.tier);
        expect((await state(engine, slug)).chunks[0]!.hash).toBe(expected.truncated);

        // Same text, same identity: only the recorded provenance decides whether the vector is kept.
        const snapshot = (await readProjectionSnapshot(engine, slug, 'default'))!;
        const same: ChunkInput = { chunk_index: 0, chunk_text: c.text, chunk_source: 'compiled_truth', token_count: 4 };
        await installPageProjection(engine, snapshot, [same], { seal: true, preserveEmbeddings: true });
        expect((await state(engine, slug)).chunks[0]).toEqual({ hash: null, has_vector: false });

        // Control: a vector recorded under the FULL input's canonical hash is kept by the very same rebuild.
        // (A short text that embeds without truncation, so this proves the keep path is live, not vacuously skipped.)
        const slug2 = 'full-input-rebuild';
        const short = c.text.slice(0, 100);
        await seedPendingPage(engine, slug2, c.mode, short);
        await embedStaleForSource(engine, 'default', { embedFn: oomEmbedder().embedFn, embeddingSignature: NEW_SIG });
        const full = (await expectedHashes(engine, slug2, c.tier)).full;
        expect((await state(engine, slug2)).chunks[0]!.hash).toBe(full);
        const snapshot2 = (await readProjectionSnapshot(engine, slug2, 'default'))!;
        await installPageProjection(engine, snapshot2, [{ chunk_index: 0, chunk_text: short, chunk_source: 'compiled_truth', token_count: 4 }], { seal: true, preserveEmbeddings: true });
        expect((await state(engine, slug2)).chunks[0]).toEqual({ hash: full, has_vector: true });
      });
    }
  });
}

/**
 * R5-1 (user ruling 2026-10-11): follow upstream N2 / page-state/projections.ts (#5553) on the signature
 * invalidation path too. A vector in the CURRENT embedding space (model, text hash, width) that has NO recorded
 * embedding-input hash is a legitimate current input only on a page WITHOUT a contextual-retrieval mode. On a page
 * whose mode is set (including the explicit 'none') it is nulled once and re-embedded, never kept and never stamped.
 *
 * The risk this guards: nulling it without also teaching the second (restamp) UPDATE the same rule leaves the page
 * unstampable, and a page that is neither stamped nor re-embedded makes every drain re-probe the embedder. So this is
 * a closed loop: invalidate -> re-embed -> stamp -> the next drain does nothing and does not probe.
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
import { embedStaleForSource, EMBED_PROBE_TEXT } from '../../src/core/embed-stale.ts';
import { countSignatureDriftedEmbeddings, countRestampOnlyChunks } from '../../src/core/embedding-invalidation.ts';

const NEW_SIG = 'new:model:1536';
const OLD_SIG = 'old:model:1536';

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

/**
 * A page whose chunks are already vectors in the TARGET space (model, text hash and width match) but whose page
 * signature is still the old one, with the given contextual mode and recorded input hash.
 */
async function seedCurrentSpacePage(engine: BrainEngine, slug: string, opts: { mode: string | null; inputHash: string | null; chunks?: number }): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
  await installFixtureChunks(engine, slug, Array.from({ length: opts.chunks ?? 2 }, (_, i) => ({
    chunk_index: i, chunk_text: `${slug} chunk ${i}`, chunk_source: 'compiled_truth' as const, token_count: 4,
    embedding: new Float32Array(1536).fill(0.1),
  })));
  if (opts.mode !== null) {
    await engine.executeRaw(`UPDATE pages SET contextual_retrieval_mode = $2 WHERE source_id='default' AND slug=$1`, [slug, opts.mode]);
    // A mode change bumps the knowledge revision; re-seal so the page is drainable.
    const { sealPageTextProjection } = await import('../../src/core/page-state/projections.ts');
    await sealPageTextProjection(engine, slug, 'default');
  }
  await engine.executeRaw(
    `UPDATE content_chunks SET model = 'new:model', embedded_text_hash = md5(chunk_text), embedding_input_hash = $2::text
      WHERE page_id = (SELECT id FROM pages WHERE source_id='default' AND slug=$1)`, [slug, opts.inputHash]);
  await engine.setPageEmbeddingSignature(slug, { signature: OLD_SIG });
}

async function pageState(engine: BrainEngine, slug: string) {
  const [page] = await engine.executeRaw<{ sig: string | null }>(`SELECT embedding_signature AS sig FROM pages WHERE source_id='default' AND slug=$1`, [slug]);
  const chunks = await engine.executeRaw<{ nulls: number; hashes: number; total: number }>(
    `SELECT count(*) FILTER (WHERE cc.embedding IS NULL)::int AS nulls,
            count(*) FILTER (WHERE cc.embedding_input_hash IS NOT NULL)::int AS hashes,
            count(*)::int AS total
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.source_id='default' AND p.slug=$1`, [slug]);
  return { sig: page!.sig, nulls: Number(chunks[0]!.nulls), hashes: Number(chunks[0]!.hashes), total: Number(chunks[0]!.total) };
}

function trackedEmbedder() {
  const calls: string[][] = [];
  return {
    calls,
    probes: () => calls.filter(texts => texts.includes(EMBED_PROBE_TEXT)).length,
    realTexts: () => calls.flat().filter(text => text !== EMBED_PROBE_TEXT).length,
    embedFn: async (texts: string[]) => {
      calls.push([...texts]);
      return texts.map(() => { const v = new Float32Array(1536); v[0] = 1; return v; });
    },
  };
}

for (const kind of ['pglite', 'postgres'] as const) {
  describe(`R5-1 NULL-hash vectors on a contextual-mode page are re-embedded, not stamped (${kind})`, () => {
    const engineOf = (): BrainEngine | null => (kind === 'pglite' ? pglite : pg);

    test("closed loop: mode='none' page with NULL-hash current-space vectors -> nulled -> re-embedded -> stamped -> next drain is a no-op without a probe", async () => {
      const engine = engineOf();
      if (!engine) { console.warn('[skip] DATABASE_URL not set; Postgres half of R5-1 not run'); return; }
      await seedCurrentSpacePage(engine, 'none-null-hash', { mode: 'none', inputHash: null });
      // Controls that must keep today's behavior: the same state on a page WITHOUT a mode, and on a mode page whose
      // vectors carry a recorded input hash. Both keep their vectors and are stamped by the invalidation restamp.
      await seedCurrentSpacePage(engine, 'plain-null-hash', { mode: null, inputHash: null });
      await seedCurrentSpacePage(engine, 'none-recorded-hash', { mode: 'none', inputHash: 'recorded' });

      // The counters the drain uses to decide whether the probe is needed see exactly the chunks that will be nulled.
      expect(await countSignatureDriftedEmbeddings(engine, { signature: NEW_SIG, sourceId: 'default' })).toBe(2);
      expect(await countRestampOnlyChunks(engine, { signature: NEW_SIG, sourceId: 'default' })).toBe(4);

      // Round 1: probe fires once, only the mode page's 2 chunks are nulled and re-embedded.
      const first = trackedEmbedder();
      const r1 = await embedStaleForSource(engine, 'default', { embedFn: first.embedFn, embeddingSignature: NEW_SIG });
      expect(first.probes()).toBe(1);
      expect(r1.invalidated).toBe(2);
      expect(r1.embedded).toBe(2);
      expect(first.realTexts()).toBe(2);
      expect(r1).toMatchObject({ done: true, aborted: false });
      expect(r1.complete ?? true).toBe(true);
      expect(await pageState(engine, 'none-null-hash')).toEqual({ sig: NEW_SIG, nulls: 0, hashes: 2, total: 2 });
      // Controls: untouched vectors (still no hash recorded on the plain page), stamped.
      expect(await pageState(engine, 'plain-null-hash')).toEqual({ sig: NEW_SIG, nulls: 0, hashes: 0, total: 2 });
      expect(await pageState(engine, 'none-recorded-hash')).toEqual({ sig: NEW_SIG, nulls: 0, hashes: 2, total: 2 });

      // Round 2: nothing left to invalidate, embed or probe.
      const second = trackedEmbedder();
      const r2 = await embedStaleForSource(engine, 'default', { embedFn: second.embedFn, embeddingSignature: NEW_SIG });
      expect(second.calls).toEqual([]);
      expect(r2).toMatchObject({ embedded: 0, invalidated: 0, done: true, aborted: false });

      // Round 3: still stable (no oscillation between nulled and stamped).
      const third = trackedEmbedder();
      await embedStaleForSource(engine, 'default', { embedFn: third.embedFn, embeddingSignature: NEW_SIG });
      expect(third.calls).toEqual([]);
      expect(await pageState(engine, 'none-null-hash')).toEqual({ sig: NEW_SIG, nulls: 0, hashes: 2, total: 2 });
    });

    test('a mixed page (one recorded hash, one NULL hash) nulls only the unproven chunk and is stamped once it is re-embedded', async () => {
      const engine = engineOf();
      if (!engine) return;
      await seedCurrentSpacePage(engine, 'mixed', { mode: 'none', inputHash: 'recorded', chunks: 3 });
      await engine.executeRaw(
        `UPDATE content_chunks SET embedding_input_hash = NULL WHERE chunk_index = 1
           AND page_id = (SELECT id FROM pages WHERE source_id='default' AND slug='mixed')`);
      const run = trackedEmbedder();
      const r = await embedStaleForSource(engine, 'default', { embedFn: run.embedFn, embeddingSignature: NEW_SIG });
      expect(r.invalidated).toBe(1);
      expect(r.embedded).toBe(1);
      expect(run.realTexts()).toBe(1);
      expect(await pageState(engine, 'mixed')).toEqual({ sig: NEW_SIG, nulls: 0, hashes: 3, total: 3 });
      const again = trackedEmbedder();
      await embedStaleForSource(engine, 'default', { embedFn: again.embedFn, embeddingSignature: NEW_SIG });
      expect(again.calls).toEqual([]);
    });

    test('an oversize chunk that can only be embedded truncated (unknown input hash) converges: no endless probe / re-null / re-embed', async () => {
      const engine = engineOf();
      if (!engine) return;
      // The fallback truncates inputs longer than 5500 chars and records an UNKNOWN input hash for the result, which
      // on a mode page can never satisfy the strict stamp. Nulling it again would loop forever, so the invalidation
      // keeps such a chunk and restamps the page (keptBySignatureInvalidationPredicate).
      const slug = 'oversize-truncated';
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: 'x'.repeat(6000), chunk_source: 'compiled_truth', token_count: 4, embedding: undefined }]);
      await engine.executeRaw(`UPDATE pages SET contextual_retrieval_mode = 'none' WHERE source_id='default' AND slug=$1`, [slug]);
      const { sealPageTextProjection } = await import('../../src/core/page-state/projections.ts');
      await sealPageTextProjection(engine, slug, 'default');
      await engine.setPageEmbeddingSignature(slug, { signature: OLD_SIG });
      const embedFn = (calls: string[][]) => async (texts: string[]) => {
        calls.push([...texts]);
        if (texts.some(text => text.length > 5500)) throw new Error('EOF'); // OOM-like: triggers the truncation fallback
        return texts.map(() => { const v = new Float32Array(1536); v[0] = 1; return v; });
      };
      const rounds: string[][][] = [];
      for (let round = 0; round < 4; round++) {
        const calls: string[][] = [];
        await embedStaleForSource(engine, 'default', { embedFn: embedFn(calls), embeddingSignature: NEW_SIG });
        rounds.push(calls);
      }
      const embeds = (calls: string[][]) => calls.flat().filter(text => text.length > 5000).length;
      // Round 1 embeds the chunk (original attempt + one truncation). Round 2 may probe once and restamps the page.
      expect(embeds(rounds[0]!)).toBe(2);
      expect(rounds[1]!.flat().some(text => text.length > 5000)).toBe(false);
      // From then on the drain does nothing at all: no probe, no re-embed.
      expect(rounds[2]).toEqual([]);
      expect(rounds[3]).toEqual([]);
      const state = await pageState(engine, slug);
      expect(state.sig).toBe(NEW_SIG);
      expect(state.nulls).toBe(0);
    });
  });
}

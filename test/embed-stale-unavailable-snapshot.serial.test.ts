/**
 * #5804: `embed --stale` must not report success for pages it could not embed.
 *
 * Protects: a stale page whose projection snapshot is unavailable when the
 * sweep reaches it (edited or tagged after the readiness gate) is a
 * counted failure, so the CLI exits non-zero, and the run reports ONE batch
 * summary naming how many pages were skipped and which, instead of a
 * `Embedded 0 chunks` success. Pages in a source archived mid-run stay
 * counted once, by the archived-work report, never twice.
 * Fails when: the null-snapshot path returns silently again (failures 0), the
 * summary is replaced by per-page samples, or an archived page is
 * double-counted.
 * Seam: `assertOwned`, which every stale transaction calls before its work;
 * the first call lands after the run-level readiness gate, the window the
 * race opens in.
 *
 * Named `.serial.test.ts`: configures the AI gateway and a fake embed
 * transport for its whole lifecycle, which withEnv() can't wrap.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { listPendingProjectionPages, prepareEmbeddingProjections } from '../src/core/embedding-readiness.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';
import { LockStolenError } from '../src/core/db-lock.ts';

const DIMS = 1536;
let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' },
  });
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => ({
    embeddings: values.map(() => new Array(DIMS).fill(0.001)),
    usage: { tokens: values.length * 4 },
  } as never));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function stalePage(slug: string, sourceId = 'default') {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Synthetic body for ${slug}.` }, { sourceId });
  await installFixtureChunks(engine, slug, [
    { chunk_index: 0, chunk_text: `Synthetic body for ${slug}.`, chunk_source: 'compiled_truth' },
  ], { sourceId });
}

/** Runs `change` once, inside the first stale transaction (after readiness). */
function once(change: (tx: BrainEngine) => Promise<void>) {
  let done = false;
  return async (tx?: BrainEngine) => {
    if (done || !tx) return;
    done = true;
    await change(tx);
  };
}

async function nullVectors(slug: string): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>(
    'SELECT count(*)::int AS n FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = $1 AND c.embedding IS NULL', [slug]);
  return row.n;
}

// #6223 (fix wave 12, W1.5): a page only its importer can rebuild (an image
// page whose projection was unsealed) must not starve every other stale chunk.
async function blockedImagePage(slug: string) {
  await stalePage(slug);
  await engine.executeRaw("UPDATE pages SET page_kind='image', text_projection_revision=NULL WHERE slug=$1", [slug]);
}
const chunkRows = (slug: string) => engine.executeRaw(
  'SELECT c.chunk_index,c.chunk_text,c.embedding IS NULL AS unembedded FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.slug=$1 ORDER BY c.chunk_index', [slug]);

describe('embed --stale past pages still waiting for a projection (#6223)', () => {
  test.each([[false], [true]])('a blocked image page does not starve healthy stale chunks (catchUp=%s)', async catchUp => {
    await blockedImagePage('images/scan-0001');
    await stalePage('notes/healthy');
    const before = await chunkRows('images/scan-0001');
    const result = await runEmbedCore(engine, { stale: true, quiet: true, catchUp, batchSize: 1 });
    expect(result.embedded).toBe(1);
    expect(await nullVectors('notes/healthy')).toBe(0);
    expect(result.failures).toBe(1);
    const samples = result.failure_samples.join(' ');
    expect(samples).toContain('default:images/scan-0001');
    expect(samples).toContain('gbrain embed --stale --images');
    expect(samples).not.toContain('changed, was deleted or lost its projection during this run');
    expect(await chunkRows('images/scan-0001')).toEqual(before);
  });

  test('bounded recovery reaches a repairable page behind a full batch of blocked image pages', async () => {
    for (const slug of ['images/a', 'images/b']) await blockedImagePage(slug);
    await stalePage('notes/repairable');
    await engine.executeRaw("UPDATE pages SET text_projection_revision=NULL WHERE slug='notes/repairable'");
    const result = await prepareEmbeddingProjections(engine, { repair: true, limit: 2, activeSourcesOnly: true });
    expect(result).toEqual({ rebuilt: 1, blocked: 2 });
    expect((await listPendingProjectionPages(engine, { activeSourcesOnly: true })).map(page => [page.slug, page.page_kind]))
      .toEqual([['images/a', 'image'], ['images/b', 'image']]);
    const repaired = await engine.readPageSnapshot('notes/repairable');
    expect(repaired?.page.text_projection_revision).toBe(repaired?.revision);
  });

  test('the source drain (embed-backfill, remediation) embeds healthy pages and stays incomplete', async () => {
    await blockedImagePage('images/scan-0002');
    await stalePage('notes/healthy-source');
    const texts: string[] = [];
    const result = await embedStaleForSource(engine, 'default', {
      embedFn: async values => { texts.push(...values); return values.map(() => new Float32Array(DIMS).fill(0.001)); } });
    expect(result.embedded).toBe(1);
    expect(texts.join(' ')).not.toContain('images/scan-0002');
    expect(result.blocked).toBe(1);
    expect(result.complete).toBe(false);
    expect(await nullVectors('notes/healthy-source')).toBe(0);
  });
});

describe('embed --stale with a projection snapshot that becomes unavailable mid-run (#5804)', () => {
  test('edited pages are counted failures with one batch summary; untouched pages still embed', async () => {
    await stalePage('notes/tagged-mid-run');
    await stalePage('notes/edited-mid-run');
    await stalePage('notes/untouched');
    const result = await runEmbedCore(engine, {
      stale: true, quiet: true,
      assertOwned: once(async tx => {
        await tx.executeRaw("INSERT INTO tags (page_id, tag) SELECT id, 'added-mid-run' FROM pages WHERE slug = $1", ['notes/tagged-mid-run']);
        await tx.executeRaw("UPDATE pages SET compiled_truth = compiled_truth || ' More text.' WHERE slug = $1", ['notes/edited-mid-run']);
      }),
    });

    expect(result.embedded).toBe(1);
    expect(await nullVectors('notes/untouched')).toBe(0);
    expect(await nullVectors('notes/tagged-mid-run')).toBe(1);
    expect(await nullVectors('notes/edited-mid-run')).toBe(1);
    expect(result.failures).toBe(2);
    expect(result.failure_samples).toHaveLength(1);
    const [summary] = result.failure_samples;
    expect(summary).toStartWith('2 page(s) not embedded:');
    expect(summary).toContain('notes/tagged-mid-run');
    expect(summary).toContain('notes/edited-mid-run');
    expect(summary).toContain('rerun gbrain embed --stale');
  });

  test('the summary names five pages and counts the rest', async () => {
    const slugs = Array.from({ length: 7 }, (_, i) => `notes/edited-${i}`);
    for (const slug of slugs) await stalePage(slug);
    const result = await runEmbedCore(engine, {
      stale: true, quiet: true,
      assertOwned: once(async tx => {
        await tx.executeRaw("UPDATE pages SET compiled_truth = compiled_truth || ' More text.' WHERE slug = ANY($1::text[])", [slugs]);
      }),
    });

    expect(result.embedded).toBe(0);
    expect(result.failures).toBe(7);
    expect(result.failure_samples).toHaveLength(1);
    expect(result.failure_samples[0]).toStartWith('7 page(s) not embedded:');
    expect(result.failure_samples[0]).toContain(' and 2 more)');
  });

  test('a page whose source is archived mid-run is counted once, by the archived-work report', async () => {
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', ['archive-example']);
    await stalePage('notes/archived-mid-run', 'archive-example');
    const result = await runEmbedCore(engine, {
      stale: true, quiet: true,
      assertOwned: once(async tx => {
        await tx.executeRaw('UPDATE sources SET archived = true WHERE id = $1', ['archive-example']);
      }),
    });

    expect(result.embedded).toBe(0);
    expect(result.failures).toBe(1);
    expect(result.failure_samples.join('\n')).toContain('1 archived page(s) have blocked embedding work');
    expect(result.failure_samples.join('\n')).not.toContain('not embedded');
  });
});

// F4a review fixes (R4-2/R4-5): the CLI stale drain (commands/embed.ts) keeps lease loss a
// LockStolenError instead of counting it as one page's failure or quietly stopping.
describe('embed --stale lease loss stays a LockStolenError (F4a)', () => {
  test('lease loss while healing a page rejects the run instead of becoming a page failure', async () => {
    await stalePage('notes/heal-lease');
    // The content-drift invalidation swallows its own transactional fence error by design; the heal
    // transaction is the next transactional ownership check, and its failure must propagate.
    await expect(runEmbedCore(engine, {
      stale: true, quiet: true,
      assertOwned: async tx => { if (tx) throw new LockStolenError('embed-backfill:test'); },
    })).rejects.toBeInstanceOf(LockStolenError);
    expect(await nullVectors('notes/heal-lease')).toBe(1);
  });

  test('lease loss recorded as the abort reason inside the content-drift invalidation transaction rejects instead of ending the run quietly', async () => {
    await stalePage('notes/drift-lease');
    const controller = new AbortController();
    await expect(runEmbedCore(engine, {
      stale: true, quiet: true, signal: controller.signal,
      // The first transactional ownership check of a clean stale run is the content-drift invalidation.
      assertOwned: async tx => {
        if (!tx) return;
        const error = new LockStolenError('embed-backfill:test');
        controller.abort(error);
        throw error;
      },
    })).rejects.toBeInstanceOf(LockStolenError);
    expect(await nullVectors('notes/drift-lease')).toBe(1);
  });

  test('lease loss recorded as the abort reason right before the signature stamp commits rejects, leaving the page unstamped', async () => {
    await stalePage('notes/stamp-lease');
    const controller = new AbortController();
    const prototype = Object.getPrototypeOf(engine) as { setPageEmbeddingSignature: (...args: unknown[]) => Promise<unknown> };
    // Own-property override (transaction-bound engines inherit it): the stamp transaction's pre-COMMIT stop check
    // then sees the lease loss. Removed in `finally`.
    (engine as unknown as Record<string, unknown>).setPageEmbeddingSignature = async function (this: unknown, ...args: unknown[]) {
      const done = await prototype.setPageEmbeddingSignature.apply(this, args);
      controller.abort(new LockStolenError('embed-backfill:test'));
      return done;
    };
    try {
      await expect(runEmbedCore(engine, { stale: true, quiet: true, signal: controller.signal })).rejects.toBeInstanceOf(LockStolenError);
    } finally {
      delete (engine as unknown as Record<string, unknown>).setPageEmbeddingSignature;
    }
    const [row] = await engine.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE slug = 'notes/stamp-lease' AND source_id = 'default'`);
    expect(row!.embedding_signature).toBeNull();
  });
});

// F5 review fixes (R5-2/R5-3): lease loss is recognised from the caught LockStolenError itself (a runtime can
// deliver an abort with no reason), and the slice and restamp rethrow points each have a case that aborts with
// a LockStolenError and then fails the step.
describe('embed --stale lease loss detection (F5)', () => {
  test('R5-2: content-drift invalidation: abort with NO reason, then LockStolenError from the fence, still rejects', async () => {
    await stalePage('notes/no-reason-drift');
    const controller = new AbortController();
    await expect(runEmbedCore(engine, {
      stale: true, quiet: true, signal: controller.signal,
      assertOwned: async tx => {
        if (!tx) return;
        controller.abort(); // reason is a plain DOMException, not the LockStolenError
        throw new LockStolenError('embed-backfill:test');
      },
    })).rejects.toBeInstanceOf(LockStolenError);
    expect(controller.signal.reason).not.toBeInstanceOf(LockStolenError);
    expect(await nullVectors('notes/no-reason-drift')).toBe(1);
  });

  test('R5-3: slice catch: lease recorded as the abort reason after the writes, before COMMIT, rejects and rolls the slice back', async () => {
    await stalePage('notes/slice-lease');
    const controller = new AbortController();
    const prototype = Object.getPrototypeOf(engine) as { persistEmbedOutcome: (...args: unknown[]) => Promise<unknown> };
    // Own-property override (transaction-bound engines inherit it); the original runs unbound so it still uses the
    // transaction connection. The pre-COMMIT stop check then sees the lease loss. Removed in `finally`.
    (engine as unknown as Record<string, unknown>).persistEmbedOutcome = async function (this: unknown, ...args: unknown[]) {
      const outcome = await prototype.persistEmbedOutcome.apply(this, args);
      controller.abort(new LockStolenError('embed-backfill:test'));
      return outcome;
    };
    try {
      await expect(runEmbedCore(engine, { stale: true, quiet: true, signal: controller.signal })).rejects.toBeInstanceOf(LockStolenError);
    } finally {
      delete (engine as unknown as Record<string, unknown>).persistEmbedOutcome;
    }
    expect(await nullVectors('notes/slice-lease')).toBe(1);
  });

  test('R5-3: restamp catch: lease recorded as the abort reason, the restamp then fails; committed vectors stay', async () => {
    await stalePage('notes/restamp-lease');
    await engine.updatePageContextualRetrievalState('notes/restamp-lease', 'default', 'per_chunk_synopsis', 'gen-synopsis');
    const controller = new AbortController();
    let restamps = 0;
    // The drain's post-slice restamp is the only caller of this method here. Own-property override, removed in `finally`.
    (engine as unknown as Record<string, unknown>).updatePageContextualRetrievalState = async function () {
      restamps += 1;
      controller.abort(new LockStolenError('embed-backfill:test'));
      throw new Error('restamp failed');
    };
    try {
      await expect(runEmbedCore(engine, { stale: true, quiet: true, signal: controller.signal })).rejects.toBeInstanceOf(LockStolenError);
    } finally {
      delete (engine as unknown as Record<string, unknown>).updatePageContextualRetrievalState;
    }
    expect(restamps).toBe(1);
    expect(await nullVectors('notes/restamp-lease')).toBe(0);
  });
});

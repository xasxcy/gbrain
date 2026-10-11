/**
 * R6-3: the invalid-input bisection must treat a structurally malformed provider response (EmbeddingResponseShapeError:
 * wrong number of vectors or wrong width) from a SUB-request as a per-item result, not as a run-fatal error. Mixed path:
 * the whole batch fails with an invalid-input error, the bisection's sub-request containing the offender then returns a
 * malformed response; the offender is ledgered, its siblings and every LATER page are still embedded. A real
 * configuration fault (401, unknown model) from a sub-request stays fatal.
 *
 * Instance-level only: the provider is an injected embedFn, nothing touches the process-wide gateway or env.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';
import { embedWithTruncationFallbackPartial, type EmbedFn } from '../src/core/embed-fallback.ts';
import { AIConfigError } from '../src/core/ai/errors.ts';
import { EmbeddingResponseShapeError } from '../src/core/ai/embedding-guard.ts';

const DIMS = 1536;
const vec = (): Float32Array => new Float32Array(DIMS).fill(0.25);

/** Deterministic mixed-path provider: a call with >= `fullSize` inputs and an offender fails invalid-input; smaller ones with the offender fail `sub`. */
function provider(fullSize: number, sub: () => Error) {
  const calls: string[][] = [];
  const embedFn: EmbedFn = async (texts) => {
    calls.push([...texts]);
    if (texts.some(text => text.includes('MALFORMED'))) {
      if (texts.length >= fullSize) throw new Error('400 invalid input: one of the inputs is rejected');
      throw sub();
    }
    return texts.map(vec);
  };
  return { calls, embedFn };
}

describe('embedWithTruncationFallbackPartial: bisection sub-request errors', () => {
  const texts = ['fine 0', 'fine 1', 'MALFORMED 2', 'fine 3'];
  for (const shape of ['count', 'width'] as const) {
    test(`invalid-input -> sub-request ${shape} shape error: offender is a per-item failure, siblings keep their vectors, no fatalError`, async () => {
      const { embedFn } = provider(4, () => new EmbeddingResponseShapeError(shape, `malformed ${shape}`));
      const result = await embedWithTruncationFallbackPartial(texts, embedFn, { policy: 'partial-stale', expectedDimensions: DIMS });
      expect(result.fatalError).toBeUndefined();
      expect(result.aborted).toBe(false);
      expect(result.vectors.map(v => v !== null)).toEqual([true, true, false, true]);
      expect(result.failures.map(f => f.index)).toEqual([2]);
      expect(result.failures[0]!.error).toBeInstanceOf(EmbeddingResponseShapeError);
    });
  }

  test('a 64-input slice bisects all the way down to the single offender (no fixed depth cap)', async () => {
    const big = Array.from({ length: 64 }, (_, i) => (i === 37 ? `MALFORMED ${i}` : `fine ${i}`));
    const { embedFn } = provider(64, () => new EmbeddingResponseShapeError('count', 'malformed count'));
    const result = await embedWithTruncationFallbackPartial(big, embedFn, { policy: 'partial-stale', expectedDimensions: DIMS });
    expect(result.fatalError).toBeUndefined();
    expect(result.aborted).toBe(false);
    expect(result.failures.map(f => f.index)).toEqual([37]);
    expect(result.vectors.map((v, i) => (v !== null) === (i !== 37)).every(Boolean)).toBe(true);
  });

  test('an empty input whose provider call fails invalid-input terminates without a fatal (no endless empty bisection)', async () => {
    let calls = 0;
    const embedFn: EmbedFn = async () => { calls++; if (calls > 10) throw new Error('runaway'); throw new Error('400 invalid input: rejected'); };
    const result = await embedWithTruncationFallbackPartial([], embedFn, { policy: 'partial-stale', expectedDimensions: DIMS });
    expect(result.fatalError).toBeUndefined();
    expect(result.vectors).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(calls).toBe(1);
  });

  test('invalid-input -> sub-request 401 stays run-fatal and names every index of the failing group', async () => {
    const { embedFn } = provider(4, () => Object.assign(new AIConfigError('401 Unauthorized: invalid api key'), { status: 401 }));
    const result = await embedWithTruncationFallbackPartial(texts, embedFn, { policy: 'partial-stale', expectedDimensions: DIMS });
    expect(result.fatalError).toBeInstanceOf(AIConfigError);
    expect(result.fatalError).not.toBeInstanceOf(EmbeddingResponseShapeError);
    expect(result.fatalIndexes).toEqual([2, 3]);
    expect(result.vectors.map(v => v !== null)).toEqual([true, true, false, false]); // the group before the fault keeps its vectors
  });
});

describe('embedStaleForSource: invalid-input then a malformed sub-request does not stop the later pages', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  async function seed(slug: string, chunkTexts: string[]): Promise<void> {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body` });
    await installFixtureChunks(engine, slug, chunkTexts.map((chunk_text, i) => ({ chunk_index: i, chunk_text, chunk_source: 'compiled_truth' as const, token_count: 4 })));
  }
  const embeddedSlugs = async () => (await engine.executeRaw<{ slug: string }>(
    `SELECT DISTINCT p.slug FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE c.embedding IS NOT NULL ORDER BY p.slug`)).map(row => row.slug);
  const ledger = () => engine.executeRaw<{ slug: string; chunk_index: number; error_class: string }>(
    'SELECT slug, chunk_index, error_class FROM embed_failures ORDER BY slug, chunk_index');

  for (const shape of ['count', 'width'] as const) {
    test(`${shape}: the bad page comes first at concurrency 1; the page's siblings and every later page are embedded`, async () => {
      await seed('a-bad', ['fine zero', 'MALFORMED one', 'fine two', 'fine three']);
      for (const slug of ['good-1', 'good-2', 'good-3']) await seed(slug, [`fine ${slug}`]);
      const { embedFn, calls } = provider(4, () => new EmbeddingResponseShapeError(shape, `malformed ${shape}`));
      const result = await embedStaleForSource(engine, 'default', { concurrency: 1, embedFn });
      // The bisection really ran: the whole page was sent first, then split.
      expect(calls[0]).toHaveLength(4);
      expect(calls.some(call => call.length === 2 && call.includes('MALFORMED one'))).toBe(true);
      expect(result.aborted).toBe(false);
      expect(await embeddedSlugs()).toEqual(['a-bad', 'good-1', 'good-2', 'good-3']);
      expect(result.embedded).toBe(3 + 3);
      expect(result.remaining).toBe(1);
      expect(await ledger()).toEqual([{ slug: 'a-bad', chunk_index: 1, error_class: 'provider_other' }]);
    });
  }

  test('a 401 from the bisection sub-request still stops the run (nothing after it is embedded)', async () => {
    await seed('a-bad', ['fine zero', 'MALFORMED one', 'fine two', 'fine three']);
    await seed('good-1', ['fine good-1']);
    const { embedFn } = provider(4, () => Object.assign(new AIConfigError('401 Unauthorized: invalid api key'), { status: 401 }));
    await expect(embedStaleForSource(engine, 'default', { concurrency: 1, embedFn })).rejects.toBeInstanceOf(AIConfigError);
    expect(await embeddedSlugs()).not.toContain('good-1');
  });
});

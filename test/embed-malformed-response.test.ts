/**
 * F6 (advisor ruling 3): a provider response that does not line up with the request (wrong number of vectors, wrong
 * vector width) is a per-item failure of THAT call. The stale drain ledgers the chunks of the call (bisecting down to
 * the offender), and the pages after it are still embedded. Before this, the gateway raised both as AIConfigError, the
 * drain treated them as a run-global configuration fault and aborted: with concurrency 1 and the bad page first, no
 * good page was embedded at all (upstream embeds all of them and reports the bad one as remaining).
 *
 * A REAL configuration fault (rejected credentials, no key, unknown model) still stops the whole run, and a plain
 * AIConfigError is still fatal to the classifier. Serial: it owns the process-wide gateway config and transport.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';
import { classifyEmbedFailure } from '../src/core/embed-failure.ts';
import { AIConfigError } from '../src/core/ai/errors.ts';
import { EmbeddingResponseShapeError } from '../src/core/ai/embedding-guard.ts';

const MODEL = 'openai:text-embedding-3-small';
const DIMS = 1536;
const valid = (): number[] => Array(DIMS).fill(0.25);

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  resetGateway();
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'synthetic-only' } });
});
afterEach(() => { __setEmbedTransportForTests(null); });

async function seed(slug: string, texts: string[]): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body` });
  await installFixtureChunks(engine, slug, texts.map((chunk_text, i) => ({ chunk_index: i, chunk_text, chunk_source: 'compiled_truth' as const, token_count: 4 })));
}

/** A transport that answers every call correctly except calls containing `MALFORMED`. */
function transport(malformed: 'width' | 'count' | 'none') {
  return async ({ values }: { values: string[] }) => {
    let embeddings = values.map(valid);
    if (values.some(value => value.includes('MALFORMED'))) {
      if (malformed === 'width') embeddings = values.map(() => [0.25]);
      if (malformed === 'count') embeddings = [...embeddings, valid()];
    }
    return { values, warnings: [], embeddings, usage: { tokens: values.length * 8 } };
  };
}

const embeddedSlugs = async () => (await engine.executeRaw<{ slug: string }>(
  `SELECT DISTINCT p.slug FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE c.embedding IS NOT NULL ORDER BY p.slug`)).map(row => row.slug);
const ledger = () => engine.executeRaw<{ slug: string; chunk_index: number; error_class: string }>(
  'SELECT slug, chunk_index, error_class FROM embed_failures ORDER BY slug, chunk_index');

describe('malformed provider response is a per-item failure', () => {
  for (const malformed of ['width', 'count'] as const) {
    test(`${malformed}: the bad page comes FIRST at concurrency 1 and every later page is still embedded`, async () => {
      await seed('a-bad', ['MALFORMED a-bad']);
      for (const slug of ['good-1', 'good-2', 'good-3', 'good-4']) await seed(slug, [`fine ${slug}`]);
      __setEmbedTransportForTests(transport(malformed));
      const result = await embedStaleForSource(engine, 'default', { concurrency: 1, batchSize: 1 });
      expect(result.aborted).toBe(false);
      expect(result.embedded).toBe(4);
      expect(result.remaining).toBe(1);
      expect(result.complete).toBe(false);
      expect(await embeddedSlugs()).toEqual(['good-1', 'good-2', 'good-3', 'good-4']);
      // The offender is in the retry ledger (backoff), not silently dropped and not an abort.
      expect(await ledger()).toEqual([{ slug: 'a-bad', chunk_index: 0, error_class: 'provider_other' }]);
    });

    test(`${malformed}: inside one page only the offending chunk is ledgered; its siblings are embedded`, async () => {
      await seed('mixed', ['fine zero', 'MALFORMED one', 'fine two']);
      __setEmbedTransportForTests(transport(malformed));
      const result = await embedStaleForSource(engine, 'default', { concurrency: 1 });
      expect(result.aborted).toBe(false);
      expect(result.embedded).toBe(2);
      expect(result.remaining).toBe(1);
      expect(await ledger()).toEqual([{ slug: 'mixed', chunk_index: 1, error_class: 'provider_other' }]);
    });
  }

  test('a real configuration fault (rejected credentials) still stops the whole run', async () => {
    await seed('a-first', ['fine a-first']);
    for (const slug of ['b-second', 'c-third']) await seed(slug, [`fine ${slug}`]);
    __setEmbedTransportForTests(async () => { throw Object.assign(new Error('401 Unauthorized: invalid api key'), { status: 401 }); });
    await expect(embedStaleForSource(engine, 'default', { concurrency: 1, batchSize: 1 })).rejects.toBeInstanceOf(AIConfigError);
    expect(await embeddedSlugs()).toEqual([]);
    expect(await ledger()).toEqual([]);
  });
});

describe('classifyEmbedFailure', () => {
  test('response-shape errors are per-item provider failures; other config errors stay fatal', () => {
    for (const shape of ['count', 'width'] as const) {
      const error = new EmbeddingResponseShapeError(shape, `shape ${shape}`);
      // Still an AIConfigError (and still named so) for callers that cannot salvage a partial result.
      expect(error).toBeInstanceOf(AIConfigError);
      expect(error.name).toBe('AIConfigError');
      expect(classifyEmbedFailure(error)).toEqual({ kind: 'failure', errorClass: 'provider_other' });
    }
    expect(classifyEmbedFailure(new AIConfigError('no api key'))).toEqual({ kind: 'fatal' });
    expect(classifyEmbedFailure(Object.assign(new AIConfigError('unauthorized'), { status: 401 }))).toEqual({ kind: 'fatal' });
  });
});

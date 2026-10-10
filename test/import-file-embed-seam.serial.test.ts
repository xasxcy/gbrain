/**
 * P2B — markdown import inline-embed seam.
 *
 * Hermetic: the embedding module is mocked before importing import-file.ts;
 * the engine is an in-memory PGLite brain. Upstream's import path runs through
 * revision-bound projections and transaction settings (executeRaw row reads), which a
 * null-returning Proxy recorder can no longer model, so the seam is exercised against
 * the real engine. No gateway or network is used.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { _registeredShutdownWorkCountForTests, _resetForTests } from '../src/core/process-cleanup.ts';
import { waitFor } from './helpers/wait-for.ts';

let embedCalls: string[][] = [];
let embedImpl = async (texts: string[]): Promise<Float32Array[]> => {
  if (texts.length > 1) throw new Error('read EOF while waiting for response from llama-server');
  return texts.map(() => new Float32Array(1536));
};

mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => {
    embedCalls.push(texts);
    return embedImpl(texts);
  },
  embedMultimodal: async () => {
    throw new Error('embedMultimodal not used by this test');
  },
  currentEmbeddingSignature: () => 'test:model:1536',
}));

const { importFromContent } = await import('../src/core/import-file.ts');
const { isOllamaOomLikeError } = await import('../src/core/embed-fallback.ts');

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

afterEach(() => {
  _resetForTests();
});

// >300 words so the real recursive chunker (300-word target) splits this
// into 2 chunks — required to reproduce the batch-of-2 EOF failure.
const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(60);

describe('markdown import inline-embed fallback (import-file.ts:707 seam)', () => {
  test('batch EOF on inline import embed falls back to per-chunk retry instead of aborting the import', async () => {
    embedCalls = [];
    embedImpl = async (texts) => {
      if (texts.length > 1) throw new Error('read EOF while waiting for response from llama-server');
      return texts.map(() => new Float32Array(1536));
    };

    const result = await importFromContent(engine, 'seam-test-page', LOREM, { sourceId: 'default' });

    expect(result.status).toBe('imported');
    expect(result.chunks).toBe(2);
    const rows = await engine.executeRaw<{ has_embedding: boolean }>(
      `SELECT embedding IS NOT NULL AS has_embedding FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = 'seam-test-page' AND p.source_id = 'default' ORDER BY cc.chunk_index`,
    );
    expect(rows).toEqual([{ has_embedding: true }, { has_embedding: true }]);
    expect(embedCalls.map((call) => call.length)).toEqual([2, 1, 1]);
  });

  test('isOllamaOomLikeError classifies the production socket-closed error text', () => {
    const err = new Error('Cannot connect to API: The socket connection was closed unexpectedly');
    expect(isOllamaOomLikeError(err)).toBe(true);
  });

  // Default ruling (2), pending user confirmation: an ordinary provider failure
  // (even one shaped like an AbortError, while no shutdown signal fired) follows
  // upstream's contract: the text is saved and its vectors are deferred to
  // `gbrain embed --stale`. Shutdown/cancel is covered by the registration tests below.
  test('inline-import saves text and defers vectors when the provider raises an AbortError-shaped failure', async () => {
    embedCalls = [];
    const abortError = new DOMException('aborted', 'AbortError');
    embedImpl = async (texts) => {
      if (texts.length > 1) throw new Error('EOF');
      throw abortError;
    };
    const result = await importFromContent(engine, 'seam-abort', LOREM, { sourceId: 'default' });
    expect(result.status).toBe('imported');
    expect(result.embedding_deferred).toBe(true);
    const rows = await engine.executeRaw<{ has_embedding: boolean }>(
      `SELECT (cc.embedding IS NOT NULL) AS has_embedding FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = 'seam-abort' AND p.source_id = 'default' ORDER BY cc.chunk_index`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(row => row.has_embedding === false)).toBe(true);
    expect(embedCalls.map((call) => call.length)).toEqual([2, 1]);
  });
});

test('inline embedding remains registered until its canonical transaction can commit', async () => {
  embedImpl = async (texts) => texts.map(() => new Float32Array(1536));
  const enteredCommit = Promise.withResolvers<void>();
  const releaseCommit = Promise.withResolvers<void>();
  const importing = importFromContent(engine, 'shutdown/inline', 'Inline text.', {
    sourceId: 'default',
    beforeCommit: async () => {
      enteredCommit.resolve();
      await releaseCommit.promise;
    },
  });
  await enteredCommit.promise;
  expect(_registeredShutdownWorkCountForTests()).toBe(1);
  releaseCommit.resolve();
  await importing;
  expect(_registeredShutdownWorkCountForTests()).toBe(0);
});

test('deferred embedding remains registered until its final installation transaction commits', async () => {
  embedImpl = async (texts) => texts.map(() => new Float32Array(1536));
  let complete: (() => Promise<{ status: 'embedded' | 'failed' | 'superseded'; error?: string }>) | undefined;
  await importFromContent(engine, 'shutdown/deferred', 'Deferred text.', {
    sourceId: 'default',
    onPostCommitEmbedding: callback => { complete = callback; },
  });
  expect(complete).toBeDefined();

  const transaction = engine.transaction.bind(engine);
  const enteredInstall = Promise.withResolvers<void>();
  const releaseInstall = Promise.withResolvers<void>();
  let holdNextTransaction = true;
  engine.transaction = async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => transaction(async tx => {
    if (holdNextTransaction) {
      holdNextTransaction = false;
      enteredInstall.resolve();
      await releaseInstall.promise;
    }
    return fn(tx);
  });
  try {
    const completing = complete!();
    await enteredInstall.promise;
    await waitFor(() => _registeredShutdownWorkCountForTests() === 1, { label: 'deferred installation registration' });
    releaseInstall.resolve();
    await expect(completing).resolves.toEqual({ status: 'embedded' });
    expect(_registeredShutdownWorkCountForTests()).toBe(0);
  } finally {
    engine.transaction = transaction;
  }
});

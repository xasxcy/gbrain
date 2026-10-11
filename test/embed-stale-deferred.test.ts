/**
 * F3 review fixes (N1/N3/N4/N6/N7): the deferred-only drain verdict, driven
 * through the REAL embedStaleForSource on PGLite (no runStale mock).
 *
 * A source whose only incomplete chunks sit in the retry ledger (backoff or
 * quarantine) is `deferred`: not success, not an ordinary failure, and it must
 * not spend a provider health probe. The verdict is reached only AFTER the
 * maintenance steps (signature/content-drift invalidation) ran.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { embedStaleForSource, EMBED_PROBE_TEXT } from '../src/core/embed-stale.ts';
import { LockStolenError } from '../src/core/db-lock.ts';
import { createNoopPacer } from '../src/core/db-pacer.ts';

let engine: PGLiteEngine;
const SIGNATURE = 'test:model:1536';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function seedPage(slug: string, texts: string[]): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\nseeded` });
  await installFixtureChunks(engine, slug, texts.map((chunk_text, chunk_index) => ({
    chunk_index, chunk_text, chunk_source: 'compiled_truth', token_count: 4, embedding: undefined,
  })));
}

/** Put one chunk into the retry ledger, backing off until `retryAt` or quarantined. */
async function ledger(slug: string, chunkIndex: number, state: { retryAt: Date } | { quarantined: true }): Promise<void> {
  const [row] = await engine.executeRaw<{ page_id: number; chunk_hash: string }>(
    `SELECT cc.page_id, md5(cc.chunk_text) AS chunk_hash FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = $1 AND p.source_id = 'default' AND cc.chunk_index = $2`, [slug, chunkIndex]);
  const quarantined = 'quarantined' in state;
  const now = new Date();
  const retryAt = quarantined ? new Date(now.getTime() + 3_600_000) : state.retryAt;
  await engine.executeRaw(
    `INSERT INTO embed_failures
      (source_id, page_id, slug, chunk_index, embedding_signature, chunk_hash, error_class, error_fingerprint, first_seen, last_seen, next_retry_at, quarantined_at, quarantine_reason)
     VALUES ('default', $1, $2, $3, $4, $5, 'provider_timeout', 'fp', $6, $6, $7, $8, $9)`,
    [row!.page_id, slug, chunkIndex, SIGNATURE, row!.chunk_hash, now.toISOString(), retryAt.toISOString(),
      quarantined ? now.toISOString() : null, quarantined ? 'provider_timeout' : null]);
}

const vec = () => new Float32Array(1536).fill(0.01);

function recordingEmbed() {
  const calls: string[][] = [];
  return { calls, embedFn: async (texts: string[]) => { calls.push(texts); return texts.map(vec); } };
}

describe('deferred-only drain verdict (F3 N7)', () => {
  test('only backoff-deferred chunks: deferred, earliest_retry_at, no provider call at all', async () => {
    await seedPage('p', ['a', 'b']);
    const early = new Date(Date.now() + 600_000);
    const late = new Date(Date.now() + 7_200_000);
    await ledger('p', 0, { retryAt: late });
    await ledger('p', 1, { retryAt: early });
    const { calls, embedFn } = recordingEmbed();
    const result = await embedStaleForSource(engine, 'default', { embeddingSignature: SIGNATURE, embedFn });
    expect(result).toMatchObject({ deferred: true, done: true, complete: false, remaining: 2, embedded: 0, aborted: false });
    expect(result.failureSummary!.counts).toEqual({ total_null: 2, eligible_now: 0, backoff_deferred: 2, quarantined: 0 });
    expect(result.failureSummary!.earliest_retry_at!.getTime()).toBe(early.getTime());
    expect(calls).toEqual([]); // not even the health probe
  });

  test('only quarantined chunks: deferred with the quarantine count and no earliest retry', async () => {
    await seedPage('q', ['a', 'b']);
    await ledger('q', 0, { quarantined: true });
    await ledger('q', 1, { quarantined: true });
    const { calls, embedFn } = recordingEmbed();
    const result = await embedStaleForSource(engine, 'default', { embeddingSignature: SIGNATURE, embedFn });
    expect(result).toMatchObject({ deferred: true, done: true, complete: false, remaining: 2, embedded: 0 });
    expect(result.failureSummary!.counts).toEqual({ total_null: 2, eligible_now: 0, backoff_deferred: 0, quarantined: 2 });
    expect(result.failureSummary!.earliest_retry_at).toBeNull();
    expect(calls).toEqual([]);
  });

  test('eligible mixed with deferred: only the eligible chunk is embedded, then the leftover is deferred (not an incomplete failure)', async () => {
    await seedPage('m', ['eligible', 'backoff', 'quarantined']);
    const retryAt = new Date(Date.now() + 600_000);
    await ledger('m', 1, { retryAt });
    await ledger('m', 2, { quarantined: true });
    const { calls, embedFn } = recordingEmbed();
    const result = await embedStaleForSource(engine, 'default', { embeddingSignature: SIGNATURE, embedFn });
    expect(calls).toEqual([['eligible']]);
    expect(result).toMatchObject({ embedded: 1, done: true, complete: false, deferred: true, remaining: 2 });
    expect(result.failureSummary!.counts).toEqual({ total_null: 2, eligible_now: 0, backoff_deferred: 1, quarantined: 1 });
    expect(result.failureSummary!.earliest_retry_at!.getTime()).toBe(retryAt.getTime());
  });

  test('an eligible chunk left behind is never reported as deferred', async () => {
    await seedPage('e', ['a', 'b']);
    await ledger('e', 1, { retryAt: new Date(Date.now() + 600_000) });
    // Resume cursor past chunk 0: the eligible chunk is not visited by this call.
    const { embedFn } = recordingEmbed();
    const result = await embedStaleForSource(engine, 'default', {
      embeddingSignature: SIGNATURE, embedFn, cursor: { afterPageId: 1_000_000, afterChunkIndex: 0 },
    });
    expect(result.deferred).toBeUndefined();
    expect(result).toMatchObject({ done: true, complete: false, remaining: 2 });
  });

  test('a completed sibling on an unstamped page is not counted as remaining', async () => {
    await seedPage('s', ['a', 'b', 'c']);
    await ledger('s', 2, { quarantined: true });
    await engine.setPageEmbeddingSignature('s', { signature: 'old:model:1536' });
    const { embedFn } = recordingEmbed();
    const result = await embedStaleForSource(engine, 'default', { embeddingSignature: SIGNATURE, embedFn });
    expect(result).toMatchObject({ deferred: true, remaining: 1 });
    expect(result.failureSummary!.counts.total_null).toBe(1);
  });

  // Parameterised over the drift size: the drift probe compares a signature-wide count with a
  // NULL-only count, so ledgered NULL chunks must not offset equal or larger drift.
  for (const driftChunks of [1, 2, 3]) test(`N1: drift invalidation and repair still run when ${driftChunks} drifted chunk(s) sit beside one quarantined NULL chunk`, async () => {
    await seedPage('drifted', Array.from({ length: driftChunks }, (_, i) => `x${i}`));
    await engine.executeRaw(
      `UPDATE content_chunks SET embedding = ('[' || array_to_string(array_fill(0.0::real, ARRAY[1536]), ',') || ']')::vector
        WHERE page_id = (SELECT id FROM pages WHERE slug = 'drifted' AND source_id = 'default')`);
    await engine.setPageEmbeddingSignature('drifted', { signature: 'old:model:1536' });
    await seedPage('toxic', ['bad']);
    await ledger('toxic', 0, { quarantined: true });
    const { calls, embedFn } = recordingEmbed();
    const result = await embedStaleForSource(engine, 'default', { embeddingSignature: SIGNATURE, embedFn });
    expect(calls[0]).toEqual([EMBED_PROBE_TEXT]); // drift exists, so the probe is legitimate
    expect(result.invalidated).toBe(driftChunks);
    expect(result.embedded).toBe(driftChunks);
    expect(result).toMatchObject({ deferred: true, remaining: 1, aborted: false });
    expect(await engine.countStaleChunks({ sourceId: 'default', ignoreBackoff: true })).toBe(1);
  });
});

describe('degraded drift handling keeps the honesty gate (F3 N6)', () => {
  test('a failed drift probe leaves un-invalidated drifted vectors as unfinished work: incomplete, never deferred or complete', async () => {
    await seedPage('drifted-only', ['x']);
    await engine.executeRaw(
      `UPDATE content_chunks SET embedding = ('[' || array_to_string(array_fill(0.0::real, ARRAY[1536]), ',') || ']')::vector`);
    await engine.setPageEmbeddingSignature('drifted-only', { signature: 'old:model:1536' });
    const result = await embedStaleForSource(engine, 'default', {
      embeddingSignature: SIGNATURE, embedFn: async () => { throw new Error('provider down'); },
    });
    expect(result).toMatchObject({ invalidationSkipped: 'embedder_probe_failed', complete: false, remaining: 1, done: true });
    expect(result.deferred).toBeUndefined();
  });
});

describe('control-flow fences (F3 N3/N4/N8)', () => {
  test('N3: lease loss while healing a page rejects the drain instead of becoming a page failure', async () => {
    await seedPage('heal', ['a']);
    await expect(embedStaleForSource(engine, 'default', {
      embedFn: async texts => texts.map(vec),
      // The content-drift invalidation swallows its own fence error by design;
      // the heal transaction is the next transactional ownership check.
      assertOwned: async tx => { if (tx) throw new LockStolenError('embed-backfill:test'); },
    })).rejects.toBeInstanceOf(LockStolenError);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);
  });

  test('N4: lease loss recorded as the abort reason is not reported as an ordinary abort', async () => {
    await seedPage('lease', ['a']);
    const controller = new AbortController();
    await expect(embedStaleForSource(engine, 'default', {
      signal: controller.signal,
      embedFn: async texts => { controller.abort(new LockStolenError('embed-backfill:test')); return texts.map(vec); },
    })).rejects.toBeInstanceOf(LockStolenError);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);
  });

  test('N8: cancellation rolls the whole slice back (vectors already computed in it are discarded) and maps to aborted', async () => {
    await seedPage('slice', ['a', 'b']);
    const controller = new AbortController();
    const result = await embedStaleForSource(engine, 'default', {
      signal: controller.signal,
      embedFn: async texts => { controller.abort(); return texts.map(vec); },
    });
    expect(result).toMatchObject({ aborted: true, embedded: 0, done: false });
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(2);
  });

  test('N4: a stop requested after the writes but before COMMIT still rolls the slice back', async () => {
    await seedPage('precommit', ['a', 'b']);
    const controller = new AbortController();
    const prototype = Object.getPrototypeOf(engine) as { persistEmbedOutcome: (...args: unknown[]) => Promise<unknown> };
    // Own-property override on the engine (transaction-bound engines inherit it); the original
    // runs unbound so it still uses the transaction connection. Removed in `finally`.
    (engine as unknown as Record<string, unknown>).persistEmbedOutcome = async function (this: unknown, ...args: unknown[]) {
      const outcome = await prototype.persistEmbedOutcome.apply(this, args);
      controller.abort(); // the vectors are written inside the transaction; only the pre-COMMIT check remains
      return outcome;
    };
    try {
      const result = await embedStaleForSource(engine, 'default', {
        signal: controller.signal,
        embedFn: async texts => texts.map(vec),
      });
      expect(result).toMatchObject({ aborted: true, embedded: 0 });
    } finally {
      delete (engine as unknown as Record<string, unknown>).persistEmbedOutcome;
    }
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(2);
  });

  test('N8: an AbortError that is not backed by a fired signal or deadline is not mapped to aborted', async () => {
    await seedPage('spurious', ['a']);
    const spurious = Object.assign(new Error('spurious'), { name: 'AbortError' });
    let armed = false;
    // The commit fence throws an AbortError-named error although no signal fired and no deadline passed.
    await expect(embedStaleForSource(engine, 'default', {
      embedFn: async texts => { armed = true; return texts.map(vec); },
      assertOwned: async tx => { if (tx && armed) throw spurious; },
    })).rejects.toBe(spurious);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);
  });

  test('N4: a deadline that expires before the write fence rolls the slice back', async () => {
    await seedPage('deadline', ['a']);
    const result = await embedStaleForSource(engine, 'default', {
      deadline: Date.now() + 1_500,
      // The provider outlives the lease deadline; the commit fence must refuse the write.
      embedFn: async texts => { await new Promise(resolve => setTimeout(resolve, 1_800)); return texts.map(vec); },
    });
    expect(result).toMatchObject({ aborted: true, embedded: 0 });
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);
  });
});

// F4a review fixes (R4-2): lease loss reaches the drain as the stop signal's reason (the owner's
// assertOwned aborts with a LockStolenError, then throws). Every catch that used to map a stop to
// `aborted` must re-raise it.
describe('lease loss stays a LockStolenError on every catch path (F4a R4-2)', () => {
  /** assertOwned that records the loss as the signal reason first, then throws, inside any transaction. */
  const loseLeaseInTx = (controller: AbortController) => async (tx?: unknown) => {
    if (!tx) return;
    const error = new LockStolenError('embed-backfill:test');
    controller.abort(error);
    throw error;
  };

  test('signature-invalidation transaction: abort-then-throw rejects instead of returning aborted', async () => {
    await seedPage('sig-drift', ['x']);
    await engine.executeRaw(
      `UPDATE content_chunks SET embedding = ('[' || array_to_string(array_fill(0.0::real, ARRAY[1536]), ',') || ']')::vector`);
    await engine.setPageEmbeddingSignature('sig-drift', { signature: 'old:model:1536' });
    const controller = new AbortController();
    const { embedFn } = recordingEmbed();
    await expect(embedStaleForSource(engine, 'default', {
      embeddingSignature: SIGNATURE, embedFn, signal: controller.signal, assertOwned: loseLeaseInTx(controller),
    })).rejects.toBeInstanceOf(LockStolenError);
    // The rolled-back invalidation left the old vector in place.
    expect(await engine.countStaleChunks({ sourceId: 'default', ignoreBackoff: true })).toBe(0);
  });

  test('content-drift invalidation transaction: abort-then-throw rejects instead of returning aborted', async () => {
    await seedPage('content-drift', ['x']);
    const controller = new AbortController();
    const { calls, embedFn } = recordingEmbed();
    await expect(embedStaleForSource(engine, 'default', {
      embedFn, signal: controller.signal, assertOwned: loseLeaseInTx(controller),
    })).rejects.toBeInstanceOf(LockStolenError);
    expect(calls).toEqual([]);
  });

  test('signature stamp: lease recorded as the abort reason right before the stamp commits rejects and leaves the page unstamped', async () => {
    await seedPage('stamp', ['a']);
    const controller = new AbortController();
    const prototype = Object.getPrototypeOf(engine) as { setPageEmbeddingSignature: (...args: unknown[]) => Promise<unknown> };
    // Own-property override (transaction-bound engines inherit it); the stamp transaction's pre-COMMIT
    // stop check then sees the lease loss. Removed in `finally`.
    (engine as unknown as Record<string, unknown>).setPageEmbeddingSignature = async function (this: unknown, ...args: unknown[]) {
      const done = await prototype.setPageEmbeddingSignature.apply(this, args);
      controller.abort(new LockStolenError('embed-backfill:test'));
      return done;
    };
    try {
      await expect(embedStaleForSource(engine, 'default', {
        embeddingSignature: SIGNATURE, signal: controller.signal, embedFn: async texts => texts.map(vec),
      })).rejects.toBeInstanceOf(LockStolenError);
    } finally {
      delete (engine as unknown as Record<string, unknown>).setPageEmbeddingSignature;
    }
    const [row] = await engine.executeRaw<{ embedding_signature: string | null }>(
      `SELECT embedding_signature FROM pages WHERE slug = 'stamp' AND source_id = 'default'`);
    expect(row!.embedding_signature).toBeNull();
  });

  test('a plain abort on the same stamp path is still reported as aborted (not every stop is lease loss)', async () => {
    await seedPage('stamp-plain', ['a']);
    const controller = new AbortController();
    const prototype = Object.getPrototypeOf(engine) as { setPageEmbeddingSignature: (...args: unknown[]) => Promise<unknown> };
    (engine as unknown as Record<string, unknown>).setPageEmbeddingSignature = async function (this: unknown, ...args: unknown[]) {
      const done = await prototype.setPageEmbeddingSignature.apply(this, args);
      controller.abort();
      return done;
    };
    try {
      const result = await embedStaleForSource(engine, 'default', {
        embeddingSignature: SIGNATURE, signal: controller.signal, embedFn: async texts => texts.map(vec),
      });
      expect(result.aborted).toBe(true);
    } finally {
      delete (engine as unknown as Record<string, unknown>).setPageEmbeddingSignature;
    }
  });
});


// F5 review fixes (R5-2/R5-3): lease loss is recognised from the caught LockStolenError itself, not only
// from the stop signal's reason (a runtime can deliver an abort with no reason), and every rethrow point
// has a case that aborts with a LockStolenError and then fails the step.
describe('lease loss detection does not depend on the signal reason (F5 R5-2)', () => {
  test('content-drift invalidation: abort with NO reason, then LockStolenError from the fence, still rejects', async () => {
    await seedPage('no-reason-drift', ['x']);
    const controller = new AbortController();
    const { calls, embedFn } = recordingEmbed();
    await expect(embedStaleForSource(engine, 'default', {
      embedFn, signal: controller.signal,
      assertOwned: async tx => {
        if (!tx) return;
        controller.abort(); // reason is a plain DOMException, not the LockStolenError
        throw new LockStolenError('embed-backfill:test');
      },
    })).rejects.toBeInstanceOf(LockStolenError);
    expect(controller.signal.reason).not.toBeInstanceOf(LockStolenError);
    expect(calls).toEqual([]);
  });

  test('signature invalidation: abort with NO reason, then LockStolenError from the fence, still rejects', async () => {
    await seedPage('no-reason-sig', ['x']);
    await engine.executeRaw(
      `UPDATE content_chunks SET embedding = ('[' || array_to_string(array_fill(0.0::real, ARRAY[1536]), ',') || ']')::vector`);
    await engine.setPageEmbeddingSignature('no-reason-sig', { signature: 'old:model:1536' });
    const controller = new AbortController();
    let aborted = false;
    await expect(embedStaleForSource(engine, 'default', {
      embeddingSignature: SIGNATURE, embedFn: async texts => texts.map(vec), signal: controller.signal,
      assertOwned: async tx => {
        // The first transaction of a drifted run is the signature invalidation.
        if (!tx || aborted) return;
        aborted = true;
        controller.abort();
        throw new LockStolenError('embed-backfill:test');
      },
    })).rejects.toBeInstanceOf(LockStolenError);
    expect(controller.signal.reason).not.toBeInstanceOf(LockStolenError);
    // The rolled-back invalidation left the old vector in place.
    expect(await engine.countStaleChunks({ sourceId: 'default', ignoreBackoff: true })).toBe(0);
  });
});

describe('every rethrow point keeps lease loss a LockStolenError (F5 R5-3)', () => {
  test('heal catch: lease recorded as the abort reason inside the heal transaction, the step then fails with an abort', async () => {
    await seedPage('heal-abort', ['a']);
    const controller = new AbortController();
    let txChecks = 0;
    const { calls, embedFn } = recordingEmbed();
    await expect(embedStaleForSource(engine, 'default', {
      embedFn, signal: controller.signal,
      assertOwned: async tx => {
        // Transactional checks: content-drift invalidation (start, end), then the heal transaction (start).
        if (tx && ++txChecks === 3) controller.abort(new LockStolenError('embed-backfill:test'));
      },
    })).rejects.toBeInstanceOf(LockStolenError);
    expect(txChecks).toBe(3);
    expect(calls).toEqual([]);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(1);
  });

  test('restamp catch: lease recorded as the abort reason, the restamp then fails; committed vectors stay', async () => {
    await seedPage('restamp-abort', ['a', 'b']);
    await engine.updatePageContextualRetrievalState('restamp-abort', 'default', 'per_chunk_synopsis', 'gen-synopsis');
    const controller = new AbortController();
    let restamps = 0;
    // The drain's post-slice restamp is the only caller of this method here. Own-property override,
    // removed in `finally`.
    (engine as unknown as Record<string, unknown>).updatePageContextualRetrievalState = async function () {
      restamps += 1;
      controller.abort(new LockStolenError('embed-backfill:test'));
      throw new Error('restamp failed');
    };
    try {
      await expect(embedStaleForSource(engine, 'default', {
        signal: controller.signal, embedFn: async texts => texts.map(vec),
      })).rejects.toBeInstanceOf(LockStolenError);
    } finally {
      delete (engine as unknown as Record<string, unknown>).updatePageContextualRetrievalState;
    }
    expect(restamps).toBe(1);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
  });

  test('worker join: lease recorded as the abort reason after the last page, with no catch on the way, still rejects', async () => {
    await seedPage('join-abort', ['a']);
    const controller = new AbortController();
    const pacer = createNoopPacer();
    // The only code that runs between the page finishing and the workers joining.
    pacer.pace = async () => { controller.abort(new LockStolenError('embed-backfill:test')); };
    await expect(embedStaleForSource(engine, 'default', {
      signal: controller.signal, pacer, embedFn: async texts => texts.map(vec),
    })).rejects.toBeInstanceOf(LockStolenError);
    expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
  });

  test('control: the same worker-join abort with an ordinary reason is still reported as aborted', async () => {
    await seedPage('join-plain', ['a']);
    const controller = new AbortController();
    const pacer = createNoopPacer();
    pacer.pace = async () => { controller.abort(); };
    const result = await embedStaleForSource(engine, 'default', {
      signal: controller.signal, pacer, embedFn: async texts => texts.map(vec),
    });
    expect(result.aborted).toBe(true);
  });
});

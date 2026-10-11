/**
 * FORK: PostgresEngine.connect() issues no PGroonga probe query (a borrower of an in-flight
 * module-singleton create must not wait on, or dial beside, the owner's unverified pool; see
 * test/postgres-engine-singleton-lifecycle.test.ts). connect() arms the probe and the first keyword
 * search runs it once, before it picks the PGroonga or tsvector SQL.
 */
import { describe, expect, test } from 'bun:test';
import { makeEngineWithFake } from './helpers/postgres-engine-sql-cases.ts';
import { probePgroongaExtension } from '../src/core/postgres-engine/pgroonga-probe.ts';

const probes = (fake: { statements(): Array<{ text: string }> }) =>
  fake.statements().filter(s => /FROM pg_extension WHERE extname = 'pgroonga'/.test(s.text)).length;

describe('deferred PGroonga probe', () => {
  test('an armed probe runs once, on the first keyword search, and selects the PGroonga SQL', async () => {
    const { engine, fake } = makeEngineWithFake([[/FROM pg_extension WHERE extname = 'pgroonga'/, [{ '?column?': 1 }]]]);
    engine._pgroongaProbeArmed = true;
    expect(probes(fake)).toBe(0);
    await Promise.all([engine.searchKeyword('alice'), engine.searchKeywordChunks('alice')]);
    await engine.searchKeyword('alice');
    expect(probes(fake)).toBe(1);
    const search = fake.statements().filter(s => /FROM content_chunks cc/.test(s.text));
    expect(search.length).toBeGreaterThan(0);
    for (const s of search) expect(s.text).toContain('&@~');
  });

  test('without an armed probe (no connect) a keyword search issues no probe and keeps the tsvector SQL', async () => {
    const { engine, fake } = makeEngineWithFake();
    await engine.searchKeyword('alice');
    expect(probes(fake)).toBe(0);
    for (const s of fake.statements().filter(x => /FROM content_chunks cc/.test(x.text))) expect(s.text).not.toContain('&@~');
  });

  test('a failing probe downgrades to tsvector instead of failing the search', async () => {
    const { engine, fake } = makeEngineWithFake([[/FROM pg_extension WHERE extname = 'pgroonga'/, () => { throw new Error('boom'); }]]);
    engine._pgroongaProbeArmed = true;
    await expect(engine.searchKeyword('alice')).resolves.toBeDefined();
    expect(probes(fake)).toBe(1);
  });
});

/**
 * R6-4: "the query succeeded and the extension is absent" is a definitive answer and is cached; "the probe itself
 * failed" (error or timeout) is not. A failed probe falls back to tsvector, is not repeated inside the backoff, and is
 * retried once the backoff has elapsed, so a transient outage on the first search cannot pin the instance to tsvector.
 */
describe('PGroonga probe failure backoff', () => {
  const PROBE = /FROM pg_extension WHERE extname = 'pgroonga'/;
  const usesPgroonga = (fake: { statements(): Array<{ text: string }> }) =>
    fake.statements().filter(s => /FROM content_chunks cc/.test(s.text)).some(s => s.text.includes('&@~'));
  const mark = (fake: { statements(): Array<{ text: string }> }) => fake.statements().length;

  function armed(rule: unknown) {
    const { engine, fake } = makeEngineWithFake([[PROBE, rule as never]]);
    let now = 1_000_000;
    engine._pgroongaNow = () => now;
    engine._pgroongaProbeArmed = true;
    return { engine, fake, advance: (ms: number) => { now += ms; }, retryMs: () => engine._pgroongaRetryMs as number };
  }

  test('a failed probe is not repeated inside the backoff; after it, a successful probe restores PGroonga', async () => {
    let failing = true;
    const { engine, fake, advance, retryMs } = armed(() => { if (failing) throw new Error('connection reset'); return [{ '?column?': 1 }]; });
    await engine.searchKeyword('alice');
    expect(probes(fake)).toBe(1);
    expect(usesPgroonga(fake)).toBe(false);
    // Inside the backoff window: several searches (also concurrent ones), still one probe, still tsvector.
    advance(retryMs() - 1);
    await Promise.all([engine.searchKeyword('alice'), engine.searchKeywordChunks('alice'), engine.searchKeyword('bob')]);
    expect(probes(fake)).toBe(1);
    expect(usesPgroonga(fake)).toBe(false);
    // The database recovers and the backoff elapses: the next search re-probes (once, shared) and uses PGroonga.
    failing = false;
    advance(2);
    const before = mark(fake);
    await Promise.all([engine.searchKeyword('alice'), engine.searchKeywordChunks('alice')]);
    expect(probes(fake)).toBe(2);
    expect(fake.statements().slice(before).filter(s => /FROM content_chunks cc/.test(s.text)).every(s => s.text.includes('&@~'))).toBe(true);
    // Resolved for good: no further probes however much time passes.
    advance(10 * retryMs());
    await engine.searchKeyword('alice');
    expect(probes(fake)).toBe(2);
  });

  test('a probe that keeps failing is retried once per backoff window, not on every search', async () => {
    const { engine, fake, advance, retryMs } = armed(() => { throw new Error('still down'); });
    await engine.searchKeyword('alice');
    advance(retryMs());
    await engine.searchKeyword('alice');
    await engine.searchKeyword('alice');
    expect(probes(fake)).toBe(2);
    advance(retryMs() - 1);
    await engine.searchKeyword('alice');
    expect(probes(fake)).toBe(2);
    advance(1);
    await engine.searchKeyword('alice');
    expect(probes(fake)).toBe(3);
  });

  test('an extension that is genuinely absent is cached as unavailable and never probed again', async () => {
    const { engine, fake, advance, retryMs } = armed(() => []);
    await engine.searchKeyword('alice');
    advance(100 * retryMs());
    await engine.searchKeyword('alice');
    await engine.searchKeywordChunks('alice');
    expect(probes(fake)).toBe(1);
    expect(usesPgroonga(fake)).toBe(false);
  });

  test('a probe that hangs times out on its own short deadline, counts as failed and the search still completes', async () => {
    const { engine, fake, advance, retryMs } = armed(() => new Promise(() => {}));
    engine._pgroongaProbeTimeoutMs = 25;
    const started = Date.now();
    await expect(engine.searchKeyword('alice')).resolves.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(probes(fake)).toBe(1);
    expect(usesPgroonga(fake)).toBe(false);
    await engine.searchKeyword('alice');
    expect(probes(fake)).toBe(1); // inside the backoff
    advance(retryMs());
    await engine.searchKeyword('alice');
    expect(probes(fake)).toBe(2);
  });
});

describe('probePgroongaExtension: timeout cancel', () => {
  test('a cancel that rejects asynchronously (cancel connection failed) is swallowed; the probe still reports failed', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      let cancels = 0;
      const hung = Object.assign(new Promise<ArrayLike<unknown>>(() => {}), {
        cancel: () => { cancels++; return Promise.reject(new Error('cancel connection refused')); },
      });
      expect(await probePgroongaExtension(() => hung, 20)).toBe('failed');
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(cancels).toBe(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

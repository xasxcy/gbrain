/**
 * FORK: PostgresEngine.connect() issues no PGroonga probe query (a borrower of an in-flight
 * module-singleton create must not wait on, or dial beside, the owner's unverified pool; see
 * test/postgres-engine-singleton-lifecycle.test.ts). connect() arms the probe and the first keyword
 * search runs it once, before it picks the PGroonga or tsvector SQL.
 */
import { describe, expect, test } from 'bun:test';
import { makeEngineWithFake } from './helpers/postgres-engine-sql-cases.ts';

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

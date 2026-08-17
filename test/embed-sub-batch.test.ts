import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { resolveEmbedSubBatchSize } from '../src/core/embed-slices.ts';

// T1b (2026-08-17): the local dev .env now sets GBRAIN_EMBED_SUBBATCH_SIZE=8
// (see DECISIONS.md ADR-089) so the fallback-to-DEFAULT case (`raw ===
// undefined`) can no longer rely on the ambient environment being unset —
// `bun test` auto-loads .env. Stash/restore around each assertion, matching
// the pattern already used for the same reason in
// test/embed-stale-oom-fallback.serial.test.ts.
let previousSubBatchSize: string | undefined;

beforeEach(() => {
  previousSubBatchSize = process.env.GBRAIN_EMBED_SUBBATCH_SIZE;
  delete process.env.GBRAIN_EMBED_SUBBATCH_SIZE;
});

afterEach(() => {
  if (previousSubBatchSize === undefined) delete process.env.GBRAIN_EMBED_SUBBATCH_SIZE;
  else process.env.GBRAIN_EMBED_SUBBATCH_SIZE = previousSubBatchSize;
});

describe('resolveEmbedSubBatchSize', () => {
  test('uses the batch-1 default and accepts only the inclusive [8, 100] range', () => {
    expect(resolveEmbedSubBatchSize(undefined, () => {})).toBe(32);
    expect(resolveEmbedSubBatchSize('8', () => {})).toBe(8);
    expect(resolveEmbedSubBatchSize('100', () => {})).toBe(100);
  });

  test('falls back with a warning for malformed or out-of-range values', () => {
    const warnings: string[] = [];
    for (const value of ['0', '7', '101', '-1', '3.5', 'nope']) {
      expect(resolveEmbedSubBatchSize(value, (message) => warnings.push(message))).toBe(32);
    }
    expect(warnings).toHaveLength(6);
    expect(warnings.every((message) => message.includes('GBRAIN_EMBED_SUBBATCH_SIZE'))).toBe(true);
  });
});

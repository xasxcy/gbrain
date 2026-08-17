import { describe, expect, test } from 'bun:test';
import { resolveEmbedSubBatchSize } from '../src/core/embed-slices.ts';
import { withEnv } from './helpers/with-env.ts';

// T1b (2026-08-17): the local dev .env now sets GBRAIN_EMBED_SUBBATCH_SIZE=8
// (see DECISIONS.md ADR-089) so the fallback-to-DEFAULT case (`raw ===
// undefined`) can no longer rely on the ambient environment being unset —
// `bun test` auto-loads .env. withEnv() unsets it for the duration of each
// assertion (R1: process.env mutation must go through withEnv(), not raw
// beforeEach/afterEach).
describe('resolveEmbedSubBatchSize', () => {
  test('uses the batch-1 default and accepts only the inclusive [8, 100] range', async () => {
    await withEnv({ GBRAIN_EMBED_SUBBATCH_SIZE: undefined }, () => {
      expect(resolveEmbedSubBatchSize(undefined, () => {})).toBe(32);
      expect(resolveEmbedSubBatchSize('8', () => {})).toBe(8);
      expect(resolveEmbedSubBatchSize('100', () => {})).toBe(100);
    });
  });

  test('falls back with a warning for malformed or out-of-range values', async () => {
    await withEnv({ GBRAIN_EMBED_SUBBATCH_SIZE: undefined }, () => {
      const warnings: string[] = [];
      for (const value of ['0', '7', '101', '-1', '3.5', 'nope']) {
        expect(resolveEmbedSubBatchSize(value, (message) => warnings.push(message))).toBe(32);
      }
      expect(warnings).toHaveLength(6);
      expect(warnings.every((message) => message.includes('GBRAIN_EMBED_SUBBATCH_SIZE'))).toBe(true);
    });
  });
});

import { describe, expect, test } from 'bun:test';
import { resolveEmbedSubBatchSize } from '../src/core/embed-slices.ts';

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

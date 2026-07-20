import { describe, test, expect } from 'bun:test';
import { formatStaleRunSummary } from '../src/commands/embed.ts';

describe('stale embed run summary', () => {
  test('includes persistFailures and the four eligibility counts', () => {
    expect(formatStaleRunSummary({
      embedded: 3,
      pagesProcessed: 2,
      persistFailures: 1,
      counts: { total_null: 4, eligible_now: 2, backoff_deferred: 1, quarantined: 1 },
    })).toBe(
      'Embedded 3 chunks across 2 pages; persistFailures=1; total_null=4; eligible_now=2; backoff_deferred=1; quarantined=1',
    );
  });
});

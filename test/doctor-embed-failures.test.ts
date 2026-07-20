import { describe, test, expect } from 'bun:test';
import { checkEmbedFailuresHealth } from '../src/commands/doctor.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('doctor embed_failures check', () => {
  test('renders the four metrics, error classes, and quarantined top pages from the shared engine summary', async () => {
    const engine = {
      getEmbedFailureSummary: async (opts: unknown) => {
        expect(opts).toEqual({ sourceId: 'team-notes', signature: 'test:model:1536' });
        return {
          counts: { total_null: 4, eligible_now: 2, backoff_deferred: 1, quarantined: 1 },
          by_error_class: [{ error_class: 'provider_timeout', count: 2 }],
          quarantined_top: [{ slug: 'notes/a', chunk_index: 7, error_class: 'provider_timeout', attempt_count: 5 }],
        };
      },
    } as unknown as BrainEngine;

    const check = await checkEmbedFailuresHealth(engine, { sourceId: 'team-notes', signature: 'test:model:1536' });
    expect(check.name).toBe('embed_failures');
    expect(check.status).toBe('warn');
    expect(check.message).toContain('total_null=4');
    expect(check.message).toContain('eligible_now=2');
    expect(check.message).toContain('backoff_deferred=1');
    expect(check.message).toContain('quarantined=1');
    expect(check.message).toContain('provider_timeout=2');
    expect(check.message).toContain('notes/a#7');
  });
});

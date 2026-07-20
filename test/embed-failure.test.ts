import { describe, expect, test } from 'bun:test';
import { classifyEmbedFailure, fingerprintEmbedFailure } from '../src/core/embed-failure.ts';
import { AIConfigError } from '../src/core/ai/errors.ts';

describe('batch-1 embed failure classification', () => {
  test('keeps configuration errors run-global and classifies local provider failures', () => {
    expect(classifyEmbedFailure(new AIConfigError('401 invalid key'))).toEqual({ kind: 'fatal' });
    expect(classifyEmbedFailure(new Error('request timed out after 30s'))).toEqual({ kind: 'failure', errorClass: 'provider_timeout' });
    expect(classifyEmbedFailure(new Error('read ECONNRESET from upstream'))).toEqual({ kind: 'failure', errorClass: 'provider_conn' });
    expect(classifyEmbedFailure(new Error('invalid input: token limit exceeded'))).toEqual({ kind: 'failure', errorClass: 'invalid_input' });
    expect(classifyEmbedFailure(new Error('provider returned 502'))).toEqual({ kind: 'failure', errorClass: 'provider_other' });
  });

  test('normalizes volatile network locations before fingerprinting', () => {
    const first = fingerprintEmbedFailure(new Error('ECONNRESET 127.0.0.1:49152 at 2026-07-20T10:00:00Z addr 0xABC123'));
    const second = fingerprintEmbedFailure(new Error('ECONNRESET 127.0.0.1:50231 at 2026-07-20T10:01:59Z addr 0xDEAD99'));
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});

import { createHash } from 'node:crypto';
import { AIConfigError, AITransientError } from './ai/errors.ts';

export type EmbedFailureClass =
  | 'provider_timeout'
  | 'provider_conn'
  | 'provider_other'
  | 'invalid_input';

export type EmbedFailureClassification =
  | { kind: 'fatal' }
  | { kind: 'failure'; errorClass: EmbedFailureClass };

export function isInvalidInputError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid input|input (?:is )?too long|context length|token limit|unprocessable entity/i.test(message);
}

/**
 * #3037 cost bounding: rate-limit (429) and transient outage errors must
 * never be treated as split-worthy — fanning a struggling/rate-limited
 * provider out into N single-chunk calls makes the outage worse, it doesn't
 * salvage anything. Mirrors src/commands/embed.ts's isRateLimitError.
 */
export function isTransientEmbedError(error: unknown): boolean {
  if (error instanceof AITransientError) return true;
  let cur: unknown = error;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth++) {
    const obj = cur as { status?: unknown; statusCode?: unknown; cause?: unknown };
    if (obj.status === 429 || obj.statusCode === 429) return true;
    cur = obj.cause;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /rate.?limit|429/i.test(message);
}

export function classifyEmbedFailure(error: unknown): EmbedFailureClassification {
  if (error instanceof AIConfigError) return { kind: 'fatal' };
  const message = error instanceof Error ? error.message : String(error);
  if (isInvalidInputError(error)) {
    return { kind: 'failure', errorClass: 'invalid_input' };
  }
  if (/timed out|timeout|ETIMEDOUT/i.test(message)) {
    return { kind: 'failure', errorClass: 'provider_timeout' };
  }
  if (/ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|socket|network|fetch failed|\bEOF\b/i.test(message)) {
    return { kind: 'failure', errorClass: 'provider_conn' };
  }
  return { kind: 'failure', errorClass: 'provider_other' };
}

/** Stable diagnostic identity, deliberately excluding volatile peer/time data. */
export function fingerprintEmbedFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}:\d+\b/g, '<host:port>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.+-]+Z?\b/g, '<timestamp>')
    .replace(/\b[\w.-]+:\d+\b/g, '<host:port>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>');
  return createHash('sha256').update(normalized).digest('hex');
}

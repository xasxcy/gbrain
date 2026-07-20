import { createHash } from 'node:crypto';
import { AIConfigError } from './ai/errors.ts';

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

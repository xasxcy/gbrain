import { createHash } from 'node:crypto';
import { AIConfigError, AITransientError, PER_ITEM_HTTP_STATUSES } from './ai/errors.ts';
import { isEmbeddingResponseShapeError, isEmbeddingZeroNormError } from './ai/embedding-guard.ts';
import { isMustAbortError } from './worker-pool.ts';

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
  // F4c CI fixes: a must-abort stop (budget cap / spend-group refusal) is a
  // run-global stop condition, not a fact about the chunk. Ledgering it as a
  // provider failure would put every in-flight chunk into retry backoff, so a
  // later run with a raised cap would skip them until the backoff expired.
  if (isMustAbortError(error)) return { kind: 'fatal' };
  // A zero-norm response is an aligned, terminal refusal for individual
  // inputs. Although its public error extends AIConfigError for callers that
  // cannot preserve partial vectors, stale embedding can: it must ledger the
  // refused chunks instead of turning a provider response for one item into a
  // global credential/config failure.
  if (isEmbeddingZeroNormError(error)) {
    return { kind: 'failure', errorClass: 'invalid_input' };
  }
  // F6 (advisor ruling 3): the same holds for a response that does not line up with the request (wrong number of
  // vectors, wrong width). It says nothing about credentials or configuration, and one bad answer must not abort
  // the pages after it: the chunks of that call are ledgered (and bisected) like any other per-item provider
  // failure. Upstream treats every per-page error this way. A real config fault (no key, unknown model, rejected
  // credentials) is a different AIConfigError and still falls through to `fatal` below.
  if (isEmbeddingResponseShapeError(error)) {
    return { kind: 'failure', errorClass: 'provider_other' };
  }
  // Pre-existing bug fix: normalizeAIError (ai/errors.ts) wraps EVERY non-429
  // 4xx into AIConfigError, including request-shaped ones (400/408/413/422 —
  // bad content, too long, timeout) that are per-item, not a whole-batch
  // config fault. Treating instanceof AIConfigError alone as fatal collapsed
  // a single bad chunk's 400 into a fatal verdict for the WHOLE batch,
  // defeating the per-chunk isolation below (isInvalidInputError exists
  // precisely to catch this case but was unreachable — this branch was
  // checked first and always won). Mirrors PER_ITEM_HTTP_STATUSES's identical
  // distinction in classifyGlobalLlmError. A status outside that set (401/403
  // auth, or no status at all, e.g. a missing-API-key AIConfigError) still
  // falls through to fatal below.
  const status = error instanceof AIConfigError ? (error.status ?? error.apiErrorStatus) : undefined;
  if (error instanceof AIConfigError && !(status !== undefined && PER_ITEM_HTTP_STATUSES.has(status))) {
    return { kind: 'fatal' };
  }
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

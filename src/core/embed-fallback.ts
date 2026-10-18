import { classifyEmbedFailure, isInvalidInputError, isTransientEmbedError } from './embed-failure.ts';
import { detectGatewayErrorFromCause } from './embed-retry.ts';
import { isSingleInputOverLengthError } from './embed-overlength-classify.ts';
import { isMustAbortError } from './worker-pool.ts';
import { isEmbeddingResponseShapeError, isEmbeddingZeroNormError } from './ai/embedding-guard.ts';

/**
 * Shared Ollama fallback for foreground and Minion embedding callers.
 *
 * A split-worthy failed batch is retried one chunk at a time. Only OOM-like
 * single-chunk failures use the finite 5500 → 5000 → 4500 truncation ladder.
 */

export type EmbedFn = (
  texts: string[],
  opts: { abortSignal?: AbortSignal },
) => Promise<Float32Array[]>;

/** A provider response shape that cannot safely reach vector persistence. */
class EmbeddingOutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingOutputValidationError';
  }
}

function validateEmbeddingOutput(
  vectors: Float32Array[],
  expectedCount: number,
  expectedDimensions?: number,
): Float32Array[] {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new EmbeddingOutputValidationError(
      `embedding provider returned ${Array.isArray(vectors) ? vectors.length : 'a non-array'} result(s) for ${expectedCount} input(s)`,
    );
  }
  for (const [index, vector] of vectors.entries()) {
    if (!(vector instanceof Float32Array)) {
      throw new EmbeddingOutputValidationError(`embedding provider returned a non-Float32Array vector at index ${index}`);
    }
    if (expectedDimensions !== undefined && vector.length !== expectedDimensions) {
      throw new EmbeddingOutputValidationError(
        `embedding provider returned ${vector.length} dimensions at index ${index}; expected ${expectedDimensions}`,
      );
    }
    if (!vector.every(Number.isFinite)) {
      throw new EmbeddingOutputValidationError(`embedding provider returned a non-finite vector at index ${index}`);
    }
  }
  return vectors;
}

/** Batch layer: failures worth splitting into independent chunk attempts. */
export function isOllamaBatchSplitWorthyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /EOF|timed out|llama-server process no longer running|socket connection was closed/i.test(message);
}

/**
 * Batch-1 policy for the stale-only partial pipeline. It deliberately widens
 * only that caller's salvage set; legacy inline/single-page callers retain the
 * V4 Ollama predicate and first-failure semantics.
 *
 * T1b (2026-08-17, ADR — see DECISIONS.md): a batch that fails because it
 * genuinely timed out (content volume exceeds GBRAIN_AI_EMBED_TIMEOUT_MS, not
 * because the provider is degraded) is split-worthy even though it is an
 * AITransientError. A page with N chunks that all individually embed in
 * seconds but never fit inside the timeout as one batch has no other
 * self-healing path — #3037's blast-radius argument against fanning out
 * (rate-limit/outage amplification) does not apply to a wall-clock budget
 * problem. Rate-limit (429) and non-timeout transient/outage errors keep the
 * #3037 no-fan-out property.
 */
export function isPartialStaleSplitWorthyError(error: unknown): boolean {
  const classified = classifyEmbedFailure(error);
  if (classified.kind === 'failure' && classified.errorClass === 'provider_timeout') return true;
  // Configuration faults and transient/rate-limit errors (#3037 cost
  // bounding) are run-global. Every other provider error gets a one-chunk
  // salvage attempt in the stale-only pipeline.
  //
  // 2026-08-25 upstream merge (v0.46.16.0→v0.46.29.0): upstream's #3966
  // WIDENED the no-fan-out contract from 429-only to gateway 5xx
  // (502/503/504). The fork's isTransientEmbedError only detects 429 /
  // rate-limit, so a sustained 502 fell through to per-chunk salvage —
  // exactly the cost blow-up #3037 exists to prevent (caught by upstream's
  // test/embed-partial-failure-3037 "sustained 502 … does not fan out").
  // Discriminator is the STRUCTURED status on the error's cause chain, not a
  // message match: upstream's guard fires on `cause.status = 502` (a real
  // provider-level outage — run-global), while a free-text message that
  // merely mentions 502 ("provider 502 upstream reset") is an unknown
  // provider error that must still reach the per-chunk provider_other ledger
  // (fork test: "unknown transient provider errors enter the ledger").
  // isEmbedRetriableError's message regex would swallow both; the cause-chain
  // check separates them, and it never matches a bare "timed out", so the
  // provider_timeout ladder above and the Ollama EOF/socket-close split
  // below are untouched.
  // Upstream #6772: one input over the model's context, even behind a 5xx or no status (llama.cpp / Ollama
  // answer 500), fails the same way on every retry; fan out so the siblings embed and only that chunk fails.
  if (isSingleInputOverLengthError(error)) return true;
  if (isTransientEmbedError(error) || detectGatewayErrorFromCause(error)) return false;
  return classified.kind === 'failure';
}

/** Ladder layer: failures for which shorter text can plausibly succeed. */
export function isOllamaOomLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /EOF|llama-server process no longer running|socket connection was closed/i.test(message);
}

export interface PartialEmbedResult {
  vectors: (Float32Array | null)[];
  /**
   * Per input: the number of leading characters actually embedded when the
   * vector was built from a fallback-truncated input, else null (R6-1: the
   * truncation provenance recorded instead of the full input's hash).
   */
  truncatedTo: (number | null)[];
  failures: { index: number; error: unknown }[];
  aborted: boolean;
  fatalError?: unknown;
  /** Input indexes affected by fatalError; batch-fatal means every index. */
  fatalIndexes?: number[];
}

type SingleAttempt =
  | { kind: 'success'; vector: Float32Array; truncatedTo: number | null }
  | { kind: 'ollamaFailure'; error: unknown }
  | { kind: 'fatal'; error: unknown }
  | { kind: 'aborted'; error?: unknown };

const FALLBACK_LEVELS = [5500, 5000, 4500] as const;
export type PartialFallbackPolicy = 'legacy' | 'partial-stale';

function isSplitWorthy(error: unknown, policy: PartialFallbackPolicy): boolean {
  if (isMustAbortError(error)) return false;
  return policy === 'partial-stale'
    ? isPartialStaleSplitWorthyError(error)
    : isOllamaBatchSplitWorthyError(error);
}

/**
 * One chunk's original attempt plus, only after an OOM-like failure, its
 * strictly-shorter truncation attempts. The caller decides partial vs throw
 * control flow so legacy callers retain first-failure short-circuiting.
 */
async function attemptSingleChunk(
  text: string,
  embedFn: EmbedFn,
  opts: { abortSignal?: AbortSignal; expectedDimensions?: number },
  originalAlreadyTried: boolean,
  previousError?: unknown,
  policy: PartialFallbackPolicy = 'legacy',
): Promise<SingleAttempt> {
  const levels = originalAlreadyTried
    ? FALLBACK_LEVELS.filter((level) => level < text.length)
    : [text.length, ...FALLBACK_LEVELS.filter((level) => level < text.length)];
  let lastError: unknown = previousError;

  if (levels.length === 0) return { kind: 'ollamaFailure', error: lastError };

  for (const maxLength of levels) {
    if (opts.abortSignal?.aborted) return { kind: 'aborted' };
    const candidate = text.length > maxLength ? text.slice(0, maxLength) : text;
    try {
      const [vector] = validateEmbeddingOutput(await embedFn([candidate], opts), 1, opts.expectedDimensions);
      if (candidate.length < text.length) {
        process.stderr.write(
          `  [embed-fallback] chunk truncated ${text.length}→${candidate.length} chars for embedding\n`,
        );
      }
      return { kind: 'success', vector, truncatedTo: candidate.length < text.length ? candidate.length : null };
    } catch (error) {
      if (opts.abortSignal?.aborted) return { kind: 'aborted', error };
      // A zero-norm refusal of this one input is a terminal per-item result
      // under the partial-stale contract, not a run-global config fault.
      if (policy === 'partial-stale' && isEmbeddingZeroNormError(error)) return { kind: 'ollamaFailure', error };
      if (!isOllamaOomLikeError(error)) {
        return isSplitWorthy(error, policy)
          ? { kind: 'ollamaFailure', error }
          : { kind: 'fatal', error };
      }
      lastError = error;
    }
  }

  return { kind: 'ollamaFailure', error: lastError };
}

function terminalResult(
  vectors: (Float32Array | null)[],
  truncatedTo: (number | null)[],
  failures: { index: number; error: unknown }[],
  signal: AbortSignal | undefined,
  error?: unknown,
  fatalIndexes?: number[],
): PartialEmbedResult {
  if (signal?.aborted) return { vectors, truncatedTo, failures, aborted: true };
  return error === undefined
    ? { vectors, truncatedTo, failures, aborted: false }
    : { vectors, truncatedTo, failures, aborted: false, fatalError: error, fatalIndexes };
}

function mergeZeroNormPartial(
  error: { vectors: (Float32Array | null)[]; failures: { index: number }[] },
  expectedCount: number,
  expectedDimensions: number | undefined,
  vectors: (Float32Array | null)[],
  failures: { index: number; error: unknown }[],
  offset: number,
): void {
  // Never throws (the partial entry point is documented never-throwing): a
  // malformed provider response becomes per-item failures instead.
  if (error.vectors.length !== expectedCount) {
    const mismatch = new EmbeddingOutputValidationError(`embedding provider returned ${error.vectors.length} partial result(s) for ${expectedCount} input(s)`);
    for (let index = 0; index < expectedCount; index++) failures.push({ index: offset + index, error: mismatch });
    return;
  }
  const rejected = new Set(error.failures.map(failure => failure.index));
  for (const [index, vector] of error.vectors.entries()) {
    // Gateway errors may retain the rejected (zero/nan) vector in the array.
    // The structured failure is authoritative; never validate or preserve it.
    if (rejected.has(index)) continue;
    if (vector === null) {
      failures.push({ index: offset + index, error: new EmbeddingOutputValidationError(`embedding provider returned a null partial vector at index ${index} without a failure`) });
      continue;
    }
    try { vectors[offset + index] = validateEmbeddingOutput([vector], 1, expectedDimensions)[0]!; }
    catch (validationError) { failures.push({ index: offset + index, error: validationError }); }
  }
  for (const failure of error.failures) failures.push({ index: offset + failure.index, error });
}

async function bisectInvalidInputs(
  texts: string[],
  embedFn: EmbedFn,
  opts: { abortSignal?: AbortSignal; expectedDimensions?: number },
  vectors: (Float32Array | null)[],
  failures: { index: number; error: unknown }[],
  offset: number,
  invalidError: unknown,
): Promise<{ fatalError?: unknown; fatalIndexes?: number[]; aborted?: boolean }> {
  if (opts.abortSignal?.aborted) return { aborted: true };
  if (texts.length === 0) return {}; // R7b: an empty group would split into empty groups forever
  if (texts.length === 1) {
    failures.push({ index: offset, error: invalidError });
    return {};
  }
  // No fixed depth cap (R7-1): every level halves the group, so recursion ends at single items
  // (ceil(log2(n)) levels) for any slice size; a fixed cap left 2..4-item groups run-fatal on large slices.

  const mid = Math.ceil(texts.length / 2);
  for (const [start, end] of [[0, mid], [mid, texts.length]] as const) {
    const group = texts.slice(start, end);
    try {
      const embedded = validateEmbeddingOutput(await embedFn(group, opts), group.length, opts.expectedDimensions);
      for (let index = 0; index < embedded.length; index++) vectors[offset + start + index] = embedded[index]!;
    } catch (error) {
      if (opts.abortSignal?.aborted) return { aborted: true };
      if (isEmbeddingZeroNormError(error) && error.vectors.length === group.length) {
        mergeZeroNormPartial(error, group.length, opts.expectedDimensions, vectors, failures, offset + start);
        continue;
      }
      // A structurally malformed response (count/width) from a sub-request is a per-item result
      // like the initial invalid input: keep splitting down to the single item, never run-fatal (R6-3).
      // Real configuration faults (401, unknown model) stay fatal.
      if (!isInvalidInputError(error) && !isEmbeddingResponseShapeError(error)) return { fatalError: error, fatalIndexes: group.map((_, index) => offset + start + index) };
      const nested = await bisectInvalidInputs(group, embedFn, opts, vectors, failures, offset + start, error);
      if (nested.aborted || nested.fatalError !== undefined) return nested;
    }
  }
  return {};
}

/**
 * Never-throwing partial variant for stale callers. At every error boundary it
 * returns either `aborted` or `fatalError`, never both, preserving vectors that
 * completed before the boundary.
 */
export async function embedWithTruncationFallbackPartial(
  texts: string[],
  embedFn: EmbedFn,
  opts: { abortSignal?: AbortSignal; policy?: PartialFallbackPolicy; expectedDimensions?: number },
): Promise<PartialEmbedResult> {
  const vectors: (Float32Array | null)[] = Array.from({ length: texts.length }, () => null);
  const truncatedTo: (number | null)[] = Array.from({ length: texts.length }, () => null);
  const failures: { index: number; error: unknown }[] = [];

  try {
    const embedded = validateEmbeddingOutput(await embedFn(texts, opts), texts.length, opts.expectedDimensions);
    return { vectors: embedded, truncatedTo, failures, aborted: false };
  } catch (error) {
    if (opts.abortSignal?.aborted) return terminalResult(vectors, truncatedTo, failures, opts.abortSignal);
    // #4616: the gateway refused some or all items (zero-norm / non-finite / empty). Keep every
    // usable vector; each refused item is a terminal per-chunk failure (never retried, never
    // fanned out, and not a run-global AIConfigError even though the error class extends it).
    if (isEmbeddingZeroNormError(error) && error.vectors.length === texts.length) {
      mergeZeroNormPartial(error, texts.length, opts.expectedDimensions, vectors, failures, 0);
      return terminalResult(vectors, truncatedTo, failures, opts.abortSignal);
    }
    if (texts.length === 1) {
      if (!isOllamaOomLikeError(error)) {
        if (isSplitWorthy(error, opts.policy ?? 'legacy')) failures.push({ index: 0, error });
        else return terminalResult(vectors, truncatedTo, failures, opts.abortSignal, error, [0]);
      } else {
        const attempt = await attemptSingleChunk(texts[0]!, embedFn, opts, true, error, opts.policy ?? 'legacy');
        if (attempt.kind === 'success') { vectors[0] = attempt.vector; truncatedTo[0] = attempt.truncatedTo; }
        else if (attempt.kind === 'ollamaFailure') failures.push({ index: 0, error: attempt.error });
        else if (attempt.kind === 'fatal') return terminalResult(vectors, truncatedTo, failures, opts.abortSignal, attempt.error, [0]);
        else return terminalResult(vectors, truncatedTo, failures, opts.abortSignal);
      }
      return terminalResult(vectors, truncatedTo, failures, opts.abortSignal);
    }
    if (opts.policy === 'partial-stale' && isInvalidInputError(error)) {
      const isolated = await bisectInvalidInputs(texts, embedFn, opts, vectors, failures, 0, error);
      return terminalResult(vectors, truncatedTo, failures, opts.abortSignal, isolated.fatalError, isolated.fatalIndexes);
    }
    if (!isSplitWorthy(error, opts.policy ?? 'legacy')) {
      return terminalResult(vectors, truncatedTo, failures, opts.abortSignal, error, texts.map((_, index) => index));
    }
  }

  for (let index = 0; index < texts.length; index++) {
    if (opts.abortSignal?.aborted) return terminalResult(vectors, truncatedTo, failures, opts.abortSignal);
    const attempt = await attemptSingleChunk(texts[index]!, embedFn, opts, false, undefined, opts.policy ?? 'legacy');
    if (attempt.kind === 'success') { vectors[index] = attempt.vector; truncatedTo[index] = attempt.truncatedTo; }
    else if (attempt.kind === 'ollamaFailure') failures.push({ index, error: attempt.error });
    else if (attempt.kind === 'fatal') return terminalResult(vectors, truncatedTo, failures, opts.abortSignal, attempt.error, [index]);
    else return terminalResult(vectors, truncatedTo, failures, opts.abortSignal);
  }
  return terminalResult(vectors, truncatedTo, failures, opts.abortSignal);
}

/**
 * Throwing legacy API. It shares the per-chunk attempt primitive with partial
 * mode but deliberately throws the original first exhausted error and does
 * not process later chunks.
 */
export async function embedWithTruncationFallback(
  texts: string[],
  embedFn: EmbedFn,
  opts: { abortSignal?: AbortSignal },
): Promise<Float32Array[]> {
  try {
    return await embedFn(texts, opts);
  } catch (error) {
    if (opts.abortSignal?.aborted) throw error;
    if (texts.length === 1) {
      if (!isOllamaOomLikeError(error)) throw error;
      const attempt = await attemptSingleChunk(texts[0]!, embedFn, opts, true, error);
      if (attempt.kind === 'success') return [attempt.vector];
      if (attempt.kind === 'aborted') throw attempt.error ?? new Error('embed budget aborted');
      throw attempt.error;
    }
    if (!isOllamaBatchSplitWorthyError(error)) throw error;
  }

  const results: Float32Array[] = [];
  for (const text of texts) {
    if (opts.abortSignal?.aborted) throw new Error('embed budget aborted');
    const attempt = await attemptSingleChunk(text, embedFn, opts, false);
    if (attempt.kind === 'success') results.push(attempt.vector);
    else if (attempt.kind === 'aborted') throw attempt.error ?? new Error('embed budget aborted');
    else throw attempt.error;
  }
  return results;
}

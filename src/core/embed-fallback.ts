import { classifyEmbedFailure, isInvalidInputError, isTransientEmbedError } from './embed-failure.ts';
import { isMustAbortError } from './worker-pool.ts';

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

/** Batch layer: failures worth splitting into independent chunk attempts. */
export function isOllamaBatchSplitWorthyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /EOF|timed out|llama-server process no longer running|socket connection was closed/i.test(message);
}

/**
 * Batch-1 policy for the stale-only partial pipeline. It deliberately widens
 * only that caller's salvage set; legacy inline/single-page callers retain the
 * V4 Ollama predicate and first-failure semantics.
 */
export function isPartialStaleSplitWorthyError(error: unknown): boolean {
  // Configuration faults and transient/rate-limit errors (#3037 cost
  // bounding) are run-global. Every other provider error gets a one-chunk
  // salvage attempt in the stale-only pipeline.
  if (isTransientEmbedError(error)) return false;
  return classifyEmbedFailure(error).kind === 'failure';
}

/** Ladder layer: failures for which shorter text can plausibly succeed. */
export function isOllamaOomLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /EOF|llama-server process no longer running|socket connection was closed/i.test(message);
}

export interface PartialEmbedResult {
  vectors: (Float32Array | null)[];
  failures: { index: number; error: unknown }[];
  aborted: boolean;
  fatalError?: unknown;
  /** Input indexes affected by fatalError; batch-fatal means every index. */
  fatalIndexes?: number[];
}

type SingleAttempt =
  | { kind: 'success'; vector: Float32Array }
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
  opts: { abortSignal?: AbortSignal },
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
      const [vector] = await embedFn([candidate], opts);
      if (candidate.length < text.length) {
        process.stderr.write(
          `  [embed-fallback] chunk truncated ${text.length}→${candidate.length} chars for embedding\n`,
        );
      }
      return { kind: 'success', vector };
    } catch (error) {
      if (opts.abortSignal?.aborted) return { kind: 'aborted', error };
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
  failures: { index: number; error: unknown }[],
  signal: AbortSignal | undefined,
  error?: unknown,
  fatalIndexes?: number[],
): PartialEmbedResult {
  if (signal?.aborted) return { vectors, failures, aborted: true };
  return error === undefined
    ? { vectors, failures, aborted: false }
    : { vectors, failures, aborted: false, fatalError: error, fatalIndexes };
}

async function bisectInvalidInputs(
  texts: string[],
  embedFn: EmbedFn,
  opts: { abortSignal?: AbortSignal },
  vectors: (Float32Array | null)[],
  failures: { index: number; error: unknown }[],
  offset: number,
  depth: number,
  invalidError: unknown,
): Promise<{ fatalError?: unknown; fatalIndexes?: number[]; aborted?: boolean }> {
  if (opts.abortSignal?.aborted) return { aborted: true };
  if (texts.length === 1) {
    failures.push({ index: offset, error: invalidError });
    return {};
  }
  if (depth >= 5) return { fatalError: new Error('invalid input could not be localized'), fatalIndexes: texts.map((_, index) => offset + index) };

  const mid = Math.ceil(texts.length / 2);
  for (const [start, end] of [[0, mid], [mid, texts.length]] as const) {
    const group = texts.slice(start, end);
    try {
      const embedded = await embedFn(group, opts);
      for (let index = 0; index < embedded.length; index++) vectors[offset + start + index] = embedded[index]!;
    } catch (error) {
      if (opts.abortSignal?.aborted) return { aborted: true };
      if (!isInvalidInputError(error)) return { fatalError: error, fatalIndexes: group.map((_, index) => offset + start + index) };
      const nested = await bisectInvalidInputs(group, embedFn, opts, vectors, failures, offset + start, depth + 1, error);
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
  opts: { abortSignal?: AbortSignal; policy?: PartialFallbackPolicy },
): Promise<PartialEmbedResult> {
  const vectors: (Float32Array | null)[] = Array.from({ length: texts.length }, () => null);
  const failures: { index: number; error: unknown }[] = [];

  try {
    const embedded = await embedFn(texts, opts);
    return { vectors: embedded, failures, aborted: false };
  } catch (error) {
    if (opts.abortSignal?.aborted) return terminalResult(vectors, failures, opts.abortSignal);
    if (texts.length === 1) {
      if (!isOllamaOomLikeError(error)) {
        if (isSplitWorthy(error, opts.policy ?? 'legacy')) failures.push({ index: 0, error });
        else return terminalResult(vectors, failures, opts.abortSignal, error, [0]);
      } else {
        const attempt = await attemptSingleChunk(texts[0]!, embedFn, opts, true, error, opts.policy ?? 'legacy');
        if (attempt.kind === 'success') vectors[0] = attempt.vector;
        else if (attempt.kind === 'ollamaFailure') failures.push({ index: 0, error: attempt.error });
        else if (attempt.kind === 'fatal') return terminalResult(vectors, failures, opts.abortSignal, attempt.error, [0]);
        else return terminalResult(vectors, failures, opts.abortSignal);
      }
      return terminalResult(vectors, failures, opts.abortSignal);
    }
    if (opts.policy === 'partial-stale' && isInvalidInputError(error)) {
      const isolated = await bisectInvalidInputs(texts, embedFn, opts, vectors, failures, 0, 0, error);
      return terminalResult(vectors, failures, opts.abortSignal, isolated.fatalError, isolated.fatalIndexes);
    }
    if (!isSplitWorthy(error, opts.policy ?? 'legacy')) {
      return terminalResult(vectors, failures, opts.abortSignal, error, texts.map((_, index) => index));
    }
  }

  for (let index = 0; index < texts.length; index++) {
    if (opts.abortSignal?.aborted) return terminalResult(vectors, failures, opts.abortSignal);
    const attempt = await attemptSingleChunk(texts[index]!, embedFn, opts, false, undefined, opts.policy ?? 'legacy');
    if (attempt.kind === 'success') vectors[index] = attempt.vector;
    else if (attempt.kind === 'ollamaFailure') failures.push({ index, error: attempt.error });
    else if (attempt.kind === 'fatal') return terminalResult(vectors, failures, opts.abortSignal, attempt.error, [index]);
    else return terminalResult(vectors, failures, opts.abortSignal);
  }
  return terminalResult(vectors, failures, opts.abortSignal);
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

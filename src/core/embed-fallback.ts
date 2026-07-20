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
        return isOllamaBatchSplitWorthyError(error)
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

/**
 * Never-throwing partial variant for stale callers. At every error boundary it
 * returns either `aborted` or `fatalError`, never both, preserving vectors that
 * completed before the boundary.
 */
export async function embedWithTruncationFallbackPartial(
  texts: string[],
  embedFn: EmbedFn,
  opts: { abortSignal?: AbortSignal },
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
        if (isOllamaBatchSplitWorthyError(error)) failures.push({ index: 0, error });
        else return terminalResult(vectors, failures, opts.abortSignal, error, [0]);
      } else {
        const attempt = await attemptSingleChunk(texts[0]!, embedFn, opts, true, error);
        if (attempt.kind === 'success') vectors[0] = attempt.vector;
        else if (attempt.kind === 'ollamaFailure') failures.push({ index: 0, error: attempt.error });
        else if (attempt.kind === 'fatal') return terminalResult(vectors, failures, opts.abortSignal, attempt.error, [0]);
        else return terminalResult(vectors, failures, opts.abortSignal);
      }
      return terminalResult(vectors, failures, opts.abortSignal);
    }
    if (!isOllamaBatchSplitWorthyError(error)) {
      return terminalResult(vectors, failures, opts.abortSignal, error, texts.map((_, index) => index));
    }
  }

  for (let index = 0; index < texts.length; index++) {
    if (opts.abortSignal?.aborted) return terminalResult(vectors, failures, opts.abortSignal);
    const attempt = await attemptSingleChunk(texts[index]!, embedFn, opts, false);
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

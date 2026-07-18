/**
 * Shared EOF/timeout fallback for foreground and Minion embedding callers.
 *
 * A batch-level Ollama failure is retried one chunk at a time. An oversized
 * chunk then gets the finite 5500 → 5000 → 4500 character truncation ladder.
 */

type EmbedFn = (
  texts: string[],
  opts: { abortSignal?: AbortSignal },
) => Promise<Float32Array[]>;

/** True for Ollama llama-server failures that truncation can work around. */
export function isOllamaOomLikeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /EOF|timed out|llama-server process no longer running|socket connection was closed/i.test(message);
}

/**
 * Try a batch once, then fall back to single chunks on an Ollama EOF/timeout.
 * A single chunk is retried at its original length and, when shorter, at the
 * finite truncation ladder. Non-Ollama errors preserve the caller's existing
 * error handling by propagating immediately.
 */
export async function embedWithTruncationFallback(
  texts: string[],
  embedFn: EmbedFn,
  opts: { abortSignal?: AbortSignal },
): Promise<Float32Array[]> {
  try {
    return await embedFn(texts, opts);
  } catch (error) {
    if (!isOllamaOomLikeError(error)) throw error;
  }

  const fallbackLevels = [5500, 5000, 4500] as const;
  const results: Float32Array[] = [];
  for (const text of texts) {
    if (opts.abortSignal?.aborted) throw new Error('embed budget aborted');
    let embedded = false;
    let lastError: unknown;
    const effectiveLevels = [text.length, ...fallbackLevels.filter((level) => level < text.length)];
    for (const maxLength of effectiveLevels) {
      if (opts.abortSignal?.aborted) throw new Error('embed budget aborted');
      const candidate = text.length > maxLength ? text.slice(0, maxLength) : text;
      try {
        const [vector] = await embedFn([candidate], opts);
        if (candidate.length < text.length) {
          process.stderr.write(
            `  [embed-fallback] chunk truncated ${text.length}→${candidate.length} chars for embedding\n`,
          );
        }
        results.push(vector);
        embedded = true;
        break;
      } catch (error) {
        if (!isOllamaOomLikeError(error)) throw error;
        lastError = error;
      }
    }
    if (!embedded) throw lastError;
  }
  return results;
}

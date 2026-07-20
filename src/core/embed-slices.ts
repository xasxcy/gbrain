/**
 * Batch-1 outer-slice configuration for stale embedding. A slice is the
 * checkpoint/persistence unit; callers deliberately keep legacy embed paths
 * out of this module.
 */
export const DEFAULT_EMBED_SUBBATCH_SIZE = 32;
export const MIN_EMBED_SUBBATCH_SIZE = 8;
export const MAX_EMBED_SUBBATCH_SIZE = 100;

export function resolveEmbedSubBatchSize(
  raw: string | undefined = process.env.GBRAIN_EMBED_SUBBATCH_SIZE,
  warn: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): number {
  if (raw === undefined || raw === '') return DEFAULT_EMBED_SUBBATCH_SIZE;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed >= MIN_EMBED_SUBBATCH_SIZE && parsed <= MAX_EMBED_SUBBATCH_SIZE) {
    return parsed;
  }
  warn(
    `[embed] invalid GBRAIN_EMBED_SUBBATCH_SIZE=${raw}; using ${DEFAULT_EMBED_SUBBATCH_SIZE} `
      + `(expected integer ${MIN_EMBED_SUBBATCH_SIZE}-${MAX_EMBED_SUBBATCH_SIZE})`,
  );
  return DEFAULT_EMBED_SUBBATCH_SIZE;
}

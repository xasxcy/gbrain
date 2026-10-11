/**
 * PGroonga capability probe (fork). Three outcomes, and only the first two are cached for the life of the
 * connection:
 *   present: the query succeeded and the extension exists
 *   absent:  the query succeeded and the extension does not exist
 *   failed:  the query errored or timed out; the caller falls back to tsvector for now and re-probes after a backoff
 * The probe runs outside the keyword query's own statement timeout, so it carries a short timeout of its own.
 */
export const PGROONGA_PROBE_RETRY_MS = 30_000;
export const PGROONGA_PROBE_TIMEOUT_MS = 3_000;

export type PgroongaProbeResult = 'present' | 'absent' | 'failed';

type ProbeQuery = PromiseLike<ArrayLike<unknown>> & { cancel?: () => void | PromiseLike<unknown> };

export async function probePgroongaExtension(run: () => ProbeQuery, timeoutMs: number): Promise<PgroongaProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`pgroonga probe timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  let query: ProbeQuery | undefined;
  try {
    query = run();
    const rows = await Promise.race([query, timeout]);
    return rows.length > 0 ? 'present' : 'absent';
  } catch {
    // Best-effort and never awaited (the probe deadline stays bounded); the driver's cancel can reject
    // asynchronously when the cancel connection fails, so that rejection is swallowed too (R7-2).
    try { Promise.resolve(query?.cancel?.()).catch(() => {}); } catch { /* the query may already be done */ }
    return 'failed';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

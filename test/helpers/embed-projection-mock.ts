import type { BrainEngine } from '../../src/core/engine.ts';

/** Minimal coherent read/transaction surface for provider orchestration tests. */
export function mockEmbedProjectionEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  // Raw SQL the stale drain issues (the page-provenance stamp check) reads an
  // empty result set unless a test models it — the Proxy's null default would
  // throw on indexing and count the page as a failed embed.
  const revision = '00000000-0000-4000-8000-000000000001';
  const pages = new Map<string, number>();
  const pageKinds = new Map<number, string>();
  overrides = {
    executeRaw: async (sql: string) => sql.startsWith('SELECT count(*)::int AS n FROM pages p')
      && sql.includes('p.text_projection_revision IS DISTINCT FROM p.knowledge_revision') ? [{ n: 0 }] : [],
    getConfigKeys: async () => [],
    transaction: async (run: (tx: BrainEngine) => Promise<unknown>) => run(engine),
    readPageSnapshot: async (slug: string, opts?: { sourceId?: string }) => {
      const page = overrides.getPage ? await overrides.getPage(slug, opts) : { slug, compiled_truth: 'Fixture body', timeline: '' };
      if (!page) return null;
      if (!pages.has(slug)) pages.set(slug, pages.size + 1);
      pageKinds.set(pages.get(slug)!, page.page_kind ?? (page.type === 'code' ? 'code' : 'markdown'));
      return { revision, sourceIncarnation: revision, tags: [], withdrawals: [], page: {
        id: pages.get(slug), slug, source_id: opts?.sourceId ?? 'default', title: slug,
        knowledge_revision: revision, text_projection_revision: revision, ...page,
      } };
    },
    // Coherent default for the projection snapshot's chunk read: a test that models a stale
    // set through `listStaleChunks` but not `getChunks` (the pre-projection --stale path
    // needed no chunk read) sees those rows as the page's stored chunks, so the
    // snapshot-vs-stale text match in the drain holds. An explicit `getChunks` still wins.
    getChunks: async (slug: string, opts?: { sourceId?: string }) => {
      const rows: any[] = overrides.listStaleChunks ? (await overrides.listStaleChunks({ afterPageId: 0 })) ?? [] : [];
      return rows
        .filter(row => row.slug === slug && (row.source_id ?? 'default') === (opts?.sourceId ?? 'default'))
        .map(row => ({ ...row, embedded_at: null }));
    },
    ...overrides,
  };
  const executeRaw = overrides.executeRaw;
  overrides.executeRaw = async (sql: string, params?: unknown[]) => sql.startsWith('SELECT page_kind FROM pages WHERE id=')
    ? [{ page_kind: pageKinds.get(Number(params?.[0])) ?? 'markdown' }]
    : sql === 'SELECT archived FROM sources WHERE id=$1' ? [{ archived: false }]
    : executeRaw(sql, params);
  const calls: { method: string; args: any[] }[] = [];
  const track = (method: string) => (...args: any[]) => {
    calls.push({ method, args });
    if (overrides[method]) return overrides[method](...args);
    // fork: the --stale path commits through the atomic persistEmbedOutcome
    // checkpoint; default it to "everything committed" so tests that do not
    // model the checkpoint still see a clean outcome (failures → ledger rows).
    if (method === 'persistEmbedOutcome') {
      const entries = args[0]?.entries ?? [];
      const vectors = entries.filter((entry: any) => 'vector' in entry.outcome).length;
      return Promise.resolve({
        committedChunks: vectors,
        vectorCommittedChunks: vectors,
        staleSkippedChunks: 0,
        ledgerUpserts: entries.length - vectors,
        ledgerDeletes: 0,
      });
    }
    return Promise.resolve(null);
  };
  const engine = new Proxy({} as any, {
    get(_, prop: string) {
      if (prop === '_calls') return calls;
      if (overrides[prop] && typeof overrides[prop] !== 'function') return overrides[prop];
      return track(prop);
    },
  });
  return engine;
}

export function embeddingUpdates(engine: BrainEngine) {
  return (engine as any)._calls.filter((call: any) => call.method === 'executeRaw'
    && /^UPDATE content_chunks SET/.test(call.args[0]));
}

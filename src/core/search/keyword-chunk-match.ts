/**
 * The chunk side of the Postgres keyword statement (PostgresEngine.searchKeyword):
 * where `cc` comes from, the full-text match, and the text-modality filter.
 *
 * excludePrivate (remote callers) adds correlated visibility subplans that
 * inflate the cost of every join plan, so a cheaper bitmap scan on the match
 * fell within the planner's 1% fuzz of a serial seq scan and lost on startup
 * cost; that seq scan detoasts every chunk's search_vector (~1.1 s for a
 * common term at 250k chunks). The OFFSET 0 subquery plans the match on its
 * own. Without those subplans the join plans well, often in parallel, which
 * an OFFSET subquery would forbid, so it stays unfenced.
 *
 * `modality = 'text'` (v0.27.1) hides image rows from text-keyword search so
 * OCR text doesn't drown text-page hits; image search runs a separate vector
 * path on embedding_image.
 *
 * `ftsLang` must already be validated (getFtsLanguage); `$1` is the websearch text.
 *
 * FORK: `pgroonga` swaps the match for the PGroonga operator (`chunk_text &@~ $1`), which
 * finds CJK text the english tsvector cannot split; ranking stays on the caller's ts_rank.
 */
/**
 * FORK: Groonga's query syntax only honors uppercase `OR`, while websearch_to_tsquery reads a bare `or`
 * in any case, so `acme or globex` would match nothing on the PGroonga path. Uppercase a bare `or`
 * between two terms outside double quotes (a phrase stays literal in both syntaxes). ts_rank reads the
 * same $1 and websearch parses `OR` exactly as `or`, so the tsvector side is unchanged.
 */
export function pgroongaWebsearchOr(query: string): string {
  return query.replace(/("[^"]*")|(?<=\S\s+)or(?=\s+\S)/gi, (_m, quoted) => quoted ?? 'OR');
}

export function buildKeywordChunkMatch(ftsLang: string, excludePrivate: boolean | undefined, pgroonga = false): { from: string; match: string; modality: string } {
  const tsq = `websearch_to_tsquery('${ftsLang}', $1)`;
  const matchOn = (alias: string) => pgroonga ? `${alias}chunk_text &@~ $1` : `${alias}search_vector @@ ${tsq}`;
  if (!excludePrivate) return { from: 'content_chunks cc', match: matchOn('cc.'), modality: `AND cc.modality = 'text'` };
  return {
    // chunk-visibility-ok: the outer search statement applies buildVisibilityClause(..., { chunkAlias: 'cc' }) to the generation columns this subquery projects
    from: `(
          SELECT id, page_id, chunk_index, chunk_text, chunk_source, search_vector, language, symbol_type, body_generation, occurrence_id
          FROM content_chunks
          WHERE ${matchOn('')} AND modality = 'text'
          OFFSET 0
        ) cc`,
    match: 'true',
    modality: '',
  };
}

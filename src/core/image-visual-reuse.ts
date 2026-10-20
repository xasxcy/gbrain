/**
 * FORK: an unchanged image keeps the visual vector it already has.
 *
 * `importImageFile` rebuilds an unchanged image when its index is incomplete
 * (missing OCR text while OCR is enabled, an unsealed projection). The bytes
 * are the same, so the multimodal provider would return the same vector; the
 * paid call is skipped and the stored vector is carried into the rebuilt
 * chunk.
 *
 * The page's `visual_model` frontmatter names the model that produced its
 * vector. A vector is reused only when that stamp equals the model the
 * provider would be called with now: after a multimodal model switch the
 * rebuild pays for a fresh vector in the current model's space. A page
 * written before the stamp existed counts as made by
 * `embedding_image_legacy_visual_model` when that config key is set (the
 * operator vouches for the model of the old vectors; no page is rewritten),
 * and otherwise pays once.
 *
 * Only the page's published body generation is read (not its text projection
 * state: a rebuild is often the repair of exactly that state).
 */
import type { BrainEngine } from './engine.ts';
import { parseEmbedding } from './utils.ts';
import { chunkGenerationFilter, chunkManifestReads } from './search/safe-chunks.ts';
import { getEmbeddingModel, getMultimodalModel } from './ai/gateway.ts';

/** The model `embedMultimodal` calls: `embedding_multimodal_model`, else `embedding_model`. */
export function currentVisualModel(): string {
  return getMultimodalModel() ?? getEmbeddingModel();
}

/**
 * Whether a page's vector counts as made by the current model: its `visual_model` stamp, else the
 * `embedding_image_legacy_visual_model` config (read once here; a failed read credits nothing).
 */
export async function currentModelCredit(engine: BrainEngine): Promise<(stamp: unknown) => boolean> {
  const legacy = await engine.getConfig('embedding_image_legacy_visual_model').catch(() => null);
  const current = currentVisualModel();
  return stamp => (stamp ?? legacy) === current && !!current;
}

/**
 * The stored visual vector of the `(sourceId, slug)` image page, or null when
 * it has none or its `visual_model` stamp (else the legacy model config) is not the current model. Callers
 * reuse it only when the image bytes are unchanged and no forced re-embed was
 * asked for.
 */
export async function reusableVisualVector(engine: BrainEngine, sourceId: string, slug: string,
  frontmatter: Record<string, unknown> | null | undefined): Promise<Float32Array | null> {
  // Only an unstamped page reads the legacy config.
  const stamp = frontmatter?.visual_model;
  if (!(stamp != null ? stamp === currentVisualModel() : (await currentModelCredit(engine))(null))) return null;
  const [row] = await engine.executeRaw<{ vec: string | null }>(
    `SELECT c.embedding_image::text AS vec FROM pages p JOIN content_chunks c ON c.page_id = p.id
      WHERE p.source_id = $1 AND p.slug = $2 AND c.embedding_image IS NOT NULL
        AND ${chunkGenerationFilter('p', 'c', await chunkManifestReads(engine))}
      ORDER BY c.chunk_index LIMIT 1`, [sourceId, slug]);
  const vec = parseEmbedding(row?.vec ?? null);
  return vec && vec.length > 0 ? vec : null;
}

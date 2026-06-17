import type { MultimodalInput } from './types.ts';
import { AIConfigError, AITransientError } from './errors.ts';

const DASHSCOPE_MULTIMODAL_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding';

const TIMEOUT_MS = 60_000;

export interface DashScopeMultimodalOpts {
  dimension?: number;
}

/**
 * Calls the DashScope qwen3-vl-embedding private HTTP endpoint.
 * NOT the OpenAI-compat path — uses input.contents[] + parameters.dimension.
 * Serial per input to avoid rate-limit bursts; ~100 DayOne images is fine.
 */
export async function embedMultimodalDashScope(
  inputs: MultimodalInput[],
  modelId: string,
  apiKey: string,
  opts: DashScopeMultimodalOpts = {},
): Promise<Float32Array[]> {
  const dimension = opts.dimension ?? 1024;
  const results: Float32Array[] = [];
  for (const input of inputs) {
    results.push(await embedOne(input, modelId, apiKey, dimension));
  }
  return results;
}

async function embedOne(
  input: MultimodalInput,
  modelId: string,
  apiKey: string,
  dimension: number,
): Promise<Float32Array> {
  // DashScope qwen3-vl-embedding hard limit: 10 MB per image.
  // base64 data length * 0.75 ≈ raw bytes.
  if (input.kind === 'image_base64') {
    const rawBytes = input.data.length * 0.75;
    if (rawBytes > 10 * 1024 * 1024) {
      throw new AIConfigError(
        `DashScope qwen3-vl-embedding: image exceeds 10 MB limit (${(rawBytes / 1024 / 1024).toFixed(1)} MB).`,
        'Resize the image before embedding.',
      );
    }
  }

  // Map MultimodalInput → DashScope HTTP contents item.
  // MultimodalInput: { kind: 'image_base64'; data: string; mime: string }
  //               | { kind: 'text'; text: string }
  // DashScope:    { image: "data:<mime>;base64,<data>" } | { text: string }
  let contentsItem: { image: string } | { text: string };
  if (input.kind === 'image_base64') {
    contentsItem = { image: `data:${input.mime};base64,${input.data}` };
  } else {
    contentsItem = { text: input.text };
  }

  const body = {
    model: modelId,
    input: { contents: [contentsItem] },
    parameters: { enable_fusion: true, dimension },
  };

  let resp: Response;
  try {
    resp = await fetch(DASHSCOPE_MULTIMODAL_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: unknown) {
    throw new AITransientError(
      `DashScope multimodal network error: ${String(err)}`,
      err,
    );
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    if (resp.status === 429 || resp.status >= 500) {
      throw new AITransientError(`DashScope transient error (${resp.status}): ${text}`);
    }
    throw new AIConfigError(
      `DashScope multimodal error (${resp.status}): ${text}`,
      resp.status === 401 || resp.status === 403
        ? 'Check DASHSCOPE_MULTIMODAL_API_KEY (or QWEN3_VL_EMBEDDING_API_KEY).'
        : 'Check request format and model/dimension support.',
    );
  }

  const json = await resp.json() as DashScopeResponse;
  if (json.code) {
    throw new AIConfigError(`DashScope API error: ${json.code} ${json.message ?? ''}`);
  }

  const embedding = json.output?.embeddings?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new AITransientError(
      `DashScope returned no embedding. Response: ${JSON.stringify(json)}`,
    );
  }
  if (embedding.length !== dimension) {
    throw new AIConfigError(
      `DashScope returned ${embedding.length}d vector, expected ${dimension}d.`,
      `Check that the model supports dimension=${dimension} and the API parameter was accepted.`,
    );
  }
  return new Float32Array(embedding);
}

interface DashScopeResponse {
  output?: { embeddings: Array<{ embedding: number[] }> };
  code?: string;
  message?: string;
}

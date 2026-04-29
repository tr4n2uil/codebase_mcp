import './ort-env-early.js';
import type { AppConfig } from './config.js';
import { logInfo } from './log.js';
import { applyOrtSessionCpuCaps } from './onnx-ort-caps.js';
import type { SearchHit } from './store.js';

/** Fusion rerank score from `rerankSearchHits`, preserved through CE for debug + match-confidence primary(). */
export type CrossEncoderInputHit = SearchHit & { rerank_score?: number };

type CrossEncoderBundle = {
  tokenizer: {
    (
      text: string | string[],
      options?: {
        text_pair?: string | string[];
        padding?: boolean | 'max_length';
        truncation?: boolean;
        max_length?: number;
        return_token_type_ids?: boolean;
      },
    ): Promise<Record<string, unknown>> | Record<string, unknown>;
  };
  model: { (inputs: Record<string, unknown>): Promise<{ logits: { data: Float32Array; dims: number[] } }> };
};

let crossEncoderBundle: CrossEncoderBundle | null = null;
let crossEncoderLoad: Promise<CrossEncoderBundle> | null = null;

function sigmoid(x: number): number {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

/** Read one relevance score per row from [batch, num_labels] (BGE uses num_labels=1). */
function logitsToScores(logits: { data: Float32Array; dims: number[] }): number[] {
  const { data, dims } = logits;
  if (dims.length === 0) {
    return [];
  }
  if (dims.length === 1) {
    return Array.from(data);
  }
  const batch = dims[0] ?? 0;
  const last = dims[dims.length - 1] ?? 1;
  const out: number[] = [];
  for (let r = 0; r < batch; r++) {
    const v = data[r * last + (last - 1)]!;
    out.push(v);
  }
  return out;
}

async function getCrossEncoder(config: AppConfig): Promise<CrossEncoderBundle> {
  if (crossEncoderBundle) {
    return crossEncoderBundle;
  }
  if (crossEncoderLoad) {
    try {
      return await crossEncoderLoad;
    } catch {
      crossEncoderLoad = null;
      crossEncoderBundle = null;
    }
  }
  crossEncoderLoad = (async () => {
    applyOrtSessionCpuCaps(config);
    const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import('@xenova/transformers');
    const w = (env as { backends?: { onnx?: { wasm?: { numThreads?: number } } } })?.backends?.onnx?.wasm;
    if (w && typeof w === 'object' && 'numThreads' in w) {
      w.numThreads = Math.max(1, Math.min(32, config.ortWasmNumThreads));
    }
    const modelId = config.crossEncoderModel;
    logInfo('cross-encoder', `loading ${modelId} (first use; may download/cache)…`);
    const tokenizer = await AutoTokenizer.from_pretrained(modelId);
    const model = await AutoModelForSequenceClassification.from_pretrained(modelId);
    const tok = tokenizer as unknown as CrossEncoderBundle['tokenizer'];
    const m = model as unknown as CrossEncoderBundle['model'];
    const bundle: CrossEncoderBundle = { tokenizer: tok, model: m };
    crossEncoderBundle = bundle;
    logInfo('cross-encoder', `ready: ${modelId}`);
    return bundle;
  })();
  return crossEncoderLoad;
}

/**
 * Re-score the first `poolK` hits with a cross-encoder, return the best `returnTop` by relevance.
 * Strips any heuristic `rerank_score`; `score` becomes the sigmoid of the cross-encoder logit.
 */
export async function runCrossEncoderRerank(
  config: AppConfig,
  query: string,
  ranked: CrossEncoderInputHit[],
  poolK: number,
  returnTop: number,
): Promise<SearchHit[]> {
  if (poolK <= 0 || returnTop <= 0 || ranked.length === 0) {
    return [];
  }
  const n = Math.min(ranked.length, poolK);
  const slice = ranked.slice(0, n);
  const { tokenizer, model } = await getCrossEncoder(config);
  const allScores: number[] = [];
  const batch = Math.max(1, config.crossEncoderBatch);
  for (let i = 0; i < slice.length; i += batch) {
    const part = slice.slice(i, i + batch);
    const qArr = new Array<string>(part.length).fill(query);
    const passages = part.map((h) => h.text);
    const tokFn = tokenizer as (q: string[], o: object) => Promise<Record<string, unknown>>;
    const modelInputs = await tokFn(qArr, {
      text_pair: passages,
      padding: true,
      truncation: true,
      max_length: 512,
      return_token_type_ids: true,
    });
    const out = await model(modelInputs);
    const rowScores = logitsToScores(out.logits);
    for (const s of rowScores) {
      allScores.push(s);
    }
  }
  if (allScores.length !== slice.length) {
    throw new Error(
      `Cross-encoder score count mismatch: expected ${slice.length}, got ${allScores.length}`,
    );
  }
  const indexed = slice.map((h, j) => ({
    hit: h,
    logit: allScores[j]!,
  }));
  indexed.sort((a, b) => b.logit - a.logit);
  const outHits: SearchHit[] = [];
  for (let i = 0; i < Math.min(returnTop, indexed.length); i++) {
    const { hit, logit } = indexed[i]!;
    const ceOk = Number.isFinite(logit);
    const displayScore = ceOk ? sigmoid(logit) : hit.score;
    outHits.push({
      path: hit.path,
      start_line: hit.start_line,
      end_line: hit.end_line,
      text: hit.text,
      score: Number.isFinite(displayScore) ? displayScore : hit.score,
      ...(hit.definition_of ? { definition_of: hit.definition_of } : {}),
      ...(typeof hit.rerank_score === 'number' && Number.isFinite(hit.rerank_score)
        ? { rerank_score: hit.rerank_score }
        : {}),
      ...(ceOk ? { cross_encoder_logit: logit } : {}),
    });
  }
  return outHits;
}

export function makeCrossEncoderPoolK(config: AppConfig, rankedLen: number, returnTop: number): number {
  if (rankedLen === 0 || returnTop <= 0) {
    return 0;
  }
  return Math.min(rankedLen, Math.max(returnTop, config.crossEncoderTopK));
}

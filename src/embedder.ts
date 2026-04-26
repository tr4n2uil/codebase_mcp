import { pipeline } from '@xenova/transformers';
import type { AppConfig } from './config.js';

type FeatureExtractor = (texts: string | string[], options?: object) => Promise<{ data: Float32Array; dims?: number[] }>;

let extractorPromise: Promise<FeatureExtractor> | null = null;

export function getEmbedder(config: AppConfig): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', config.embeddingModel).then((p) => p as FeatureExtractor);
  }
  return extractorPromise;
}

function tensorToVectors(tensor: { data: Float32Array; dims?: number[] }, expectedDim: number): Float32Array[] {
  const data = tensor.data;
  const dims = tensor.dims ?? [];
  if (dims.length === 1 && dims[0] === expectedDim) {
    return [data];
  }
  if (dims.length === 2 && dims[1] === expectedDim) {
    const rows = dims[0] ?? 0;
    const out: Float32Array[] = [];
    for (let r = 0; r < rows; r++) {
      const start = r * expectedDim;
      out.push(data.slice(start, start + expectedDim));
    }
    return out;
  }
  if (data.length % expectedDim === 0) {
    const rows = data.length / expectedDim;
    const out: Float32Array[] = [];
    for (let r = 0; r < rows; r++) {
      const start = r * expectedDim;
      out.push(data.slice(start, start + expectedDim));
    }
    return out;
  }
  throw new Error(`Unexpected embedding tensor shape: dims=${JSON.stringify(dims)} len=${data.length}`);
}

export async function embedTexts(
  extractor: FeatureExtractor,
  texts: string[],
  expectedDim: number,
): Promise<Float32Array[]> {
  if (texts.length === 0) {
    return [];
  }
  const tensor = await extractor(texts, { pooling: 'mean', normalize: true });
  return tensorToVectors(tensor, expectedDim);
}

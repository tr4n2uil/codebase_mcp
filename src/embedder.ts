import { pipeline } from '@xenova/transformers';
import type { AppConfig } from './config.js';
import { logError, logInfo } from './log.js';

type FeatureExtractor = (texts: string | string[], options?: object) => Promise<{ data: Float32Array; dims?: number[] }>;

let extractorPromise: Promise<FeatureExtractor> | null = null;

export function getEmbedder(config: AppConfig): Promise<FeatureExtractor> {
  if (!extractorPromise) {
    logInfo('embedder', `loading ${config.embeddingModel} (first use; may download/cache)…`);
    extractorPromise = pipeline('feature-extraction', config.embeddingModel)
      .then(async (p) => {
        const ex = p as FeatureExtractor;
        // First real run compiles/optimizes the ONNX graph; without this, the pause happens on the first indexer batch and looks "stuck".
        logInfo(
          'embedder',
          'warmup: first ONNX run (graph compile; on CPU this often takes 1–10+ minutes, high usage is expected)…',
        );
        const warm = Array.from({ length: Math.min(8, Math.max(1, config.embedBatchSize)) }, () => 'x');
        await withInferencePendingLogs('warmup', ex(warm, { pooling: 'mean', normalize: true }));
        logInfo('embedder', `ready: ${config.embeddingModel}`);
        return ex;
      })
      .catch((e) => {
        logError('embedder', `failed to load ${config.embeddingModel}`, e);
        extractorPromise = null;
        throw e;
      });
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

const HEARTBEAT_MS = 20_000;

function withInferencePendingLogs<T>(label: string, p: Promise<T>): Promise<T> {
  const t0 = Date.now();
  const id = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    logInfo(
      'embedder',
      `… still in ${label} (${s}s) — not frozen; set CODEBASE_MCP_EMBED_BATCH_SIZE=1 for smaller steps`,
    );
  }, HEARTBEAT_MS);
  return p.finally(() => {
    clearInterval(id);
  });
}

export async function embedTexts(
  extractor: FeatureExtractor,
  texts: string[],
  expectedDim: number,
): Promise<Float32Array[]> {
  if (texts.length === 0) {
    return [];
  }
  const inputChars = texts.reduce((n, t) => n + t.length, 0);
  logInfo(
    'embedder',
    `inference: ${texts.length} input(s), ~${(inputChars / 1024).toFixed(0)} KiB text (this can take a while; high CPU is normal)…`,
  );
  const tensor = await withInferencePendingLogs(
    'batch inference',
    extractor(texts, { pooling: 'mean', normalize: true }),
  );
  return tensorToVectors(tensor, expectedDim);
}

import './ort-env-early.js';
import type { AppConfig } from './config.js';
import { logError, logInfo } from './log.js';
import { applyOrtSessionCpuCaps } from './onnx-ort-caps.js';

type FeatureExtractor = (texts: string | string[], options?: object) => Promise<{ data: Float32Array; dims?: number[] }>;

type Embedder =
  | { kind: 'local'; extractor: FeatureExtractor }
  | { kind: 'http'; url: string; model: string; apiKey?: string };

let embedderPromise: Promise<Embedder> | null = null;

export function getEmbedder(config: AppConfig): Promise<Embedder> {
  if (!embedderPromise) {
    if (config.embedBackend === 'http') {
      if (!config.embedHttpUrl) {
        throw new Error('CODEBASE_MCP_EMBED_BACKEND=http requires CODEBASE_MCP_EMBED_HTTP_URL');
      }
      const url = config.embedHttpUrl.replace(/\/+$/, '');
      logInfo('embedder', `using HTTP backend at ${url}`);
      embedderPromise = Promise.resolve({
        kind: 'http',
        url,
        model: config.embeddingModel,
        apiKey: config.embedHttpApiKey,
      });
      return embedderPromise;
    }
    applyOrtSessionCpuCaps(config);
    embedderPromise = (async () => {
      // Dynamic import: ORT is patched in applyOrtSessionCpuCaps (before native + xenova see ORT).
      const { pipeline, env } = await import('@xenova/transformers');
      const w = (env as { backends?: { onnx?: { wasm?: { numThreads?: number } } } }).backends?.onnx
        ?.wasm;
      if (w && typeof w === 'object' && 'numThreads' in w) {
        w.numThreads = Math.max(1, Math.min(32, config.ortWasmNumThreads));
      }
      logInfo('embedder', `loading ${config.embeddingModel} (first use; may download/cache)…`);
      try {
        const p = await pipeline('feature-extraction', config.embeddingModel);
        const ex = p as FeatureExtractor;
        // First real run compiles/optimizes the ONNX graph; without this, the pause happens on the first indexer batch and looks "stuck".
        logInfo(
          'embedder',
          'warmup: first ONNX run (graph compile; on CPU this often takes 1–10+ minutes, high usage is expected)…',
        );
        const warm = Array.from({ length: Math.min(8, Math.max(1, config.embedBatchSize)) }, () => 'x');
        await withInferencePendingLogs(
          'warmup',
          ex(warm, { pooling: 'mean', normalize: true }),
          config.embedInferenceLogMs,
        );
        logInfo('embedder', `ready: ${config.embeddingModel}`);
        return { kind: 'local' as const, extractor: ex };
      } catch (e) {
        logError('embedder', `failed to load ${config.embeddingModel}`, e);
        embedderPromise = null;
        throw e;
      }
    })();
  }
  return embedderPromise;
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

function withInferencePendingLogs<T>(label: string, p: Promise<T>, intervalMs: number): Promise<T> {
  if (intervalMs <= 0) {
    return p;
  }
  const t0 = Date.now();
  const id = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    logInfo(
      'embedder',
      `… still in ${label} (${s}s) — not frozen; high CPU is normal. Set CODEBASE_MCP_EMBED_INFER_LOG_MS=0 to silence`,
    );
  }, intervalMs);
  return p.finally(() => {
    clearInterval(id);
  });
}

export async function embedTexts(
  embedder: Embedder,
  texts: string[],
  expectedDim: number,
  inferenceLogMs = 0,
): Promise<Float32Array[]> {
  if (texts.length === 0) {
    return [];
  }
  const inputChars = texts.reduce((n, t) => n + t.length, 0);
  logInfo(
    'embedder',
    `inference: ${texts.length} input(s), ~${(inputChars / 1024).toFixed(0)} KiB text (this can take a while; high CPU is normal)…`,
  );
  if (embedder.kind === 'local') {
    const tensor = await withInferencePendingLogs(
      'batch inference',
      embedder.extractor(texts, { pooling: 'mean', normalize: true }),
      inferenceLogMs,
    );
    return tensorToVectors(tensor, expectedDim);
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (embedder.apiKey) {
    headers.authorization = `Bearer ${embedder.apiKey}`;
  }
  const body = JSON.stringify({ input: texts, model: embedder.model });
  const resp = await fetch(embedder.url, { method: 'POST', headers, body });
  if (!resp.ok) {
    const msg = await resp.text().catch(() => '');
    throw new Error(`HTTP embed failed (${resp.status}): ${msg || resp.statusText}`);
  }
  const data = (await resp.json()) as unknown;
  const rows = parseHttpEmbeddings(data);
  const out = rows.map((row) => {
    const v = Float32Array.from(row);
    if (v.length !== expectedDim) {
      throw new Error(`HTTP embedding dim mismatch: expected ${expectedDim}, got ${v.length}`);
    }
    return v;
  });
  if (out.length !== texts.length) {
    throw new Error(`HTTP embedding count mismatch: expected ${texts.length}, got ${out.length}`);
  }
  return out;
}

function parseHttpEmbeddings(payload: unknown): number[][] {
  if (Array.isArray(payload) && payload.every((r) => Array.isArray(r))) {
    return payload as number[][];
  }
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.embeddings) && p.embeddings.every((r) => Array.isArray(r))) {
      return p.embeddings as number[][];
    }
    if (Array.isArray(p.data)) {
      const rows: number[][] = [];
      for (const it of p.data) {
        if (!it || typeof it !== 'object') {
          continue;
        }
        const emb = (it as Record<string, unknown>).embedding;
        if (Array.isArray(emb)) {
          rows.push(emb as number[]);
        }
      }
      if (rows.length > 0) {
        return rows;
      }
    }
  }
  throw new Error('HTTP embedding response format not recognized');
}

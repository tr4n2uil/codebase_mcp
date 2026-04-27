# Embeddings & ONNX

Indexing and search both use **`@xenova/transformers`** in Node: a `feature-extraction` **pipeline** loads an ONNX model (via `onnxruntime-node` for CPU by default) and returns embedding vectors. The same code path is used for **ingest** (batched chunk strings) and **query** (single string, possibly batched in API shape).

## Startup order (why it matters)

ONNX and native BLAS can spin many threads if started **before** thread limits are set. The codebase enforces:

1. **`ort-env-early.ts`** — Imported first from `main`, `daemon-entry`, and `embedder`. Sets `OMP_NUM_THREADS`, `OPENBLAS_NUM_THREADS`, `VECLIB_MAXIMUM_THREADS`, `MKL_NUM_THREADS`, and `NUMEXPR_MAX_THREADS` from `CODEBASE_MCP_ORT_INTRA_OP_THREADS` unless `CODEBASE_MCP_ORT_UNLIMITED` is set. No Transformers or ORT import runs before this in those entry files.

2. **`onnx-ort-caps.ts`** — `applyOrtSessionCpuCaps(config)` is called **before** the dynamic `import('@xenova/transformers')` in `getEmbedder`. It `require()`s `onnxruntime-node` and wraps `InferenceSession.create` to merge `intraOpNumThreads` / `interOpNumThreads` and optional `executionMode: 'sequential'`. Patching uses the same module resolution as the library: `ort.default ?? ort`.

3. **Dynamic import** — `embedder.ts` does not statically import Transformers; it loads the library only after `applyOrtSessionCpuCaps`, then sets `env.backends.onnx.wasm.numThreads` if applicable.

## Configuration surface

| Env (subset) | Role |
|--------------|------|
| `CODEBASE_MCP_ORT_UNLIMITED` | Skip capping (default `false`) |
| `CODEBASE_MCP_ORT_INTRA_OP_THREADS` / `..._INTER_...` | ORT session thread caps (defaults `1`) |
| `CODEBASE_MCP_ORT_SEQUENTIAL` | Prefer sequential execution mode when capping (default on) |
| `CODEBASE_MCP_ORT_WASM_NUM_THREADS` | Wasm path only (default `1`) |
| `CODEBASE_MCP_EMBED_INFER_LOG_MS` | Heartbeat log interval during long ONNX work |

## Warmup

`getEmbedder` runs a small **warmup** batch so the first “real” indexer batch does not pay all compile cost alone (logged in `embedder`).

## Related code

- `embedder.ts` — `getEmbedder`, `embedTexts`, `withInferencePendingLogs`
- `onnx-ort-caps.ts` — `applyOrtSessionCpuCaps`
- `ort-env-early.ts` — process env before native loads
- `config.ts` — ORT-related fields in `loadConfig()`

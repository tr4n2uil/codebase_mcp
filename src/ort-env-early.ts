/**
 * Set OMP/BLAS thread env before any native ORT/BLAS load. This module must be imported
 * first from entry points and from `embedder.ts` (before @xenova or onnxruntime-node).
 */
function ortUnlimitedFromEnv(): boolean {
  const v = process.env.CODEBASE_MCP_ORT_UNLIMITED?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function intraFromEnv(): number {
  const raw = process.env.CODEBASE_MCP_ORT_INTRA_OP_THREADS;
  if (raw === undefined || raw.trim() === '') {
    return 1;
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 1) {
    return 1;
  }
  return Math.min(32, n);
}

if (typeof process !== 'undefined' && process?.release?.name === 'node' && !ortUnlimitedFromEnv()) {
  const n = String(Math.max(1, intraFromEnv()));
  if (!process.env.OMP_NUM_THREADS) {
    process.env.OMP_NUM_THREADS = n;
  }
  if (!process.env.OPENBLAS_NUM_THREADS) {
    process.env.OPENBLAS_NUM_THREADS = n;
  }
  if (!process.env.MKL_NUM_THREADS) {
    process.env.MKL_NUM_THREADS = n;
  }
  if (!process.env.VECLIB_MAXIMUM_THREADS) {
    process.env.VECLIB_MAXIMUM_THREADS = n;
  }
  if (!process.env.NUMEXPR_MAX_THREADS) {
    process.env.NUMEXPR_MAX_THREADS = n;
  }
}

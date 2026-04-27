import { createRequire } from 'node:module';
import type { InferenceSession } from 'onnxruntime-common';
import type { AppConfig } from './config.js';
import { logInfo } from './log.js';

const require = createRequire(import.meta.url);

type CreateFn = typeof InferenceSession.create;

let patched = false;

/**
 * @xenova/transformers only passes `executionProviders` to `InferenceSession.create`, so ONNX
 * Runtime defaults to many intra-op threads → high CPU. We wrap `create` once to cap threads.
 * Must run after `ort-env-early.ts` and before any `@xenova/transformers` import that loads ORT.
 * Uses `createRequire` so the native ORT binding loads only here (after env is set).
 */
export function applyOrtSessionCpuCaps(config: AppConfig): void {
  if (patched || config.ortUnlimited) {
    return;
  }
  if (typeof process === 'undefined' || process?.release?.name !== 'node') {
    return;
  }

  const { ortIntraOpThreads, ortInterOpThreads, ortSequential } = config;
  if (!process.env.OMP_NUM_THREADS) {
    process.env.OMP_NUM_THREADS = String(Math.max(1, ortIntraOpThreads));
  }
  if (!process.env.VECLIB_MAXIMUM_THREADS) {
    process.env.VECLIB_MAXIMUM_THREADS = String(Math.max(1, ortIntraOpThreads));
  }
  if (!process.env.MKL_NUM_THREADS) {
    process.env.MKL_NUM_THREADS = String(Math.max(1, ortIntraOpThreads));
  }
  if (!process.env.OPENBLAS_NUM_THREADS) {
    process.env.OPENBLAS_NUM_THREADS = String(Math.max(1, ortIntraOpThreads));
  }

  // Same resolution as @xenova (backends/onnx.js): `ONNX = ONNX_NODE.default ?? ONNX_NODE`
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ORT: typeof import('onnxruntime-node') = require('onnxruntime-node');
  const ortMod = (ORT as { default?: typeof ORT } & typeof ORT).default ?? ORT;
  const IS = ortMod.InferenceSession;
  if (!IS?.create) {
    return;
  }
  if ((IS as { __mcpOrtPatched?: boolean }).__mcpOrtPatched) {
    return;
  }

  const orig = IS.create.bind(IS) as CreateFn;
  const cap: InferenceSession.SessionOptions = {
    intraOpNumThreads: Math.max(1, ortIntraOpThreads),
    interOpNumThreads: Math.max(1, ortInterOpThreads),
  };
  if (ortSequential) {
    cap.executionMode = 'sequential';
  }
  const merge = (o: InferenceSession.SessionOptions | undefined): InferenceSession.SessionOptions => ({
    ...o,
    ...cap,
  });

  (IS as { create: CreateFn; __mcpOrtPatched?: boolean }).create = ((
    a0: string | ArrayBuffer | SharedArrayBuffer | Uint8Array,
    a1?: InferenceSession.SessionOptions | number,
    a2?: number,
    a3?: InferenceSession.SessionOptions,
  ) => {
    if (typeof a0 === 'string') {
      return orig(a0, merge(a1 as InferenceSession.SessionOptions | undefined));
    }
    if (a0 instanceof Uint8Array) {
      return orig(a0, merge(a1 as InferenceSession.SessionOptions | undefined));
    }
    if (a0 instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && a0 instanceof SharedArrayBuffer)) {
      if (typeof a1 === 'object' && a1 !== null) {
        return orig(a0, merge(a1 as InferenceSession.SessionOptions));
      }
      if (typeof a1 === 'number') {
        return orig(a0, a1, a2 ?? 0, merge(a3));
      }
    }
    return orig(a0 as never, a1 as never, a2 as never, a3 as never);
  }) as CreateFn;

  (IS as { __mcpOrtPatched?: boolean }).__mcpOrtPatched = true;
  patched = true;
  logInfo(
    'embedder',
    `ONNX session CPU caps: intraOp=${cap.intraOpNumThreads} interOp=${cap.interOpNumThreads} mode=${
      cap.executionMode ?? 'default'
    } (set CODEBASE_MCP_ORT_UNLIMITED=1 to use ONNX Runtime defaults)`,
  );
}

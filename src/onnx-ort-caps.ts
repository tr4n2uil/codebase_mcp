import { env as transformersEnv } from '@xenova/transformers';
import type { InferenceSession } from 'onnxruntime-common';
import * as ORT from 'onnxruntime-node';
import type { AppConfig } from './config.js';
import { logInfo } from './log.js';

type CreateFn = typeof InferenceSession.create;

let patched = false;

/**
 * @xenova/transformers only passes `executionProviders` to `InferenceSession.create`, so ONNX
 * Runtime defaults to many intra-op threads → 300–500% CPU in Activity Monitor. We wrap `create`
 * once to set intra/inter threads and (by default) sequential execution so the host is less
 * likely to throttle or kill the daemon.
 */
export function applyOrtSessionCpuCaps(config: AppConfig): void {
  if (patched || config.ortUnlimited) {
    return;
  }
  if (typeof process === 'undefined' || process?.release?.name !== 'node') {
    return;
  }

  const { ortIntraOpThreads, ortInterOpThreads, ortSequential, ortWasmNumThreads } = config;
  if (!process.env.OMP_NUM_THREADS) {
    process.env.OMP_NUM_THREADS = String(Math.max(1, ortIntraOpThreads));
  }
  if (!process.env.VECLIB_MAXIMUM_THREADS) {
    process.env.VECLIB_MAXIMUM_THREADS = String(Math.max(1, ortIntraOpThreads));
  }
  if (!process.env.MKL_NUM_THREADS) {
    process.env.MKL_NUM_THREADS = String(Math.max(1, ortIntraOpThreads));
  }

  const IS = ORT.InferenceSession;
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

  const w = (transformersEnv as { backends?: { onnx?: { wasm?: { numThreads?: number } } } }).backends
    ?.onnx?.wasm;
  if (w && typeof w === 'object' && 'numThreads' in w) {
    w.numThreads = Math.max(1, Math.min(32, ortWasmNumThreads));
  }

  (IS as { __mcpOrtPatched?: boolean }).__mcpOrtPatched = true;
  patched = true;
  logInfo(
    'embedder',
    `ONNX session CPU caps: intraOp=${cap.intraOpNumThreads} interOp=${cap.interOpNumThreads} mode=${
      cap.executionMode ?? 'default'
    } (set CODEBASE_MCP_ORT_UNLIMITED=1 to use ONNX Runtime defaults)`,
  );
}

import path from 'node:path';
import { parseForceIncludeList, parseIndexExcludeList } from './force-include.js';
import { defaultMatchConfRerank, defaultMatchConfVector } from './search-confidence.js';

const DEFAULT_MODEL = 'Xenova/jina-embeddings-v2-base-en';
const DEFAULT_EMBEDDING_DIM = 768;
const DEFAULT_EMBED_INFER_LOG_MS = 20_000;

/** Default index + logs under the repo (per `CODEBASE_MCP_ROOT`). Override with `CODEBASE_MCP_INDEX_DIR`. */
function defaultIndexDirAbs(watchRootAbs: string): string {
  return path.join(watchRootAbs, '.claude', 'codebase_mcp', 'db');
}

export interface AppConfig {
  watchRootAbs: string;
  indexDirAbs: string;
  lanceDirAbs: string;
  metaPathAbs: string;
  embeddingModel: string;
  embeddingDim: number;
  /** Embedding backend: `local` (Transformers.js ONNX) or `http` (external embedding service). */
  embedBackend: 'local' | 'http';
  /** Base URL for HTTP embedding backend (used when `embedBackend === 'http'`). */
  embedHttpUrl: string;
  /** Optional bearer token for HTTP embedding backend. */
  embedHttpApiKey?: string;
  /** Chunks per embedding call (1–32). Smaller = more progress logs, less RAM per op; CPU can still be slow. */
  embedBatchSize: number;
  /**
   * Log a “still in inference” line at this interval (ms) during ONNX work. Default 20_000. Set `0` to disable.
   */
  embedInferenceLogMs: number;
  chunkLines: number;
  chunkOverlapLines: number;
  maxFileBytes: number;
  debounceMs: number;
  reconcileIntervalMs: number;
  /** When true, use polling instead of native fs.watch (avoids EMFILE on huge trees). */
  usePolling: boolean;
  /** Polling interval when usePolling is true (ms). */
  pollingIntervalMs: number;
  /**
   * Repo-relative POSIX paths that bypass .gitignore for indexing (safety rules still apply).
   * From `CODEBASE_MCP_WORKING_DOCS_PATH` (comma/newline list; default includes `.claude/docs`).
   */
  workingDocsPathsRelPosix: string[];
  /**
   * Gitignore-style patterns (repo-relative) never indexed; not written to `.gitignore`.
   * Overrides `workingDocsPathsRelPosix` for matching paths. Parsed from `CODEBASE_MCP_INDEX_EXCLUDE`.
   */
  indexExcludeRelPosix: string[];
  /**
   * When true (default), unscoped `codebase_search` omits hits under `workingDocsPathsRelPosix` (same list
   * as `CODEBASE_MCP_WORKING_DOCS_PATH`). Those paths are still indexed; to search them, set `path_prefix` to
   * a prefix that includes them. Disable with `CODEBASE_MCP_SEARCH_EXCLUDE_FORCE_INCLUDE=0`.
   */
  searchExcludeForceInclude: boolean;
  /** Enable symbol-aware chunking with line-window fallback. */
  codeAwareChunking: boolean;
  /** Enable config-aware JSON/YAML section chunking (off by default). */
  configAwareChunking: boolean;
  /** Enable lexical/path reranking over vector-search candidates. */
  rerankEnabled: boolean;
  /** Candidate pool size for reranking. */
  rerankCandidates: number;
  /**
   * When true, search combines LanceDB vector kNN with BM25 full-text (FTS) and RRF.
   * Requires an FTS index on `text` (created by the indexing daemon on `init`).
   */
  hybridSearch: boolean;
  /** RRF `k` constant (default 60, common in the literature). */
  rrfK: number;
  /** Max results requested per channel before RRF; should be ≥ rerankCandidates for best results. */
  hybridDepth: number;
  /** Substrings in repo-relative path (case-insensitive) that lower search rank. From `CODEBASE_MCP_RERANK_DEMOTE_PATHS`. */
  rerankDemotePathSubstrings: string[];
  /**
   * For each path substring that matches, subtract this from the rerank path prior (capped in reranker).
   * From `CODEBASE_MCP_RERANK_DEMOTE_STRENGTH` (default 0.1).
   */
  rerankDemotePerMatch: number;
  /** Include reranking diagnostic fields in search output. */
  rerankDebugScores: boolean;
  /**
   * When true, `codebase_search` JSON includes `match_confidence` and related fields
   * (heuristic, tunable with `CODEBASE_MCP_MATCH_CONF_*`).
   */
  searchMatchConfidence: boolean;
  /** Below = `match_confidence: low` on the primary (rerank or vector) scale. */
  searchMatchWeakBelow: number;
  /** At or above with clear separation = `high` (heuristic). */
  searchMatchStrongAbove: number;
  /** Min relative (top−2nd)/|top| to treat top as clearly separated. */
  searchMatchMinGap: number;
  /**
   * When true, **high** `match_confidence` may be downgraded to **medium** for short identifier-like
   * queries. Disable with `CODEBASE_MCP_MATCH_CONF_AMBIG_LIT=0`.
   */
  matchConfAmbiguousLiteralDowngrade: boolean;
  /**
   * When true, **high** may be downgraded when top-2 hits are different file-type families (e.g. Ruby vs
   * TS/JS). Disable with `CODEBASE_MCP_MATCH_CONF_XDOMAIN_EXT=0`.
   */
  matchConfTopPathFamilyDivergence: boolean;
  /**
   * When true and the query looks like a definition request (“where is X defined?”), boost chunks
   * whose `definition_of` metadata matches. Requires code-aware reindex. Disable with
   * `CODEBASE_MCP_DEF_BOOST=0`.
   */
  definitionBoostEnabled: boolean;
  /** Additive path prior in rerank when `definition_of` matches parsed symbol (0–0.5). */
  definitionBoost: number;
  /**
   * When true, queries that mention test/spec/jest/etc. *boost* `spec/`, `test/`, `__tests__` paths
   * in the reranker instead of de-prioritizing them. Set `CODEBASE_MCP_TEST_PATH_QUERY_BOOST=0` to always
   * use the legacy demotion for those paths.
   */
  testPathQueryBoost: boolean;
  /**
   * When true, queries that look UI/React/TS-oriented **boost** common frontend path shapes (e.g. `.tsx`,
   * `components/`, `app/javascript/`). `CODEBASE_MCP_FRONTEND_PATH_QUERY_BOOST=0` disables.
   */
  frontendPathQueryBoost: boolean;
  /**
   * When true, the indexer includes `def=…` in the **embedding** prefix (alongside `path=`, `symbol=`, etc.).
   * Default **true**: definition labels steer retrieval as well as `definition_of`-based rerank. Set
   * `CODEBASE_MCP_EMBED_DEF_TAG=0` for rerank-only (re-embed after changing).
   */
  embedDefTagInChunk: boolean;
  /**
   * Definition detection for code-aware chunking: `regex` (line heuristics), `tree_sitter` / `auto`
   * (native `tree-sitter` when installed; merge with regex per line; falls back to regex if native load fails).
   */
  defEngine: 'auto' | 'tree_sitter' | 'regex';
  /** Do not run tree-sitter parse on files larger than this (bytes). */
  treeSitterMaxBytes: number;
  /** Log every indexed file path (can be noisy on large repos). */
  logIndexEachFile: boolean;
  /** Log each MCP tool invocation to stderr. */
  logMcpTools: boolean;
  /**
   * When true, do not cap ONNX `InferenceSession` thread counts (Transformers.js otherwise leaves ORT
   * defaults, which can use all cores and look like 400% CPU to macOS).
   */
  ortUnlimited: boolean;
  /** ONNX `intraOpNumThreads` (see onnxruntime). Default 1. */
  ortIntraOpThreads: number;
  /** ONNX `interOpNumThreads`. Default 1. */
  ortInterOpThreads: number;
  /** When true, `executionMode: 'sequential'`. Default true with caps. */
  ortSequential: boolean;
  /** When wasm backend is used, `wasm.numThreads` (Transformers). Default 1. */
  ortWasmNumThreads: number;
  /**
   * When true, run a **cross-encoder** (e.g. BGE-reranker) on the top K heuristic/hybrid results and
   * re-order before returning. Second ONNX model; first use downloads weights. `CODEBASE_MCP_CROSS_ENCODER=1`.
   */
  crossEncoderEnabled: boolean;
  /** Hugging Face / Xenova id for the cross-encoder ONNX model. Default: `Xenova/bge-reranker-base`. */
  crossEncoderModel: string;
  /**
   * How many top candidates (from hybrid + heuristic rerank) to score with the cross-encoder.
   * At least `limit` and at most pool size. Default 50. `CODEBASE_MCP_CROSS_ENCODER_TOP_K`.
   */
  crossEncoderTopK: number;
  /**
   * Forward pass batch size for cross-encoder scoring. Default 4. `CODEBASE_MCP_CROSS_ENCODER_BATCH`.
   */
  crossEncoderBatch: number;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value || value.trim() === '') {
    return fallback;
  }
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Repo to index. If `CODEBASE_MCP_ROOT` is unset or empty, uses `process.cwd()` so running from the
 * project root after `cd` does not require the env var.
 */
function getWatchRootAbsFromEnvOrCwd(): string {
  const raw = process.env.CODEBASE_MCP_ROOT?.trim();
  if (raw) {
    return path.resolve(raw);
  }
  return path.resolve(process.cwd());
}

export function loadConfig(): AppConfig {
  const watchRootAbs = getWatchRootAbsFromEnvOrCwd();
  const indexDirAbs = process.env.CODEBASE_MCP_INDEX_DIR
    ? path.resolve(process.env.CODEBASE_MCP_INDEX_DIR.trim())
    : defaultIndexDirAbs(watchRootAbs);
  const lanceDirAbs = path.join(indexDirAbs, 'lancedb');
  const metaPathAbs = path.join(indexDirAbs, 'meta.json');
  const embeddingModel = process.env.CODEBASE_MCP_EMBEDDING_MODEL?.trim() || DEFAULT_MODEL;
  const embeddingDim = Number.parseInt(process.env.CODEBASE_MCP_EMBEDDING_DIM || '', 10);
  const rawEmbedBackend = process.env.CODEBASE_MCP_EMBED_BACKEND?.trim().toLowerCase() ?? '';
  const embedBackend: 'local' | 'http' = rawEmbedBackend === 'http' ? 'http' : 'local';
  const embedHttpUrl = process.env.CODEBASE_MCP_EMBED_HTTP_URL?.trim() ?? '';
  const embedHttpApiKey = process.env.CODEBASE_MCP_EMBED_HTTP_API_KEY?.trim() || undefined;
  const rawBatch = Number.parseInt(process.env.CODEBASE_MCP_EMBED_BATCH_SIZE || '4', 10);
  const embedBatchSize = Math.min(32, Math.max(1, Number.isFinite(rawBatch) ? rawBatch : 4));
  const rawInferLog = process.env.CODEBASE_MCP_EMBED_INFER_LOG_MS;
  const embedInferenceLogMs = (() => {
    if (rawInferLog === undefined || rawInferLog.trim() === '') {
      return DEFAULT_EMBED_INFER_LOG_MS;
    }
    const n = Number.parseInt(rawInferLog.trim(), 10);
    if (!Number.isFinite(n) || n < 0) {
      return DEFAULT_EMBED_INFER_LOG_MS;
    }
    if (n === 0) {
      return 0;
    }
    return n;
  })();
  const pollingEnv = process.env.CODEBASE_MCP_USE_POLLING?.trim().toLowerCase();
  const usePolling =
    pollingEnv === undefined || pollingEnv === ''
      ? true
      : pollingEnv === '1' || pollingEnv === 'true' || pollingEnv === 'yes';
  const pollingIntervalMs =
    Number.parseInt(process.env.CODEBASE_MCP_POLL_MS || '2000', 10) || 2000;
  const rawWorkingDocs = process.env.CODEBASE_MCP_WORKING_DOCS_PATH?.trim() ?? '';
  const workingDocsPathsRelPosix = (() => {
    if (rawWorkingDocs === '') {
      return ['.claude/docs'];
    }
    if (rawWorkingDocs === '-' || /^none$/i.test(rawWorkingDocs)) {
      return [];
    }
    return parseForceIncludeList(process.env.CODEBASE_MCP_WORKING_DOCS_PATH);
  })();
  const indexExcludeRelPosix = parseIndexExcludeList(process.env.CODEBASE_MCP_INDEX_EXCLUDE);
  const searchExcludeForceInclude = parseBool(
    process.env.CODEBASE_MCP_SEARCH_EXCLUDE_FORCE_INCLUDE,
    true,
  );
  const codeAwareChunking = parseBool(process.env.CODEBASE_MCP_CODE_AWARE_CHUNKING, true);
  const configAwareChunking = parseBool(process.env.CODEBASE_MCP_CONFIG_AWARE_CHUNKING, false);
  const rerankEnabled = parseBool(process.env.CODEBASE_MCP_RERANK, true);
  const rerankCandidates =
    Number.parseInt(process.env.CODEBASE_MCP_RERANK_CANDIDATES || '100', 10) || 100;
  const hybridSearch = parseBool(process.env.CODEBASE_MCP_HYBRID, true);
  const rrfK = Math.min(200, Math.max(1, Number.parseInt(process.env.CODEBASE_MCP_RRF_K || '60', 10) || 60));
  const rawHybridDepth = process.env.CODEBASE_MCP_HYBRID_DEPTH?.trim() ?? '';
  const hybridDepth =
    rawHybridDepth === ''
      ? Math.max(100, rerankCandidates)
      : Math.max(1, Number.parseInt(rawHybridDepth, 10) || Math.max(100, rerankCandidates));
  const rerankDemotePathSubstrings = parseForceIncludeList(process.env.CODEBASE_MCP_RERANK_DEMOTE_PATHS);
  const rawDemoteStr = process.env.CODEBASE_MCP_RERANK_DEMOTE_STRENGTH?.trim() ?? '';
  const rerankDemotePerMatch = (() => {
    if (rawDemoteStr === '') {
      return 0.1;
    }
    const n = Number.parseFloat(rawDemoteStr);
    if (!Number.isFinite(n) || n < 0) {
      return 0;
    }
    return Math.min(0.5, n);
  })();
  const rerankDebugScores = parseBool(process.env.CODEBASE_MCP_RERANK_DEBUG_SCORES, false);
  const searchMatchConfidence = parseBool(process.env.CODEBASE_MCP_MATCH_CONFIDENCE, true);
  const matchConfBase = rerankEnabled ? defaultMatchConfRerank : defaultMatchConfVector;
  const parseMatchFloat = (raw: string | undefined, def: number): number => {
    if (raw === undefined || raw.trim() === '') {
      return def;
    }
    const n = Number.parseFloat(raw.trim());
    return Number.isFinite(n) && n >= 0 ? n : def;
  };
  let searchMatchWeakBelow = parseMatchFloat(process.env.CODEBASE_MCP_MATCH_CONF_WEAK, matchConfBase.weakBelow);
  let searchMatchStrongAbove = parseMatchFloat(
    process.env.CODEBASE_MCP_MATCH_CONF_STRONG,
    matchConfBase.strongAbove,
  );
  let searchMatchMinGap = parseMatchFloat(
    process.env.CODEBASE_MCP_MATCH_CONF_GAP,
    matchConfBase.minRelativeGap,
  );
  if (searchMatchStrongAbove <= searchMatchWeakBelow) {
    searchMatchStrongAbove = searchMatchWeakBelow + 0.01;
  }
  const matchConfAmbiguousLiteralDowngrade = parseBool(
    process.env.CODEBASE_MCP_MATCH_CONF_AMBIG_LIT,
    true,
  );
  const matchConfTopPathFamilyDivergence = parseBool(
    process.env.CODEBASE_MCP_MATCH_CONF_XDOMAIN_EXT,
    true,
  );
  const definitionBoostEnabled = parseBool(process.env.CODEBASE_MCP_DEF_BOOST, true);
  const rawDefStr = process.env.CODEBASE_MCP_DEF_STRENGTH?.trim() ?? '';
  const definitionBoost = (() => {
    if (rawDefStr === '') {
      return 0.18;
    }
    const n = Number.parseFloat(rawDefStr);
    if (!Number.isFinite(n) || n < 0) {
      return 0;
    }
    return Math.min(0.5, n);
  })();
  const testPathQueryBoost = parseBool(process.env.CODEBASE_MCP_TEST_PATH_QUERY_BOOST, true);
  const frontendPathQueryBoost = parseBool(process.env.CODEBASE_MCP_FRONTEND_PATH_QUERY_BOOST, true);
  const embedDefTagInChunk = parseBool(process.env.CODEBASE_MCP_EMBED_DEF_TAG, true);
  const rawDefEngine = process.env.CODEBASE_MCP_DEF_ENGINE?.trim().toLowerCase() ?? '';
  const legacyRuby = process.env.CODEBASE_MCP_RUBY_DEF_ENGINE?.trim().toLowerCase() ?? '';
  const defEngine: 'auto' | 'tree_sitter' | 'regex' = (() => {
    if (rawDefEngine === 'regex' || rawDefEngine === 'tree_sitter' || rawDefEngine === 'auto') {
      return rawDefEngine;
    }
    if (legacyRuby === 'regex') {
      return 'regex';
    }
    return 'auto';
  })();
  const rawTsMax = Number.parseInt(process.env.CODEBASE_MCP_TREE_SITTER_MAX_BYTES || '2097152', 10);
  const treeSitterMaxBytes = Number.isFinite(rawTsMax) && rawTsMax >= 65_536 ? rawTsMax : 2_097_152;
  const logIndexEachFile = parseBool(process.env.CODEBASE_MCP_VERBOSE, true);
  const logMcpTools = parseBool(process.env.CODEBASE_MCP_LOG_TOOLS, true);
  const ortUnlimited = parseBool(process.env.CODEBASE_MCP_ORT_UNLIMITED, false);
  const ortIn = Number.parseInt(process.env.CODEBASE_MCP_ORT_INTRA_OP_THREADS || '1', 10);
  const ortInter = Number.parseInt(process.env.CODEBASE_MCP_ORT_INTER_OP_THREADS || '1', 10);
  const ortIntraOpThreads = Math.min(32, Math.max(1, Number.isFinite(ortIn) && ortIn > 0 ? ortIn : 1));
  const ortInterOpThreads = Math.min(32, Math.max(1, Number.isFinite(ortInter) && ortInter > 0 ? ortInter : 1));
  const ortSequential = parseBool(process.env.CODEBASE_MCP_ORT_SEQUENTIAL, true);
  const ortW = Number.parseInt(process.env.CODEBASE_MCP_ORT_WASM_NUM_THREADS || '1', 10);
  const ortWasmNumThreads = Math.min(32, Math.max(1, Number.isFinite(ortW) && ortW > 0 ? ortW : 1));
  const crossEncoderEnabled = parseBool(process.env.CODEBASE_MCP_CROSS_ENCODER, false);
  const crossEncoderModel = process.env.CODEBASE_MCP_CROSS_ENCODER_MODEL?.trim() || 'Xenova/bge-reranker-base';
  const rawCeTopK = Number.parseInt(process.env.CODEBASE_MCP_CROSS_ENCODER_TOP_K || '50', 10);
  const crossEncoderTopK = Math.min(200, Math.max(1, Number.isFinite(rawCeTopK) && rawCeTopK > 0 ? rawCeTopK : 50));
  const rawCeBatch = Number.parseInt(process.env.CODEBASE_MCP_CROSS_ENCODER_BATCH || '4', 10);
  const crossEncoderBatch = Math.min(32, Math.max(1, Number.isFinite(rawCeBatch) && rawCeBatch > 0 ? rawCeBatch : 4));
  return {
    watchRootAbs,
    indexDirAbs,
    lanceDirAbs,
    metaPathAbs,
    embeddingModel,
    embeddingDim: Number.isFinite(embeddingDim) ? embeddingDim : DEFAULT_EMBEDDING_DIM,
    embedBackend,
    embedHttpUrl,
    embedHttpApiKey,
    embedBatchSize,
    embedInferenceLogMs,
    chunkLines: Number.parseInt(process.env.CODEBASE_MCP_CHUNK_LINES || '60', 10) || 60,
    chunkOverlapLines: Number.parseInt(process.env.CODEBASE_MCP_CHUNK_OVERLAP || '12', 10) || 12,
    maxFileBytes: Number.parseInt(process.env.CODEBASE_MCP_MAX_FILE_BYTES || `${5 * 1024 * 1024}`, 10) || 5 * 1024 * 1024,
    debounceMs: Number.parseInt(process.env.CODEBASE_MCP_DEBOUNCE_MS || '1500', 10) || 1500,
    reconcileIntervalMs:
      Number.parseInt(process.env.CODEBASE_MCP_RECONCILE_MS || `${5 * 60 * 1000}`, 10) || 5 * 60 * 1000,
    usePolling,
    pollingIntervalMs,
    workingDocsPathsRelPosix,
    indexExcludeRelPosix,
    searchExcludeForceInclude,
    codeAwareChunking,
    configAwareChunking,
    rerankEnabled,
    rerankCandidates,
    hybridSearch,
    rrfK,
    hybridDepth,
    rerankDemotePathSubstrings,
    rerankDemotePerMatch,
    rerankDebugScores,
    searchMatchConfidence,
    searchMatchWeakBelow,
    searchMatchStrongAbove,
    searchMatchMinGap,
    matchConfAmbiguousLiteralDowngrade,
    matchConfTopPathFamilyDivergence,
    definitionBoostEnabled,
    definitionBoost,
    testPathQueryBoost,
    frontendPathQueryBoost,
    embedDefTagInChunk,
    defEngine,
    treeSitterMaxBytes,
    logIndexEachFile,
    logMcpTools,
    ortUnlimited,
    ortIntraOpThreads,
    ortInterOpThreads,
    ortSequential,
    ortWasmNumThreads,
    crossEncoderEnabled,
    crossEncoderModel,
    crossEncoderTopK,
    crossEncoderBatch,
  };
}

/** POSIX-style path relative to root, forward slashes */
export function toPosixPath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

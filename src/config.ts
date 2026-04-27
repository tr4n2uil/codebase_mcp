import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseForceIncludeList } from './force-include.js';

const DEFAULT_MODEL = 'Xenova/jina-embeddings-v2-base-en';
const DEFAULT_EMBEDDING_DIM = 768;

/** Directory containing this module (`dist/` when compiled). */
function packageRootDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** Stable folder name under `db/` from the watch root (basename, sanitized). Collisions if two repos share a basename — set CODEBASE_MCP_INDEX_DIR to override. */
export function repoDataDirName(watchRootAbs: string): string {
  const base = path.basename(watchRootAbs.replace(/[/\\]+$/, '')) || 'repo';
  const slug = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'repo';
  return slug;
}

function defaultIndexDirAbs(watchRootAbs: string): string {
  return path.join(packageRootDir(), 'db', repoDataDirName(watchRootAbs));
}

export interface AppConfig {
  watchRootAbs: string;
  indexDirAbs: string;
  lanceDirAbs: string;
  metaPathAbs: string;
  embeddingModel: string;
  embeddingDim: number;
  chunkLines: number;
  chunkOverlapLines: number;
  maxFileBytes: number;
  debounceMs: number;
  reconcileIntervalMs: number;
  /** When true, use polling instead of native fs.watch (avoids EMFILE on huge trees). */
  usePolling: boolean;
  /** Polling interval when usePolling is true (ms). */
  pollingIntervalMs: number;
  /** Repo-relative POSIX paths that bypass .gitignore for indexing (safety rules still apply). */
  forceIncludeRelPosix: string[];
  /** Enable symbol-aware chunking with line-window fallback. */
  codeAwareChunking: boolean;
  /** Enable lexical/path reranking over vector-search candidates. */
  rerankEnabled: boolean;
  /** Candidate pool size for reranking. */
  rerankCandidates: number;
  /** Include reranking diagnostic fields in search output. */
  rerankDebugScores: boolean;
  /** Log every indexed file path (can be noisy on large repos). */
  logIndexEachFile: boolean;
  /** Log each MCP tool invocation to stderr. */
  logMcpTools: boolean;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (!value || value.trim() === '') {
    return fallback;
  }
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. Set it to the absolute path of the repository root to index.`,
    );
  }
  return path.resolve(value.trim());
}

export function loadConfig(): AppConfig {
  const watchRootAbs = requireEnv('CODEBASE_MCP_ROOT');
  const indexDirAbs = process.env.CODEBASE_MCP_INDEX_DIR
    ? path.resolve(process.env.CODEBASE_MCP_INDEX_DIR.trim())
    : defaultIndexDirAbs(watchRootAbs);
  const lanceDirAbs = path.join(indexDirAbs, 'lancedb');
  const metaPathAbs = path.join(indexDirAbs, 'meta.json');
  const embeddingModel = process.env.CODEBASE_MCP_EMBEDDING_MODEL?.trim() || DEFAULT_MODEL;
  const embeddingDim = Number.parseInt(process.env.CODEBASE_MCP_EMBEDDING_DIM || '', 10);
  const pollingEnv = process.env.CODEBASE_MCP_USE_POLLING?.trim().toLowerCase();
  const usePolling =
    pollingEnv === undefined || pollingEnv === ''
      ? true
      : pollingEnv === '1' || pollingEnv === 'true' || pollingEnv === 'yes';
  const pollingIntervalMs =
    Number.parseInt(process.env.CODEBASE_MCP_POLL_MS || '2000', 10) || 2000;
  const forceIncludeRelPosix = parseForceIncludeList(process.env.CODEBASE_MCP_FORCE_INCLUDE);
  const codeAwareChunking = parseBool(process.env.CODEBASE_MCP_CODE_AWARE_CHUNKING, true);
  const rerankEnabled = parseBool(process.env.CODEBASE_MCP_RERANK, true);
  const rerankCandidates =
    Number.parseInt(process.env.CODEBASE_MCP_RERANK_CANDIDATES || '50', 10) || 50;
  const rerankDebugScores = parseBool(process.env.CODEBASE_MCP_RERANK_DEBUG_SCORES, false);
  const logIndexEachFile = parseBool(process.env.CODEBASE_MCP_VERBOSE, true);
  const logMcpTools = parseBool(process.env.CODEBASE_MCP_LOG_TOOLS, true);
  return {
    watchRootAbs,
    indexDirAbs,
    lanceDirAbs,
    metaPathAbs,
    embeddingModel,
    embeddingDim: Number.isFinite(embeddingDim) ? embeddingDim : DEFAULT_EMBEDDING_DIM,
    chunkLines: Number.parseInt(process.env.CODEBASE_MCP_CHUNK_LINES || '60', 10) || 60,
    chunkOverlapLines: Number.parseInt(process.env.CODEBASE_MCP_CHUNK_OVERLAP || '12', 10) || 12,
    maxFileBytes: Number.parseInt(process.env.CODEBASE_MCP_MAX_FILE_BYTES || `${5 * 1024 * 1024}`, 10) || 5 * 1024 * 1024,
    debounceMs: Number.parseInt(process.env.CODEBASE_MCP_DEBOUNCE_MS || '1500', 10) || 1500,
    reconcileIntervalMs:
      Number.parseInt(process.env.CODEBASE_MCP_RECONCILE_MS || `${5 * 60 * 1000}`, 10) || 5 * 60 * 1000,
    usePolling,
    pollingIntervalMs,
    forceIncludeRelPosix,
    codeAwareChunking,
    rerankEnabled,
    rerankCandidates,
    rerankDebugScores,
    logIndexEachFile,
    logMcpTools,
  };
}

/** POSIX-style path relative to root, forward slashes */
export function toPosixPath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

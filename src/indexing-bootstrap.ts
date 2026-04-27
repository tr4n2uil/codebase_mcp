import fs from 'node:fs/promises';
import { createRootGitignoreFilter } from './gitignore.js';
import { logError, logInfo } from './log.js';
import { readMeta, writeMeta } from './meta.js';
import { ChunkStore } from './store.js';
import { Indexer } from './indexer.js';
import { startWatcher } from './watcher.js';
import type { AppConfig } from './config.js';
import type { MetaFile } from './meta.js';

function assertMeta(m: MetaFile | null): asserts m is MetaFile {
  if (!m) {
    throw new Error('[codebase-mcp] Internal error: meta not initialized');
  }
}

export interface IndexingHandles {
  config: AppConfig;
  indexer: Indexer;
  store: ChunkStore;
  closeWatcher: () => Promise<void>;
}

/**
 * Shared setup: meta, LanceDB, indexer, filesystem watcher. Caller runs MCP or daemon IPC on top.
 */
export async function bootstrapIndexing(config: AppConfig): Promise<IndexingHandles> {
  logInfo(
    'bootstrap',
    `index root=${config.watchRootAbs} indexDir=${config.indexDirAbs} lance=${config.lanceDirAbs} model=${config.embeddingModel}`,
  );
  await fs.mkdir(config.indexDirAbs, { recursive: true });

  let meta = await readMeta(config.metaPathAbs);
  if (!meta) {
    meta = {
      embeddingModel: config.embeddingModel,
      embeddingDim: config.embeddingDim,
      watchRoot: config.watchRootAbs,
      lastFullScanAt: null,
      fileHashes: {},
      fileStatCache: {},
    };
    await writeMeta(config.metaPathAbs, meta);
  }

  if (meta.embeddingModel !== config.embeddingModel || meta.embeddingDim !== config.embeddingDim) {
    console.error(
      `[codebase-mcp] Embedding model/dim changed (${meta.embeddingModel} -> ${config.embeddingModel}); resetting index.`,
    );
    try {
      await fs.rm(config.lanceDirAbs, { recursive: true });
    } catch {
      /* ignore */
    }
    meta = {
      embeddingModel: config.embeddingModel,
      embeddingDim: config.embeddingDim,
      watchRoot: config.watchRootAbs,
      lastFullScanAt: null,
      fileHashes: {},
      fileStatCache: {},
    };
    await writeMeta(config.metaPathAbs, meta);
  }

  if (meta.watchRoot !== config.watchRootAbs) {
    console.error('[codebase-mcp] Watch root changed; resetting index data.');
    try {
      await fs.rm(config.lanceDirAbs, { recursive: true });
    } catch {
      /* ignore */
    }
    meta.watchRoot = config.watchRootAbs;
    meta.fileHashes = {};
    meta.fileStatCache = {};
    meta.lastFullScanAt = null;
    await writeMeta(config.metaPathAbs, meta);
  }

  const ig = createRootGitignoreFilter(config.watchRootAbs);
  const store = new ChunkStore(config.lanceDirAbs, config.embeddingDim);
  await store.init();

  assertMeta(meta);
  const indexer = new Indexer(config, ig, store, meta);

  void indexer
    .fullScan()
    .then(() => {
      logInfo('bootstrap', 'initial full scan queue finished (indexer may still be embedding)');
    })
    .catch((e) => {
      logError('bootstrap', 'initial full scan failed (daemon may exit depending on error)', e);
    });

  const watcher = startWatcher(config, indexer);

  const closeWatcher = async () => {
    await watcher.close();
  };

  return { config, indexer, store, closeWatcher };
}

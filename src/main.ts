#!/usr/bin/env node
import type { AppConfig } from './config.js';
import { loadConfig } from './config.js';
import { initFileLogging, type FileLogKind } from './logger.js';
import { logInfo } from './log.js';
import { bootstrapIndexing } from './indexing-bootstrap.js';
import { ensureDaemonClient } from './ensure-daemon.js';
import { ChunkStore } from './store.js';
import { createLocalMcpBackend, createSharedDaemonMcpBackend, runMcpServer } from './mcp.js';
import { runIndexingDaemon } from './run-indexing-daemon.js';

function argvHasDaemonFlag(): boolean {
  return process.argv.includes('--daemon');
}

function noDaemonEnv(): boolean {
  const v = process.env.CODEBASE_MCP_NO_DAEMON?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

async function runInlineMcpWithLocalIndexing(config: AppConfig): Promise<void> {
  logInfo('mcp', `stdio MCP starting (mode: inline NO_DAEMON; watcher+index+tools in one process)`);
  const { indexer, store, closeWatcher } = await bootstrapIndexing(config);

  let reconcileRunning = false;
  setInterval(() => {
    if (reconcileRunning) {
      return;
    }
    reconcileRunning = true;
    void indexer
      .reconcile()
      .catch((error) => {
        console.error('[codebase-mcp] reconcile error:', error);
      })
      .finally(() => {
        reconcileRunning = false;
      });
  }, config.reconcileIntervalMs);

  const shutdown = async () => {
    await closeWatcher();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  const backend = createLocalMcpBackend(config, indexer, store);
  await runMcpServer(config, backend);
}

/** Default: stdio MCP only; indexer daemon is started automatically if not already up for this index (see `ensureDaemonClient`). */
async function runMcpWithSharedDaemon(config: AppConfig): Promise<void> {
  logInfo('mcp', `stdio MCP starting (mode: shared daemon; search/stats=local LanceDB; reindex=IPC)`);
  const client = await ensureDaemonClient(config);
  const store = new ChunkStore(config.lanceDirAbs, config.embeddingDim);
  logInfo('mcp', 'opening LanceDB read-only (connect + open table if present)…');
  await store.initReadOnly();
  logInfo('mcp', `read-only LanceDB at ${config.lanceDirAbs}`);
  const backend = createSharedDaemonMcpBackend(config, store, client);
  await runMcpServer(config, backend);
}

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }

  const fileLogKind: FileLogKind = argvHasDaemonFlag() ? 'daemon' : 'mcp';
  initFileLogging(config.indexDirAbs, fileLogKind);

  if (argvHasDaemonFlag()) {
    logInfo('daemon', 'indexer daemon process (--daemon)');
    await runIndexingDaemon(config);
    return;
  }
  if (noDaemonEnv()) {
    await runInlineMcpWithLocalIndexing(config);
    return;
  }
  await runMcpWithSharedDaemon(config);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

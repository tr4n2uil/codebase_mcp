#!/usr/bin/env node
import './ort-env-early.js';
import type { AppConfig } from './config.js';
import { loadConfig } from './config.js';
import { initFileLogging, registerFatalProcessLogging, type FileLogKind } from './logger.js';
import { logError, logInfo } from './log.js';
import { bootstrapIndexing } from './indexing-bootstrap.js';
import { tryConnectDaemonClient } from './daemon-connect.js';
import { runDaemonCliMain } from './daemon-cli.js';
import { ChunkStore } from './store.js';
import {
  createLocalMcpBackend,
  createSharedDaemonMcpBackend,
  DAEMON_REINDEX_HOWTO,
  runMcpServer,
} from './mcp.js';

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
        logError('mcp', 'reconcile() error (continuing; next interval will retry)', error);
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

/** Default: stdio MCP; indexer daemon is separate — connect only if already running (no auto-start). */
async function runMcpWithSharedDaemon(config: AppConfig): Promise<void> {
  logInfo('mcp', `stdio MCP starting (mode: shared index; search/stats=local LanceDB; reindex=IPC if daemon is up)`);
  const client = await tryConnectDaemonClient(config);
  if (client) {
    logInfo('mcp', 'connected to indexer daemon for reindex (IPC ok)');
  } else {
    logInfo('mcp', `indexer daemon not running — codebase_reindex will suggest: ${DAEMON_REINDEX_HOWTO}`);
  }
  const store = new ChunkStore(config.lanceDirAbs, config.embeddingDim, {
    hybridEnabled: config.hybridSearch,
    rrfK: config.rrfK,
    hybridDepth: config.hybridDepth,
  });
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
  registerFatalProcessLogging();

  if (argvHasDaemonFlag()) {
    await runDaemonCliMain();
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

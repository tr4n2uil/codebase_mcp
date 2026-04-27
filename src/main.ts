#!/usr/bin/env node
import { initFileLogging } from './logger.js';
import { loadConfig } from './config.js';
import { bootstrapIndexing } from './indexing-bootstrap.js';
import { ensureDaemonClient } from './ensure-daemon.js';
import { ChunkStore } from './store.js';
import { createLocalMcpBackend, createSharedDaemonMcpBackend, runMcpServer } from './mcp.js';
import { runIndexingDaemon } from './run-indexing-daemon.js';

initFileLogging();

function argvHasDaemonFlag(): boolean {
  return process.argv.includes('--daemon');
}

function noDaemonEnv(): boolean {
  const v = process.env.CODEBASE_MCP_NO_DAEMON?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

async function runInlineMcpWithLocalIndexing(): Promise<void> {
  const config = loadConfig();
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
async function runMcpWithSharedDaemon(): Promise<void> {
  const config = loadConfig();
  const client = await ensureDaemonClient(config);
  const store = new ChunkStore(config.lanceDirAbs, config.embeddingDim);
  await store.initReadOnly();
  const backend = createSharedDaemonMcpBackend(config, store, client);
  await runMcpServer(config, backend);
}

async function main(): Promise<void> {
  if (argvHasDaemonFlag()) {
    await runIndexingDaemon();
    return;
  }
  if (noDaemonEnv()) {
    await runInlineMcpWithLocalIndexing();
    return;
  }
  await runMcpWithSharedDaemon();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import fs from 'node:fs/promises';
import net from 'node:net';
import { loadConfig } from './config.js';
import { bootstrapIndexing } from './indexing-bootstrap.js';
import { daemonStateDir, getDaemonListenPath } from './daemon-paths.js';
import { startDaemonIpcServer } from './daemon-server.js';

async function unlinkIfExists(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }
}

/**
 * Single long-lived process: index + watch + periodic reconcile + IPC for MCP clients.
 */
export async function runIndexingDaemon(): Promise<void> {
  const config = loadConfig();
  const listenPath = getDaemonListenPath(config.indexDirAbs);
  await fs.mkdir(daemonStateDir(config.indexDirAbs), { recursive: true });

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

  if (process.platform !== 'win32') {
    await unlinkIfExists(listenPath);
  }

  const ipcServer: net.Server = await startDaemonIpcServer(config, indexer, store, listenPath);
  console.error(`[codebase-mcp] Daemon listening on ${listenPath}`);

  const shutdown = async () => {
    await new Promise<void>((resolve) => {
      ipcServer.close(() => resolve());
    });
    await closeWatcher();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

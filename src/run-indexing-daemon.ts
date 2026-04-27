import fs from 'node:fs/promises';
import net from 'node:net';
import { loadConfig, type AppConfig } from './config.js';
import { bootstrapIndexing } from './indexing-bootstrap.js';
import { daemonStateDir, getDaemonListenPath } from './daemon-paths.js';
import { startDaemonIpcServer } from './daemon-server.js';
import { logInfo } from './log.js';

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
 * Pass `config` from `main` when available to avoid a second `loadConfig()`.
 */
export async function runIndexingDaemon(configIn?: AppConfig): Promise<void> {
  const config = configIn ?? loadConfig();
  const listenPath = getDaemonListenPath(config.indexDirAbs);
  await fs.mkdir(daemonStateDir(config.indexDirAbs), { recursive: true });

  const { indexer, closeWatcher } = await bootstrapIndexing(config);

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

  const ipcServer: net.Server = await startDaemonIpcServer(config, indexer, listenPath);
  logInfo('daemon', `IPC listening on ${listenPath} (commands: ping, reindex)`);
  logInfo('daemon', 'search/stats are served by each MCP process via read-only LanceDB; this process only indexes');

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

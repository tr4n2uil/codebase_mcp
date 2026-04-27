import fs from 'node:fs/promises';
import net from 'node:net';
import { loadConfig, type AppConfig } from './config.js';
import { isIndexerDaemonAlreadyRunning } from './daemon-connect.js';
import { bootstrapIndexing } from './indexing-bootstrap.js';
import { daemonStateDir, getDaemonListenPath } from './daemon-paths.js';
import { startDaemonIpcServer } from './daemon-server.js';
import { logError, logInfo } from './log.js';

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

  if (await isIndexerDaemonAlreadyRunning(listenPath)) {
    logInfo(
      'daemon',
      `indexer already running for this index (ping ok on ${listenPath}); exit 0 (idempotent --daemon)`,
    );
    process.exit(0);
  }

  if (process.platform !== 'win32') {
    await unlinkIfExists(listenPath);
  }

  const indexingPromise = bootstrapIndexing(config);
  void indexingPromise.catch((e) => {
    logError('daemon', 'indexing bootstrap failed; exiting (IPC may have been listening briefly)', e);
    process.exit(1);
  });

  let reconcileRunning = false;
  void indexingPromise.then(({ indexer }) => {
    setInterval(() => {
      if (reconcileRunning) {
        return;
      }
      reconcileRunning = true;
      void indexer
        .reconcile()
        .catch((error) => {
          logError('daemon', 'reconcile() error (continuing; next interval will retry)', error);
        })
        .finally(() => {
          reconcileRunning = false;
        });
    }, config.reconcileIntervalMs);
  });

  const ipcServer: net.Server = await startDaemonIpcServer(config, indexingPromise, listenPath);
  logInfo('daemon', `IPC listening on ${listenPath} (commands: ping, reindex; reindex waits until bootstrap finishes)`);
  logInfo('daemon', 'search/stats are served by each MCP process via read-only LanceDB; this process only indexes');

  const shutdown = async () => {
    const { closeWatcher } = await indexingPromise;
    await new Promise<void>((resolve) => {
      ipcServer.close(() => resolve());
    });
    await closeWatcher();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

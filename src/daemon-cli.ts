import { loadConfig } from './config.js';
import { initFileLogging, registerFatalProcessLogging } from './logger.js';
import { logInfo } from './log.js';
import { runIndexingDaemon } from './run-indexing-daemon.js';

/**
 * Indexer-daemon only: used by `main --daemon` and the `codebase-mcp-daemon` bin.
 */
export async function runDaemonCliMain(): Promise<void> {
  const config = loadConfig();
  initFileLogging(config.indexDirAbs, 'daemon');
  registerFatalProcessLogging();
  logInfo('daemon', 'indexer daemon (watcher + index + reindex IPC)');
  await runIndexingDaemon(config);
}

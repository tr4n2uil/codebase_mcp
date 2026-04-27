/**
 * All messages go to stderr so they are mirrored to `<indexDir>/.logs/mcp.log` or `daemon.log` by `initFileLogging()` (each file line is prefixed with `[pid=…] `).
 */
export type LogScope = 'daemon' | 'mcp' | 'indexer' | 'chunker' | 'ipc' | 'bootstrap' | 'embedder' | 'watcher';

export function logInfo(scope: LogScope, message: string): void {
  console.error(`[codebase-mcp] [${scope}] ${message}`);
}

export function logWarn(scope: LogScope, message: string): void {
  console.error(`[codebase-mcp] [${scope}] ${message}`);
}

export function logError(scope: LogScope, message: string, err?: unknown): void {
  if (err !== undefined) {
    const detail = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(`[codebase-mcp] [${scope}] ${message}`, detail);
  } else {
    console.error(`[codebase-mcp] [${scope}] ${message}`);
  }
}


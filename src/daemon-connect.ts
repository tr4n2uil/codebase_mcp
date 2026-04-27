import type { AppConfig } from './config.js';
import { DaemonClient } from './daemon-client.js';
import { getDaemonListenPath } from './daemon-paths.js';

const DUPLICATE_DAEMON_PING_TIMEOUT_MS = 2_000;

/**
 * Tries a single connect + `ping` round-trip. **Bounded** in wall time: if the socket never
 * connects, or the server never returns a line, or `call` hangs, the client is destroyed and
 * we return `null`.
 */
export async function tryPingWithTimeout(
  listenPath: string,
  timeoutMs: number,
): Promise<DaemonClient | null> {
  let c: DaemonClient | null = null;
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    try {
      c?.destroy();
    } catch {
      /* ignore */
    }
    c = null;
  }, timeoutMs);
  try {
    c = await DaemonClient.connect(listenPath);
    if (timedOut) {
      c.destroy();
      return null;
    }
    const resp = await c.call('ping');
    if (timedOut) {
      c.destroy();
      return null;
    }
    if (resp.ok && (resp.result as { ok?: boolean })?.ok === true) {
      const out = c;
      c = null;
      return out;
    }
    c.destroy();
    c = null;
    return null;
  } catch {
    try {
      c?.destroy();
    } catch {
      /* ignore */
    }
    c = null;
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * If an indexer daemon is already listening for this `indexDir`, return a `DaemonClient` for
 * reindex IPC. **Does not** start a daemon. MCP uses a short default timeout so startup never blocks.
 */
export async function tryConnectDaemonClient(
  config: AppConfig,
  timeoutMs = 2_000,
): Promise<DaemonClient | null> {
  const listenPath = getDaemonListenPath(config.indexDirAbs);
  return tryPingWithTimeout(listenPath, timeoutMs);
}

/**
 * `true` if this index’ IPC path already has a live indexer (ping ok).
 * Used by the daemon on startup to exit idempotently.
 */
export async function isIndexerDaemonAlreadyRunning(listenPath: string): Promise<boolean> {
  const c = await tryPingWithTimeout(listenPath, DUPLICATE_DAEMON_PING_TIMEOUT_MS);
  if (c) {
    c.destroy();
    return true;
  }
  return false;
}

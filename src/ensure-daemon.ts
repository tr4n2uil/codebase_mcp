import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config.js';
import { DaemonClient } from './daemon-client.js';
import { daemonStateDir, getDaemonListenPath, spawnLockPath } from './daemon-paths.js';
import { logInfo } from './log.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mainScriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.js');
}

const PING_ATTEMPT_TIMEOUT_MS = 8_000;

/** Shorter connect+ping for “is a daemon already bound here?” in `--daemon` idempotent start. */
const DUPLICATE_DAEMON_PING_TIMEOUT_MS = 2_000;

/**
 * Tries a single connect + `ping` round-trip. **Bounded** in wall time: if the socket never
 * connects, or the server never returns a line, or `call` hangs, we destroy the client and
 * return null so the outer `ensure` loop can retry instead of stalling the MCP process forever.
 */
async function tryPingWithTimeout(
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

function tryPing(listenPath: string): Promise<DaemonClient | null> {
  return tryPingWithTimeout(listenPath, PING_ATTEMPT_TIMEOUT_MS);
}

/**
 * `true` if this index’ IPC path already has a live indexer (ping ok).  
 * Used by `node main.js --daemon` to exit without bootstrapping a second daemon.
 */
export async function isIndexerDaemonAlreadyRunning(listenPath: string): Promise<boolean> {
  const c = await tryPingWithTimeout(listenPath, DUPLICATE_DAEMON_PING_TIMEOUT_MS);
  if (c) {
    c.destroy();
    return true;
  }
  return false;
}

async function unlinkIfExists(p: string): Promise<void> {
  try {
    await fs.unlink(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }
}

async function readSpawnLockPid(lockPath: string): Promise<number | null> {
  try {
    const raw = (await fs.readFile(lockPath, 'utf8')).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** If spawn.lock exists but the PID is not running, another process may have crashed; remove the stale lock. */
async function tryRemoveStaleSpawnLock(lockPath: string): Promise<void> {
  const pid = await readSpawnLockPid(lockPath);
  if (pid !== null && !isPidRunning(pid)) {
    await unlinkIfExists(lockPath);
  }
}

/**
 * Ensures the indexer daemon for this index is running.
 *
 * MCP hosts typically run **only** `node dist/main.js` (no `--daemon`). This function:
 * 1. Pings the daemon socket for `config.indexDirAbs` (same process env → same `CODEBASE_MCP_ROOT` / index as the spawned child).
 * 2. If nothing answers: take `spawn.lock`, `spawn` `node main.js --daemon` with **current** `process.env`, wait until `ping` succeeds, release lock.
 * 3. Returns a client connected to that daemon (for `reindex` IPC only).
 */
export async function ensureDaemonClient(config: AppConfig): Promise<DaemonClient> {
  const listenPath = getDaemonListenPath(config.indexDirAbs);
  const stateDir = daemonStateDir(config.indexDirAbs);
  await fs.mkdir(stateDir, { recursive: true });
  logInfo('mcp', `ensuring indexer daemon (socket=${listenPath})`);

  const deadline = Date.now() + 60_000;
  let waitLogged = false;
  const hb = setInterval(() => {
    if (Date.now() < deadline) {
      logInfo(
        'mcp',
        'still waiting for indexer daemon (ping each attempt is time-limited; lock may be held by another spawner)…',
      );
    }
  }, 10_000);
  try {
    while (Date.now() < deadline) {
      const ready = await tryPing(listenPath);
      if (ready) {
        logInfo('mcp', 'indexer daemon ready (ping ok)');
        return ready;
      }
      if (!waitLogged) {
        logInfo('mcp', 'indexer daemon not ready yet; retrying, acquiring spawn lock, or waiting for peer…');
        waitLogged = true;
      }

      const lockPath = spawnLockPath(config.indexDirAbs);
      let acquired = false;
      try {
        await fs.writeFile(lockPath, String(process.pid), { flag: 'wx' });
        acquired = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw e;
        }
        await tryRemoveStaleSpawnLock(lockPath);
        await sleep(50);
        continue;
      }

      try {
        const again = await tryPing(listenPath);
        if (again) {
          logInfo('mcp', `indexer daemon ready (peer started it while waiting for lock)`);
          return again;
        }

        if (process.platform !== 'win32') {
          await unlinkIfExists(listenPath);
        }

        const entry = mainScriptPath();
        logInfo(
          'mcp',
          `starting indexer daemon: ${process.execPath} ${entry} --daemon (indexDir=${config.indexDirAbs})`,
        );
        const child = spawn(process.execPath, [entry, '--daemon'], {
          env: process.env,
          detached: true,
          stdio: 'ignore',
        });
        child.unref();

        logInfo('mcp', 'waiting for spawned daemon to accept ping on socket…');
        const innerDeadline = Date.now() + 45_000;
        while (Date.now() < innerDeadline) {
          const c = await tryPing(listenPath);
          if (c) {
            logInfo('mcp', `indexer daemon is ready (spawned in this session)`);
            return c;
          }
          await sleep(100);
        }
        throw new Error('[codebase-mcp] Daemon did not become ready in time.');
      } finally {
        if (acquired) {
          await fs.unlink(lockPath).catch(() => {});
        }
      }
    }
    throw new Error('[codebase-mcp] Timed out waiting for daemon.');
  } finally {
    clearInterval(hb);
  }
}

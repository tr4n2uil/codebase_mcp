import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from './config.js';
import { DaemonClient } from './daemon-client.js';
import { daemonStateDir, getDaemonListenPath, spawnLockPath } from './daemon-paths.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mainScriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.js');
}

async function tryPing(listenPath: string): Promise<DaemonClient | null> {
  try {
    const client = await DaemonClient.connect(listenPath);
    const resp = await client.call('ping');
    if (resp.ok && (resp.result as { ok?: boolean })?.ok === true) {
      return client;
    }
    client.destroy();
  } catch {
    /* not ready */
  }
  return null;
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
 * Connects to an existing daemon or acquires a spawn lock, starts `main.js --daemon`, and waits until ping succeeds.
 */
export async function ensureDaemonClient(config: AppConfig): Promise<DaemonClient> {
  const listenPath = getDaemonListenPath(config.indexDirAbs);
  const stateDir = daemonStateDir(config.indexDirAbs);
  await fs.mkdir(stateDir, { recursive: true });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ready = await tryPing(listenPath);
    if (ready) {
      return ready;
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
        return again;
      }

      if (process.platform !== 'win32') {
        await unlinkIfExists(listenPath);
      }

      const entry = mainScriptPath();
      const child = spawn(process.execPath, [entry, '--daemon'], {
        env: process.env,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      const innerDeadline = Date.now() + 45_000;
      while (Date.now() < innerDeadline) {
        const c = await tryPing(listenPath);
        if (c) {
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
}

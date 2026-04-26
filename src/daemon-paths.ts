import { createHash } from 'node:crypto';
import path from 'node:path';

/** Directory under the index root used for socket, spawn lock, etc. */
export function daemonStateDir(indexDirAbs: string): string {
  return path.join(indexDirAbs, '.codebase-mcp-daemon');
}

/**
 * Path for the daemon IPC server: Unix domain socket (non-Windows) or Windows named pipe.
 */
export function getDaemonListenPath(indexDirAbs: string): string {
  const h = createHash('sha256').update(indexDirAbs).digest('hex').slice(0, 24);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\codebase-mcp-${h}`;
  }
  return path.join(daemonStateDir(indexDirAbs), 'socket');
}

export function spawnLockPath(indexDirAbs: string): string {
  return path.join(daemonStateDir(indexDirAbs), 'spawn.lock');
}

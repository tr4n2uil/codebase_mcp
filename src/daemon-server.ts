import net from 'node:net';
import readline from 'node:readline';
import * as z from 'zod/v4';
import type { AppConfig } from './config.js';
import type { IndexingHandles } from './indexing-bootstrap.js';
import type { IpcRequest, IpcResponse } from './ipc-protocol.js';
import { encodeMessage, parseLine } from './ipc-protocol.js';
import { logError, logInfo } from './log.js';
import { runCodebaseReindex } from './mcp-tools.js';

const reindexPayloadSchema = z.object({
  path: z.string().optional(),
});

function isBenignClientDisconnect(err: unknown): boolean {
  const c = (err as NodeJS.ErrnoException).code;
  return c === 'EPIPE' || c === 'ECONNRESET' || c === 'ECONNABORTED';
}

function safeIpcLog(logFn: typeof logError, scope: 'ipc', message: string, err?: unknown): void {
  try {
    logFn(scope, message, err);
  } catch {
    /* e.g. stderr EPIPE; never crash the daemon from logging */
  }
}

/**
 * `socket.write` can still surface `EPIPE` as an uncaught exception in edge cases; readline on the
 * same socket can also emit `error`. We guard `writable*`, use write callbacks, and attach
 * `error` handlers on both the socket and the readline interface.
 */
function writeIpcLine(socket: net.Socket, msg: IpcRequest | IpcResponse): void {
  if (socket.destroyed) {
    return;
  }
  if (!socket.writable || socket.writableEnded) {
    return;
  }
  const data = encodeMessage(msg);
  try {
    socket.write(data, (err) => {
      if (err && !isBenignClientDisconnect(err)) {
        safeIpcLog(logError, 'ipc', 'write failed after response', err);
      }
    });
  } catch (e) {
    if (!isBenignClientDisconnect(e)) {
      safeIpcLog(logError, 'ipc', 'write threw (response)', e);
    }
  }
}

function attachIpcClientSocketErrorSink(socket: net.Socket): void {
  if ((socket as net.Socket & { __ipcErrorSink?: boolean }).__ipcErrorSink) {
    return;
  }
  (socket as net.Socket & { __ipcErrorSink?: boolean }).__ipcErrorSink = true;
  socket.on('error', (err: NodeJS.ErrnoException) => {
    if (!isBenignClientDisconnect(err)) {
      safeIpcLog(logError, 'ipc', 'client socket error', err);
    }
  });
}

async function dispatch(req: IpcRequest, indexing: Promise<IndexingHandles>): Promise<IpcResponse> {
  const id = req.id;
  switch (req.cmd) {
    case 'ping':
      return { id, ok: true, result: { ok: true } };
    case 'reindex': {
      const { config, indexer } = await indexing;
      const parsed = reindexPayloadSchema.safeParse(req.payload ?? {});
      if (!parsed.success) {
        return { id, ok: false, error: parsed.error.message };
      }
      const p = parsed.data.path?.trim();
      if (p) {
        logInfo('ipc', `reindex (single file): ${p}`);
      } else {
        logInfo('ipc', 'reindex (full reconcile)');
      }
      const result = await runCodebaseReindex(config, indexer, parsed.data);
      return { id, ok: true, result };
    }
    default:
      return { id, ok: false, error: `Unknown cmd: ${String((req as IpcRequest).cmd)}` };
  }
}

/**
 * Binds the Unix socket and accepts connections **as soon as listen() completes**, while
 * `indexing` may still be in progress. `ping` is answered immediately; `reindex` awaits bootstrap.
 * This allows MCP stdio clients to connect with `tryConnectDaemonClient` even when LanceDB init or
 * other bootstrap work is slow.
 */
export function startDaemonIpcServer(
  _config: AppConfig,
  indexing: Promise<IndexingHandles>,
  listenPath: string,
): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      attachIpcClientSocketErrorSink(socket);
      let lineChain: Promise<void> = Promise.resolve();
      const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
      rl.on('error', (err: NodeJS.ErrnoException) => {
        if (!isBenignClientDisconnect(err)) {
          safeIpcLog(logError, 'ipc', 'readline on IPC socket', err);
        }
      });
      rl.on('line', (line) => {
        lineChain = lineChain
          .then(async () => {
            let req: IpcRequest;
            try {
              req = parseLine(line) as IpcRequest;
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              writeIpcLine(socket, { id: 0, ok: false, error: msg });
              return;
            }
            const id = req.id;
            try {
              const resp = await dispatch(req, indexing);
              writeIpcLine(socket, resp);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              safeIpcLog(logError, 'ipc', `dispatch failed for cmd=${String(req.cmd)} id=${String(id)}`, e);
              writeIpcLine(socket, { id, ok: false, error: msg });
            }
          })
          .catch((e) => {
            if (!isBenignClientDisconnect(e)) {
              safeIpcLog(logError, 'ipc', 'connection handler error', e);
            }
          });
      });
    });

    server.once('error', reject);
    server.listen(listenPath, () => {
      server.off('error', reject);
      server.on('error', (err) => {
        safeIpcLog(logError, 'ipc', 'IPC server error', err);
      });
      resolve(server);
    });
  });
}

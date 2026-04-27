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

/**
 * `socket.write` without a callback can throw `EPIPE` if the client closed the connection; the same
 * error may also be emitted on `socket` if unhandled, which crashes the daemon. Using the callback
 * + an error handler avoids uncaught `uncaughtException: write EPIPE`.
 */
function writeIpcLine(socket: net.Socket, msg: IpcRequest | IpcResponse): void {
  if (socket.destroyed) {
    return;
  }
  const data = encodeMessage(msg);
  try {
    socket.write(data, (err) => {
      if (err && !isBenignClientDisconnect(err)) {
        logError('ipc', 'write failed after response', err);
      }
    });
  } catch (e) {
    if (!isBenignClientDisconnect(e)) {
      logError('ipc', 'write threw (response)', e);
    }
  }
}

function attachIpcClientSocketErrorSink(socket: net.Socket): void {
  socket.on('error', (err: NodeJS.ErrnoException) => {
    if (!isBenignClientDisconnect(err)) {
      logError('ipc', 'client socket error', err);
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
 * This allows MCP stdio clients to get past `ensureDaemonClient` even when LanceDB init or
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
              logError('ipc', `dispatch failed for cmd=${String(req.cmd)} id=${String(id)}`, e);
              writeIpcLine(socket, { id, ok: false, error: msg });
            }
          })
          .catch((e) => {
            if (!isBenignClientDisconnect(e)) {
              logError('ipc', 'connection handler error', e);
            }
          });
      });
    });

    server.once('error', reject);
    server.listen(listenPath, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

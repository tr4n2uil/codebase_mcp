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
              if (!socket.destroyed) {
                socket.write(encodeMessage({ id: 0, ok: false, error: msg }));
              }
              return;
            }
            const id = req.id;
            try {
              const resp = await dispatch(req, indexing);
              if (!socket.destroyed) {
                socket.write(encodeMessage(resp));
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              logError('ipc', `dispatch failed for cmd=${String(req.cmd)} id=${String(id)}`, e);
              if (!socket.destroyed) {
                socket.write(encodeMessage({ id, ok: false, error: msg }));
              }
            }
          })
          .catch((e) => {
            logError('ipc', 'connection handler error', e);
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

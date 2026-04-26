import net from 'node:net';
import readline from 'node:readline';
import * as z from 'zod/v4';
import type { AppConfig } from './config.js';
import type { Indexer } from './indexer.js';
import type { ChunkStore } from './store.js';
import type { IpcRequest, IpcResponse } from './ipc-protocol.js';
import { encodeMessage, parseLine } from './ipc-protocol.js';
import { runCodebaseSearch, runCodebaseStats, runCodebaseReindex } from './mcp-tools.js';

const searchPayloadSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(50).optional(),
  path_prefix: z.string().optional(),
});

const reindexPayloadSchema = z.object({
  path: z.string().optional(),
});

async function dispatch(
  req: IpcRequest,
  config: AppConfig,
  indexer: Indexer,
  store: ChunkStore,
): Promise<IpcResponse> {
  const id = req.id;
  switch (req.cmd) {
    case 'ping':
      return { id, ok: true, result: { ok: true } };
    case 'search': {
      const parsed = searchPayloadSchema.safeParse(req.payload ?? {});
      if (!parsed.success) {
        return { id, ok: false, error: parsed.error.message };
      }
      const result = await runCodebaseSearch(config, store, parsed.data);
      return { id, ok: true, result };
    }
    case 'stats': {
      const result = await runCodebaseStats(indexer, store);
      return { id, ok: true, result };
    }
    case 'reindex': {
      const parsed = reindexPayloadSchema.safeParse(req.payload ?? {});
      if (!parsed.success) {
        return { id, ok: false, error: parsed.error.message };
      }
      const result = await runCodebaseReindex(config, indexer, parsed.data);
      return { id, ok: true, result };
    }
    default:
      return { id, ok: false, error: `Unknown cmd: ${String((req as IpcRequest).cmd)}` };
  }
}

export function startDaemonIpcServer(
  config: AppConfig,
  indexer: Indexer,
  store: ChunkStore,
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
              const resp = await dispatch(req, config, indexer, store);
              if (!socket.destroyed) {
                socket.write(encodeMessage(resp));
              }
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              if (!socket.destroyed) {
                socket.write(encodeMessage({ id, ok: false, error: msg }));
              }
            }
          })
          .catch((e) => {
            console.error('[codebase-mcp] ipc connection error:', e);
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

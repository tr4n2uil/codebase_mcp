import net from 'node:net';
import readline from 'node:readline';
import type { IpcCmd, IpcRequest, IpcResponse } from './ipc-protocol.js';
import { encodeMessage, parseLine } from './ipc-protocol.js';

function connectNet(pathOrPipe: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pathOrPipe);
    const t = setTimeout(() => {
      socket.destroy();
      reject(new Error(`IPC connect to ${pathOrPipe} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const clear = () => {
      clearTimeout(t);
    };
    const onErr = (err: Error) => {
      clear();
      socket.destroy();
      reject(err);
    };
    socket.once('error', onErr);
    socket.once('connect', () => {
      socket.off('error', onErr);
      clear();
      resolve(socket);
    });
  });
}

/**
 * Client for the indexing daemon. One readline loop; responses matched by `id`.
 */
export class DaemonClient {
  private readonly socket: net.Socket;
  private readonly rl: readline.Interface;
  private nextId = 1;
  private readonly pending = new Map<
    string | number,
    { resolve: (r: IpcResponse) => void; reject: (e: Error) => void }
  >();

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.rl = readline.createInterface({ input: socket, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      let resp: IpcResponse;
      try {
        resp = parseLine(line) as IpcResponse;
      } catch {
        for (const [, p] of this.pending) {
          p.reject(new Error('Invalid IPC response line'));
        }
        this.pending.clear();
        return;
      }
      const id = resp.id;
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        p.resolve(resp);
      }
    });
    this.rl.on('close', () => {
      const err = new Error('IPC connection closed');
      for (const [, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
    });
  }

  static async connect(listenPath: string, connectTimeoutMs = 8_000): Promise<DaemonClient> {
    const socket = await connectNet(listenPath, connectTimeoutMs);
    return new DaemonClient(socket);
  }

  destroy(): void {
    this.rl.close();
    this.socket.destroy();
  }

  call(cmd: IpcCmd, payload?: unknown): Promise<IpcResponse> {
    const id = this.nextId++;
    const req: IpcRequest = { id, cmd, payload };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(encodeMessage(req), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }
}

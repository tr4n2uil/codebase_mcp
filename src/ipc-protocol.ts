export type IpcCmd = 'ping' | 'search' | 'stats' | 'reindex';

export interface IpcRequest {
  id: string | number;
  cmd: IpcCmd;
  payload?: unknown;
}

export interface IpcResponseOk {
  id: string | number;
  ok: true;
  result: unknown;
}

export interface IpcResponseErr {
  id: string | number;
  ok: false;
  error: string;
}

export type IpcResponse = IpcResponseOk | IpcResponseErr;

const MAX_LINE_BYTES = 12 * 1024 * 1024;

export function encodeMessage(msg: IpcRequest | IpcResponse): string {
  return `${JSON.stringify(msg)}\n`;
}

export function parseLine(line: string): IpcRequest | IpcResponse {
  if (line.length > MAX_LINE_BYTES) {
    throw new Error('IPC line too large');
  }
  return JSON.parse(line) as IpcRequest | IpcResponse;
}

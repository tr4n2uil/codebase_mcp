import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function packageRootDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

let logFilePath = '';
let stream: fs.WriteStream | null = null;

/**
 * Append all stderr (including `console.error`) to `tools/codebase-mcp/.logs/<pid>`,
 * while still writing to the original stderr (MCP clients keep host-visible logs when attached).
 */
export function initFileLogging(): string {
  if (stream) {
    return logFilePath;
  }
  const dir = path.join(packageRootDir(), '.logs');
  fs.mkdirSync(dir, { recursive: true });
  logFilePath = path.join(dir, String(process.pid));
  stream = fs.createWriteStream(logFilePath, { flags: 'a', autoClose: false });

  const stderr = process.stderr;
  const origWrite = stderr.write.bind(stderr);
  stderr.write = (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null | undefined) => void),
    cb?: (err?: Error | null | undefined) => void,
  ): boolean => {
    try {
      if (typeof chunk === 'string') {
        stream!.write(chunk, 'utf8');
      } else {
        stream!.write(chunk);
      }
    } catch {
      /* ignore */
    }
    return origWrite(chunk, encodingOrCb as never, cb as never);
  };

  const banner = `[codebase-mcp] pid=${process.pid} logging to ${logFilePath}\n`;
  stream.write(banner);
  origWrite(banner);
  return logFilePath;
}

export function getLogFilePath(): string {
  return logFilePath;
}

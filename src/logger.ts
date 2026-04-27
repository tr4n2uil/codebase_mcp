import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export type FileLogKind = 'daemon' | 'mcp';

let logFilePath = '';
let stream: fs.WriteStream | null = null;
let fileDecoder: StringDecoder | null = null;
let lineBuf = '';

/**
 * Append all stderr (including `console.error`) to `<indexDir>/.logs/mcp.log` or `daemon.log`,
 * while still writing to the original stderr. Each *line* in the file is prefixed with `[pid=…] `.
 * `indexDir` is the resolved `CODEBASE_MCP_INDEX_DIR` (e.g. `.../codebase_mcp/db/<repo>/`), next to `meta.json` and `lancedb/`.
 */
export function initFileLogging(indexDirAbs: string, kind: FileLogKind): string {
  if (stream) {
    return logFilePath;
  }
  const dir = path.join(indexDirAbs, '.logs');
  fs.mkdirSync(dir, { recursive: true });
  const name = kind === 'daemon' ? 'daemon.log' : 'mcp.log';
  logFilePath = path.join(dir, name);
  stream = fs.createWriteStream(logFilePath, { flags: 'a', autoClose: false });
  fileDecoder = new StringDecoder('utf8');

  const pid = process.pid;
  const linePrefix = `[pid=${pid}] `;

  const writePrefixedLineToFile = (line: string) => {
    try {
      stream!.write(linePrefix + line + '\n', 'utf8');
    } catch {
      /* ignore */
    }
  };

  const processTextForFile = (text: string) => {
    lineBuf += text;
    const parts = lineBuf.split('\n');
    lineBuf = parts.pop() ?? '';
    for (const line of parts) {
      writePrefixedLineToFile(line);
    }
  };

  const chunkToText = (chunk: string | Uint8Array): string => {
    if (typeof chunk === 'string') {
      return chunk;
    }
    return fileDecoder!.write(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  };

  const onceBeforeExit = () => {
    process.removeListener('beforeExit', onceBeforeExit);
    try {
      if (fileDecoder) {
        const tail = fileDecoder.end();
        if (tail) {
          processTextForFile(tail);
        }
      }
    } catch {
      /* ignore */
    }
    if (lineBuf.length > 0) {
      writePrefixedLineToFile(lineBuf);
      lineBuf = '';
    }
  };
  process.once('beforeExit', onceBeforeExit);

  const stderr = process.stderr;
  const origWrite = stderr.write.bind(stderr);
  stderr.write = (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null | undefined) => void),
    cb?: (err?: Error | null | undefined) => void,
  ): boolean => {
    const text = chunkToText(chunk);
    if (text.length > 0) {
      processTextForFile(text);
    }
    return origWrite(chunk, encodingOrCb as never, cb as never);
  };

  const banner = `[codebase-mcp] logging to ${logFilePath} (appending, pid=${pid})\n`;
  origWrite(banner);
  try {
    stream.write(linePrefix + `[codebase-mcp] file logging started\n`, 'utf8');
  } catch {
    /* ignore */
  }
  return logFilePath;
}

export function getLogFilePath(): string {
  return logFilePath;
}

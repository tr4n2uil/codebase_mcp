import { yieldToEventLoop } from './event-loop-yield.js';
import type { AppConfig } from './config.js';
import { atMostOneSymbolPerLine, mergeAstWithRegex } from './declaration-merge.js';
import type { SymbolSpan } from './chunker-symbols.js';
import { getDefinitionSpansFromTreeSitter } from './tree-sitter-definitions.js';

export interface TextChunk {
  startLine: number;
  endLine: number;
  text: string;
  language?: string;
  symbolName?: string;
  symbolKind?: string;
  /**
   * When set, the chunk *starts* at a detected declaration line for this symbol (heuristic, code-aware
   * chunking only). Used at search time to boost “where is X defined?” queries vs usages in the same file.
   */
  definitionOf?: string;
}

/** Use fast path below this; above, scan for newlines in chunks and yield to keep IPC alive. */
const LINES_STRING_SYNC_MAX = 1_000_000;
const LINES_YIELD_EVERY = 10_000;
const SYMBOLS_YIELD_EVERY = 5_000;
const CHUNKEMIT_YIELD_EVERY = 200;

/**
 * Build the same `string[]` as `content.split(/\r?\n/)`, with periodic yields for huge files so
 * a single 100k-line+ file does not block the daemon event loop and IPC.
 */
export async function buildLinesArray(content: string): Promise<string[]> {
  if (content.length <= LINES_STRING_SYNC_MAX) {
    return content.split(/\r?\n/);
  }
  const lines: string[] = [];
  let start = 0;
  let lineCount = 0;
  for (let p = 0; p < content.length; p++) {
    if (content.charCodeAt(p) === 10) {
      /* \n */
      let line = content.slice(start, p);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      lines.push(line);
      start = p + 1;
      lineCount += 1;
      if (lineCount % LINES_YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }
    }
  }
  {
    const rest = content.slice(start);
    lines.push(rest.endsWith('\r') ? rest.slice(0, -1) : rest);
  }
  return lines;
}

const LINE_WINDOW_CHUNKS_YIELD_EVERY = 150;

/** Sync: small/medium line counts only. */
export function chunkByLinesFromLines(
  lines: string[],
  chunkLines: number,
  overlapLines: number,
): TextChunk[] {
  if (lines.length === 0) {
    return [];
  }
  const step = Math.max(1, chunkLines - overlapLines);
  const chunks: TextChunk[] = [];
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + chunkLines, lines.length);
    const slice = lines.slice(start, end);
    chunks.push({
      startLine: start + 1,
      endLine: end,
      text: slice.join('\n'),
    });
    if (end >= lines.length) {
      break;
    }
  }
  return chunks;
}

/**
 * Long files produce many line windows; `slice`+`join` per window can block the event loop
 * (daemon IPC) for a long time without this.
 */
export async function chunkByLinesFromLinesWithYields(
  lines: string[],
  chunkLines: number,
  overlapLines: number,
): Promise<TextChunk[]> {
  if (lines.length === 0) {
    return [];
  }
  if (lines.length < 20_000) {
    return chunkByLinesFromLines(lines, chunkLines, overlapLines);
  }
  const step = Math.max(1, chunkLines - overlapLines);
  const chunks: TextChunk[] = [];
  let k = 0;
  for (let start = 0; start < lines.length; start += step) {
    if (k > 0 && k % LINE_WINDOW_CHUNKS_YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
    k += 1;
    const end = Math.min(start + chunkLines, lines.length);
    const slice = lines.slice(start, end);
    chunks.push({
      startLine: start + 1,
      endLine: end,
      text: slice.join('\n'),
    });
    if (end >= lines.length) {
      break;
    }
  }
  return chunks;
}

export async function chunkByLines(
  content: string,
  chunkLines: number,
  overlapLines: number,
): Promise<TextChunk[]> {
  const lines = await buildLinesArray(content);
  return chunkByLinesFromLinesWithYields(lines, chunkLines, overlapLines);
}

export type { SymbolSpan } from './chunker-symbols.js';

/** Indexing options for symbol detection (native tree-sitter + regex merge). */
export interface ChunkerOptions {
  /** `auto` / `tree_sitter` use `tree-sitter` when the native module loads; merge with regex. `regex` = line heuristics only. */
  defEngine: 'auto' | 'tree_sitter' | 'regex';
  /** Skip in-process parse for very large single files. */
  treeSitterMaxBytes: number;
}

export function buildChunkerOptions(config: AppConfig): ChunkerOptions {
  return {
    defEngine: config.defEngine,
    treeSitterMaxBytes: config.treeSitterMaxBytes,
  };
}

function detectLanguage(filePath: string): string {
  const dot = filePath.lastIndexOf('.');
  const ext = dot >= 0 ? filePath.slice(dot + 1).toLowerCase() : '';
  if (!ext) {
    return 'text';
  }
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) {
    return 'javascript';
  }
  if (ext === 'py') {
    return 'python';
  }
  if (ext === 'go') {
    return 'go';
  }
  if (ext === 'java') {
    return 'java';
  }
  if (ext === 'rs') {
    return 'rust';
  }
  if (ext === 'rb' || ext === 'rake' || ext === 'rbi') {
    return 'ruby';
  }
  return ext;
}

async function extractSymbolsRegex(lines: string[], language: string): Promise<SymbolSpan[]> {
  const symbols: SymbolSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && i % SYMBOLS_YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) {
      continue;
    }
    const lineNum = i + 1;
    let m: RegExpMatchArray | null = null;
    if (language === 'javascript') {
      m = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'function', startLine: lineNum });
        continue;
      }
      m = trimmed.match(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'class', startLine: lineNum });
        continue;
      }
      m = trimmed.match(/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'interface', startLine: lineNum });
        continue;
      }
      m = trimmed.match(
        /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)(?:<[^>]+>)?(?:\s*=\s*|\s+extends\b)/,
      );
      if (m) {
        symbols.push({ name: m[1]!, kind: 'type', startLine: lineNum });
        continue;
      }
      m = trimmed.match(/^(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'type', startLine: lineNum });
        continue;
      }
      m = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'function', startLine: lineNum });
        continue;
      }
      m = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'function', startLine: lineNum });
      }
      continue;
    }
    if (language === 'python') {
      m = trimmed.match(/^def\s+([A-Za-z_]\w*)\s*\(/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'function', startLine: lineNum });
        continue;
      }
      m = trimmed.match(/^class\s+([A-Za-z_]\w*)\b/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'class', startLine: lineNum });
      }
      continue;
    }
    if (language === 'ruby') {
      m = trimmed.match(/^\s*def\s+self\.([A-Za-z_][\w]*)/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'function', startLine: lineNum });
        continue;
      }
      m = trimmed.match(
        /^\s*def\s+([A-Za-z_](?:\w|_)*[!?]?(?:=(?=\s*\())?)(?=[\s\(\n#&;!]|$)/,
      );
      if (m) {
        symbols.push({ name: m[1]!, kind: 'function', startLine: lineNum });
        continue;
      }
      m = trimmed.match(
        /^\s*([A-Z][A-Za-z0-9_]*)\s*=\s*(?:::)?Struct\.new(?:\s*|\s*\(|\s*#)/,
      );
      if (m) {
        symbols.push({ name: m[1]!, kind: 'class', startLine: lineNum });
        continue;
      }
      m = trimmed.match(
        /^\s*([A-Z][A-Za-z0-9_]*)\s*=\s*(?:::)?Data\.define(?:\s*|\s*\(|\s*#)/,
      );
      if (m) {
        symbols.push({ name: m[1]!, kind: 'class', startLine: lineNum });
        continue;
      }
      m = trimmed.match(
        /^\s*([A-Z][A-Za-z0-9_]*)\s*=\s*(?:::)?Class\.new(?:\s*|\s*\(|\s*#)/,
      );
      if (m) {
        symbols.push({ name: m[1]!, kind: 'class', startLine: lineNum });
        continue;
      }
      m = trimmed.match(
        /^\s*([A-Z][A-Za-z0-9_]*)\s*=\s*(?:::)?Module\.new(?:\s*|\s*\(|\s*#)/,
      );
      if (m) {
        symbols.push({ name: m[1]!, kind: 'class', startLine: lineNum });
        continue;
      }
      m = trimmed.match(/^\s*enum\s+:([a-zA-Z_][\w]*)\b/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'type', startLine: lineNum });
        continue;
      }
      m = trimmed.match(/^\s*enum\s+([a-zA-Z_][\w]*)\s*:/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'type', startLine: lineNum });
        continue;
      }
      m = trimmed.match(/^\s*class\s+([A-Z][A-Za-z0-9_:]*)\b/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'class', startLine: lineNum });
        continue;
      }
      m = trimmed.match(/^\s*module\s+([A-Z][A-Za-z0-9_:]*)\b/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'class', startLine: lineNum });
        continue;
      }
    }
    m = trimmed.match(/^(?:export\s+)?(?:func|fn)\s+([A-Za-z_]\w*)\s*\(/);
    if (m) {
      symbols.push({ name: m[1]!, kind: 'function', startLine: lineNum });
      continue;
    }
    m = trimmed.match(/^(?:export\s+)?(?:class|struct|interface|trait|type)\s+([A-Za-z_]\w*)\b/);
    if (m) {
      symbols.push({ name: m[1]!, kind: 'type', startLine: lineNum });
    }
  }
  return symbols;
}

async function extractSymbols(
  lines: string[],
  language: string,
  content: string,
  filePath: string,
  options?: ChunkerOptions,
): Promise<SymbolSpan[]> {
  const regex = await extractSymbolsRegex(lines, language);
  if (!options || options.defEngine === 'regex') {
    return atMostOneSymbolPerLine(regex);
  }
  const ast = await getDefinitionSpansFromTreeSitter(filePath, content, options.treeSitterMaxBytes);
  return atMostOneSymbolPerLine(mergeAstWithRegex(ast, regex));
}

function sliceText(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join('\n');
}

async function splitLargeSymbolChunk(
  lines: string[],
  chunkLines: number,
  symbol: SymbolSpan,
  startLine: number,
  endLine: number,
): Promise<TextChunk[]> {
  const out: TextChunk[] = [];
  let cursor = startLine;
  let n = 0;
  while (cursor <= endLine) {
    n += 1;
    if (n > 1 && n % LINE_WINDOW_CHUNKS_YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
    const chunkEnd = Math.min(cursor + chunkLines - 1, endLine);
    out.push({
      startLine: cursor,
      endLine: chunkEnd,
      text: sliceText(lines, cursor, chunkEnd),
      symbolName: symbol.name,
      symbolKind: symbol.kind,
      ...(cursor === symbol.startLine ? { definitionOf: symbol.name } : {}),
    });
    cursor = chunkEnd + 1;
  }
  return out;
}

export async function chunkCodeAware(
  content: string,
  filePath: string,
  chunkLines: number,
  overlapLines: number,
  options?: ChunkerOptions,
): Promise<TextChunk[]> {
  const lines = await buildLinesArray(content);
  if (lines.length === 0) {
    return [];
  }
  const language = detectLanguage(filePath);
  const symbols = await extractSymbols(lines, language, content, filePath, options);
  if (symbols.length === 0) {
    const raw = await chunkByLinesFromLinesWithYields(lines, chunkLines, overlapLines);
    return raw.map((c) => ({ ...c, language }));
  }

  const chunks: TextChunk[] = [];
  if (symbols[0]!.startLine > 1) {
    chunks.push({
      startLine: 1,
      endLine: symbols[0]!.startLine - 1,
      text: sliceText(lines, 1, symbols[0]!.startLine - 1),
      language,
    });
  }

  for (let i = 0; i < symbols.length; i++) {
    if (i > 0 && i % CHUNKEMIT_YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
    const current = symbols[i]!;
    const next = symbols[i + 1];
    const startLine = current.startLine;
    const endLine = next ? next.startLine - 1 : lines.length;
    if (endLine < startLine) {
      continue;
    }
    const symbolChunks =
      endLine - startLine + 1 > chunkLines
        ? await splitLargeSymbolChunk(lines, chunkLines, current, startLine, endLine)
        : [
            {
              startLine,
              endLine,
              text: sliceText(lines, startLine, endLine),
              symbolName: current.name,
              symbolKind: current.kind,
              definitionOf: current.name,
            } as TextChunk,
          ];
    for (const c of symbolChunks) {
      chunks.push({ ...c, language });
    }
  }
  return chunks;
}

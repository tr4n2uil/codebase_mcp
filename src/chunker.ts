export interface TextChunk {
  startLine: number;
  endLine: number;
  text: string;
  language?: string;
  symbolName?: string;
  symbolKind?: string;
}

export function chunkByLines(content: string, chunkLines: number, overlapLines: number): TextChunk[] {
  const lines = content.split(/\r?\n/);
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

interface SymbolSpan {
  name: string;
  kind: string;
  startLine: number;
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
  return ext;
}

function extractSymbols(lines: string[], language: string): SymbolSpan[] {
  const symbols: SymbolSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) {
      continue;
    }

    let m: RegExpMatchArray | null = null;
    if (language === 'javascript') {
      m = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'function', startLine: i + 1 });
        continue;
      }
      m = trimmed.match(/^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'class', startLine: i + 1 });
        continue;
      }
      m = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'function', startLine: i + 1 });
        continue;
      }
      m = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\b/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'function', startLine: i + 1 });
      }
      continue;
    }

    if (language === 'python') {
      m = trimmed.match(/^def\s+([A-Za-z_]\w*)\s*\(/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'function', startLine: i + 1 });
        continue;
      }
      m = trimmed.match(/^class\s+([A-Za-z_]\w*)\b/);
      if (m) {
        symbols.push({ name: m[1]!, kind: 'class', startLine: i + 1 });
      }
      continue;
    }

    m = trimmed.match(/^(?:export\s+)?(?:func|fn)\s+([A-Za-z_]\w*)\s*\(/);
    if (m) {
      symbols.push({ name: m[1]!, kind: 'function', startLine: i + 1 });
      continue;
    }
    m = trimmed.match(/^(?:export\s+)?(?:class|struct|interface|trait|type)\s+([A-Za-z_]\w*)\b/);
    if (m) {
      symbols.push({ name: m[1]!, kind: 'type', startLine: i + 1 });
    }
  }
  return symbols;
}

function sliceText(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(startLine - 1, endLine).join('\n');
}

function splitLargeSymbolChunk(
  lines: string[],
  chunkLines: number,
  symbol: SymbolSpan,
  startLine: number,
  endLine: number,
): TextChunk[] {
  const out: TextChunk[] = [];
  let cursor = startLine;
  while (cursor <= endLine) {
    const chunkEnd = Math.min(cursor + chunkLines - 1, endLine);
    out.push({
      startLine: cursor,
      endLine: chunkEnd,
      text: sliceText(lines, cursor, chunkEnd),
      symbolName: symbol.name,
      symbolKind: symbol.kind,
    });
    cursor = chunkEnd + 1;
  }
  return out;
}

export function chunkCodeAware(
  content: string,
  filePath: string,
  chunkLines: number,
  overlapLines: number,
): TextChunk[] {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0) {
    return [];
  }
  const language = detectLanguage(filePath);
  const symbols = extractSymbols(lines, language);
  if (symbols.length === 0) {
    return chunkByLines(content, chunkLines, overlapLines).map((c) => ({ ...c, language }));
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
    const current = symbols[i]!;
    const next = symbols[i + 1];
    const startLine = current.startLine;
    const endLine = next ? next.startLine - 1 : lines.length;
    if (endLine < startLine) {
      continue;
    }
    const symbolChunks =
      endLine - startLine + 1 > chunkLines
        ? splitLargeSymbolChunk(lines, chunkLines, current, startLine, endLine)
        : [
            {
              startLine,
              endLine,
              text: sliceText(lines, startLine, endLine),
              symbolName: current.name,
              symbolKind: current.kind,
            } as TextChunk,
          ];
    for (const c of symbolChunks) {
      chunks.push({ ...c, language });
    }
  }
  return chunks;
}

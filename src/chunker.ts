export interface TextChunk {
  startLine: number;
  endLine: number;
  text: string;
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

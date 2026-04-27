import type { SymbolSpan } from './chunker-symbols.js';

/**
 * AST/Ripper wins per-line: if Ripper has any span on a line, regex spans on that line are dropped.
 * Then concat, sort, dedupe by (startLine, name). Keeps a stable order for code-aware chunking.
 */
export function mergeRipperWithRegex(ripper: SymbolSpan[], regex: SymbolSpan[]): SymbolSpan[] {
  if (ripper.length === 0) {
    return dedupeByLineAndName(regex);
  }
  const ripperLines = new Set(ripper.map((r) => r.startLine));
  const filtered = regex.filter((r) => !ripperLines.has(r.startLine));
  return dedupeByLineAndName([...ripper, ...filtered]);
}

/**
 * Code-aware chunking requires at most one “anchor” per line. If Ripper/regex list multiple
 * declarations on the same line (e.g. `module M; class C; end; end`), keep the **last** in sort order
 * (name/kind) so the inner struct wins over the outer.
 */
export function atMostOneSymbolPerLine(symbols: SymbolSpan[]): SymbolSpan[] {
  if (symbols.length < 2) {
    return symbols;
  }
  const sorted = [...symbols].sort(
    (a, b) =>
      a.startLine - b.startLine || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind),
  );
  const out: SymbolSpan[] = [];
  let i = 0;
  while (i < sorted.length) {
    const line = sorted[i]!.startLine;
    let last = sorted[i]!;
    while (i + 1 < sorted.length && sorted[i + 1]!.startLine === line) {
      i += 1;
      last = sorted[i]!;
    }
    out.push(last);
    i += 1;
  }
  return out;
}

function dedupeByLineAndName(symbols: SymbolSpan[]): SymbolSpan[] {
  const seen = new Set<string>();
  const out: SymbolSpan[] = [];
  for (const s of symbols) {
    const k = `${s.startLine}\0${s.name}\0${s.kind}`;
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    out.push(s);
  }
  out.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind));
  return out;
}

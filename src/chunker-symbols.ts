/** One detected declaration (regex or Ripper) for code-aware symbol boundaries. */
export interface SymbolSpan {
  name: string;
  kind: string;
  startLine: number;
}

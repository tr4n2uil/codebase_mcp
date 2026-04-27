/** One detected declaration (regex or tree-sitter) for code-aware symbol boundaries. */
export interface SymbolSpan {
  name: string;
  kind: string;
  startLine: number;
}

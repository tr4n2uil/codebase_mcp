/** One detected declaration (regex or tree-sitter) for code-aware symbol boundaries. */
export interface SymbolSpan {
  name: string;
  kind: string;
  startLine: number;
  /** Optional ancestor scope path (for example `Users::Callbacks` or `MyClass`). */
  scopePath?: string;
}

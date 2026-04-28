import picomatch from 'picomatch';

/**
 * Maps `lang` tool argument to file suffixes (no leading dot in values; we normalize to `.ext`).
 * Keys are lowercased; unknown `lang` is rejected at parse time.
 */
const LANG_EXTS: Record<string, string[]> = {
  ruby: ['rb', 'rake', 'gemspec'],
  rb: ['rb', 'rake', 'gemspec'],
  javascript: ['js', 'cjs', 'mjs', 'jsx', 'vue'],
  js: ['js', 'cjs', 'mjs', 'jsx', 'vue'],
  typescript: ['ts', 'mts', 'cts', 'tsx', 'vue'],
  ts: ['ts', 'mts', 'cts', 'tsx', 'vue'],
  python: ['py', 'pyi', 'pyw'],
  py: ['py', 'pyi', 'pyw'],
  go: ['go'],
  rust: ['rs'],
  rs: ['rs'],
  java: ['java'],
  kotlin: ['kt', 'kts'],
  kt: ['kt', 'kts'],
  scala: ['scala', 'sc', 'sbt'],
  c: ['c', 'h'],
  cpp: ['cc', 'cpp', 'cxx', 'h', 'hpp', 'hxx', 'hh'],
  csharp: ['cs'],
  cs: ['cs'],
  fsharp: ['fs', 'fsi', 'fsx'],
  fs: ['fs', 'fsi', 'fsx'],
  elixir: ['ex', 'exs'],
  ex: ['ex', 'exs'],
  erl: ['erl', 'hrl'],
  hcl: ['hcl', 'tf', 'tfvars'],
  json: ['json', 'jsonc'],
  yaml: ['yaml', 'yml'],
  yml: ['yaml', 'yml'],
  toml: ['toml'],
  html: ['html', 'htm'],
  css: ['css', 'scss', 'sass', 'less'],
  markdown: ['md', 'mdx', 'markdown'],
  md: ['md', 'mdx'],
  shell: ['sh', 'bash', 'zsh', 'fish'],
  sh: ['sh', 'bash', 'zsh', 'fish'],
  sql: ['sql'],
  swift: ['swift'],
};

function normalizeOneExt(s: string): string {
  const t = s.trim().toLowerCase();
  if (!t) {
    return '';
  }
  return t.startsWith('.') ? t : `.${t}`;
}

/** Parse `ext` string or list into a list of lowercased `.{suffix}` (including leading dot). */
function parseExtList(ext?: string | string[]): string[] {
  if (ext == null) {
    return [];
  }
  const raw = Array.isArray(ext) ? ext : ext.split(/[,\n\r]+/);
  return raw.map((s) => normalizeOneExt(String(s).trim())).filter((e) => e.length > 0);
}

function pathSuffixMatchesExts(filePath: string, exts: string[]): boolean {
  const p = filePath.toLowerCase();
  for (const e of exts) {
    if (p.endsWith(e)) {
      return true;
    }
  }
  return false;
}

export type PathQueryForSearchResult =
  | { ok: true; pathFilter?: (relPath: string) => boolean; pathFilterNarrowing: boolean }
  | { ok: false; error: string };

/**
 * Build optional (ext ∪ lang) ∩ glob over repo-relative POSIX paths.
 * If none of `ext` / `lang` / `glob` are set, returns { ok, pathFilter: undefined, narrowing: false }.
 * `ext` and `lang` are unioned into one allowed-suffix set; that set is then ANDed with `glob` when set.
 */
export function parsePathQueryForSearch(input: {
  ext?: string | string[];
  lang?: string;
  glob?: string;
}): PathQueryForSearchResult {
  const extSet = new Set<string>(parseExtList(input.ext));
  if (input.lang?.trim()) {
    const key = input.lang.trim().toLowerCase();
    const list = LANG_EXTS[key];
    if (list == null) {
      return {
        ok: false,
        error: `Unknown lang "${input.lang.trim()}". Use a known name (e.g. ruby, typescript) or set ext= instead.`,
      };
    }
    for (const s of list) {
      const e = normalizeOneExt(s);
      if (e) {
        extSet.add(e);
      }
    }
  }
  const exts = [...extSet];
  const hasExts = exts.length > 0;
  const g = input.glob?.trim() ?? '';
  const hasGlob = g.length > 0;
  if (!hasExts && !hasGlob) {
    return { ok: true, pathFilter: undefined, pathFilterNarrowing: false };
  }
  let globMatcher: ((p: string) => boolean) | null = null;
  if (hasGlob) {
    try {
      /**
       * Grep/ripgrep-like UX: `*.rb` should match nested files by basename (e.g. `app/models/user.rb`),
       * while path-aware patterns (for example `app/**\/*.rb`) continue to work.
       */
      globMatcher = picomatch(g, { dot: true, basename: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Invalid glob: ${msg}` };
    }
  }
  const extCopy = exts;
  const matches = (relPath: string): boolean => {
    const p = relPath.replace(/\\/g, '/');
    if (hasExts) {
      if (!pathSuffixMatchesExts(p, extCopy)) {
        return false;
      }
    }
    if (globMatcher) {
      return globMatcher(p);
    }
    return true;
  };
  return { ok: true, pathFilter: matches, pathFilterNarrowing: true };
}

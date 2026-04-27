import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * All languages used by the chunker. Grammars load lazily; a missing/failed .node binding
 * only disables that language (regex fallback for those files).
 */
export type TSGrammar = 'ts' | 'tsx' | 'js' | 'py' | 'rb' | 'go' | 'java' | 'rs';

export type TSGrammarSet = {
  Parser: { new (...args: unknown[]): TSParser };
  languages: Record<TSGrammar, TSLanguage | null>;
};

export type TSLanguage = object;

export type TSParser = {
  setLanguage(lang: TSLanguage | null): void;
  parse(input: string, old?: unknown | null): TSTree;
};

export type TSTree = { rootNode: TSNode; hasError: boolean };

export type TSNode = {
  type: string;
  text: string;
  namedChildCount: number;
  namedChild: (i: number) => TSNode;
  childForFieldName: (name: string) => TSNode | null;
  startPosition: { row: number; column: number };
  walk: () => TSTreeCursor;
};

export type TSTreeCursor = {
  nodeType: string;
  currentNode: TSNode;
  gotoFirstChild: () => boolean;
  gotoNextSibling: () => boolean;
  gotoParent: () => boolean;
};

let cache: TSGrammarSet | 'failed' | null = null;

function tryReq<T = unknown>(id: string): T | null {
  try {
    return require(id) as T;
  } catch {
    return null;
  }
}

function asLanguage(m: TSLanguage | { default: TSLanguage } | null): TSLanguage | null {
  if (!m) {
    return null;
  }
  if (typeof m === 'object' && m !== null && 'default' in m && (m as { default: TSLanguage }).default) {
    return (m as { default: TSLanguage }).default;
  }
  return m as TSLanguage;
}

function loadSet(): TSGrammarSet | null {
  const Parser = tryReq<{ new (): TSParser }>('tree-sitter');
  if (!Parser) {
    return null;
  }
  const TSP = tryReq<{
    typescript: TSLanguage;
    tsx: TSLanguage;
  }>('tree-sitter-typescript');
  const js = asLanguage(tryReq('tree-sitter-javascript'));
  const py = asLanguage(tryReq('tree-sitter-python'));
  const rb = asLanguage(tryReq('tree-sitter-ruby'));
  const go = asLanguage(tryReq('tree-sitter-go'));
  const java = asLanguage(tryReq('tree-sitter-java'));
  const rust = asLanguage(tryReq('tree-sitter-rust'));
  if (!TSP) {
    return {
      Parser: Parser as TSGrammarSet['Parser'],
      languages: { ts: null, tsx: null, js, py, rb, go, java, rs: rust },
    };
  }
  return {
    Parser: Parser as TSGrammarSet['Parser'],
    languages: {
      ts: TSP.typescript,
      tsx: TSP.tsx,
      js,
      py,
      rb,
      go,
      java,
      rs: rust,
    },
  };
}

/**
 * Return shared Parser + per-language `Language` objects, or `null` if the core
 * `tree-sitter` native module failed to load.
 */
export function getTreeSitterSet(): TSGrammarSet | null {
  if (cache === 'failed') {
    return null;
  }
  if (cache) {
    return cache;
  }
  const s = loadSet();
  if (!s) {
    cache = 'failed';
    return null;
  }
  cache = s;
  return s;
}

export function pickGrammarForPath(filePath: string): TSGrammar | null {
  const dot = filePath.lastIndexOf('.');
  const ext = dot >= 0 ? filePath.slice(dot + 1).toLowerCase() : '';
  if (ext === 'ts') {
    return 'ts';
  }
  if (ext === 'tsx') {
    return 'tsx';
  }
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs' || ext === 'cjs') {
    return 'js';
  }
  if (ext === 'py') {
    return 'py';
  }
  if (ext === 'rb' || ext === 'rake' || ext === 'rbi') {
    return 'rb';
  }
  if (ext === 'go') {
    return 'go';
  }
  if (ext === 'java') {
    return 'java';
  }
  if (ext === 'rs') {
    return 'rs';
  }
  return null;
}

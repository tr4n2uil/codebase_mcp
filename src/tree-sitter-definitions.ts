import { createHash } from 'node:crypto';
import { yieldToEventLoop } from './event-loop-yield.js';
import type { SymbolSpan } from './chunker-symbols.js';
import { getTreeSitterSet, pickGrammarForPath, type TSGrammar } from './tree-sitter-loader.js';
import { logInfo } from './log.js';

const CACHE_VER = 1;
const CACHE_MAX = 2_000;
const spanCache = new Map<string, SymbolSpan[] | 'fail'>();

let loggedLoadFailure = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TAny = any;

function line1(node: { startPosition: { row: number } }): number {
  return node.startPosition.row + 1;
}

function nameFromField(
  n: TAny,
  field: string,
): string | null {
  if (!n) {
    return null;
  }
  const c = n.childForFieldName(field);
  return c && c.text ? c.text : null;
}

function methodLikeName(n: TAny): string | null {
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    if (
      c.type === 'property_identifier' ||
      c.type === 'private_property_identifier' ||
      c.type === 'public_field_identifier'
    ) {
      return c.text;
    }
  }
  return null;
}

async function walkTsLike(root: TAny): Promise<SymbolSpan[]> {
  const out: SymbolSpan[] = [];
  let nVisits = 0;
  const visit = async (n: TAny): Promise<void> => {
    nVisits += 1;
    if (nVisits % 4_000 === 0) {
      await yieldToEventLoop();
    }
    const t = n.type;
    if (
      t === 'function_declaration' ||
      t === 'generator_function' ||
      t === 'class_declaration' ||
      t === 'interface_declaration' ||
      t === 'type_alias_declaration' ||
      t === 'enum_declaration' ||
      t === 'abstract_class_declaration'
    ) {
      const raw = nameFromField(n, 'name');
      if (raw) {
        const kind =
          t === 'class_declaration' || t === 'abstract_class_declaration'
            ? 'class'
            : t === 'enum_declaration'
              ? 'type'
              : t === 'interface_declaration'
                ? 'interface'
                : t === 'type_alias_declaration'
                  ? 'type'
                  : 'function';
        out.push({ name: raw, kind, startLine: line1(n) });
      }
    } else if (t === 'method_definition' || t === 'public_field_definition' || t === 'abstract_method_signature') {
      const raw = nameFromField(n, 'name') ?? methodLikeName(n);
      if (raw) {
        out.push({ name: raw, kind: t === 'public_field_definition' ? 'class' : 'function', startLine: line1(n) });
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      await visit(n.namedChild(i));
    }
  };
  await visit(root);
  return out;
}

async function walkPython(root: TAny): Promise<SymbolSpan[]> {
  const out: SymbolSpan[] = [];
  let nVisits = 0;
  const visit = async (n: TAny): Promise<void> => {
    nVisits += 1;
    if (nVisits % 4_000 === 0) {
      await yieldToEventLoop();
    }
    if (n.type === 'function_definition' || n.type === 'class_definition') {
      const raw = nameFromField(n, 'name');
      if (raw) {
        out.push({
          name: raw,
          kind: n.type === 'class_definition' ? 'class' : 'function',
          startLine: line1(n),
        });
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      await visit(n.namedChild(i));
    }
  };
  await visit(root);
  return out;
}

async function walkRuby(root: TAny): Promise<SymbolSpan[]> {
  const out: SymbolSpan[] = [];
  let nVisits = 0;
  const visit = async (n: TAny, classScope: string[]): Promise<void> => {
    nVisits += 1;
    if (nVisits % 4_000 === 0) {
      await yieldToEventLoop();
    }
    if (n.type === 'method' || n.type === 'singleton_method') {
      const raw = nameFromField(n, 'name');
      if (raw) {
        const scopePath = classScope.length > 0 ? classScope.join('::') : undefined;
        const qualified = scopePath ? `${scopePath}#${raw}` : raw;
        out.push({ name: qualified, kind: 'function', startLine: line1(n), scopePath });
      }
    } else if (n.type === 'class' || n.type === 'module') {
      const raw = nameFromField(n, 'name');
      if (raw) {
        const thisScope = [...classScope, raw];
        const scopePath = classScope.length > 0 ? classScope.join('::') : undefined;
        out.push({
          name: thisScope.join('::'),
          kind: 'class',
          startLine: line1(n),
          ...(scopePath ? { scopePath } : {}),
        });
        for (let i = 0; i < n.namedChildCount; i++) {
          await visit(n.namedChild(i), thisScope);
        }
        return;
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      await visit(n.namedChild(i), classScope);
    }
  };
  await visit(root, []);
  return out;
}

async function walkGo(root: TAny): Promise<SymbolSpan[]> {
  const out: SymbolSpan[] = [];
  let nVisits = 0;
  const visit = async (n: TAny): Promise<void> => {
    nVisits += 1;
    if (nVisits % 4_000 === 0) {
      await yieldToEventLoop();
    }
    if (n.type === 'function_declaration' || n.type === 'method_declaration') {
      const raw = nameFromField(n, 'name');
      if (raw) {
        out.push({ name: raw, kind: 'function', startLine: line1(n) });
      }
    } else if (n.type === 'type_spec') {
      const raw = nameFromField(n, 'name');
      if (raw) {
        out.push({ name: raw, kind: 'type', startLine: line1(n) });
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      await visit(n.namedChild(i));
    }
  };
  await visit(root);
  return out;
}

async function walkJava(root: TAny): Promise<SymbolSpan[]> {
  const out: SymbolSpan[] = [];
  let nVisits = 0;
  const visit = async (n: TAny): Promise<void> => {
    nVisits += 1;
    if (nVisits % 4_000 === 0) {
      await yieldToEventLoop();
    }
    if (n.type === 'class_declaration' || n.type === 'interface_declaration' || n.type === 'enum_declaration') {
      const raw = nameFromField(n, 'name');
      if (raw) {
        out.push({
          name: raw,
          kind: n.type === 'interface_declaration' ? 'interface' : n.type === 'enum_declaration' ? 'type' : 'class',
          startLine: line1(n),
        });
      }
    } else if (n.type === 'method_declaration' || n.type === 'constructor_declaration') {
      const raw = nameFromField(n, 'name');
      if (raw) {
        out.push({ name: raw, kind: 'function', startLine: line1(n) });
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      await visit(n.namedChild(i));
    }
  };
  await visit(root);
  return out;
}

async function walkRust(root: TAny): Promise<SymbolSpan[]> {
  const out: SymbolSpan[] = [];
  let nVisits = 0;
  const visit = async (n: TAny): Promise<void> => {
    nVisits += 1;
    if (nVisits % 4_000 === 0) {
      await yieldToEventLoop();
    }
    if (
      n.type === 'function_item' ||
      n.type === 'struct_item' ||
      n.type === 'enum_item' ||
      n.type === 'trait_item' ||
      n.type === 'type_item' ||
      n.type === 'mod_item'
    ) {
      const raw = nameFromField(n, 'name');
      if (raw) {
        const kind =
          n.type === 'struct_item' || n.type === 'enum_item' || n.type === 'trait_item' || n.type === 'type_item'
            ? 'type'
            : n.type === 'mod_item'
              ? 'class'
              : 'function';
        out.push({ name: raw, kind, startLine: line1(n) });
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      await visit(n.namedChild(i));
    }
  };
  await visit(root);
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharedParser: any = null;

function getParser(ParserClass: new () => TAny): TAny {
  if (!sharedParser) {
    sharedParser = new ParserClass();
  }
  return sharedParser;
}

async function runCollector(grammar: TSGrammar, content: string, lang: TAny, ParserClass: new () => TAny): Promise<SymbolSpan[]> {
  const p = getParser(ParserClass);
  p.setLanguage(lang);
  const tree = p.parse(content);
  const root = tree.rootNode;
  switch (grammar) {
    case 'ts':
    case 'tsx':
    case 'js':
      return walkTsLike(root);
    case 'py':
      return walkPython(root);
    case 'rb':
      return walkRuby(root);
    case 'go':
      return walkGo(root);
    case 'java':
      return walkJava(root);
    case 'rs':
      return walkRust(root);
    default:
      return [];
  }
}

/**
 * Return declaration `SymbolSpan`s for supported paths using the native `tree-sitter` stack, or
 * `[]` if native bindings, grammar, or parse failed.
 */
export async function getDefinitionSpansFromTreeSitter(
  filePath: string,
  content: string,
  maxBytes: number,
): Promise<SymbolSpan[]> {
  const grammar = pickGrammarForPath(filePath);
  if (!grammar) {
    return [];
  }
  if (content.length > maxBytes) {
    return [];
  }
  const bundle = getTreeSitterSet();
  if (!bundle) {
    if (!loggedLoadFailure) {
      loggedLoadFailure = true;
      logInfo('chunker', 'tree-sitter: native module failed to load (using regex for definitions only)');
    }
    return [];
  }
  const lang = bundle.languages[grammar];
  if (!lang) {
    return [];
  }
  const h = createHash('sha256').update(content, 'utf8').digest('hex');
  const key = `${CACHE_VER}\0${h}\0${grammar}`;
  const hit = spanCache.get(key);
  if (hit) {
    return hit === 'fail' ? [] : hit;
  }
  try {
    const spans = await runCollector(grammar, content, lang, bundle.Parser);
    if (spanCache.size >= CACHE_MAX) {
      const k = spanCache.keys().next();
      if (!k.done) {
        spanCache.delete(k.value);
      }
    }
    spanCache.set(key, spans);
    return spans;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!loggedLoadFailure) {
      loggedLoadFailure = true;
      logInfo('chunker', `tree-sitter: parse/visitor error (${msg}) — using regex for definitions only`);
    }
    spanCache.set(key, 'fail');
    return [];
  }
}

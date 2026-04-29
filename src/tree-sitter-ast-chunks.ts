/**
 * Hierarchical code chunking: explicit Tree-sitter node ranges and recursive splits
 * along class/method (and similar) boundaries instead of "next declaration start line".
 */
import { yieldToEventLoop } from './event-loop-yield.js';
import { getTreeSitterSet, pickGrammarForPath, type TSGrammar } from './tree-sitter-loader.js';

/** Chunk fragment — caller attaches `language`. Kept local to avoid importing `chunker.js` here. */
export interface ChunkFrag {
  startLine: number;
  endLine: number;
  text: string;
  symbolName?: string;
  symbolKind?: string;
  definitionOf?: string;
  scopePath?: string;
  chunkMode?: 'symbol' | 'symbol_split' | 'preamble' | 'fallback_lexical';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TAny = any;

const YIELD_EVERY = 4000;
const CHUNK_YIELD_EVERY = 200;

/** Runtime tree-sitter nodes expose byte indices. */
type TSNodeExt = TAny & { startIndex: number; endIndex: number };

function lineRange(n: TSNodeExt): { startLine: number; endLine: number } {
  return {
    startLine: n.startPosition.row + 1,
    endLine: n.endPosition.row + 1,
  };
}

function sliceLines(lines: string[], startLine: number, endLine: number): string {
  if (startLine > endLine || startLine < 1) {
    return '';
  }
  return lines.slice(startLine - 1, endLine).join('\n');
}

function nameFromField(n: TAny, field: string): string | null {
  const c = n.childForFieldName?.(field) as TAny | null;
  return c?.text ?? null;
}

function methodLikeNameTs(n: TAny): string | null {
  for (let i = 0; i < n.namedChildCount; i++) {
    const c = n.namedChild(i);
    const t = c.type;
    if (t === 'property_identifier' || t === 'private_property_identifier' || t === 'public_field_identifier') {
      return c.text;
    }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharedParser: any = null;

function getParser(ParserClass: new () => TAny): TAny {
  if (!sharedParser) {
    sharedParser = new ParserClass();
  }
  return sharedParser;
}

async function lineSplitSpan(
  lines: string[],
  startLine: number,
  endLine: number,
  chunkLines: number,
  base: Pick<ChunkFrag, 'symbolName' | 'symbolKind' | 'scopePath' | 'definitionOf'>,
): Promise<ChunkFrag[]> {
  if (startLine > endLine) {
    return [];
  }
  const out: ChunkFrag[] = [];
  let cursor = startLine;
  let k = 0;
  while (cursor <= endLine) {
    k += 1;
    if (k > 1 && k % CHUNK_YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
    const chunkEnd = Math.min(cursor + chunkLines - 1, endLine);
    const defHere = cursor === startLine ? base.definitionOf : undefined;
    out.push({
      startLine: cursor,
      endLine: chunkEnd,
      text: sliceLines(lines, cursor, chunkEnd),
      symbolName: base.symbolName,
      symbolKind: base.symbolKind,
      scopePath: base.scopePath,
      chunkMode: 'symbol_split',
      ...(defHere ? { definitionOf: base.definitionOf } : {}),
    });
    cursor = chunkEnd + 1;
  }
  return out;
}

async function emitLeafOrSplit(
  lines: string[],
  n: TSNodeExt,
  chunkLines: number,
  name: string,
  kind: string,
  definitionOf: string | undefined,
  scopePath?: string,
): Promise<ChunkFrag[]> {
  const { startLine: sl, endLine: el } = lineRange(n);
  const nLines = el - sl + 1;
  if (nLines <= chunkLines) {
    return [
      {
        startLine: sl,
        endLine: el,
        text: sliceLines(lines, sl, el),
        symbolName: name,
        symbolKind: kind,
        ...(scopePath ? { scopePath } : {}),
        chunkMode: 'symbol',
        ...(definitionOf ? { definitionOf } : {}),
      },
    ];
  }
  return lineSplitSpan(lines, sl, el, chunkLines, {
    symbolName: name,
    symbolKind: kind,
    scopePath,
    definitionOf: definitionOf ?? name,
  });
}

function unwrapExportLike(n: TAny): TAny {
  const t = n.type;
  if (t === 'export_statement' || t === 'export_declaration') {
    const d = n.childForFieldName?.('declaration') as TAny | null;
    if (d) {
      return d;
    }
    if (n.namedChildCount > 0) {
      return n.namedChild(0);
    }
  }
  return n;
}

function collectTsClassMembers(body: TAny): TAny[] {
  const out: TAny[] = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const ch = body.namedChild(i);
    const t = ch.type;
    if (
      t === 'method_definition' ||
      t === 'public_field_definition' ||
      t === 'abstract_method_signature' ||
      t === 'class_declaration' ||
      t === 'abstract_class_declaration'
    ) {
      out.push(ch);
    }
  }
  out.sort((a, b) => (a.startIndex as number) - (b.startIndex as number));
  return out;
}

async function emitTsClassLike(
  lines: string[],
  n: TAny,
  chunkLines: number,
  name: string,
  kind = 'class',
): Promise<ChunkFrag[]> {
  const node = n as TSNodeExt;
  const clsRange = lineRange(node);
  const nLinesTot = clsRange.endLine - clsRange.startLine + 1;
  if (nLinesTot <= chunkLines) {
    return [
      {
        startLine: clsRange.startLine,
        endLine: clsRange.endLine,
        text: sliceLines(lines, clsRange.startLine, clsRange.endLine),
        symbolName: name,
        symbolKind: kind,
        chunkMode: 'symbol',
        definitionOf: name,
      },
    ];
  }
  const body = n.childForFieldName?.('body') as TAny | null;
  if (!body) {
    return lineSplitSpan(lines, clsRange.startLine, clsRange.endLine, chunkLines, {
      symbolName: name,
      symbolKind: kind,
      definitionOf: name,
    });
  }
  const members = collectTsClassMembers(body);
  if (members.length === 0) {
    return lineSplitSpan(lines, clsRange.startLine, clsRange.endLine, chunkLines, {
      symbolName: name,
      symbolKind: kind,
      definitionOf: name,
    });
  }
  let cursor = clsRange.startLine;
  const out: ChunkFrag[] = [];
  let memberNum = 0;
  for (const mem of members) {
    memberNum += 1;
    if (memberNum % CHUNK_YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
    const m = mem as TSNodeExt;
    const mt = m.type;
    const mr = lineRange(m);
    const hdr =
      mr.startLine > cursor ? sliceLines(lines, cursor, mr.startLine - 1) : '';
    if (mt === 'class_declaration' || mt === 'abstract_class_declaration') {
      const innerName = nameFromField(m, 'name') ?? 'Class';
      const nested = await emitTsClassLike(lines, mem, chunkLines, innerName, 'class');
      if (hdr.trim().length > 0 && nested.length > 0) {
        nested[0] = {
          ...nested[0]!,
          text: hdr + '\n' + nested[0]!.text,
          startLine: cursor,
        };
      } else if (nested.length === 0 && hdr.trim().length > 0) {
        out.push({
          startLine: cursor,
          endLine: mr.startLine - 1,
          text: hdr,
          symbolName: name,
          symbolKind: kind,
          chunkMode: 'symbol',
          definitionOf: name,
        });
      }
      out.push(...nested);
    } else {
      const memName = nameFromField(m, 'name') ?? methodLikeNameTs(m) ?? 'member';
      const memKind = mt === 'public_field_definition' ? 'class' : 'function';
      const defOf = mt === 'public_field_definition' ? undefined : memName;
      const memChunks = await emitLeafOrSplit(lines, m, chunkLines, memName, memKind, defOf);
      if (hdr.trim().length > 0 && memChunks.length > 0) {
        memChunks[0] = {
          ...memChunks[0]!,
          text: hdr + '\n' + memChunks[0]!.text,
          startLine: cursor,
          ...(cursor === clsRange.startLine ? { definitionOf: name } : {}),
        };
      }
      out.push(...memChunks);
    }
    cursor = mr.endLine + 1;
  }
  if (cursor <= clsRange.endLine) {
    const tail = sliceLines(lines, cursor, clsRange.endLine);
    if (tail.trim().length > 0) {
      out.push({
        startLine: cursor,
        endLine: clsRange.endLine,
        text: tail,
        symbolName: name,
        symbolKind: kind,
        chunkMode: 'symbol',
        definitionOf: name,
      });
    }
  }
  return out;
}

async function emitTsTopLevelDecl(lines: string[], n: TAny, chunkLines: number): Promise<ChunkFrag[]> {
  const u = unwrapExportLike(n);
  const t = u.type;
  if (t === 'class_declaration' || t === 'abstract_class_declaration') {
    const raw = nameFromField(u, 'name');
    return raw ? await emitTsClassLike(lines, u, chunkLines, raw, 'class') : [];
  }
  if (
    t === 'function_declaration' ||
    t === 'generator_function' ||
    t === 'function' ||
    t === 'generator_function_declaration'
  ) {
    const raw = nameFromField(u, 'name');
    return raw ? await emitLeafOrSplit(lines, u as TSNodeExt, chunkLines, raw, 'function', raw) : [];
  }
  if (t === 'interface_declaration') {
    const raw = nameFromField(u, 'name');
    return raw ? await emitLeafOrSplit(lines, u as TSNodeExt, chunkLines, raw, 'interface', raw) : [];
  }
  if (t === 'type_alias_declaration') {
    const raw = nameFromField(u, 'name');
    return raw ? await emitLeafOrSplit(lines, u as TSNodeExt, chunkLines, raw, 'type', raw) : [];
  }
  if (t === 'enum_declaration') {
    const raw = nameFromField(u, 'name');
    return raw ? await emitLeafOrSplit(lines, u as TSNodeExt, chunkLines, raw, 'type', raw) : [];
  }
  if (t === 'lexical_declaration') {
    for (let i = 0; i < u.namedChildCount; i++) {
      const ch = u.namedChild(i);
      const decl = unwrapExportLike(ch);
      const subt = decl.type;
      if (subt === 'class_declaration' || subt === 'abstract_class_declaration' || subt === 'function_declaration') {
        const r = await emitTsTopLevelDecl(lines, decl, chunkLines);
        if (r.length > 0) {
          return r;
        }
      }
    }
  }
  return [];
}

async function chunkTsJsModule(root: TAny, lines: string[], chunkLines: number, nVisits: { v: number }): Promise<ChunkFrag[]> {
  const out: ChunkFrag[] = [];
  let firstDeclLine: number | null = null;

  for (let i = 0; i < root.namedChildCount; i++) {
    nVisits.v += 1;
    if (nVisits.v % YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
    const ch = unwrapExportLike(root.namedChild(i));
    const t = ch.type;
    if (t === 'import_statement' || t === 'import') {
      continue;
    }
    const decl = await emitTsTopLevelDecl(lines, ch, chunkLines);
    if (decl.length === 0) {
      continue;
    }
    const start = decl[0]!.startLine;
    if (firstDeclLine === null || start < firstDeclLine) {
      firstDeclLine = start;
    }
    out.push(...decl);
  }

  if (out.length === 0) {
    return [];
  }
  if (firstDeclLine !== null && firstDeclLine > 1) {
    const pre = sliceLines(lines, 1, firstDeclLine - 1);
    if (pre.trim().length > 0) {
      const c0 = out[0]!;
      out[0] = {
        ...c0,
        text: pre + '\n' + c0.text,
        startLine: 1,
      };
    }
  }
  return out;
}

function collectPythonClassMembers(classNode: TAny): TAny[] {
  const body = classNode.childForFieldName?.('body') as TAny | null;
  if (!body) {
    return [];
  }
  const out: TAny[] = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const ch = body.namedChild(i);
    if (ch.type === 'function_definition' || ch.type === 'class_definition') {
      out.push(ch);
    }
  }
  out.sort((a, b) => (a.startIndex as number) - (b.startIndex as number));
  return out;
}

async function emitPythonClass(
  lines: string[],
  n: TAny,
  chunkLines: number,
  name: string,
): Promise<ChunkFrag[]> {
  const node = n as TSNodeExt;
  const clsRange = lineRange(node);
  const nLinesTot = clsRange.endLine - clsRange.startLine + 1;
  if (nLinesTot <= chunkLines) {
    return [
      {
        startLine: clsRange.startLine,
        endLine: clsRange.endLine,
        text: sliceLines(lines, clsRange.startLine, clsRange.endLine),
        symbolName: name,
        symbolKind: 'class',
        chunkMode: 'symbol',
        definitionOf: name,
      },
    ];
  }
  const members = collectPythonClassMembers(n);
  if (members.length === 0) {
    return lineSplitSpan(lines, clsRange.startLine, clsRange.endLine, chunkLines, {
      symbolName: name,
      symbolKind: 'class',
      definitionOf: name,
    });
  }
  let cursor = clsRange.startLine;
  const out: ChunkFrag[] = [];
  for (const mem of members) {
    const m = mem as TSNodeExt;
    const mr = lineRange(m);
    const hdr =
      mr.startLine > cursor ? sliceLines(lines, cursor, mr.startLine - 1) : '';
    if (mem.type === 'class_definition') {
      const inner = nameFromField(mem, 'name') ?? 'Class';
      const nested = await emitPythonClass(lines, mem, chunkLines, inner);
      if (hdr.trim().length > 0 && nested.length > 0) {
        nested[0] = {
          ...nested[0]!,
          text: hdr + '\n' + nested[0]!.text,
          startLine: cursor,
        };
      }
      out.push(...nested);
    } else {
      const fn = nameFromField(mem, 'name') ?? 'fn';
      const memChunks = await emitLeafOrSplit(lines, m, chunkLines, fn, 'function', fn);
      if (hdr.trim().length > 0 && memChunks.length > 0) {
        memChunks[0] = {
          ...memChunks[0]!,
          text: hdr + '\n' + memChunks[0]!.text,
          startLine: cursor,
        };
      }
      out.push(...memChunks);
    }
    cursor = mr.endLine + 1;
  }
  if (cursor <= clsRange.endLine) {
    const tail = sliceLines(lines, cursor, clsRange.endLine);
    if (tail.trim().length > 0) {
      out.push({
        startLine: cursor,
        endLine: clsRange.endLine,
        text: tail,
        symbolName: name,
        symbolKind: 'class',
        chunkMode: 'symbol',
        definitionOf: name,
      });
    }
  }
  return out;
}

function unwrapPythonStmt(n: TAny): TAny {
  if (n.type === 'decorated_definition') {
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c.type === 'function_definition' || c.type === 'class_definition') {
        return c;
      }
    }
  }
  return n;
}

async function chunkPythonModule(root: TAny, lines: string[], chunkLines: number, nVisits: { v: number }): Promise<ChunkFrag[]> {
  const out: ChunkFrag[] = [];
  let firstDeclLine: number | null = null;
  for (let i = 0; i < root.namedChildCount; i++) {
    nVisits.v += 1;
    if (nVisits.v % YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
    const ch = unwrapPythonStmt(root.namedChild(i));
    if (ch.type === 'function_definition') {
      const raw = nameFromField(ch, 'name');
      if (!raw) {
        continue;
      }
      const decl = await emitLeafOrSplit(lines, ch as TSNodeExt, chunkLines, raw, 'function', raw);
      if (decl.length > 0 && firstDeclLine === null) {
        firstDeclLine = decl[0]!.startLine;
      }
      out.push(...decl);
    } else if (ch.type === 'class_definition') {
      const raw = nameFromField(ch, 'name');
      if (!raw) {
        continue;
      }
      const decl = await emitPythonClass(lines, ch, chunkLines, raw);
      if (decl.length > 0 && firstDeclLine === null) {
        firstDeclLine = decl[0]!.startLine;
      }
      out.push(...decl);
    }
  }
  if (out.length === 0) {
    return [];
  }
  if (firstDeclLine !== null && firstDeclLine > 1) {
    const pre = sliceLines(lines, 1, firstDeclLine - 1);
    if (pre.trim().length > 0) {
      out[0] = { ...out[0]!, text: pre + '\n' + out[0]!.text, startLine: 1 };
    }
  }
  return out;
}

function walkRubyClassBody(classNode: TAny, acc: TAny[]): void {
  const body = (classNode.childForFieldName?.('body') as TAny | null) ?? null;
  if (!body) {
    return;
  }
  const visit = (n: TAny): void => {
    const t = n.type;
    if (t === 'method' || t === 'singleton_method') {
      acc.push(n);
      return;
    }
    if (t === 'class' || t === 'module') {
      acc.push(n);
      return;
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      visit(n.namedChild(i));
    }
  };
  visit(body);
}

async function emitRubyClassOrModule(
  lines: string[],
  n: TAny,
  chunkLines: number,
  qualifiedName: string,
  scopePath: string | undefined,
): Promise<ChunkFrag[]> {
  const node = n as TSNodeExt;
  const modRange = lineRange(node);
  const nLinesTot = modRange.endLine - modRange.startLine + 1;
  if (nLinesTot <= chunkLines) {
    return [
      {
        startLine: modRange.startLine,
        endLine: modRange.endLine,
        text: sliceLines(lines, modRange.startLine, modRange.endLine),
        symbolName: qualifiedName,
        symbolKind: 'class',
        ...(scopePath ? { scopePath } : {}),
        chunkMode: 'symbol',
        definitionOf: qualifiedName,
      },
    ];
  }
  const members: TAny[] = [];
  walkRubyClassBody(n, members);
  members.sort((a, b) => (a.startIndex as number) - (b.startIndex as number));
  if (members.length === 0) {
    return lineSplitSpan(lines, modRange.startLine, modRange.endLine, chunkLines, {
      symbolName: qualifiedName,
      symbolKind: 'class',
      scopePath,
      definitionOf: qualifiedName,
    });
  }
  let cursor = modRange.startLine;
  const out: ChunkFrag[] = [];
  for (const mem of members) {
    const m = mem as TSNodeExt;
    const mr = lineRange(m);
    const hdr =
      mr.startLine > cursor ? sliceLines(lines, cursor, mr.startLine - 1) : '';
    if (mem.type === 'class' || mem.type === 'module') {
      const raw = nameFromField(mem, 'name');
      if (!raw) {
        cursor = mr.endLine + 1;
        continue;
      }
      const childFq = `${qualifiedName}::${raw}`;
      const nested = await emitRubyClassOrModule(lines, mem, chunkLines, childFq, qualifiedName);
      if (hdr.trim().length > 0 && nested.length > 0) {
        nested[0] = {
          ...nested[0]!,
          text: hdr + '\n' + nested[0]!.text,
          startLine: cursor,
        };
      }
      out.push(...nested);
    } else {
      const meth = nameFromField(mem, 'name') ?? 'method';
      const mq = `${qualifiedName}#${meth}`;
      const memChunks = await emitLeafOrSplit(lines, m, chunkLines, mq, 'function', meth, qualifiedName);
      if (hdr.trim().length > 0 && memChunks.length > 0) {
        memChunks[0] = {
          ...memChunks[0]!,
          text: hdr + '\n' + memChunks[0]!.text,
          startLine: cursor,
        };
      }
      out.push(...memChunks);
    }
    cursor = mr.endLine + 1;
  }
  if (cursor <= modRange.endLine) {
    const tail = sliceLines(lines, cursor, modRange.endLine);
    if (tail.trim().length > 0) {
      out.push({
        startLine: cursor,
        endLine: modRange.endLine,
        text: tail,
        symbolName: qualifiedName,
        symbolKind: 'class',
        ...(scopePath ? { scopePath } : {}),
        chunkMode: 'symbol',
        definitionOf: qualifiedName,
      });
    }
  }
  return out;
}

async function chunkRubyProgram(root: TAny, lines: string[], chunkLines: number, nVisits: { v: number }): Promise<ChunkFrag[]> {
  const out: ChunkFrag[] = [];
  let firstDeclLine: number | null = null;

  async function walk(n: TAny, classScope: string[]): Promise<void> {
    nVisits.v += 1;
    if (nVisits.v % YIELD_EVERY === 0) {
      await yieldToEventLoop();
    }
    const t = n.type;
    if (t === 'method' || t === 'singleton_method') {
      const raw = nameFromField(n, 'name');
      if (!raw) {
        return;
      }
      const scopePath = classScope.length > 0 ? classScope.join('::') : undefined;
      const qualified = scopePath ? `${scopePath}#${raw}` : raw;
      const decl = await emitLeafOrSplit(lines, n as TSNodeExt, chunkLines, qualified, 'function', raw, scopePath);
      if (decl.length > 0) {
        if (firstDeclLine === null) {
          firstDeclLine = decl[0]!.startLine;
        }
        out.push(...decl);
      }
      return;
    }
    if (t === 'class' || t === 'module') {
      const raw = nameFromField(n, 'name');
      if (!raw) {
        return;
      }
      const thisScope = [...classScope, raw];
      const scopePath = classScope.length > 0 ? classScope.join('::') : undefined;
      const qualified = thisScope.join('::');
      const decl = await emitRubyClassOrModule(lines, n, chunkLines, qualified, scopePath);
      if (decl.length > 0) {
        if (firstDeclLine === null) {
          firstDeclLine = decl[0]!.startLine;
        }
        out.push(...decl);
      }
      return;
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      await walk(n.namedChild(i), classScope);
    }
  }

  await walk(root, []);

  if (out.length === 0) {
    return [];
  }
  if (firstDeclLine !== null && firstDeclLine > 1) {
    const pre = sliceLines(lines, 1, firstDeclLine - 1);
    if (pre.trim().length > 0) {
      out[0] = { ...out[0]!, text: pre + '\n' + out[0]!.text, startLine: 1 };
    }
  }
  return out;
}

async function chunkGoFlat(root: TAny, lines: string[], chunkLines: number): Promise<ChunkFrag[]> {
  const symbols: Array<{ node: TSNodeExt; name: string; kind: string }> = [];
  const visit = async (n: TAny): Promise<void> => {
    const t = n.type;
    if (t === 'function_declaration' || t === 'method_declaration') {
      const raw = nameFromField(n, 'name');
      if (raw) {
        symbols.push({ node: n as TSNodeExt, name: raw, kind: 'function' });
      }
    } else if (t === 'type_spec') {
      const raw = nameFromField(n, 'name');
      if (raw) {
        symbols.push({ node: n as TSNodeExt, name: raw, kind: 'type' });
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      await visit(n.namedChild(i));
    }
  };
  await visit(root);
  symbols.sort((a, b) => a.node.startIndex - b.node.startIndex);
  if (symbols.length === 0) {
    return [];
  }
  const out: ChunkFrag[] = [];
  let firstDeclLine = symbols[0]!.node.startPosition.row + 1;
  for (const s of symbols) {
    out.push(
      ...(await emitLeafOrSplit(lines, s.node, chunkLines, s.name, s.kind, s.kind === 'function' ? s.name : s.name)),
    );
  }
  if (firstDeclLine > 1) {
    const pre = sliceLines(lines, 1, firstDeclLine - 1);
    if (pre.trim().length > 0) {
      out[0] = { ...out[0]!, text: pre + '\n' + out[0]!.text, startLine: 1 };
    }
  }
  return out;
}

function collectJavaClassMembers(body: TAny): TAny[] {
  const out: TAny[] = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const ch = body.namedChild(i);
    const t = ch.type;
    if (
      t === 'method_declaration' ||
      t === 'constructor_declaration' ||
      t === 'class_declaration' ||
      t === 'interface_declaration' ||
      t === 'enum_declaration'
    ) {
      out.push(ch);
    }
  }
  out.sort((a, b) => (a.startIndex as number) - (b.startIndex as number));
  return out;
}

async function emitJavaClassLike(lines: string[], n: TAny, chunkLines: number, name: string, kind = 'class'): Promise<ChunkFrag[]> {
  const node = n as TSNodeExt;
  const clsRange = lineRange(node);
  const nLinesTot = clsRange.endLine - clsRange.startLine + 1;
  if (nLinesTot <= chunkLines) {
    return [
      {
        startLine: clsRange.startLine,
        endLine: clsRange.endLine,
        text: sliceLines(lines, clsRange.startLine, clsRange.endLine),
        symbolName: name,
        symbolKind: kind,
        chunkMode: 'symbol',
        definitionOf: name,
      },
    ];
  }
  const body = n.childForFieldName?.('body') as TAny | null;
  if (!body) {
    return lineSplitSpan(lines, clsRange.startLine, clsRange.endLine, chunkLines, {
      symbolName: name,
      symbolKind: kind,
      definitionOf: name,
    });
  }
  const members = collectJavaClassMembers(body);
  if (members.length === 0) {
    return lineSplitSpan(lines, clsRange.startLine, clsRange.endLine, chunkLines, {
      symbolName: name,
      symbolKind: kind,
      definitionOf: name,
    });
  }
  let cursor = clsRange.startLine;
  const out: ChunkFrag[] = [];
  for (const mem of members) {
    const m = mem as TSNodeExt;
    const mr = lineRange(m);
    const hdr =
      mr.startLine > cursor ? sliceLines(lines, cursor, mr.startLine - 1) : '';
    const mt = mem.type;
    if (mt === 'class_declaration' || mt === 'interface_declaration' || mt === 'enum_declaration') {
      const raw = nameFromField(mem, 'name');
      if (!raw) {
        cursor = mr.endLine + 1;
        continue;
      }
      const nk = mt === 'interface_declaration' ? 'interface' : mt === 'enum_declaration' ? 'type' : 'class';
      const nested = await emitJavaClassLike(lines, mem, chunkLines, raw, nk);
      if (hdr.trim().length > 0 && nested.length > 0) {
        nested[0] = {
          ...nested[0]!,
          text: hdr + '\n' + nested[0]!.text,
          startLine: cursor,
        };
      }
      out.push(...nested);
    } else {
      const memName = nameFromField(mem, 'name') ?? 'member';
      out.push(...(await emitLeafOrSplit(lines, m, chunkLines, memName, 'function', memName)));
    }
    cursor = mr.endLine + 1;
  }
  return out.length > 0
    ? out
    : lineSplitSpan(lines, clsRange.startLine, clsRange.endLine, chunkLines, {
        symbolName: name,
        symbolKind: kind,
        definitionOf: name,
      });
}

async function chunkJavaModule(root: TAny, lines: string[], chunkLines: number, nVisits: { v: number }): Promise<ChunkFrag[]> {
  const out: ChunkFrag[] = [];
  let firstDeclLine: number | null = null;
  for (let i = 0; i < root.namedChildCount; i++) {
    nVisits.v += 1;
    const ch = root.namedChild(i);
    if (ch.type === 'class_declaration' || ch.type === 'interface_declaration' || ch.type === 'enum_declaration') {
      const raw = nameFromField(ch, 'name');
      if (!raw) {
        continue;
      }
      const nk =
        ch.type === 'interface_declaration' ? 'interface' : ch.type === 'enum_declaration' ? 'type' : 'class';
      const decl = await emitJavaClassLike(lines, ch, chunkLines, raw, nk);
      if (decl.length > 0) {
        if (firstDeclLine === null) {
          firstDeclLine = decl[0]!.startLine;
        }
        out.push(...decl);
      }
    } else if (ch.type?.endsWith('_declaration')) {
      continue;
    }
  }
  if (out.length === 0) {
    return [];
  }
  if (firstDeclLine !== null && firstDeclLine > 1) {
    const pre = sliceLines(lines, 1, firstDeclLine - 1);
    if (pre.trim().length > 0) {
      out[0] = { ...out[0]!, text: pre + '\n' + out[0]!.text, startLine: 1 };
    }
  }
  return out;
}

async function chunkRustFlat(root: TAny, lines: string[], chunkLines: number): Promise<ChunkFrag[]> {
  const symbols: Array<{ node: TSNodeExt; name: string; kind: string }> = [];
  const visit = async (n: TAny): Promise<void> => {
    const t = n.type;
    if (
      t === 'function_item' ||
      t === 'struct_item' ||
      t === 'enum_item' ||
      t === 'trait_item' ||
      t === 'type_item' ||
      t === 'mod_item'
    ) {
      const raw = nameFromField(n, 'name');
      if (raw) {
        const kind =
          t === 'struct_item' || t === 'enum_item' || t === 'trait_item' || t === 'type_item'
            ? 'type'
            : t === 'mod_item'
              ? 'class'
              : 'function';
        symbols.push({ node: n as TSNodeExt, name: raw, kind });
      }
    }
    for (let i = 0; i < n.namedChildCount; i++) {
      await visit(n.namedChild(i));
    }
  };
  await visit(root);
  symbols.sort((a, b) => a.node.startIndex - b.node.startIndex);
  const out: ChunkFrag[] = [];
  for (const s of symbols) {
    const def =
      s.kind === 'function' ? s.name : s.name;
    out.push(...(await emitLeafOrSplit(lines, s.node, chunkLines, s.name, s.kind, def)));
  }
  return out.length > 0 ? out : [];
}

async function chunkByGrammar(
  grammar: TSGrammar,
  root: TAny,
  lines: string[],
  chunkLines: number,
): Promise<ChunkFrag[] | undefined> {
  const nVisits = { v: 0 };
  switch (grammar) {
    case 'ts':
    case 'tsx':
    case 'js':
      return chunkTsJsModule(root, lines, chunkLines, nVisits);
    case 'py':
      return chunkPythonModule(root, lines, chunkLines, nVisits);
    case 'rb':
      return chunkRubyProgram(root, lines, chunkLines, nVisits);
    case 'go':
      return chunkGoFlat(root, lines, chunkLines);
    case 'java':
      return chunkJavaModule(root, lines, chunkLines, nVisits);
    case 'rs':
      return chunkRustFlat(root, lines, chunkLines);
    default:
      return undefined;
  }
}

/**
 * Try hierarchical AST chunking. Returns chunks or `null` to fall back to legacy code-aware splitting.
 */
export async function tryChunkAstHierarchy(
  content: string,
  lines: string[],
  filePath: string,
  chunkLines: number,
  maxBytes: number,
): Promise<ChunkFrag[] | null> {
  const grammar = pickGrammarForPath(filePath);
  if (!grammar || content.length > maxBytes || lines.length === 0) {
    return null;
  }
  const bundle = getTreeSitterSet();
  if (!bundle) {
    return null;
  }
  const lang = bundle.languages[grammar];
  if (!lang) {
    return null;
  }
  try {
    const p = getParser(bundle.Parser);
    p.setLanguage(lang);
    const tree = p.parse(content);
    const root = tree.rootNode;
    const chunks = await chunkByGrammar(grammar, root, lines, chunkLines);
    if (!chunks || chunks.length === 0) {
      return null;
    }
    return chunks;
  } catch {
    return null;
  }
}

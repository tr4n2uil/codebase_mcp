import type { SearchHit } from './store.js';

/**
 * Detect queries that ask for a symbol's *definition* (vs usages, examples, or docs).
 * Heuristic: false negatives are acceptable (no boost); keep patterns conservative.
 */
export function parseDefinitionIntentQuery(query: string): string | undefined {
  const q = query.trim();
  if (q.length < 4) {
    return undefined;
  }
  const patterns: RegExp[] = [
    // "where is the User class defined?" — also method/module for Ruby, etc.
    /where\s+(?:is|are)\s+(?:the\s+)?`?([A-Za-z_][\w$]*)`?\s+(?:class|interface|type|enum|struct|trait|record|method|module)\s+defined\b/i,
    /\bdefinition(?:s)?\s+of\s+(?:the\s+)?`?([A-Za-z_][\w$]*)`?\s+(?:class|interface|type|enum|method|module)\b/i,
    /where\s+(?:is|are)\s+(?:the\s+)?`?([A-Za-z_][\w$]*)`?\s+defined\b/i,
    /\bdefinition(?:s)?\s+of\s+(?:the\s+)?`?([A-Za-z_][\w$]*)`?\b/i,
    /\bfind\s+(?:the\s+)?`?([A-Za-z_][\w$]*)`?\s+definition\b/i,
    /\b`?([A-Za-z_][\w$]*)`?\s+definition\s*$/i,
  ];
  for (const re of patterns) {
    const m = q.match(re);
    if (m?.[1]) {
      return m[1];
    }
  }
  const exactDefine = q.match(/^\s*define\s+`?([A-Za-z_][\w$]*)`?\s*$/i);
  if (exactDefine?.[1]) {
    return exactDefine[1];
  }
  return undefined;
}

/**
 * Turn spaced words ("user service") into StudlyCaps ("UserService") for definition_of lookup.
 */
function spacedWordsToStudlySymbol(phrase: string): string | undefined {
  const trimmed = phrase.trim();
  if (!trimmed || trimmed.length > 80) {
    return undefined;
  }
  const parts = trimmed.split(/\s+/).filter((w) => w.length > 0);
  if (parts.length < 1 || parts.length > 6) {
    return undefined;
  }
  for (const w of parts) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(w)) {
      return undefined;
    }
  }
  const joined = parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
  if (joined.length < 4 || joined.length > 64 || !/^[A-Z]/.test(joined)) {
    return undefined;
  }
  return joined;
}

/**
 * When {@link parseDefinitionIntentQuery} finds no phrase, infer a symbol for `definition_of` boost:
 * bare identifiers (`UserService`), verb + name (`find UserService`), or spaced words before
 * `base class` (e.g. `find user service base class` → `UserService`).
 */
export function inferDefinitionTargetFromQuery(query: string): string | undefined {
  const q = query.trim();
  if (q.length < 4 || q.length > 128) {
    return undefined;
  }

  /** Verbs like "find Foo" / "search for Bar" — capture must look like StudlyCaps class names. */
  const verbStudly = q.match(
    /^\s*(?:(?:find|locate|show|open|get|lookup)\s+|(?:navigate\s+to)\s+|(?:search\s+for)\s+|(?:go\s+to)\s+)(?:the\s+)?([A-Za-z][A-Za-z0-9_]{3,63})\s*[?.!,;:]*$/i,
  );
  if (verbStudly?.[1] && /^[A-Z]/.test(verbStudly[1])) {
    return verbStudly[1];
  }

  /** e.g. "find user service base class" → UserService */
  const baseClass = q.match(
    /^\s*(?:find|locate|show|open|get|lookup)\s+(?:the\s+)?(.+?)\s+base\s+class\b[?.!,;:]*$/i,
  );
  if (baseClass?.[1]) {
    const inferred = spacedWordsToStudlySymbol(baseClass[1]);
    if (inferred) {
      return inferred;
    }
  }

  const verbSnake = q.match(
    /^\s*(?:find|locate|show|open|get|lookup)\s+(?:the\s+)?([a-z][a-z0-9_]{3,63})\s*[?.!,;:]*$/i,
  );
  if (verbSnake?.[1]?.includes('_')) {
    return verbSnake[1];
  }

  if (/\s/.test(q)) {
    return undefined;
  }

  const studly = q.match(/^[`"'[\]()]*([A-Z][A-Za-z0-9_]{3,63})[`"'[\]()]*[?.!,:;]*$/);
  if (studly?.[1]) {
    return studly[1];
  }
  const snake = q.match(/^[`"'[\]()]*([a-z][a-z0-9_]{3,63})[`"'[\]()]*[?.!,:;]*$/);
  if (snake?.[1]?.includes('_')) {
    return snake[1];
  }
  return undefined;
}

/** When full rerank is off, re-sort by `score` + a flat bonus for definition_of matches. */
export function orderHitsByDefinitionBoost(
  hits: SearchHit[],
  target: string | undefined,
  boost: number,
): SearchHit[] {
  if (!target || boost <= 0) {
    return hits;
  }
  const tl = target.toLowerCase();
  return [...hits].sort((a, b) => {
    const ab = a.definition_of?.toLowerCase() === tl ? boost : 0;
    const bb = b.definition_of?.toLowerCase() === tl ? boost : 0;
    return b.score + bb - (a.score + ab);
  });
}

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

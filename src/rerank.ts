import type { AppConfig } from './config.js';
import type { SearchHit } from './store.js';

export interface RerankedHit extends SearchHit {
  rerank_score: number;
}

function tokenize(query: string): string[] {
  return (query.match(/[A-Za-z0-9_.$/-]+/g) ?? [])
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);
}

function symbolLikeTokens(query: string, tokens: string[]): string[] {
  const camelOrPascal = query.match(/\b[A-Za-z]+[A-Z][A-Za-z0-9]*\b/g) ?? [];
  const loweredCamel = camelOrPascal.map((t) => t.toLowerCase());
  const base = tokens.filter((t) => /[_./$-]/.test(t));
  return Array.from(new Set([...base, ...loweredCamel]));
}

function scoreLexicalMatch(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0) {
    return 0;
  }
  const haystack = text.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += 1;
    }
  }
  return score / queryTokens.length;
}

function scoreExactWordMatch(queryTokens: string[], text: string): number {
  if (queryTokens.length === 0) {
    return 0;
  }
  const lowered = text.toLowerCase();
  let matched = 0;
  for (const token of queryTokens) {
    const re = new RegExp(`(^|[^a-z0-9_])${escapeRegExp(token)}([^a-z0-9_]|$)`, 'i');
    if (re.test(lowered)) {
      matched += 1;
    }
  }
  return matched / queryTokens.length;
}

function scorePathHint(queryTokens: string[], path: string): number {
  if (queryTokens.length === 0) {
    return 0;
  }
  const p = path.toLowerCase();
  let matched = 0;
  for (const token of queryTokens) {
    if (p.includes(token)) {
      matched += 1;
    }
  }
  return matched / queryTokens.length;
}

function scoreSymbolBonus(symbolTokens: string[], hit: SearchHit): number {
  if (symbolTokens.length === 0) {
    return 0;
  }
  const lines = hit.text.split('\n', 8).join('\n').toLowerCase();
  let matched = 0;
  for (const token of symbolTokens) {
    if (lines.includes(token) || hit.path.toLowerCase().includes(token)) {
      matched += 1;
    }
  }
  return matched / symbolTokens.length;
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSymbolIntentQuery(query: string, tokens: string[]): boolean {
  if (tokens.some((t) => t.includes('::') || t.includes('#') || t.includes('/') || t.includes('_'))) {
    return true;
  }
  return /\b[A-Za-z]+[A-Z][A-Za-z0-9]*\b/.test(query);
}

function codePathPrior(path: string, symbolIntent: boolean): number {
  const p = path.toLowerCase();
  let prior = 0;
  if (
    p.startsWith('app/models/') ||
    p.startsWith('app/controllers/') ||
    p.startsWith('app/services/') ||
    p.startsWith('lib/') ||
    p.startsWith('src/')
  ) {
    prior += 0.2;
  }
  if (p.includes('/test/') || p.startsWith('test/') || p.includes('/spec/') || p.startsWith('spec/')) {
    prior -= 0.12;
  }
  if (p.includes('/fixtures/') || p.includes('/locales/') || p.includes('/assets/')) {
    prior -= symbolIntent ? 0.2 : 0.08;
  }
  if (p.endsWith('.yml') || p.endsWith('.yaml')) {
    prior -= symbolIntent ? 0.15 : 0.05;
  }
  return prior;
}

/**
 * User-configured demotion: each matching substring in the path (case-insensitive) adds a negative
 * bump, capped so search still returns relevant hits in those trees when they are the only match.
 */
function userPathDemote(
  path: string,
  substrings: string[],
  perMatch: number,
): number {
  if (substrings.length === 0 || perMatch <= 0) {
    return 0;
  }
  const p = path.toLowerCase();
  let matches = 0;
  for (const raw of substrings) {
    const s = raw.replace(/\\/g, '/').trim().toLowerCase();
    if (s && p.includes(s)) {
      matches += 1;
    }
  }
  if (matches === 0) {
    return 0;
  }
  return -Math.min(0.4, matches * perMatch);
}

export function rerankSearchHits(
  query: string,
  hits: SearchHit[],
  pathDemote: Pick<AppConfig, 'rerankDemotePathSubstrings' | 'rerankDemotePerMatch'>,
): RerankedHit[] {
  const queryTokens = tokenize(query);
  const symbolTokens = symbolLikeTokens(query, queryTokens);
  const symbolIntent = isSymbolIntentQuery(query, queryTokens);
  return hits
    .map((hit) => {
      const lexical = scoreLexicalMatch(queryTokens, hit.text);
      const exact = scoreExactWordMatch(queryTokens, hit.text);
      const exactPath = scoreExactWordMatch(queryTokens, hit.path);
      const pathHint = scorePathHint(queryTokens, hit.path);
      const symbolBonus = scoreSymbolBonus(symbolTokens, hit);
      const pathPrior =
        codePathPrior(hit.path, symbolIntent) +
        userPathDemote(hit.path, pathDemote.rerankDemotePathSubstrings, pathDemote.rerankDemotePerMatch);
      const rerankScore = symbolIntent
        ? hit.score * 0.35 + lexical * 0.2 + exact * 0.2 + exactPath * 0.15 + symbolBonus * 0.15 + pathPrior
        : hit.score * 0.5 + lexical * 0.2 + exact * 0.1 + pathHint * 0.1 + symbolBonus * 0.05 + pathPrior;
      return {
        ...hit,
        rerank_score: rerankScore,
      };
    })
    .sort((a, b) => b.rerank_score - a.rerank_score);
}

import type { AppConfig } from './config.js';
import type { SearchHit } from './store.js';

export interface RerankedHit extends SearchHit {
  rerank_score: number;
}

export interface RerankDefinitionOptions {
  /** Identifier from e.g. `parseDefinitionIntentQuery` — must match chunk `definition_of` (case-insensitive). */
  definitionTarget?: string;
  /**
   * Extra path prior (additive) for chunks that declare this symbol. Set to `0` to disable.
   * Typical: ~0.12–0.22; capped implicitly by the rerank mix.
   */
  definitionBoost: number;
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

/** Repo-relative path looks like a test / spec / examples tree. */
function isTestishPath(p: string): boolean {
  return (
    p.includes('/spec/') ||
    p.startsWith('spec/') ||
    p.includes('/test/') ||
    p.startsWith('test/') ||
    p.includes('__tests__')
  );
}

/**
 * Heuristic: user is likely asking *about* test/spec code (RSpec, minitest, Jest, etc.),
 * so we *boost* `spec/`, `test/`, `__tests__` instead of the default de-prioritization.
 */
export function queryMentionsTestOrSpecContext(query: string): boolean {
  return /\b(test|spec|rspec|minitest|pytest|jest|vitest|examples?|shoulda|factory_bot|capybara|vcr)\b/i.test(
    query,
  );
}

/**
 * Heuristic: user is likely asking about UI / React / client-side / TS+JS frontends (vs e.g. Ruby-only
 * app paths) — used to nudge `rerank` toward typical frontend file trees.
 */
export function queryMentionsFrontendContext(query: string): boolean {
  return /\b(react|usestate|useeffect|usecallback|usememo|redux|zustand|next\.js|nextjs|jsbundle|components?|userouter|stimulus|webpack|vite|hotwire|turbo|tailwind|styled-?components?|framer|storybook|portal|navbar|dropdown|viewcomponent|shadcn|mui|chakra|jsx?|client[- ]?side|frontend|browser|typescript)\b/i.test(
    query,
  );
}

function isFrontendishPath(p: string): boolean {
  const x = p.toLowerCase();
  if (x.endsWith('.tsx') || x.endsWith('.jsx') || x.endsWith('.vue') || x.endsWith('.svelte')) {
    return true;
  }
  return (
    x.includes('/components/') ||
    x.includes('/ui/') ||
    x.includes('app/javascript') ||
    x.includes('/app/javascript/') ||
    x.startsWith('app/javascript/') ||
    x.includes('/frontend/') ||
    x.startsWith('frontend/') ||
    x.includes('/client/') ||
    x.startsWith('client/') ||
    x.includes('/web/') ||
    x.startsWith('web/') ||
    x.includes('packages/ui') ||
    x.includes('src/packs')
  );
}

function codePathPrior(
  path: string,
  symbolIntent: boolean,
  testPathQueryIntent: boolean,
  frontendPathQueryIntent: boolean,
): number {
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
  if (isTestishPath(p)) {
    prior += testPathQueryIntent ? 0.12 : -0.12;
  } else if (frontendPathQueryIntent && isFrontendishPath(p)) {
    prior += 0.1;
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
  pathDemote: Pick<
    AppConfig,
    'rerankDemotePathSubstrings' | 'rerankDemotePerMatch' | 'testPathQueryBoost' | 'frontendPathQueryBoost'
  >,
  definition?: RerankDefinitionOptions,
): RerankedHit[] {
  const defTarget = definition?.definitionTarget;
  const defBoost = definition?.definitionBoost ?? 0;
  const queryTokens = tokenize(query);
  const symbolTokens = symbolLikeTokens(query, queryTokens);
  const symbolIntent = isSymbolIntentQuery(query, queryTokens);
  const testPathQueryIntent = pathDemote.testPathQueryBoost && queryMentionsTestOrSpecContext(query);
  const frontendPathQueryIntent =
    pathDemote.frontendPathQueryBoost && queryMentionsFrontendContext(query);
  return hits
    .map((hit) => {
      const lexical = scoreLexicalMatch(queryTokens, hit.text);
      const exact = scoreExactWordMatch(queryTokens, hit.text);
      const exactPath = scoreExactWordMatch(queryTokens, hit.path);
      const pathHint = scorePathHint(queryTokens, hit.path);
      const symbolBonus = scoreSymbolBonus(symbolTokens, hit);
      const defPrior =
        defTarget && defBoost > 0 && hit.definition_of
          ? hit.definition_of.toLowerCase() === defTarget.toLowerCase()
            ? defBoost
            : 0
          : 0;
      const pathPrior =
        codePathPrior(hit.path, symbolIntent, testPathQueryIntent, frontendPathQueryIntent) +
        userPathDemote(hit.path, pathDemote.rerankDemotePathSubstrings, pathDemote.rerankDemotePerMatch) +
        defPrior;
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

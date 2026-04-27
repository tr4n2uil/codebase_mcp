import type { SearchHit } from './store.js';

export type MatchConfidence = 'high' | 'medium' | 'low';

export interface SearchMatchAssessment {
  match_confidence: MatchConfidence;
  /** Machine-readable flags for prompts and UX. */
  match_confidence_reasons: string[];
  /** Top hit primary score: `rerank_score` when rerank ran, else retriever `score`. */
  top_primary_score: number | null;
  /** (top - second) / |top| on the same scale; `null` if only one hit. */
  top_relative_separation: number | null;
}

type HitLike = SearchHit & { rerank_score?: number };

function isAmbiguousLiteralQuery(q: string | undefined): boolean {
  if (!q) {
    return false;
  }
  const t = q.trim();
  if (t.length < 2 || t.length > 64) {
    return false;
  }
  if (/^[A-Za-z_][\w]*$/.test(t)) {
    return true;
  }
  if (/^(?:the|a|an)\s+[A-Za-z_][\w]*$/i.test(t)) {
    return true;
  }
  return false;
}

type PathFamily = 'ruby' | 'tsish' | 'webstyle' | 'other';

function pathFamilyForConfidence(path: string): PathFamily {
  const dot = path.lastIndexOf('.');
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : '';
  if (['rb', 'rake', 'rbi'].includes(ext)) {
    return 'ruby';
  }
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte'].includes(ext)) {
    return 'tsish';
  }
  if (['css', 'scss', 'less', 'sass'].includes(ext)) {
    return 'webstyle';
  }
  return 'other';
}

function topTwoPathFamiliesDiverge(hits: HitLike[]): boolean {
  if (hits.length < 2) {
    return false;
  }
  const a = pathFamilyForConfidence(hits[0]!.path);
  const b = pathFamilyForConfidence(hits[1]!.path);
  if (a === 'other' || b === 'other') {
    return false;
  }
  return a !== b;
}

/**
 * Heuristic only: scores are not globally calibrated, but “weak top + tight top-2” is still
 * actionable. Tunable via `CODEBASE_MCP_MATCH_CONF_*` (see config).
 * Optional: downgrade *high* for short single-token queries or when top-2 file families differ
 * (e.g. Ruby vs TypeScript) — see `CODEBASE_MCP_MATCH_CONF_AMBIG_LIT` / `..._XDOMAIN_EXT`.
 */
export function assessSearchMatchQuality(
  hits: HitLike[],
  opts: {
    rerankEnabled: boolean;
    /** Branches: rerank fusion scores sit higher on average than raw vector/RRF `score`. */
    weakBelow: number;
    strongAbove: number;
    minRelativeGap: number;
    /** Original search string; enables ambiguous-literal / cross-family downgrades. */
    query?: string;
    matchConfAmbiguousLiteralDowngrade?: boolean;
    matchConfTopPathFamilyDivergence?: boolean;
  },
): SearchMatchAssessment {
  if (hits.length === 0) {
    return {
      match_confidence: 'low',
      match_confidence_reasons: ['no_hits'],
      top_primary_score: null,
      top_relative_separation: null,
    };
  }
  const primary = (h: HitLike): number =>
    opts.rerankEnabled && h.rerank_score !== undefined && Number.isFinite(h.rerank_score)
      ? h.rerank_score
      : h.score;
  const t0 = primary(hits[0]!);
  const t1 = hits.length > 1 ? primary(hits[1]!) : undefined;
  const denom = Math.max(Math.abs(t0), 1e-9);
  const relSep = t1 === undefined ? 1 : (t0 - t1) / denom;
  const reasons: string[] = [];
  if (t1 !== undefined && relSep < opts.minRelativeGap) {
    reasons.push('tight_top_scores');
  }
  if (t0 < opts.weakBelow) {
    reasons.push('low_primary_score');
  }
  if (t0 < opts.weakBelow) {
    return {
      match_confidence: 'low',
      match_confidence_reasons: reasons,
      top_primary_score: t0,
      top_relative_separation: t1 === undefined ? null : relSep,
    };
  }
  const clearLeader = t1 === undefined || relSep >= opts.minRelativeGap;
  if (t0 >= opts.strongAbove && clearLeader) {
    return applyHighConfidenceDowngrades(
      hits,
      {
        match_confidence: 'high',
        match_confidence_reasons: ['strong_top_and_separation'],
        top_primary_score: t0,
        top_relative_separation: t1 === undefined ? null : relSep,
      },
      {
        query: opts.query,
        ambig: opts.matchConfAmbiguousLiteralDowngrade !== false,
        ext: opts.matchConfTopPathFamilyDivergence !== false,
      },
    );
  }
  if (t0 >= opts.strongAbove && !clearLeader) {
    return {
      match_confidence: 'medium',
      match_confidence_reasons: ['strong_score_but_tight_top', ...reasons],
      top_primary_score: t0,
      top_relative_separation: relSep,
    };
  }
  return {
    match_confidence: 'medium',
    match_confidence_reasons: reasons.length > 0 ? reasons : ['below_strong_threshold'],
    top_primary_score: t0,
    top_relative_separation: t1 === undefined ? null : relSep,
  };
}

function applyHighConfidenceDowngrades(
  hits: HitLike[],
  high: SearchMatchAssessment,
  flags: { query: string | undefined; ambig: boolean; ext: boolean },
): SearchMatchAssessment {
  const extra: string[] = [];
  if (flags.ambig && isAmbiguousLiteralQuery(flags.query)) {
    extra.push('possible_ambiguous_literal_query');
  }
  if (flags.ext && topTwoPathFamiliesDiverge(hits)) {
    extra.push('top_hits_different_path_families');
  }
  if (extra.length === 0) {
    return high;
  }
  return {
    match_confidence: 'medium',
    match_confidence_reasons: [...extra, ...high.match_confidence_reasons],
    top_primary_score: high.top_primary_score,
    top_relative_separation: high.top_relative_separation,
  };
}

/** Defaults when `CODEBASE_MCP_RERANK` is true (fusion scores are typically larger). */
export const defaultMatchConfRerank = {
  weakBelow: 0.35,
  strongAbove: 0.55,
  minRelativeGap: 0.05,
} as const;

/** Defaults when rerank is off (raw vector / hybrid `score` from Lance). */
export const defaultMatchConfVector = {
  weakBelow: 0.18,
  strongAbove: 0.4,
  minRelativeGap: 0.06,
} as const;

/** One-line guidance for agent UIs (English). */
export function matchConfidenceHint(a: SearchMatchAssessment): string {
  if (a.match_confidence === 'low') {
    return 'Weak or empty retrieval signal: the query may not match this repo well, or nothing is strongly relevant.';
  }
  if (a.match_confidence === 'medium') {
    if (a.match_confidence_reasons.includes('possible_ambiguous_literal_query')) {
      return 'Short or identifier-like query: the clear top score may still be the wrong *kind* of match (e.g. another service or language); confirm in files.';
    }
    if (a.match_confidence_reasons.includes('top_hits_different_path_families')) {
      return 'Top two hits live in different file families (e.g. Ruby vs TS): rankings can look confident while cross-domain; verify the right area of the repo.';
    }
    return 'Moderate or ambiguous top results: first hits may be off-topic; verify manually.';
  }
  return 'Stronger top signal than typical for this run; still confirm relevance in files.';
}

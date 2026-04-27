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

/**
 * Heuristic only: scores are not globally calibrated, but “weak top + tight top-2” is still
 * actionable. Tunable via `CODEBASE_MCP_MATCH_CONF_*` (see config).
 */
export function assessSearchMatchQuality(
  hits: HitLike[],
  opts: {
    rerankEnabled: boolean;
    /** Branches: rerank fusion scores sit higher on average than raw vector/RRF `score`. */
    weakBelow: number;
    strongAbove: number;
    minRelativeGap: number;
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
    return {
      match_confidence: 'high',
      match_confidence_reasons: ['strong_top_and_separation'],
      top_primary_score: t0,
      top_relative_separation: t1 === undefined ? null : relSep,
    };
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
    return 'Moderate or ambiguous top results: first hits may be off-topic; verify manually.';
  }
  return 'Stronger top signal than typical for this run; still confirm relevance in files.';
}

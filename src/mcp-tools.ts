import path from 'node:path';
import { embedTexts, getEmbedder } from './embedder.js';
import type { AppConfig } from './config.js';
import { makeCrossEncoderPoolK, runCrossEncoderRerank, type CrossEncoderInputHit } from './cross-encoder-rerank.js';
import type { Indexer } from './indexer.js';
import { readMeta } from './meta.js';
import { logError } from './log.js';
import type { ChunkStore } from './store.js';
import { orderHitsByDefinitionBoost, inferDefinitionTargetFromQuery, parseDefinitionIntentQuery } from './definition-intent.js';
import {
  applyQueryClassifierPrimarySort,
  resolveQueryClassifierInput,
} from './query-classifier.js';
import { rerankSearchHits } from './rerank.js';
import type { RerankedHit } from './rerank.js';
import { assessSearchMatchQuality, matchConfidenceHint } from './search-confidence.js';
import type { SearchHit } from './store.js';
import { isCoveredByForceInclude } from './force-include.js';
import { parsePathQueryForSearch } from './path-query-filter.js';

function normalizePathPrefixForSearch(raw: string | undefined): string | undefined {
  const t = raw?.trim() ?? '';
  if (t.length === 0) {
    return undefined;
  }
  return t.replace(/\\/g, '/').replace(/\/+$/, '');
}

function rerankScoreForPayload(h: SearchHit | RerankedHit): number | undefined {
  if (!('rerank_score' in h)) {
    return undefined;
  }
  const v = (h as RerankedHit).rerank_score;
  return typeof v === 'number' ? v : undefined;
}

export type McpTextContent = { type: 'text'; text: string };

export interface CodebaseSearchHitPayload {
  path: string;
  start_line: number;
  end_line: number;
  score: number;
  definition_of?: string;
  rerank_score?: number;
  /** Raw logit when cross-encoder ran and `CODEBASE_MCP_RERANK_DEBUG_SCORES=1`. */
  cross_encoder_logit?: number;
  snippet: string;
}

export type CodebaseSearchPayload =
  | { ok: false; error: string }
  | {
      ok: true;
      hits: CodebaseSearchHitPayload[];
      query_classifier: string;
      match_confidence?: string;
      match_confidence_reasons?: string[];
      match_confidence_hint?: string;
      top_primary_score?: number;
      top_relative_separation?: number;
    };

/** Same pipeline as MCP `codebase_search`; use for CLIs and tests (structured JSON, no MCP wrapper). */
export type CodebaseSearchArgs = {
  query: string;
  limit?: number;
  path_prefix?: string;
  /**
   * Bias retrieval toward **code**, **config** (json/yaml/toml/etc.), or **docs** (markdown + configured working-docs trees).
   * Implemented as an additive rerank prior (or primary-score sort when heuristic rerank is off). Default: `auto`.
   */
  query_classifier?: string;
  /** Alias of `query_classifier`; do not pass conflicting values. */
  search_focus?: string;
  /**
   * If true, unscoped search also returns chunks under `CODEBASE_MCP_WORKING_DOCS_PATH` (e.g. `.claude/docs`),
   * which are normally omitted. Ignored when `path_prefix` is set (scoping is already explicit). `path_prefix`
   * is unchanged — use it alone to only search a subtree, or with other filters.
   */
  include_docs?: boolean;
  ext?: string | string[];
  lang?: string;
  glob?: string;
};

export async function codebaseSearchPayload(
  config: AppConfig,
  store: ChunkStore,
  args: CodebaseSearchArgs,
): Promise<CodebaseSearchPayload> {
  const lim = args.limit ?? 10;
  const candidateLimit = Math.max(lim, config.rerankCandidates);
  const qcResolved = resolveQueryClassifierInput({
    query_classifier: args.query_classifier,
    search_focus: args.search_focus,
  });
  if (!qcResolved.ok) {
    return { ok: false, error: qcResolved.error };
  }
  const queryClassifier = qcResolved.value;
  const pathQuery = parsePathQueryForSearch({
    ext: args.ext,
    lang: args.lang,
    glob: args.glob,
  });
  if (!pathQuery.ok) {
    return { ok: false, error: pathQuery.error };
  }
  const pathPrefix = normalizePathPrefixForSearch(args.path_prefix);
  const includeDocs = args.include_docs === true;
  const unscopedOmitWorkingDocs =
    !includeDocs &&
    config.searchExcludeForceInclude &&
    pathPrefix === undefined &&
    config.workingDocsPathsRelPosix.length > 0;
  const pathFilter = (() => {
    if (!unscopedOmitWorkingDocs) {
      return pathQuery.pathFilter;
    }
    const working = config.workingDocsPathsRelPosix;
    const base = pathQuery.pathFilter;
    return (relPath: string): boolean => {
      if (isCoveredByForceInclude(relPath, working)) {
        return false;
      }
      if (base && !base(relPath)) {
        return false;
      }
      return true;
    };
  })();
  const pathFilterNarrowing = unscopedOmitWorkingDocs || pathQuery.pathFilterNarrowing;
  const extractor = await getEmbedder(config);
  const [qvec] = await embedTexts(extractor, [args.query], config.embeddingDim, config.embedInferenceLogMs);
  if (!qvec) {
    return { ok: false, error: 'Failed to embed query.' };
  }
  const hits = await store.search({
    queryVector: qvec,
    queryText: args.query,
    limit: candidateLimit,
    pathPrefix,
    pathFilter,
    pathFilterNarrowing,
  });
  let workingHits =
    !config.rerankEnabled && queryClassifier !== 'auto'
      ? applyQueryClassifierPrimarySort(hits, queryClassifier, config.workingDocsPathsRelPosix)
      : hits;
  const defTarget =
    config.definitionBoostEnabled && config.definitionBoost > 0
      ? parseDefinitionIntentQuery(args.query) ?? inferDefinitionTargetFromQuery(args.query)
      : undefined;
  const defBoost = defTarget ? config.definitionBoost : 0;
  let ranked: RerankedHit[] | SearchHit[] = workingHits;
  if (config.rerankEnabled) {
    ranked = rerankSearchHits(
      args.query,
      workingHits,
      {
        rerankDemotePathSubstrings: config.rerankDemotePathSubstrings,
        rerankDemotePerMatch: config.rerankDemotePerMatch,
        testPathQueryBoost: config.testPathQueryBoost,
        frontendPathQueryBoost: config.frontendPathQueryBoost,
      },
      { definitionTarget: defTarget, definitionBoost: defBoost },
      {
        queryClassifier,
        workingDocsPathsRelPosix: config.workingDocsPathsRelPosix,
      },
    );
  } else if (defTarget) {
    ranked = orderHitsByDefinitionBoost(workingHits, defTarget, defBoost);
  }
  const toCrossEncoderInput = (r: (SearchHit | RerankedHit)[]): CrossEncoderInputHit[] =>
    r.map((h) => ({
      path: h.path,
      start_line: h.start_line,
      end_line: h.end_line,
      text: h.text,
      score: h.score,
      ...(h.definition_of ? { definition_of: h.definition_of } : {}),
      ...('rerank_score' in h && typeof (h as RerankedHit).rerank_score === 'number'
        ? { rerank_score: (h as RerankedHit).rerank_score }
        : {}),
    }));
  let topHits: (SearchHit | RerankedHit)[] = ranked.slice(0, lim);
  if (config.crossEncoderEnabled) {
    const poolK = makeCrossEncoderPoolK(config, ranked.length, lim);
    if (poolK > 0) {
      try {
        const ce = await runCrossEncoderRerank(
          config,
          args.query,
          toCrossEncoderInput(ranked as (SearchHit | RerankedHit)[]),
          poolK,
          lim,
        );
        if (ce.length > 0) {
          topHits = ce;
        }
      } catch (e) {
        logError('cross-encoder', 'rerank failed; using heuristic / vector order', e);
      }
    }
  }
  const assessment = config.searchMatchConfidence
    ? assessSearchMatchQuality(topHits, {
        rerankEnabled: config.rerankEnabled,
        weakBelow: config.searchMatchWeakBelow,
        strongAbove: config.searchMatchStrongAbove,
        minRelativeGap: config.searchMatchMinGap,
        query: args.query,
        matchConfAmbiguousLiteralDowngrade: config.matchConfAmbiguousLiteralDowngrade,
        matchConfTopPathFamilyDivergence: config.matchConfTopPathFamilyDivergence,
      })
    : null;
  const hitPayloads: CodebaseSearchHitPayload[] = topHits.map((h) => {
    const rs = config.rerankDebugScores ? rerankScoreForPayload(h) : undefined;
    const ceLog =
      config.rerankDebugScores && h.cross_encoder_logit !== undefined && Number.isFinite(h.cross_encoder_logit)
        ? h.cross_encoder_logit
        : undefined;
    return {
      path: h.path,
      start_line: h.start_line,
      end_line: h.end_line,
      score: h.score,
      ...(h.definition_of ? { definition_of: h.definition_of } : {}),
      ...(rs !== undefined ? { rerank_score: rs } : {}),
      ...(ceLog !== undefined ? { cross_encoder_logit: ceLog } : {}),
      snippet: h.text.length > 4000 ? `${h.text.slice(0, 4000)}…` : h.text,
    };
  });
  if (!assessment) {
    return { ok: true, hits: hitPayloads, query_classifier: queryClassifier };
  }
  return {
    ok: true,
    hits: hitPayloads,
    query_classifier: queryClassifier,
    match_confidence: assessment.match_confidence,
    match_confidence_reasons: assessment.match_confidence_reasons,
    match_confidence_hint: matchConfidenceHint(assessment),
    top_primary_score: assessment.top_primary_score ?? undefined,
    top_relative_separation: assessment.top_relative_separation ?? undefined,
  };
}

export async function runCodebaseSearch(
  config: AppConfig,
  store: ChunkStore,
  args: CodebaseSearchArgs,
): Promise<{ content: McpTextContent[] }> {
  const payload = await codebaseSearchPayload(config, store, args);
  if (!payload.ok) {
    return { content: [{ type: 'text' as const, text: payload.error }] };
  }
  const { ok, ...bodyObj } = payload;
  void ok;
  const body = JSON.stringify(bodyObj, null, 2);
  return { content: [{ type: 'text' as const, text: body }] };
}

export async function runCodebaseStats(
  indexer: Indexer,
  store: ChunkStore,
): Promise<{ content: McpTextContent[] }> {
  const s = indexer.getSnapshotStats();
  const chunks = await store.countChunks();
  const body = JSON.stringify(
    {
      watch_root: s.watchRoot,
      indexed_file_count: s.indexedFiles,
      chunk_count: chunks,
      embedding_model: s.embeddingModel,
      last_full_scan_at: s.lastFullScanAt,
    },
    null,
    2,
  );
  return { content: [{ type: 'text' as const, text: body }] };
}

/** Stats for MCP clients that only have read access to `meta.json` + Lance (no in-process `Indexer`). */
export async function runCodebaseStatsFromStore(
  config: AppConfig,
  store: ChunkStore,
): Promise<{ content: McpTextContent[] }> {
  const meta = await readMeta(config.metaPathAbs);
  const chunks = await store.countChunks();
  const body = JSON.stringify(
    {
      watch_root: config.watchRootAbs,
      indexed_file_count: meta ? Object.keys(meta.fileHashes).length : 0,
      chunk_count: chunks,
      embedding_model: meta?.embeddingModel ?? config.embeddingModel,
      last_full_scan_at: meta?.lastFullScanAt ?? null,
    },
    null,
    2,
  );
  return { content: [{ type: 'text' as const, text: body }] };
}

export async function runCodebaseReindex(
  config: AppConfig,
  indexer: Indexer,
  args: { path?: string },
): Promise<{ content: McpTextContent[] }> {
  const relOrAbs = args.path;
  if (relOrAbs && relOrAbs.length > 0) {
    const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(config.watchRootAbs, relOrAbs);
    indexer.scheduleIndexFile(abs);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ scheduled: abs }) }],
    };
  }
  await indexer.reconcile();
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, mode: 'reconcile' }) }] };
}

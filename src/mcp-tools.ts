import path from 'node:path';
import { embedTexts, getEmbedder } from './embedder.js';
import type { AppConfig } from './config.js';
import type { Indexer } from './indexer.js';
import { readMeta } from './meta.js';
import type { ChunkStore } from './store.js';
import { rerankSearchHits } from './rerank.js';
import { assessSearchMatchQuality, matchConfidenceHint } from './search-confidence.js';

export type McpTextContent = { type: 'text'; text: string };

export async function runCodebaseSearch(
  config: AppConfig,
  store: ChunkStore,
  args: { query: string; limit?: number; path_prefix?: string },
): Promise<{ content: McpTextContent[] }> {
  const lim = args.limit ?? 10;
  const candidateLimit = Math.max(lim, config.rerankCandidates);
  const extractor = await getEmbedder(config);
  const [qvec] = await embedTexts(extractor, [args.query], config.embeddingDim, config.embedInferenceLogMs);
  if (!qvec) {
    return { content: [{ type: 'text' as const, text: 'Failed to embed query.' }] };
  }
  const hits = await store.search({
    queryVector: qvec,
    queryText: args.query,
    limit: candidateLimit,
    pathPrefix: args.path_prefix,
  });
  const ranked = config.rerankEnabled
    ? rerankSearchHits(args.query, hits, {
        rerankDemotePathSubstrings: config.rerankDemotePathSubstrings,
        rerankDemotePerMatch: config.rerankDemotePerMatch,
      })
    : hits;
  const topHits = ranked.slice(0, lim);
  const assessment = config.searchMatchConfidence
    ? assessSearchMatchQuality(topHits, {
        rerankEnabled: config.rerankEnabled,
        weakBelow: config.searchMatchWeakBelow,
        strongAbove: config.searchMatchStrongAbove,
        minRelativeGap: config.searchMatchMinGap,
      })
    : null;
  const body = JSON.stringify(
    {
      hits: topHits.map((h) => ({
        path: h.path,
        start_line: h.start_line,
        end_line: h.end_line,
        score: h.score,
        ...(config.rerankDebugScores && 'rerank_score' in h ? { rerank_score: h.rerank_score } : {}),
        snippet: h.text.length > 4000 ? `${h.text.slice(0, 4000)}…` : h.text,
      })),
      ...(assessment
        ? {
            match_confidence: assessment.match_confidence,
            match_confidence_reasons: assessment.match_confidence_reasons,
            match_confidence_hint: matchConfidenceHint(assessment),
            top_primary_score: assessment.top_primary_score,
            top_relative_separation: assessment.top_relative_separation,
          }
        : {}),
    },
    null,
    2,
  );
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

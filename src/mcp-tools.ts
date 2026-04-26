import path from 'node:path';
import { embedTexts, getEmbedder } from './embedder.js';
import type { AppConfig } from './config.js';
import type { Indexer } from './indexer.js';
import type { ChunkStore } from './store.js';

export type McpTextContent = { type: 'text'; text: string };

export async function runCodebaseSearch(
  config: AppConfig,
  store: ChunkStore,
  args: { query: string; limit?: number; path_prefix?: string },
): Promise<{ content: McpTextContent[] }> {
  const lim = args.limit ?? 10;
  const extractor = await getEmbedder(config);
  const [qvec] = await embedTexts(extractor, [args.query], config.embeddingDim);
  if (!qvec) {
    return { content: [{ type: 'text' as const, text: 'Failed to embed query.' }] };
  }
  const hits = await store.search(qvec, lim, args.path_prefix);
  const body = JSON.stringify(
    {
      hits: hits.map((h) => ({
        path: h.path,
        start_line: h.start_line,
        end_line: h.end_line,
        score: h.score,
        snippet: h.text.length > 4000 ? `${h.text.slice(0, 4000)}…` : h.text,
      })),
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

import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import { connect, type Connection, type Table } from '@lancedb/lancedb';
import { Index, rerankers } from '@lancedb/lancedb';

const TABLE = 'chunks';

export interface ChunkRow {
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  vector: Float32Array;
  /** Heuristic: chunk starts at a declaration of this symbol (code-aware indexing). Empty = none. */
  definition_of: string;
}

export interface SearchHit {
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  score: number;
  /** Heuristic fusion score when heuristic rerank ran; preserved through cross-encoder when enabled. */
  rerank_score?: number;
  /** Heuristic: declared symbol at the start of this chunk (if indexed with code-aware chunking). */
  definition_of?: string;
  /**
   * Raw relevance logit from the optional cross-encoder reranker (higher = more relevant).
   * Exposed in MCP when `CODEBASE_MCP_RERANK_DEBUG_SCORES=1` and cross-encoder ran.
   */
  cross_encoder_logit?: number;
}

export interface ChunkStoreSearchOptions {
  queryVector: Float32Array;
  queryText: string;
  limit: number;
  pathPrefix?: string;
  /**
   * Post-filter on repo-relative POSIX `path` (after vector + optional `pathPrefix` in SQL).
   * Used for `ext` / `lang` / `glob` in `codebase_search`; not applied in Lance SQL today.
   */
  pathFilter?: (relPath: string) => boolean;
  /**
   * When true, fetches a larger candidate pool before filtering (ext/glob would otherwise empty the top-`limit`).
   */
  pathFilterNarrowing?: boolean;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Separates the BM25-only header (path / basename tokens) from chunk body in Lance `text`.
 * Uses Unicode RECORD SEPARATOR — extremely unlikely inside indexed source.
 */
export const CHUNK_TEXT_STORAGE_SEP = '\n\u241E\n';

/**
 * Lance stores `text` used for BM25 (`fullTextSearch` on `text`). Include path + basename tokens so
 * queries like "gitlab-ci" or "docker-compose" match YAML/JSON whose bodies rarely repeat the filename.
 * Embeddings still use raw chunk text via `embeddingTextForChunk` in the indexer.
 */
export function chunkTextForLanceStorage(relPosix: string, body: string): string {
  const base = relPosix.includes('/') ? relPosix.slice(relPosix.lastIndexOf('/') + 1) : relPosix;
  const pathWords = relPosix.replace(/\//g, ' ');
  const baseHyphenSplit = base.replace(/-/g, ' ');
  const header = `${relPosix} ${base} ${baseHyphenSplit} ${pathWords}`;
  return `${header}${CHUNK_TEXT_STORAGE_SEP}${body}`;
}

/** Undo {@link chunkTextForLanceStorage} for snippets / rerank / cross-encoder (body only). */
export function chunkBodyFromLanceStored(stored: string): string {
  const idx = stored.indexOf(CHUNK_TEXT_STORAGE_SEP);
  if (idx === -1) {
    return stored;
  }
  return stored.slice(idx + CHUNK_TEXT_STORAGE_SEP.length);
}

function pathPrefixSqlFilter(prefix: string): string {
  const p = prefix.replace(/\/+$/, '');
  return `(path = ${sqlLiteral(p)} OR path LIKE ${sqlLiteral(`${p}/%`)})`;
}

function hasFtsOnText(indices: { columns: string[] }[]): boolean {
  return indices.some((c) => c.columns[0] === 'text' || c.columns.includes('text'));
}

function definitionOfFromRow(r: Record<string, unknown>): string | undefined {
  const v = r.definition_of;
  if (v == null) {
    return undefined;
  }
  const s = String(v).trim();
  return s.length > 0 ? s : undefined;
}

function hitScoreFromRow(row: Record<string, unknown>): number {
  const raw =
    (row as { _score?: unknown; score?: unknown; rrf_score?: unknown; _relevance?: unknown })
      ._score ??
    (row as { score?: unknown }).score ??
    (row as { rrf_score?: unknown }).rrf_score ??
    (row as { _relevance?: unknown })._relevance;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (raw !== undefined && raw !== null) {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return 0;
}

export class ChunkStore {
  private conn: Connection | null = null;
  private table: Table | null = null;
  private canCreateIndices = false;
  private readonly hybridEnabled: boolean;
  private readonly rrfK: number;
  private readonly hybridDepth: number;

  constructor(
    private readonly lanceDirAbs: string,
    private readonly embeddingDim: number,
    options?: { hybridEnabled: boolean; rrfK: number; hybridDepth: number },
  ) {
    this.hybridEnabled = options?.hybridEnabled ?? true;
    this.rrfK = options?.rrfK ?? 60;
    this.hybridDepth = options?.hybridDepth ?? 100;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.lanceDirAbs, { recursive: true });
    this.conn = await connect(this.lanceDirAbs);
    this.canCreateIndices = true;
    const names = await this.conn.tableNames();
    if (names.includes(TABLE)) {
      this.table = await this.conn.openTable(TABLE);
      await this.ensureDefinitionOfColumn();
    }
  }

  /**
   * Open LanceDB for read/search only: no create dir or table. Used by MCP stdio when the
   * indexing daemon is the sole writer. Safe to call while the daemon is writing.
   */
  async initReadOnly(): Promise<void> {
    try {
      await fs.access(this.lanceDirAbs, fsConstants.F_OK);
    } catch {
      return;
    }
    this.conn = await connect(this.lanceDirAbs);
    const names = await this.conn.tableNames();
    if (names.includes(TABLE)) {
      this.table = await this.conn.openTable(TABLE);
    }
    this.canCreateIndices = false;
  }

  private requireTable(): Table {
    if (!this.table) {
      throw new Error('Chunk table not initialized');
    }
    return this.table;
  }

  /** Add `definition_of` to existing tables from before this column existed (indexer / writer `init` only). */
  private async ensureDefinitionOfColumn(): Promise<void> {
    if (!this.table) {
      return;
    }
    const table = this.requireTable();
    const schema = await table.schema();
    const names = schema.fields.map((f: { name: string }) => f.name);
    if (names.includes('definition_of')) {
      return;
    }
    await table.addColumns([{ name: 'definition_of', valueSql: "''" }]);
  }

  /**
   * Create / refresh BM25-capable FTS on `text` (LanceDB uses BM25 for FTS). Only safe in the
   * indexing process (or NO_DAEMON); MCP read-only does not run this.
   */
  async ensureFtsIndex(): Promise<void> {
    if (!this.table || !this.canCreateIndices) {
      return;
    }
    const table = this.requireTable();
    const n = await table.countRows();
    if (n === 0) {
      return;
    }
    const indices = await table.listIndices();
    if (hasFtsOnText(indices)) {
      return;
    }
    await table.createIndex('text', {
      config: Index.fts({ baseTokenizer: 'simple' }),
    });
  }

  async ensureTableFromRows(firstBatch: ChunkRow[]): Promise<void> {
    if (this.table) {
      return;
    }
    if (!this.conn) {
      throw new Error('Store not initialized');
    }
    if (firstBatch.length === 0) {
      return;
    }
    const data = firstBatch.map((r) => ({
      path: r.path,
      start_line: r.start_line,
      end_line: r.end_line,
      text: r.text,
      vector: Array.from(r.vector),
      definition_of: r.definition_of ?? '',
    }));
    this.table = await this.conn.createTable(TABLE, data);
    if (this.canCreateIndices) {
      await this.ensureFtsIndex();
    }
  }

  async addRows(rows: ChunkRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    if (!this.table) {
      await this.ensureTableFromRows(rows);
      return;
    }
    const data = rows.map((r) => ({
      path: r.path,
      start_line: r.start_line,
      end_line: r.end_line,
      text: r.text,
      vector: Array.from(r.vector),
      definition_of: r.definition_of ?? '',
    }));
    await this.requireTable().add(data);
    if (this.canCreateIndices) {
      await this.ensureFtsIndex();
    }
  }

  async deleteByPath(relPosix: string): Promise<void> {
    if (!this.table) {
      return;
    }
    await this.requireTable().delete(`path = ${sqlLiteral(relPosix)}`);
  }

  /**
   * Vector-only search (no query text for FTS). Used for fallback and when hybrid is off.
   */
  private vectorOverFetchLimit(
    limit: number,
    pathPrefix: string | undefined,
    pathFilter: ((p: string) => boolean) | undefined,
    pathFilterNarrowing: boolean,
  ): number {
    if (pathFilterNarrowing && pathFilter) {
      return Math.min(2000, Math.max(limit * 20, 100));
    }
    if (pathPrefix && pathPrefix.length > 0) {
      return Math.min(200, Math.max(limit * 8, limit));
    }
    return limit;
  }

  private applyPathFilter(
    hits: SearchHit[],
    pathFilter: ((p: string) => boolean) | undefined,
  ): SearchHit[] {
    if (!pathFilter) {
      return hits;
    }
    return hits.filter((h) => pathFilter(h.path));
  }

  private async searchVectorOnly(
    queryVector: Float32Array,
    limit: number,
    pathPrefix?: string,
    pathFilter?: (relPath: string) => boolean,
    pathFilterNarrowing?: boolean,
  ): Promise<SearchHit[]> {
    if (!this.table) {
      return [];
    }
    const table = this.requireTable();
    const fetchLimit = this.vectorOverFetchLimit(limit, pathPrefix, pathFilter, pathFilterNarrowing ?? false);
    const q = table.vectorSearch(Array.from(queryVector)).limit(fetchLimit);
    const rows = await q.toArray();
    const hits: SearchHit[] = [];
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const distance = (r._distance as number) ?? (r.distance as number) ?? 0;
      const def = definitionOfFromRow(r);
      hits.push({
        path: String(r.path),
        start_line: Number(r.start_line),
        end_line: Number(r.end_line),
        text: chunkBodyFromLanceStored(String(r.text)),
        score: typeof distance === 'number' ? 1 / (1 + distance) : 0,
        ...(def ? { definition_of: def } : {}),
      });
    }
    let filtered = hits;
    if (pathPrefix && pathPrefix.length > 0) {
      const prefix = pathPrefix.replace(/\/+$/, '');
      filtered = hits.filter((h) => h.path === prefix || h.path.startsWith(`${prefix}/`));
    }
    filtered = this.applyPathFilter(filtered, pathFilter);
    return filtered.slice(0, limit);
  }

  private async searchHybridRrf(
    args: {
      queryVector: Float32Array;
      queryText: string;
      limit: number;
      pathPrefix?: string;
      pathFilter?: (relPath: string) => boolean;
      pathFilterNarrowing?: boolean;
    },
  ): Promise<SearchHit[]> {
    if (!this.table) {
      return [];
    }
    const text = args.queryText.trim();
    if (text.length === 0) {
      return this.searchVectorOnly(
        args.queryVector,
        args.limit,
        args.pathPrefix,
        args.pathFilter,
        args.pathFilterNarrowing,
      );
    }
    const narrow = args.pathFilterNarrowing && args.pathFilter;
    const mult = narrow ? 4 : 1;
    const cap = 800;
    const baseDepth = Math.min(cap, Math.max(this.hybridDepth, args.limit, 1) * mult);
    const rrfReranker = await rerankers.RRFReranker.create(this.rrfK);
    const table = this.requireTable();
    let q = table.vectorSearch(Array.from(args.queryVector));
    if (args.pathPrefix && args.pathPrefix.length > 0) {
      const prefix = args.pathPrefix.replace(/\/+$/, '');
      q = q.where(pathPrefixSqlFilter(prefix));
    }
    q = q
      .fullTextSearch(text, { columns: 'text' })
      .limit(baseDepth)
      .rerank(rrfReranker);
    const rows = (await q.toArray()) as Record<string, unknown>[];
    const hits: SearchHit[] = rows.map((r) => {
      const def = definitionOfFromRow(r);
      return {
        path: String(r.path),
        start_line: Number(r.start_line),
        end_line: Number(r.end_line),
        text: chunkBodyFromLanceStored(String(r.text)),
        score: hitScoreFromRow(r),
        ...(def ? { definition_of: def } : {}),
      };
    });
    let out = this.applyPathFilter(hits, args.pathFilter);
    if (args.pathPrefix && args.pathPrefix.length > 0) {
      const prefix = args.pathPrefix.replace(/\/+$/, '');
      out = out.filter((h) => h.path === prefix || h.path.startsWith(`${prefix}/`));
    }
    return out.slice(0, args.limit);
  }

  /**
   * Hybrid BM25 (LanceDB FTS) + vector + RRF when enabled and an FTS index exists; otherwise
   * vector kNN, optionally filtered by `pathPrefix`.
   */
  async search(opts: ChunkStoreSearchOptions): Promise<SearchHit[]> {
    if (!this.table) {
      return [];
    }
    const { queryVector, queryText, limit, pathPrefix, pathFilter, pathFilterNarrowing } = opts;
    if (!this.hybridEnabled) {
      return this.searchVectorOnly(queryVector, limit, pathPrefix, pathFilter, pathFilterNarrowing);
    }
    const canHybrid =
      queryText.trim().length > 0 && (this.canCreateIndices || (await this.hasFtsIndex()));
    if (!canHybrid) {
      return this.searchVectorOnly(queryVector, limit, pathPrefix, pathFilter, pathFilterNarrowing);
    }
    try {
      return await this.searchHybridRrf({
        queryVector,
        queryText,
        limit,
        pathPrefix,
        pathFilter,
        pathFilterNarrowing,
      });
    } catch {
      return this.searchVectorOnly(queryVector, limit, pathPrefix, pathFilter, pathFilterNarrowing);
    }
  }

  private async hasFtsIndex(): Promise<boolean> {
    if (!this.table) {
      return false;
    }
    const indices = await this.requireTable().listIndices();
    return hasFtsOnText(indices);
  }

  async countChunks(): Promise<number> {
    if (!this.table) {
      return 0;
    }
    return this.requireTable().countRows();
  }
}

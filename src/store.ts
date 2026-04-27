import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import { connect, type Connection, type Table } from '@lancedb/lancedb';

const TABLE = 'chunks';

export interface ChunkRow {
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  vector: Float32Array;
}

export interface SearchHit {
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  score: number;
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export class ChunkStore {
  private conn: Connection | null = null;
  private table: Table | null = null;

  constructor(
    private readonly lanceDirAbs: string,
    private readonly embeddingDim: number,
  ) {}

  async init(): Promise<void> {
    await fs.mkdir(this.lanceDirAbs, { recursive: true });
    this.conn = await connect(this.lanceDirAbs);
    const names = await this.conn.tableNames();
    if (names.includes(TABLE)) {
      this.table = await this.conn.openTable(TABLE);
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
  }

  private requireTable(): Table {
    if (!this.table) {
      throw new Error('Chunk table not initialized');
    }
    return this.table;
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
    }));
    this.table = await this.conn.createTable(TABLE, data);
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
    }));
    await this.requireTable().add(data);
  }

  async deleteByPath(relPosix: string): Promise<void> {
    if (!this.table) {
      return;
    }
    await this.requireTable().delete(`path = ${sqlLiteral(relPosix)}`);
  }

  async search(queryVector: Float32Array, limit: number, pathPrefix?: string): Promise<SearchHit[]> {
    if (!this.table) {
      return [];
    }
    const table = this.requireTable();
    const fetchLimit = pathPrefix && pathPrefix.length > 0 ? Math.min(200, Math.max(limit * 8, limit)) : limit;
    const q = table.vectorSearch(Array.from(queryVector)).limit(fetchLimit);
    const rows = await q.toArray();
    const hits: SearchHit[] = [];
    for (const row of rows) {
      const distance = (row._distance as number) ?? (row.distance as number) ?? 0;
      hits.push({
        path: String(row.path),
        start_line: Number(row.start_line),
        end_line: Number(row.end_line),
        text: String(row.text),
        score: typeof distance === 'number' ? 1 / (1 + distance) : 0,
      });
    }
    let filtered = hits;
    if (pathPrefix && pathPrefix.length > 0) {
      const prefix = pathPrefix.replace(/\/+$/, '');
      filtered = hits.filter((h) => h.path === prefix || h.path.startsWith(`${prefix}/`));
    }
    return filtered.slice(0, limit);
  }

  async countChunks(): Promise<number> {
    if (!this.table) {
      return 0;
    }
    return this.requireTable().countRows();
  }
}

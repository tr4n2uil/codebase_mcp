# Storage (LanceDB & metadata)

## Paths

| Path | Purpose |
|------|---------|
| `CODEBASE_MCP_INDEX_DIR/lancedb/` | Lance **Connection** URI passed to `@lancedb/lancedb` `connect()` |
| `CODEBASE_MCP_INDEX_DIR/meta.json` | Indexer metadata: model id, per-file content hash, stat cache, watch root, last full scan time |

Lance is embedded: no separate server process.

## `chunks` table (logical schema)

The index stores **one row per text chunk** (not per file). Typical columns used in code:

| Column | Type (conceptual) | Use |
|--------|-------------------|-----|
| `path` | string (POSIX rel. to `CODEBASE_MCP_ROOT`) | Filter, display, delete-by-path |
| `start_line` / `end_line` | int | Provenance in search results |
| `text` | string | Snippet and **FTS** (BM25) |
| `vector` | float32[] (fixed dim) | kNN; dimension must match `CODEBASE_MCP_EMBEDDING_DIM` and model metadata in `meta.json` |

**Deletion** — `deleteByPath` runs an SQL `DELETE WHERE path = …` to remove all chunks for a file in one go.

## Hybrid retrieval indexes

- **Vector** — Default ANN is table-dependent (flat scan for small data; vector indices optional via Lance `createIndex` on the vector column, not part of the minimal mcp v1).
- **Full-text** — `ChunkStore.ensureFtsIndex()` calls `Index.fts({ baseTokenizer: 'simple' })` on the **`text`** column. Lance documents FTS as **BM25-ordered** relevance. The **writer** (daemon or `NO_DAEMON` indexer) creates the FTS index when data exists; **read-only** MCP can use it if present.

**Sync** — After new rows are `add`ed, `ensureFtsIndex` is invoked so the first batch creates both the table and, when non-empty, the FTS index.

## Model / schema migration

- If `meta.json`’s `embeddingModel` or `embeddingDim` no longer match `loadConfig()`, the bootstrap layer **wipes the Lance table directory** and resets `meta` (see `indexing-bootstrap.ts`) to avoid mixed vector spaces.

## Related code

- `store.ts` — `ChunkStore`, `ensureFtsIndex`, `search` (vector + hybrid + RRF)
- `meta.ts` — JSON read/write
- `indexer.ts` — row construction and `writeMeta` calls

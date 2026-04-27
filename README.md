# codebase-mcp

Local **semantic search** over a repository: watches files (with `.gitignore` + safety rules, and optional **`CODEBASE_MCP_FORCE_INCLUDE`** for gitignored paths you still want indexed), chunks text, embeds with **`@xenova/transformers`** (no paid API), stores vectors in **LanceDB** under **`codebase-mcp/db/<repo-name>/`** (ignored in this package via `db/`), and exposes **MCP tools** for agents.

## Prerequisites

- **Node.js 18+**
- Env **`CODEBASE_MCP_ROOT`**: absolute path to the repository root to index.

## Install & build

```bash
cd codebase-mcp
npm install
npm run build
```

## Run (stdio MCP)

```bash
export CODEBASE_MCP_ROOT=/absolute/path/to/your/repo
node dist/main.js
```

**You only need `node dist/main.js` in Cursor (or any MCP client).** Do not pass `--daemon` there: if no indexer is listening yet for this **same** `CODEBASE_MCP_ROOT` + `CODEBASE_MCP_INDEX_DIR` (resolved the same way), the first `main.js` will **start** `node dist/main.js --daemon` in the background with the **same `env`**.

**Process model (default):** one **indexing daemon** per `CODEBASE_MCP_INDEX_DIR` (watcher + ingest + **sole writer** to LanceDB). A Unix domain socket or Windows named pipe under **`<index>/.codebase-mcp-daemon/`** is used only to **start the daemon if needed (ping) and to run `codebase_reindex`**. Each stdio `node dist/main.js` process **reads the same LanceDB** for **`codebase_search` / `codebase_stats`** and runs **query embeddings locally** (so multiple MCP clients do not route search through IPC). You can also start the daemon yourself:

```bash
export CODEBASE_MCP_ROOT=/absolute/path/to/your/repo
node dist/main.js --daemon
```

Set **`CODEBASE_MCP_NO_DAEMON=1`** to restore the previous behavior (watcher + MCP in one process), e.g. for debugging.

**Logs:** stderr is mirrored to **`<CODEBASE_MCP_INDEX_DIR>/.logs/mcp.log`** (MCP / stdio process) or **`.logs/daemon.log`** (`--daemon` indexer). All lines in those files are prefixed with **`[pid=…] `** so multiple processes and restarts are easy to follow. (Default: `codebase-mcp/db/<repo>/.logs/`; under `db/` and gitignored with the index.) Use this to confirm indexing when the daemon was started detached.

First run downloads the embedding model (cached by Transformers.js, see `HF_HOME` / `XDG_CACHE_HOME`).

### Optional environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `CODEBASE_MCP_ROOT` | _(required)_ | Repo root to watch and index |
| `CODEBASE_MCP_INDEX_DIR` | `codebase-mcp/db/<basename(root)>/` | Where LanceDB + `meta.json` live (under this package). Override for custom location or to avoid basename collisions. |
| `CODEBASE_MCP_EMBEDDING_MODEL` | `Xenova/jina-embeddings-v2-base-en` | Transformers.js model id |
| `CODEBASE_MCP_EMBEDDING_DIM` | `768` | Must match the model output size |
| `CODEBASE_MCP_EMBED_BATCH_SIZE` | `4` | Chunks per ONNX call (1–32). Smaller batches = more log lines and less RAM per step; first CPU run can still take many minutes. |
| `CODEBASE_MCP_EMBED_INFER_LOG_MS` | `20000` | Log “still in inference” at this interval (ms) during ONNX (warmup + each batch) so you can tell work is still running. `0` disables. Example: `120000` for every 2 minutes. |
| `CODEBASE_MCP_CHUNK_LINES` | `60` | Lines per chunk |
| `CODEBASE_MCP_CHUNK_OVERLAP` | `12` | Overlap between chunks |
| `CODEBASE_MCP_MAX_FILE_BYTES` | `5242880` | Skip larger files |
| `CODEBASE_MCP_DEBOUNCE_MS` | `1500` | _(reserved for future tuning)_ |
| `CODEBASE_MCP_RECONCILE_MS` | `300000` | Periodic full reconcile (ms) |
| `CODEBASE_MCP_USE_POLLING` | `true` | `true`/`1` uses polling (fewer file descriptors; avoids **EMFILE** on large trees). Set `false` for native `fs.watch` on small repos. |
| `CODEBASE_MCP_POLL_MS` | `2000` | Polling interval when polling is enabled |
| `CODEBASE_MCP_CODE_AWARE_CHUNKING` | `true` | Use symbol-aware chunk boundaries (with fallback to fixed line chunks) |
| `CODEBASE_MCP_RERANK` | `true` | Apply lexical/path reranking to vector search candidates |
| `CODEBASE_MCP_RERANK_CANDIDATES` | `50` | Candidate pool size fetched before reranking |
| `CODEBASE_MCP_RERANK_DEBUG_SCORES` | `false` | Include `rerank_score` in `codebase_search` output for tuning/debugging |
| `CODEBASE_MCP_VERBOSE` | `true` | Log every successfully indexed file (`path` + chunk count); set `false` on very large repos |
| `CODEBASE_MCP_LOG_TOOLS` | `true` | Log each MCP tool call name (and reindex path) to stderr; set `false` to reduce noise |
| `CODEBASE_MCP_FORCE_INCLUDE` | _(empty)_ | Comma- or newline-separated **repo-relative** POSIX paths (e.g. `generated/api,tmp/docs`) that are indexed **even if** matched by root `.gitignore`. Lets you avoid `!` negation rules in `.gitignore`. Does **not** override hard safety skips (`.git/`, `node_modules/`, `.env*`, key material, etc.). Also overrides watcher segment skips (`dist/`, `build/`, …) when the path is on the way to or inside a listed entry. |
| `CODEBASE_MCP_NO_DAEMON` | _(unset)_ | If `1`/`true`/`yes`, run watcher + indexer + MCP in **one** Node process (no shared daemon). |

Lower-CPU, less code-aware alternative (previous default):

```bash
export CODEBASE_MCP_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
export CODEBASE_MCP_EMBEDDING_DIM=384
```

When changing embedding model/dimension or code-aware chunking behavior, use a fresh `CODEBASE_MCP_INDEX_DIR` (or reindex) to avoid mixing old and new vector/chunk layouts.

Large repos: native recursive watching can hit **EMFILE: too many open files**; polling is the default. You can also raise the process limit (e.g. `ulimit -n 10240`).

Index data lives next to this tool (`db/` is gitignored here), not inside the indexed repository.

## Cursor MCP config example

```json
{
  "mcpServers": {
    "codebase": {
      "command": "node",
      "args": ["/absolute/path/to/codebase-mcp/dist/main.js"],
      "env": {
        "CODEBASE_MCP_ROOT": "/absolute/path/to/your/repo",
        "CODEBASE_MCP_FORCE_INCLUDE": "path/inside/gitignored/tree"
      }
    }
  }
}
```

## Claude Code MCP config example

```json
{
  "mcpServers": {
    "codebase": {
      "command": "node",
      "args": ["/absolute/path/to/codebase-mcp/dist/main.js"],
      "env": {
        "CODEBASE_MCP_ROOT": "/absolute/path/to/your/repo",
        "CODEBASE_MCP_FORCE_INCLUDE": "path/inside/gitignored/tree"
      }
    }
  },
}
```

## MCP tools

| Tool | Description |
|------|-------------|
| `codebase_search` | Semantic search (`query`, optional `limit`, `path_prefix`) |
| `codebase_stats` | Chunk count, indexed file count, model, last scan time |
| `codebase_reindex` | Optional `path` to reindex one file; omit for full **reconcile** |

## Design

See `docs/local_codebase_vector_mcp_brainstorm.md` in this package.

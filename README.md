# codebase-mcp

Local **semantic search** over a repository: watches files (with `.gitignore` + safety rules; by default **`CODEBASE_MCP_FORCE_INCLUDE`** includes **`.claude/docs`** so that tree can be indexed even if gitignored), chunks text, embeds with **`@xenova/transformers`** (no paid API), stores vectors in **LanceDB** under **`<repo>/.claude/codebase_mcp/db/`** by default (override with **`CODEBASE_MCP_INDEX_DIR`**), and exposes **MCP tools** for agents.

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

**MCP stdio (`node dist/main.js`) does not start the indexer** — it only **tries a quick connect** to an already-running daemon for `codebase_reindex`. **You start the indexer separately** (same `CODEBASE_MCP_ROOT` / `CODEBASE_MCP_INDEX_DIR` as the MCP).

**Process model (default):** one **indexing daemon** per index directory (watcher + ingest + **sole writer** to LanceDB). A Unix domain socket or Windows named pipe under **`<index>/.codebase-mcp-daemon/socket`** is used for **`codebase_reindex` IPC** when the daemon is up. Each MCP process **reads LanceDB read-only** for **`codebase_search` / `codebase_stats`** and embeds queries locally.

**Start the daemon (pick one):**

```bash
export CODEBASE_MCP_ROOT=/absolute/path/to/your/repo
# Installed package (after `npm install` in this repo: `npm run build` first):
npx -y -p @tr4n2uil/codebase-mcp@latest -- codebase-mcp-daemon
```

From a local clone of this repo (after `npm run build`):

```bash
export CODEBASE_MCP_ROOT=/absolute/path/to/your/repo
npm run daemon
# or: node dist/main.js --daemon
```

Set **`CODEBASE_MCP_NO_DAEMON=1`** to restore the previous behavior (watcher + MCP in one process), e.g. for debugging.

**Logs:** stderr is mirrored to **`<CODEBASE_MCP_INDEX_DIR>/.logs/mcp.log`** (MCP / stdio process) or **`.logs/daemon.log`** (`--daemon` indexer). All lines in those files are prefixed with **`[pid=…] `** so multiple processes and restarts are easy to follow. (Default index dir: **`<repo>/.claude/codebase_mcp/db`** — add `.claude/` to `.gitignore` if you do not want the index in version control.) Use this to confirm indexing when the daemon was started detached.

First run downloads the embedding model (cached by Transformers.js, see `HF_HOME` / `XDG_CACHE_HOME`).

### Optional environment

All variables are read from `process.env` via `loadConfig()` in **each** Node process. Use the **Applies to** column: **MCP** = the stdio `codebase-mcp` process; **Daemon** = `codebase-mcp-daemon` (watcher + indexer + IPC writer); **Both** = set to the same values in MCP and daemon when you run them separately (so paths, model, and embedding options stay consistent). Variables marked **Daemon** have **no effect on search** if you set them only in the Cursor MCP `env` block; put them in the environment where the **daemon** runs (or use **`CODEBASE_MCP_NO_DAEMON=1`** so one process does everything and one `env` block covers indexing + search).

| Variable | Default | Applies to | Purpose |
|----------|---------|------------|---------|
| `CODEBASE_MCP_ROOT` | _(required)_ | **Both** | Repo root. Must match between MCP and daemon. |
| `CODEBASE_MCP_INDEX_DIR` | `<CODEBASE_MCP_ROOT>/.claude/codebase_mcp/db` | **Both** | Where LanceDB + `meta.json` live (default: under the repo’s `.claude/` tree). Must match between MCP and daemon. Override for a custom path or CI cache. |
| `CODEBASE_MCP_EMBEDDING_MODEL` | `Xenova/jina-embeddings-v2-base-en` | **Both** | Model id. Must match stored index metadata; used for **query** embed (MCP) and **ingest** embed (daemon). |
| `CODEBASE_MCP_EMBEDDING_DIM` | `768` | **Both** | Vector dimension; must match model and index. |
| `CODEBASE_MCP_EMBED_BATCH_SIZE` | `4` | **Both** | Chunks (daemon) or batching behavior when embedding; query path uses batches too. |
| `CODEBASE_MCP_EMBED_INFER_LOG_MS` | `20000` | **Both** | Heartbeat while ONNX runs (`0` = off). |
| `CODEBASE_MCP_ORT_UNLIMITED` | `false` | **Both** | ONNX thread caps: `false` = cap CPU. |
| `CODEBASE_MCP_ORT_INTRA_OP_THREADS` | `1` | **Both** | ONNX intra-op threads. |
| `CODEBASE_MCP_ORT_INTER_OP_THREADS` | `1` | **Both** | ONNX inter-op threads. |
| `CODEBASE_MCP_ORT_SEQUENTIAL` | `true` | **Both** | Prefer sequential execution mode with caps. |
| `CODEBASE_MCP_ORT_WASM_NUM_THREADS` | `1` | **Both** | Wasm backend thread count if used. |
| `CODEBASE_MCP_CHUNK_LINES` | `60` | **Daemon** | Lines per chunk when indexing. |
| `CODEBASE_MCP_CHUNK_OVERLAP` | `12` | **Daemon** | Line overlap between chunks. |
| `CODEBASE_MCP_MAX_FILE_BYTES` | `5242880` | **Daemon** | Max file size to index. |
| `CODEBASE_MCP_DEBOUNCE_MS` | `1500` | **Daemon** | _(Reserved / watcher debounce.)_ |
| `CODEBASE_MCP_RECONCILE_MS` | `300000` | **Daemon** | Interval for periodic full reconcile. |
| `CODEBASE_MCP_USE_POLLING` | `true` | **Daemon** | Polling vs native `fs.watch` for the watcher. |
| `CODEBASE_MCP_POLL_MS` | `2000` | **Daemon** | Polling interval. |
| `CODEBASE_MCP_CODE_AWARE_CHUNKING` | `true` | **Daemon** | Symbol-aware chunking when indexing. |
| `CODEBASE_MCP_RERANK` | `true` | **MCP** | Rerank vector hits lexically in `codebase_search`. |
| `CODEBASE_MCP_RERANK_CANDIDATES` | `50` | **MCP** | Candidate pool before rerank. |
| `CODEBASE_MCP_RERANK_DEBUG_SCORES` | `false` | **MCP** | Expose `rerank_score` in search output. |
| `CODEBASE_MCP_VERBOSE` | `true` | **Daemon** | Per-file indexer logs. |
| `CODEBASE_MCP_LOG_TOOLS` | `true` | **MCP** | Log each MCP tool invocation to stderr. |
| `CODEBASE_MCP_FORCE_INCLUDE` | `.claude/docs` | **Daemon** | Comma- or newline-separated **repo-relative** paths indexed even if `.gitignore` would skip them. Default alone includes **`.claude/docs`**. Set to **`-`** or **`none`** to clear the list (no extra includes). **Not used for search**; set on the **daemon** env (or the single process when `CODEBASE_MCP_NO_DAEMON=1`). |
| `CODEBASE_MCP_NO_DAEMON` | _(unset)_ | **MCP** | If `1`/`true`/`yes`, run watcher + indexer + MCP in **one** process (no separate daemon). |

Lower-CPU, less code-aware alternative (previous default):

```bash
export CODEBASE_MCP_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
export CODEBASE_MCP_EMBEDDING_DIM=384
```

When changing embedding model/dimension or code-aware chunking behavior, use a fresh `CODEBASE_MCP_INDEX_DIR` (or reindex) to avoid mixing old and new vector/chunk layouts.

Large repos: native recursive watching can hit **EMFILE: too many open files**; polling is the default. You can also raise the process limit (e.g. `ulimit -n 10240`).

Index data lives next to this tool (`db/` is gitignored here), not inside the indexed repository.

## Cursor MCP config example

The `env` object applies to the **MCP** process only. At minimum set **`CODEBASE_MCP_ROOT`** (and override **`CODEBASE_MCP_INDEX_DIR`** if needed). **Indexing** options such as **`CODEBASE_MCP_FORCE_INCLUDE`** must be set on the **daemon** (see *Start the daemon* above), not here, unless you use **`CODEBASE_MCP_NO_DAEMON=1`**.

```json
{
  "mcpServers": {
    "codebase": {
      "command": "node",
      "args": ["/absolute/path/to/codebase-mcp/dist/main.js"],
      "env": {
        "CODEBASE_MCP_ROOT": "/absolute/path/to/your/repo"
      }
    }
  }
}
```

**Daemon** (separate terminal), same index — example including force-include for gitignored trees:

```bash
export CODEBASE_MCP_ROOT=/absolute/path/to/your/repo
export CODEBASE_MCP_FORCE_INCLUDE="path/inside/gitignored/tree"
npx -y -p @tr4n2uil/codebase-mcp@latest -- codebase-mcp-daemon
```

## Claude Code MCP config example

Same as Cursor: MCP `env` is for the stdio server; put **`CODEBASE_MCP_FORCE_INCLUDE`** (and other **Daemon** rows from the table) on the **daemon** process.

```json
{
  "mcpServers": {
    "codebase": {
      "command": "node",
      "args": ["/absolute/path/to/codebase-mcp/dist/main.js"],
      "env": {
        "CODEBASE_MCP_ROOT": "/absolute/path/to/your/repo"
      }
    }
  }
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

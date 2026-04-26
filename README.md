# codebase-mcp

Local **semantic search** over a repository: watches files (with `.gitignore` + safety rules, and optional **`CODEBASE_MCP_FORCE_INCLUDE`** for gitignored paths you still want indexed), chunks text, embeds with **`@xenova/transformers`** (no paid API), stores vectors in **LanceDB** under **`tools/codebase-mcp/db/<repo-name>/`** (ignored in this package via `db/`), and exposes **MCP tools** for agents.

## Prerequisites

- **Node.js 18+**
- Env **`CODEBASE_MCP_ROOT`**: absolute path to the repository root to index.

## Install & build

```bash
cd tools/codebase-mcp
npm install
npm run build
```

## Run (stdio MCP)

```bash
export CODEBASE_MCP_ROOT=/absolute/path/to/your/repo
node dist/main.js
```

**Process model (default):** the stdio process is a thin **MCP client**. It connects to a **single indexing daemon** per `CODEBASE_MCP_INDEX_DIR` (Unix domain socket or Windows named pipe under `<index>/.codebase-mcp-daemon/`). If nothing is listening, it acquires a short-lived spawn lock, starts `node dist/main.js --daemon` detached, then talks to that daemon so **only one watcher + one reconcile loop** run for that index. You can still start the daemon yourself (same env as MCP):

```bash
export CODEBASE_MCP_ROOT=/absolute/path/to/your/repo
node dist/main.js --daemon
```

Set **`CODEBASE_MCP_NO_DAEMON=1`** to restore the previous behavior (watcher + MCP in one process), e.g. for debugging.

**Logs:** every process (MCP client or `--daemon`) mirrors **stderr** to **`tools/codebase-mcp/.logs/<pid>`** (plain file named by process id; directory is gitignored). Use this to confirm indexing when the daemon was started detached.

First run downloads the embedding model (cached by Transformers.js, see `HF_HOME` / `XDG_CACHE_HOME`).

### Optional environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `CODEBASE_MCP_ROOT` | _(required)_ | Repo root to watch and index |
| `CODEBASE_MCP_INDEX_DIR` | `tools/codebase-mcp/db/<basename(root)>/` | Where LanceDB + `meta.json` live (under this package). Override for custom location or to avoid basename collisions. |
| `CODEBASE_MCP_EMBEDDING_MODEL` | `Xenova/jina-embeddings-v2-base-en` | Transformers.js model id |
| `CODEBASE_MCP_EMBEDDING_DIM` | `768` | Must match the model output size |
| `CODEBASE_MCP_CHUNK_LINES` | `60` | Lines per chunk |
| `CODEBASE_MCP_CHUNK_OVERLAP` | `12` | Overlap between chunks |
| `CODEBASE_MCP_MAX_FILE_BYTES` | `5242880` | Skip larger files |
| `CODEBASE_MCP_DEBOUNCE_MS` | `1500` | _(reserved for future tuning)_ |
| `CODEBASE_MCP_RECONCILE_MS` | `300000` | Periodic full reconcile (ms) |
| `CODEBASE_MCP_USE_POLLING` | `true` | `true`/`1` uses polling (fewer file descriptors; avoids **EMFILE** on large trees). Set `false` for native `fs.watch` on small repos. |
| `CODEBASE_MCP_POLL_MS` | `2000` | Polling interval when polling is enabled |
| `CODEBASE_MCP_FORCE_INCLUDE` | _(empty)_ | Comma- or newline-separated **repo-relative** POSIX paths (e.g. `generated/api,tmp/docs`) that are indexed **even if** matched by root `.gitignore`. Lets you avoid `!` negation rules in `.gitignore`. Does **not** override hard safety skips (`.git/`, `node_modules/`, `.env*`, key material, etc.). Also overrides watcher segment skips (`dist/`, `build/`, …) when the path is on the way to or inside a listed entry. |
| `CODEBASE_MCP_NO_DAEMON` | _(unset)_ | If `1`/`true`/`yes`, run watcher + indexer + MCP in **one** Node process (no shared daemon). |

Lower-CPU, less code-aware alternative (previous default):

```bash
export CODEBASE_MCP_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
export CODEBASE_MCP_EMBEDDING_DIM=384
```

Large repos: native recursive watching can hit **EMFILE: too many open files**; polling is the default. You can also raise the process limit (e.g. `ulimit -n 10240`).

Index data lives next to this tool (`db/` is gitignored here), not inside the indexed repository.

## Cursor MCP config example

```json
{
  "mcpServers": {
    "codebase": {
      "command": "node",
      "args": ["/absolute/path/to/tools/codebase-mcp/dist/main.js"],
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
      "args": ["/absolute/path/to/tools/codebase-mcp/dist/main.js"],
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

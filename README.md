# codebase-mcp

_Cursor for Claude Code_

Local **semantic search** over a repository: 
- watches files (with `.gitignore` + safety rules)
- chunks text and embeds with **`@xenova/transformers`** (no paid API) 
- stores vectors in **LanceDB** under **`<repo>/.claude/codebase_mcp/db/`**
- and exposes **MCP tools** for agents.


Architecture: (diagrams, subsystems, IPC, storage) see [`docs/architecture/README.md`](docs/architecture/README.md).
License: (Apache-2.0) see [`LICENSE`](LICENSE).

# Quickstart

1. **Install the package**

```bash
npm install -g @tr4n2uil/codebase-mcp@latest
```

2. **Start the indexer from the repository you want to index** — `cd` into that repo, then start the daemon

```bash
cd /path/to/your/code/repo
codebase-mcp-daemon
```

3. **Wait** for the initial full scan to finish, then keep the process running so new edits are indexed

```
[codebase-mcp] [bootstrap] initial full scan queue finished (indexer may still be embedding)
```

4. **Register the MCP in Claude Code** — from the same repo, run the install helper

```bash
cd /path/to/your/code/repo
codebase-mcp-install-claude
```

_Copy mcp config from `~/.claude.json` to `claude_desktop_config.json` if you're using the Desktop App_

5. **Restart** Claude, then try exploratory questions

```text
how does auth work?
how is logger configured?
is there feature flag integrated?
```

## Prerequisites

- **Node.js 18+**
- For CLI/daemon, **`CODEBASE_MCP_ROOT` defaults to the current working directory** if unset; set it to an absolute path when the process is not started from the repo (typical in IDE MCP `env` blocks), or to index a different tree than your cwd.

## MCP tools

| Tool | Description |
|------|-------------|
| `codebase_search` | Semantic search (`query`, optional `limit`, `path_prefix`, optional `include_docs` to keep working-doc paths in **unscoped** search, `ext` / `lang` / `glob`); `path_prefix` scopes a subtree. Response JSON includes optional match-quality fields (see `CODEBASE_MCP_MATCH_CONFIDENCE`) |
| `codebase_find` | Alias of `codebase_search` with the same arguments and behavior (added for discoverability by code-search-oriented agents) |
| `codebase_stats` | Chunk count, indexed file count, model, last scan time |
| `codebase_reindex` | Optional `path` to reindex one file; omit for full **reconcile** |

## Configuration (optional)

All variables are read from `process.env` via `loadConfig()` in **each** Node process. Use the **Applies to** column: **MCP** = the stdio `codebase-mcp` process; **Daemon** = `codebase-mcp-daemon` (watcher + indexer + IPC writer); **Both** = set to the same values in MCP and daemon when you run them separately (so paths, model, and embedding options stay consistent). Variables marked **Daemon** have **no effect on search** if you set them only in the Cursor MCP `env` block; put them in the environment where the **daemon** runs (or use **`CODEBASE_MCP_NO_DAEMON=1`** so one process does everything and one `env` block covers indexing + search).

| Variable | Default | Applies to | Purpose |
|----------|---------|------------|---------|
| `CODEBASE_MCP_ROOT` | `process.cwd()` when unset | **Both** | Absolute repo root. When unset, **each** process uses its **current working directory** at `loadConfig()` (so `cd` into the repo is enough for CLI; set explicitly for MCP/IDE if cwd is not the project). Must match between MCP and daemon. |
| `CODEBASE_MCP_INDEX_DIR` | `<CODEBASE_MCP_ROOT>/.claude/codebase_mcp/db` | **Both** | Where LanceDB + `meta.json` live (default: under the repo’s `.claude/` tree). Must match between MCP and daemon. Override for a custom path or CI cache. |
| `CODEBASE_MCP_EMBEDDING_MODEL` | `Xenova/jina-embeddings-v2-base-en` | **Both** | Model id. Must match stored index metadata; used for **query** embed (MCP) and **ingest** embed (daemon). |
| `CODEBASE_MCP_EMBEDDING_DIM` | `768` | **Both** | Vector dimension; must match model and index. |
| `CODEBASE_MCP_EMBED_BACKEND` | `local` | **Both** | Embedding backend: `local` = Transformers.js ONNX in-process (default), `http` = external embedding service (TEI/Python/vLLM style). |
| `CODEBASE_MCP_EMBED_HTTP_URL` | _(unset)_ | **Both** | Required when `CODEBASE_MCP_EMBED_BACKEND=http`: POST endpoint that returns embeddings for batched input text. |
| `CODEBASE_MCP_EMBED_HTTP_API_KEY` | _(unset)_ | **Both** | Optional bearer token sent as `Authorization: Bearer ...` for the HTTP embedding backend. |
| `CODEBASE_MCP_EMBED_BATCH_SIZE` | `4` | **Both** | Chunks (daemon) or batching behavior when embedding; query path uses batches too. |
| `CODEBASE_MCP_EMBED_INFER_LOG_MS` | `20000` | **Both** | Heartbeat while ONNX runs (`0` = off). |
| `CODEBASE_MCP_EMBED_DEF_TAG` | `true` | **Daemon** | When `1`/`true` (default), the indexer includes `def=…` in the text passed to the embedder. Set `0`/`false` for rerank-only: `definition_of` stays in Lance but vectors omit the definition label (re-embed to apply either way). |
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
| `CODEBASE_MCP_DEF_ENGINE` | `auto` | **Daemon** | How to find declaration boundaries: `auto` / `tree_sitter` = native **tree-sitter** (TS/JS, Python, Ruby, Go, Java, Rust) merged with line-regex on non-overlapping lines; `regex` = line heuristics only (no `npm` native build required). If the `tree-sitter` native add-on fails to load, the indexer falls back to regex. **Reindex** after changes. `CODEBASE_MCP_RUBY_DEF_ENGINE=regex` is still honored as an alias for `regex`. |
| `CODEBASE_MCP_TREE_SITTER_MAX_BYTES` | `2097152` | **Daemon** | Do not run tree-sitter on a single file larger than this (bytes); use regex only for that file. |
| `CODEBASE_MCP_RERANK` | `true` | **MCP** | Rerank search hits (after hybrid) with lexical/path heuristics in `codebase_search`. |
| `CODEBASE_MCP_RERANK_CANDIDATES` | `100` | **MCP** | Candidate pool: fetch at least this many before rerank; also used as default for hybrid depth. |
| `CODEBASE_MCP_HYBRID` | `true` | **MCP** | **Hybrid search**: combine LanceDB **BM25** (FTS on chunk `text`) and **vector** kNN with **RRF** (Lance’s `RRFReranker`). The FTS index is built by the **indexing daemon** (or `NO_DAEMON`); pure MCP with an old DB and no index falls back to vector-only automatically. Set `0` to disable. |
| `CODEBASE_MCP_RRF_K` | `60` | **MCP** | RRF `k` parameter (Lance `RRFReranker.create(k)`). |
| `CODEBASE_MCP_HYBRID_DEPTH` | `max(100, RERANK_CANDIDATES)` | **MCP** | How many results to request per leg before RRF. Override for large candidate pools. |
| `CODEBASE_MCP_RERANK_DEMOTE_PATHS` | _(empty)_ | **MCP** | Comma- or newline-separated **substrings** of repo-relative paths (case-insensitive) that **lower rank** in the reranker (e.g. cassettes/specs) without removing them from the index. Example: `vcr_cassettes,spec/cassettes,__snapshots__`. |
| `CODEBASE_MCP_RERANK_DEMOTE_STRENGTH` | `0.1` | **MCP** | Per matching substring, subtracts from the path component of the rerank score (capped there). `0` disables the extra penalty (built-in heuristics like `codePathPrior` still apply). |
| `CODEBASE_MCP_RERANK_DEBUG_SCORES` | `false` | **MCP** | Expose `rerank_score` in search output. When cross-encoder is on, also exposes `cross_encoder_logit`. |
| `CODEBASE_MCP_CROSS_ENCODER` | `false` | **MCP** | `1`/`true`: after hybrid + heuristic rerank, re-order the top pool with a **cross-encoder** (default model `Xenova/bge-reranker-base`). Second ONNX model; first use may download weights. Improves top-1 quality at extra latency. |
| `CODEBASE_MCP_CROSS_ENCODER_MODEL` | `Xenova/bge-reranker-base` | **MCP** | Transformers.js–compatible cross-encoder id (ONNX on Hugging Face, e.g. **`Xenova/bge-reranker-base`**). |
| `CODEBASE_MCP_CROSS_ENCODER_TOP_K` | `50` | **MCP** | Score at most this many top candidates with the cross-encoder (capped by pool size; at least `limit`). |
| `CODEBASE_MCP_CROSS_ENCODER_BATCH` | `4` | **MCP** | Batch size for cross-encoder forward passes. |
| `CODEBASE_MCP_MATCH_CONFIDENCE` | `true` | **MCP** | When true, `codebase_search` JSON adds `match_confidence` (heuristic high / medium / low), `match_confidence_reasons`, `match_confidence_hint`, `top_primary_score`, and `top_relative_separation` so callers can tell weak or ambiguous top hits from a stronger single winner. Set `0` to omit. |
| `CODEBASE_MCP_MATCH_CONF_WEAK` | `0.35` if `CODEBASE_MCP_RERANK` is on, else `0.18` | **MCP** | Primary score (rerank or retriever) below this → `low` confidence. |
| `CODEBASE_MCP_MATCH_CONF_STRONG` | `0.55` (rerank on) or `0.4` (off) | **MCP** | Primary score at/above this can contribute to `high` (with enough top-1 vs top-2 gap). If ≤ weak, strong is raised to weak + 0.01. |
| `CODEBASE_MCP_MATCH_CONF_GAP` | `0.05` (rerank on) or `0.06` (off) | **MCP** | Minimum relative (top1−top2)/|top1| to treat the leader as “clear” for `high`. |
| `CODEBASE_MCP_MATCH_CONF_AMBIG_LIT` | `true` | **MCP** | When `high` would be returned, **downgrade to `medium`** for very short identifier-like queries (`CODEBASE_MCP_MATCH_CONFIDENCE` on). Adds `possible_ambiguous_literal_query` to reasons. Set `0` to skip. |
| `CODEBASE_MCP_MATCH_CONF_XDOMAIN_EXT` | `true` | **MCP** | When `high` would be returned, **downgrade to `medium`** if top-1 and top-2 paths are different *families* (e.g. `.rb` vs `.ts`/`.tsx`). Adds `top_hits_different_path_families`. Set `0` to skip. |
| `CODEBASE_MCP_DEF_BOOST` | `true` | **MCP** | When true, “definition-intent” queries (e.g. *where is `Foo` defined?*) boost chunks that **declare** that symbol (heuristic, code-aware indexing). Set `0` to disable. |
| `CODEBASE_MCP_DEF_STRENGTH` | `0.18` | **MCP** | Additive rerank “path prior” for matching `definition_of` (clamped 0–0.5; `0` = no extra boost). |
| `CODEBASE_MCP_TEST_PATH_QUERY_BOOST` | `true` | **MCP** | When the query looks test/spec–oriented (e.g. *spec*, *RSpec*, *Jest*), **boost** `spec/`, `test/`, `__tests__` in rerank instead of de-prioritizing them. Set `0` to always use the legacy demotion for those paths. |
| `CODEBASE_MCP_FRONTEND_PATH_QUERY_BOOST` | `true` | **MCP** | When the query looks UI/React/TS–oriented, **boost** common frontend paths (e.g. `.tsx`, `components/`, `app/javascript/`). Set `0` to disable. |
| `CODEBASE_MCP_VERBOSE` | `true` | **Daemon** | Per-file indexer logs. |
| `CODEBASE_MCP_LOG_TOOLS` | `true` | **MCP** | Log each MCP tool invocation to stderr. |
| `CODEBASE_MCP_WORKING_DOCS_PATH` | `.claude/docs` | **Daemon** (list must **match the MCP** if you rely on `CODEBASE_MCP_SEARCH_EXCLUDE_FORCE_INCLUDE`; see that row) | Comma- or newline-separated **repo-relative** path prefixes indexed even if `.gitignore` would skip them. Default includes **`.claude/docs`**. Set to **`-`** or **`none`** to clear the list (no extra “working docs” include). Unscoped `codebase_search` **omits** hits under these paths (see `CODEBASE_MCP_SEARCH_EXCLUDE_FORCE_INCLUDE`); use `include_docs=true` to keep them in unscoped search, or `path_prefix` to only search a subtree. |
| `CODEBASE_MCP_INDEX_EXCLUDE` | _(empty)_ | **Daemon** | Comma- or newline-separated **gitignore-style** patterns (repo-relative POSIX) to **skip indexing** without editing `.gitignore`. Overrides `CODEBASE_MCP_WORKING_DOCS_PATH` on matches. **Restart the daemon** after changing. Example for VCR/WebMock: `spec/vcr_cassettes/**, **/cassettes/**, **/fixtures/cassettes/**`. |
| `CODEBASE_MCP_SEARCH_EXCLUDE_FORCE_INCLUDE` | `true` | **MCP** | When `true` (default), unscoped `codebase_search` **excludes** chunks under paths in `CODEBASE_MCP_WORKING_DOCS_PATH` (so plans/docs trees do not crowd generic code queries). Chunks are still indexed. Set a non-empty `path_prefix` that **covers** that tree to search it (e.g. `.claude/docs`). The MCP process must use the **same** `CODEBASE_MCP_WORKING_DOCS_PATH` as the daemon (or both defaults) so the exclusion set matches. Set `0` to include those paths in unscoped search. |
| `CODEBASE_MCP_NO_DAEMON` | _(unset)_ | **MCP** | If `1`/`true`/`yes`, run watcher + indexer + MCP in **one** process (no separate daemon). |

`CODEBASE_MCP_WORKING_DOCS_PATH` **replaces** the former `CODEBASE_MCP_FORCE_INCLUDE`; the old variable is no longer read. Rename it in your daemon and MCP (if applicable) when upgrading.

Lower-CPU, less code-aware alternative (previous default):

```bash
export CODEBASE_MCP_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
export CODEBASE_MCP_EMBEDDING_DIM=384
```

When changing embedding model/dimension or code-aware chunking behavior, use a fresh `CODEBASE_MCP_INDEX_DIR` (or reindex) to avoid mixing old and new vector/chunk layouts.

Note: model ids must be compatible with the local Transformers.js ONNX loader. Some upstream HF repos (for example `jinaai/jina-embeddings-v3`) do not expose the expected ONNX artifacts for this runtime; in those cases use a supported Xenova-compatible model id.

HTTP embedding backend format notes (`CODEBASE_MCP_EMBED_BACKEND=http`):
- Request body: `{ "input": ["text1", "text2"], "model": "<CODEBASE_MCP_EMBEDDING_MODEL>" }`
- Accepted response formats:
  - OpenAI-style: `{ "data": [{ "embedding": [...] }, ...] }`
  - Simple: `{ "embeddings": [[...], ...] }`
  - Raw list: `[[...], ...]`

Run a local HTTP embedding server (default model: `BAAI/bge-large-en-v1.5`):

```bash
./scripts/codebase-mcp-embed-server.py
```

The script auto-installs Python deps (`fastapi`, `uvicorn`, `sentence-transformers`, `einops`) via `pip` when missing.
On macOS/Homebrew Python (PEP 668), it auto-creates and reuses a virtualenv at `~/.cache/codebase-mcp-embed-server/venv` (override with `EMBED_VENV_DIR`; disable with `EMBED_USE_VENV=0`).

Optional server env:
- `EMBED_MODEL` (default: `BAAI/bge-large-en-v1.5`)
- `EMBED_DEVICE` (default: `cpu`)
- `EMBED_HOST` (default: `127.0.0.1`)
- `EMBED_PORT` (default: `8080`)
- `EMBED_TRUST_REMOTE_CODE` (default: `1`; safe to leave on; some custom-code models require it)

Then point codebase-mcp at it:

```bash
export CODEBASE_MCP_EMBED_BACKEND=http
export CODEBASE_MCP_EMBED_HTTP_URL=http://127.0.0.1:8080/v1/embeddings
export CODEBASE_MCP_EMBEDDING_MODEL=BAAI/bge-large-en-v1.5
export CODEBASE_MCP_EMBEDDING_DIM=1024
```

**Definition boost:** run the **indexer/daemon** at least once (or `codebase_reindex`) so LanceDB has the `definition_of` column and chunks are indexed with code-aware metadata. Rerank uses `definition_of` for *where is X defined?* when `CODEBASE_MCP_DEF_BOOST` is on. By default, embeddings **include** `def=` in the embed prefix (`CODEBASE_MCP_EMBED_DEF_TAG`); set **`CODEBASE_MCP_EMBED_DEF_TAG=0`** to omit it and re-embed. Until `definition_of` is populated, search still works; definition boosting has no effect.

Large repos: native recursive watching can hit **EMFILE: too many open files**; polling is the default. You can also raise the process limit (e.g. `ulimit -n 10240`).

Index data lives next to this tool (`db/` is gitignored here), not inside the indexed repository.

## Cursor MCP config example

The `env` object applies to the **MCP** process only. Set **`CODEBASE_MCP_ROOT`** to the repo (recommended for editors where the stdio process cwd may not be the project; when omitted, each process uses **`process.cwd()`** at startup). Override **`CODEBASE_MCP_INDEX_DIR`** if needed. **Indexing** options such as **`CODEBASE_MCP_WORKING_DOCS_PATH`** must be set on the **daemon** (see *Start the daemon* above), not here, unless you use **`CODEBASE_MCP_NO_DAEMON=1`**. If you customize `CODEBASE_MCP_WORKING_DOCS_PATH`, set the **same value on the MCP** as well so `CODEBASE_MCP_SEARCH_EXCLUDE_FORCE_INCLUDE` applies to the right paths.

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

**Daemon** (separate terminal), same index — example including working-docs paths for gitignored trees:

```bash
export CODEBASE_MCP_ROOT=/absolute/path/to/your/repo
export CODEBASE_MCP_WORKING_DOCS_PATH="path/inside/gitignored/tree"
npx -y -p @tr4n2uil/codebase-mcp@latest -- codebase-mcp-daemon
```

## Claude Code MCP config example

Same as Cursor: MCP `env` is for the stdio server; put **`CODEBASE_MCP_WORKING_DOCS_PATH`** (and other **Daemon** rows from the table) on the **daemon** process.

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

## Design

See `docs/local_codebase_vector_mcp_brainstorm.md` in this package. For **roadmap** (chunking, rerank, confidence), **semantic search vs grep**, and the **definition vs usage** gap, see [`docs/plan/code-aware-retrieval.md`](docs/plan/code-aware-retrieval.md).

# Developers

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

**Trigger reindex from the shell** (daemon must already be running; same `CODEBASE_MCP_ROOT`):

```bash
export CODEBASE_MCP_ROOT=/absolute/path/to/your/repo
npx -y -p @tr4n2uil/codebase-mcp@latest -- codebase-mcp-reindex          # full reconcile
npx -y -p @tr4n2uil/codebase-mcp@latest -- codebase-mcp-reindex path/to/file.ts
```

From a local clone of this repo (after `npm run build`):

```bash
export CODEBASE_MCP_ROOT=/absolute/path/to/your/repo
npm run daemon
# or: node dist/main.js --daemon
```

With the daemon running, from another shell: `npm run reindex` (full reconcile) or `npm run reindex -- path/to/file.ts`.

Set **`CODEBASE_MCP_NO_DAEMON=1`** to restore the previous behavior (watcher + MCP in one process), e.g. for debugging.

**Logs:** stderr is mirrored to **`<CODEBASE_MCP_INDEX_DIR>/.logs/mcp.log`** (MCP / stdio process) or **`.logs/daemon.log`** (`--daemon` indexer). All lines in those files are prefixed with **`[pid=…] `** so multiple processes and restarts are easy to follow. (Default index dir: **`<repo>/.claude/codebase_mcp/db`** — add `.claude/` to `.gitignore` if you do not want the index in version control.) Use this to confirm indexing when the daemon was started detached.

First run downloads the embedding model (cached by Transformers.js, see `HF_HOME` / `XDG_CACHE_HOME`).

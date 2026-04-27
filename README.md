# codebase-mcp

_Cursor for Claude Code_

Local **semantic search** over a repository: watches files (with `.gitignore` + safety rules; by default **`CODEBASE_MCP_FORCE_INCLUDE`** includes **`.claude/docs`** so that tree can be indexed even if gitignored), chunks text, embeds with **`@xenova/transformers`** (no paid API), stores vectors in **LanceDB** under **`<repo>/.claude/codebase_mcp/db/`** by default (override with **`CODEBASE_MCP_INDEX_DIR`**), and exposes **MCP tools** for agents.

**Architecture** (diagrams, subsystems, IPC, storage): see **[`docs/architecture/README.md`](docs/architecture/README.md)**.

# Quickstart

1. Install package
```bash
mkdir -p ~/.mcp/ && cd ~/.mcp
npm install @tr4n2uil/codebase-mcp@latest
```

2. Run indexer for your codebase
```bash
CODEBASE_MCP_ROOT=/absolute/path/to/code/repo npmx -y -p @tr4n2uil/codebase-mcp@latest -- codebase-mcp-daemon
```

3. Wait for initial indexing to finish
```
[codebase-mcp] [bootstrap] initial full scan queue finished (indexer may still be embedding)
```
_Keep indexer running to ensure any codebase changes are always indexed_

4. Configure MCP on claude code
```bash
claude mcp list
claude mcp add codebase_mcp -e CODEBASE_MCP_ROOT=/absolute/path/to/code/repo -- node $HOME/.mcp/node_modules/@tr4n2uil/codebase_mcp/dist/main.js
```

4. Restart Claude 
_And ask exploratory queries and see the magic!_
```
how does auth work? 
how is logger configured?
is there feature flag integrated?
```

## Prerequisites

- **Node.js 18+**
- Env **`CODEBASE_MCP_ROOT`**: absolute path to the repository root to index.

## MCP tools

| Tool | Description |
|------|-------------|
| `codebase_search` | Semantic search (`query`, optional `limit`, `path_prefix`); response JSON includes optional match-quality fields (see `CODEBASE_MCP_MATCH_CONFIDENCE`) |
| `codebase_stats` | Chunk count, indexed file count, model, last scan time |
| `codebase_reindex` | Optional `path` to reindex one file; omit for full **reconcile** |

## Configuration (optional)

All variables are read from `process.env` via `loadConfig()` in **each** Node process. Use the **Applies to** column: **MCP** = the stdio `codebase-mcp` process; **Daemon** = `codebase-mcp-daemon` (watcher + indexer + IPC writer); **Both** = set to the same values in MCP and daemon when you run them separately (so paths, model, and embedding options stay consistent). Variables marked **Daemon** have **no effect on search** if you set them only in the Cursor MCP `env` block; put them in the environment where the **daemon** runs (or use **`CODEBASE_MCP_NO_DAEMON=1`** so one process does everything and one `env` block covers indexing + search).

| Variable | Default | Applies to | Purpose |
|----------|---------|------------|---------|
| `CODEBASE_MCP_ROOT` | _(required)_ | **Both** | Repo root. Must match between MCP and daemon. |
| `CODEBASE_MCP_INDEX_DIR` | `<CODEBASE_MCP_ROOT>/.claude/codebase_mcp/db` | **Both** | Where LanceDB + `meta.json` live (default: under the repo’s `.claude/` tree). Must match between MCP and daemon. Override for a custom path or CI cache. |
| `CODEBASE_MCP_EMBEDDING_MODEL` | `Xenova/jina-embeddings-v2-base-en` | **Both** | Model id. Must match stored index metadata; used for **query** embed (MCP) and **ingest** embed (daemon). |
| `CODEBASE_MCP_EMBEDDING_DIM` | `768` | **Both** | Vector dimension; must match model and index. |
| `CODEBASE_MCP_EMBED_BATCH_SIZE` | `4` | **Both** | Chunks (daemon) or batching behavior when embedding; query path uses batches too. |
| `CODEBASE_MCP_EMBED_INFER_LOG_MS` | `20000` | **Both** | Heartbeat while ONNX runs (`0` = off). |
| `CODEBASE_MCP_EMBED_DEF_TAG` | `false` | **Daemon** | When `1`/`true`, the indexer includes `def=…` in the text passed to the embedder (re-embed to apply). Default `false` (**V1**): `definition_of` is only in Lance and used for definition-intent **rerank** — vectors are not steered by the definition label. Set when you want **V2** (definition signal in the embedding as well). |
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
| `CODEBASE_MCP_RUBY_DEF_ENGINE` | `auto` | **Daemon** | Ruby declarations: `auto` (MRI **Ripper** via `ruby` + `scripts/ripper_definitions.rb` when available, else regex), `ripper` (always try Ripper; fall back to regex on error), `regex` (line patterns only). **Reindex** after changes. |
| `CODEBASE_MCP_RUBY` | `ruby` | **Daemon** | Ruby executable for Ripper (path to `ruby`). |
| `CODEBASE_MCP_RUBY_RIPPER_MAX_BYTES` | `524288` | **Daemon** | Skip Ripper for `.rb` / `.rake` / `.rbi` sources larger than this (use regex only). |
| `CODEBASE_MCP_RUBY_RIPPER_TIMEOUT_MS` | `10000` | **Daemon** | Wall-clock timeout per file for the Ripper subprocess. |
| `CODEBASE_MCP_RERANK` | `true` | **MCP** | Rerank search hits (after hybrid) with lexical/path heuristics in `codebase_search`. |
| `CODEBASE_MCP_RERANK_CANDIDATES` | `100` | **MCP** | Candidate pool: fetch at least this many before rerank; also used as default for hybrid depth. |
| `CODEBASE_MCP_HYBRID` | `true` | **MCP** | **Hybrid search**: combine LanceDB **BM25** (FTS on chunk `text`) and **vector** kNN with **RRF** (Lance’s `RRFReranker`). The FTS index is built by the **indexing daemon** (or `NO_DAEMON`); pure MCP with an old DB and no index falls back to vector-only automatically. Set `0` to disable. |
| `CODEBASE_MCP_RRF_K` | `60` | **MCP** | RRF `k` parameter (Lance `RRFReranker.create(k)`). |
| `CODEBASE_MCP_HYBRID_DEPTH` | `max(100, RERANK_CANDIDATES)` | **MCP** | How many results to request per leg before RRF. Override for large candidate pools. |
| `CODEBASE_MCP_RERANK_DEMOTE_PATHS` | _(empty)_ | **MCP** | Comma- or newline-separated **substrings** of repo-relative paths (case-insensitive) that **lower rank** in the reranker (e.g. cassettes/specs) without removing them from the index. Example: `vcr_cassettes,spec/cassettes,__snapshots__`. |
| `CODEBASE_MCP_RERANK_DEMOTE_STRENGTH` | `0.1` | **MCP** | Per matching substring, subtracts from the path component of the rerank score (capped there). `0` disables the extra penalty (built-in heuristics like `codePathPrior` still apply). |
| `CODEBASE_MCP_RERANK_DEBUG_SCORES` | `false` | **MCP** | Expose `rerank_score` in search output. |
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
| `CODEBASE_MCP_FORCE_INCLUDE` | `.claude/docs` | **Daemon** | Comma- or newline-separated **repo-relative** paths indexed even if `.gitignore` would skip them. Default alone includes **`.claude/docs`**. Set to **`-`** or **`none`** to clear the list (no extra includes). **Not used for search**; set on the **daemon** env (or the single process when `CODEBASE_MCP_NO_DAEMON=1`). |
| `CODEBASE_MCP_INDEX_EXCLUDE` | _(empty)_ | **Daemon** | Comma- or newline-separated **gitignore-style** patterns (repo-relative POSIX) to **skip indexing** without editing `.gitignore`. Overrides `CODEBASE_MCP_FORCE_INCLUDE` on matches. **Restart the daemon** after changing. Example for VCR/WebMock: `spec/vcr_cassettes/**, **/cassettes/**, **/fixtures/cassettes/**`. |
| `CODEBASE_MCP_NO_DAEMON` | _(unset)_ | **MCP** | If `1`/`true`/`yes`, run watcher + indexer + MCP in **one** process (no separate daemon). |

Lower-CPU, less code-aware alternative (previous default):

```bash
export CODEBASE_MCP_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
export CODEBASE_MCP_EMBEDDING_DIM=384
```

When changing embedding model/dimension or code-aware chunking behavior, use a fresh `CODEBASE_MCP_INDEX_DIR` (or reindex) to avoid mixing old and new vector/chunk layouts.

**Definition boost (V1 default):** run the **indexer/daemon** at least once (or `codebase_reindex`) so LanceDB has the `definition_of` column and chunks are indexed with code-aware metadata. Rerank uses `definition_of` for *where is X defined?* when `CODEBASE_MCP_DEF_BOOST` is on. Embeddings do **not** include `def=` unless you set **`CODEBASE_MCP_EMBED_DEF_TAG=1`** and re-embed (V2). Until `definition_of` is populated, search still works; definition boosting has no effect.

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

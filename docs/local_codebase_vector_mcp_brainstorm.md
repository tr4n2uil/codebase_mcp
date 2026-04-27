# Local codebase embeddings + MCP server

**Status:** v1 implemented under `codebase_mcp/` (indexing + MCP + **shared daemon** for multi-session hosts).

## Goal

- **Local vector storage** for code (and optionally docs) under a configurable root directory.
- **Incremental indexing:** watch the tree, embed only added/changed files, remove deleted paths.
- **Respect `.gitignore`** (and optionally nested `.gitignore` files) so build artifacts and secrets are not embedded.
- **MCP server** exposing search (and minimal ops) so any MCP-capable agent can query the index.

**Constraints (priority order)**

1. **No paid embedding APIs** — $0 recurring cost is the top requirement → use **local embeddings** via **`@xenova/transformers`** in Node (v1 runtime); not OpenAI or other metered APIs, unless you explicitly opt in later.
2. “Free” still uses **local CPU/GPU/RAM** and disk for models; that’s the tradeoff vs cloud APIs.

## High-level architecture

1. **Watcher** — filesystem events (debounced) + periodic full reconcile (safety net for missed events).
2. **Path filter** — resolve ignore rules: parse `.gitignore` at root (and per-directory rules if using a proper parser), apply to candidate paths.
3. **Chunker** — split file contents into chunks (by line windows with overlap; language-aware optional later).
4. **Embedder** — **`@xenova/transformers`** (ONNX Runtime in Node) for **local** open-source embedding models; batch for throughput. Optional paid API could exist behind a flag later, but not as the default path.
5. **Vector store** — persistent local DB **per watch root (per repo checkout)** — see **Index storage** below; metadata includes path, chunk index, mtime/hash, optional language.
6. **MCP layer** — **stdio** transport to the host; tool calls are served by a **thin Node process** that delegates indexing and search to a **long-lived indexing daemon** when daemon mode is on (default). See **Process model: shared indexing daemon** below.

## Process model: shared indexing daemon (v1)

**Problem:** Each MCP session historically spawned a full Node process with its own **watcher**, **reconcile loop**, and **embedding stack** → duplicated CPU, RAM, and file descriptors.

**Default (daemon mode):** Running `dist/main.js` **without** `--daemon` starts an **MCP stdio client** only. It:

1. Resolves config from **`CODEBASE_MCP_ROOT`** / **`CODEBASE_MCP_INDEX_DIR`** (same as the daemon).
2. **Pings** the daemon on a transport keyed by the index directory:
   - **Unix:** socket at **`.codebase-mcp-daemon/socket`**
   - **Windows:** named pipe **`\\.\pipe\codebase-mcp-<sha256(indexDir)>`** (short hash prefix)
3. If nothing answers: acquires **`spawn.lock`** under **`.codebase-mcp-daemon/`**, optionally removes a **stale Unix socket**, then **`spawn`s** `node dist/main.js --daemon` **detached** (`stdio: 'ignore'` for the child), waits until **ping** succeeds, then connects.
4. Serves MCP tools by sending **NDJSON** requests over that connection (`ping`, `search`, `stats`, `reindex`) and returning results. **Embeddings for search** run inside the daemon so the model is not loaded per MCP session.

**Daemon process (`node dist/main.js --daemon`):** Owns exactly one indexing pipeline per **`CODEBASE_MCP_INDEX_DIR`**:

- **Bootstrap:** `meta.json`, LanceDB, `Indexer`, root `.gitignore`, **chokidar** watcher, initial **fullScan**.
- **Periodic reconcile** on **`CODEBASE_MCP_RECONCILE_MS`** (same as pre-daemon design).
- **`net.Server`** on the socket/pipe above; per-connection **serialized** line handling so NDJSON responses do not interleave.
- **Shutdown:** SIGINT/SIGTERM closes IPC server and watcher.

**Inline mode (debug / single process):** Set **`CODEBASE_MCP_NO_DAEMON=1`** (or `true` / `yes`). One process runs **watcher + indexer + stdio MCP** together (legacy shape).

**Logs:** Each process tees **stderr** to **`codebase_mcp/.logs/<pid>`** (under the package; gitignored) while still writing to the real stderr when attached—useful because an auto-spawned daemon’s stderr is otherwise discarded.

**Scope:** One daemon instance per **index directory**; different **`CODEBASE_MCP_INDEX_DIR`** values get independent daemons and sockets.

## Implementation stack (recommended options)

| Layer | Option A (simple, fast to ship) | Option B (Python ecosystem) | Option C (minimal deps) |
|-------|----------------------------------|-------------------------------|-------------------------|
| Language | TypeScript + `chokidar` | Python + `watchfiles` | Rust (heavier) |
| Vector DB | **LanceDB** or **Chroma** (local persist) | Same | `sqlite-vec` |
| Embeddings (default) | `@xenova/transformers` (local) | `sentence-transformers` (local) | Same — avoid paid APIs for default |
| `.gitignore` | `ignore` npm package | `pathspec` or `gitignore-parser` | shell out to `git check-ignore` |

**v1 stack (decided):** **TypeScript** — `@modelcontextprotocol/sdk`, **`@xenova/transformers`** (local embeddings), **`chokidar`** (watch), **`ignore`** (gitignore), **LanceDB** or **Chroma** JS client for per-repo persist under **`codebase_mcp/db/<basename>/`** (default).

**Alternative later:** **Python** (`sentence-transformers`, `watchfiles`, `mcp` SDK) if we ever need to switch runtimes—same product shape.

## `.gitignore` behavior

- Load `<root>/.gitignore` first; optionally walk and merge **nested** `.gitignore` files (Git semantics: rules apply relative to the file’s directory).
- Always add **safety ignores** even if not in `.gitignore`: e.g. `.git/`, common binary extensions, very large files (size cap).
- Use **path normalization** relative to watch root; compare with POSIX-style paths for consistency on disk.

## Change detection

- Store per path: `content_hash` (SHA256 of normalized text) or `(size, mtime)` as a fast filter with hash confirmation.
- On change: re-chunk only that file, delete old vectors for that `path` in the store, insert new rows.
- On delete/unignore: delete by path prefix or exact path.

## Chunking strategy (recommended)

- **Ship v1 with fixed line windows** — e.g. 40–80 lines per chunk with **10–15 lines overlap**. Tunable constants; works for code, markdown, and config without parsers.
- **Why first:** trivial to implement and test, **no per-language grammars**, tolerates **syntax errors** and non-code files; good enough for semantic search over a repo.
- **Defer tree-sitter (or similar)** until v1 shows pain — e.g. huge files where mid-function splits hurt recall, or you need **symbol-aligned** chunks. That path adds **grammar deps**, **parse failures**, and more moving parts.

## Index storage (decision)

- **Per watch root, but not inside the indexed repo:** default path is **`codebase_mcp/db/<repo_basename>/`** (next to the MCP package), with **`db/`** gitignored in `codebase_mcp/`. Keeps the indexed repository clean.
- **Basename collisions** (two different paths ending with the same folder name): set **`CODEBASE_MCP_INDEX_DIR`** to a unique absolute path.
- **Optional env override** (`CODEBASE_MCP_INDEX_DIR`) for CI cache, separate disk, or disambiguation.

## Periodic / batch saving

- **Debounced flush:** after N seconds of quiet or M files pending, embed and write.
- **Timer:** every T minutes run a lightweight scan (stat walk of tracked extensions) to catch missed events.
- **Graceful shutdown:** flush queue on SIGINT/SIGTERM.

## MCP tools (minimal useful set)

| Tool | Purpose |
|------|---------|
| `codebase_search` | Args: `query` (string), optional `limit`, optional `path_prefix`. Returns chunks with path, line range, score, snippet. |
| `codebase_stats` | Returns indexed file count, chunk count, root path, last full sync time. |
| `codebase_reindex` | Optional `path` to schedule one file; omit for full **reconcile** (same behavior via daemon IPC or inline backend). |

Optional resources: `codebase://manifest` listing top-level indexed paths (keep small).

## Security and ops notes

- **Secrets:** never index files that might contain keys; extend ignore list (e.g. `*.pem`, `.env`).
- **Multi-root:** prefer **one MCP server / one store per watch root** (per-repo index path); avoid a single global DB unless a future mode explicitly namespaces many roots.
- **Model choice:** document dimension and embedding model id in store metadata; **reindex required** if model changes.

## Testing strategy

- Unit tests for gitignore matching (fixtures with nested rules).
- Integration test: temp dir, write files, wait for index, query and assert top hit.

## Decisions

- [x] **Language/runtime:** **TypeScript (Node)** for v1 — local embeddings via **`@xenova/transformers`** (satisfies free/local constraint); Python remains a documented alternative if needed later.
- [x] **Embeddings:** **local / free** — **`@xenova/transformers`** as default embedder; paid API only as optional opt-in if ever needed.
- [x] **Chunking:** **fixed overlapping lines for v1**; tree-sitter only if v1 retrieval is insufficient (see **Chunking strategy** above).
- [x] **Index location:** **per-repo** — default **`codebase_mcp/db/<basename>/`**; optional `CODEBASE_MCP_INDEX_DIR`; see **Index storage**.
- [x] **Multi-session hosts:** **shared indexing daemon** per `CODEBASE_MCP_INDEX_DIR`; stdio MCP processes are thin clients; **`CODEBASE_MCP_NO_DAEMON`** restores single-process mode; **`--daemon`** runs the long-lived indexer explicitly.

## Related paths (when implementing)

- **This package:** shipped as **`codebase_mcp/`** in the monorepo (see package `README.md` and source under `src/`).

## Next step

- Optional: HTTP MCP transport, richer progress events for long indexes, nested `.gitignore` parity, language-aware chunking if v1 retrieval is insufficient.

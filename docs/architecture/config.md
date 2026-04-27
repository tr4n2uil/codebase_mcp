# Configuration (cross-cutting)

All tunables are read in **`loadConfig()`** in `config.ts` from `process.env`. The **authoritative table** of variables, defaults, and **which process must see them (MCP vs daemon vs both)** is in the root **[README](../../README.md#optional-environment)**.

This page groups them by **subsystem** for architecture readers.

## Subsystem → env (representative)

| Subsystem | Variables |
|-----------|-----------|
| **Roots & storage** | `CODEBASE_MCP_ROOT` (required), `CODEBASE_MCP_INDEX_DIR` |
| **Git / includes / excludes** | `CODEBASE_MCP_FORCE_INCLUDE`, `CODEBASE_MCP_INDEX_EXCLUDE` (daemon) |
| **Chunking** | `CODEBASE_MCP_CHUNK_*`, `CODEBASE_MCP_CODE_AWARE_CHUNKING`, `CODEBASE_MCP_RUBY_DEF_ENGINE` / `CODEBASE_MCP_RUBY` / `CODEBASE_MCP_RUBY_RIPPER_*` (Ruby Ripper; daemon), `CODEBASE_MCP_MAX_FILE_BYTES` (daemon) |
| **Embeddings** | `CODEBASE_MCP_EMBEDDING_*`, `CODEBASE_MCP_EMBED_*` (incl. `EMBED_DEF_TAG`: optional `def=` in embed prefix; default off), all `CODEBASE_MCP_ORT_*` (both for consistency) |
| **Search** | `CODEBASE_MCP_RERANK*`, `CODEBASE_MCP_RERANK_DEMOTE_PATHS` / `..._DEMOTE_STRENGTH`, `CODEBASE_MCP_HYBRID`, `CODEBASE_MCP_RRF_K`, `CODEBASE_MCP_HYBRID_DEPTH`, `CODEBASE_MCP_DEF_BOOST`, `CODEBASE_MCP_DEF_STRENGTH`, `CODEBASE_MCP_TEST_PATH_QUERY_BOOST`, `CODEBASE_MCP_FRONTEND_PATH_QUERY_BOOST`, `CODEBASE_MCP_MATCH_CONFIDENCE` / `CODEBASE_MCP_MATCH_CONF_*` (incl. `MATCH_CONF_AMBIG_LIT`, `MATCH_CONF_XDOMAIN_EXT`) (MCP; see README) |
| **Watcher** | `CODEBASE_MCP_USE_POLLING`, `CODEBASE_MCP_POLL_MS` (daemon) |
| **Reconcile** | `CODEBASE_MCP_RECONCILE_MS` (daemon) |
| **Process model** | `CODEBASE_MCP_NO_DAEMON` (MCP) — inline indexer + tools |
| **Logging** | `CODEBASE_MCP_VERBOSE`, `CODEBASE_MCP_LOG_TOOLS` |

## Consistency rule

For **default** (split MCP + daemon), set **`CODEBASE_MCP_ROOT`** and, if overridden, **`CODEBASE_MCP_INDEX_DIR`** and embedding-related vars **the same** in both environments. Otherwise, query vectors and stored vectors can disagree, or reindex and search can target different trees.

## Related code

- `config.ts` — `loadConfig()`, `AppConfig`
- `README.md` — User-facing table and Cursor examples

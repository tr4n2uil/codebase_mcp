# Code-aware retrieval: roadmap & implementation status

High-ROI improvements for **semantic search over code** (same embedding model can still benefit). Status is for the **current `codebase_mcp` codebase**; update this file when behavior changes.

| Initiative | ROI (expected) | Status | Implementation notes |
|------------|----------------|--------|----------------------|
| **Chunking** — structure-aware splits, symbol + path in text | Biggest | **Partial** | **`src/chunker.ts`**: `chunkCodeAware()` uses **line-based windows** with **heuristic symbol lines** (regex) for JavaScript/TypeScript, Python, and a generic pass (e.g. `func`/`class`/`type`) — not full AST or tree-sitter boundaries. Large symbol spans are sub-split by line count. Fallback: `chunkByLines()`. Toggle: `CODEBASE_MCP_CODE_AWARE_CHUNKING` (default on). **`src/indexer.ts`** `embeddingTextForChunk()` prefixes each embedded string with **`path=…`**, optional **`lang=…`**, **`symbol=…`**, **`kind=…`** — explicit code context for the embedder. **Not done:** module/import graph chunking, parser-backed function/class boundaries only, dedicated “header + body” chunks. |
| **Reranking** — code-sensitive signals | Big | **Partial** | **`src/rerank.ts`** fuses the **fused** search score (hybrid) or **vector** score with **lexical** match, **exact token** match, **path** match, **symbol-style** token bonus, and **`codePathPrior`**. `CODEBASE_MCP_RERANK` / `CODEBASE_MCP_RERANK_CANDIDATES` (default **100**). **Not done:** import proximity, AST/signature overlap, learn-to-rank, cross-encoder. |
| **Hybrid retrieval** — BM25 + vectors + RRF | Big | **Done (LanceDB)** | **`src/store.ts`**: LanceDB **FTS on `text`** (BM25-ordered) + **`vectorSearch`** + native **`RRFReranker`** (RRF). FTS index is created in the **writer** (`ensureFtsIndex` after `init` and after `addRows` when new data exists). **MCP read-only** uses hybrid only if the index already exists (start the **daemon** / indexer once to build it). Toggles: `CODEBASE_MCP_HYBRID`, `CODEBASE_MCP_RRF_K`, `CODEBASE_MCP_HYBRID_DEPTH`. On failure, search falls back to **vector-only**. |
| **Query expansion** — NL → code aliases / symbol forms | Medium | **Not started** | Queries are embedded **as-is** in **`src/mcp-tools.ts`** / **`embedder.ts`**. No alias tables or expansion step. |
| **Path / language filtering** | Medium | **Partial** | **`codebase_search`** supports **`path_prefix`** (POSIX path under repo root) — see **`src/mcp.ts`**, applied in **`src/store.search()`** / **`mcp-tools.ts`**. Chunks store **`path`**; embedding tags include inferred **`lang`** from extension — **no** `language` or glob filter on the search tool (e.g. `*.ts` must be approximated via prefix or future work). **Related:** `CODEBASE_MCP_INDEX_EXCLUDE` (daemon) skips paths from the index, not a query-time filter. |

## Quick file map

- Chunking & embed text: `src/chunker.ts`, `src/indexer.ts` (`embeddingTextForChunk`)
- Vector retrieval: `src/store.ts`
- Search pipeline: `src/mcp-tools.ts` (`runCodebaseSearch`)
- Rerank: `src/rerank.ts`
- Tool API: `src/mcp.ts` (`path_prefix`, `limit`)
- Config: `src/config.ts` (e.g. `rerankCandidates`, `rerankEnabled`, `codeAwareChunking`, `indexExcludeRelPosix`)

For end-to-end architecture (processes, diagrams, hybrid search flow), see **[`docs/architecture/README.md`](../architecture/README.md)**.

## Suggested next steps (not committed)

1. **Chunking** — Optional **tree-sitter** (or similar) for top languages; keep line fallback for the long tail.
2. **Rerank** — Tighter **symbol/path** features or a **small cross-encoder** on the top K after fusion.
3. **Query** — Light expansion (synonyms, camelCase / snake_case flip) or a fixed **code** synonym list behind a flag.
4. **API** — Optional **`lang` / `ext`** or **glob** filter on `codebase_search` for monorepos (complements `path_prefix`).

---

_Last updated to reflect implementation as of the doc author pass; adjust rows when features land._

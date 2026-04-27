# Code-aware retrieval: roadmap & implementation status

High-ROI improvements for **semantic search over code** (same embedding model can still benefit). Status is for the **current `codebase_mcp` codebase**; update this file when behavior changes.

| Initiative | ROI (expected) | Status | Implementation notes |
|------------|----------------|--------|----------------------|
| **Chunking** — structure-aware splits, symbol + path in text | Biggest | **Partial** | **`src/chunker.ts`**: `chunkCodeAware()` uses **tree-sitter** declaration spans (supported langs) **merged** with line-regex, then line windows for long spans. Fallback: `chunkByLines()`. Toggle: `CODEBASE_MCP_CODE_AWARE_CHUNKING` (default on). See **`src/tree-sitter-definitions.ts`**, `CODEBASE_MCP_DEF_ENGINE`. **`src/indexer.ts`** `embeddingTextForChunk()` prefixes each embedded string with **`path=…`**, optional **`lang=…`**, **`symbol=…`**, **`kind=…`**; **`def=…`** by default (`CODEBASE_MCP_EMBED_DEF_TAG`; opt out with `0`). **Not done:** import-graph chunking, dedicated “header + body” chunks. |
| **Reranking** — code-sensitive signals | Big | **Partial** | **`src/rerank.ts`** fuses the **fused** search score (hybrid) or **vector** score with **lexical** match, **exact token** match, **path** match, **symbol-style** token bonus, and **`codePathPrior`**. `CODEBASE_MCP_RERANK` / `CODEBASE_MCP_RERANK_CANDIDATES` (default **100**). **Not done:** import proximity, AST/signature overlap, learn-to-rank. **Learned** second stage: see **Cross-encoder rerank** row. |
| **Cross-encoder rerank (top-K)** | Big | **Not started** | **Second stage** after fusion (and optional heuristic rerank): score **(query text, chunk text)** jointly with a small **cross-encoder** (e.g. **`BAAI/bge-reranker-base`**) on the top **K** candidates (e.g. 50), then return the best **N** (e.g. 10). Improves **precision@1** when the right chunk is already in the pool; typical added latency **~100–200ms** per query (hardware, batching, and K-dependent). **Complements query expansion:** expansion helps the true hit **enter** top-K; cross-encoder fixes **ordering** within K. Likely hook: after **`store.search`** / **`rerankSearchHits`** in **`src/mcp-tools.ts`**; opt-in via env (model id, K, timeout, ONNX caps). |
| **Hybrid retrieval** — BM25 + vectors + RRF | Big | **Done (LanceDB)** | **`src/store.ts`**: LanceDB **FTS on `text`** (BM25-ordered) + **`vectorSearch`** + native **`RRFReranker`** (RRF). FTS index is created in the **writer** (`ensureFtsIndex` after `init` and after `addRows` when new data exists). **MCP read-only** uses hybrid only if the index already exists (start the **daemon** / indexer once to build it). Toggles: `CODEBASE_MCP_HYBRID`, `CODEBASE_MCP_RRF_K`, `CODEBASE_MCP_HYBRID_DEPTH`. On failure, search falls back to **vector-only**. |
| **Query expansion** — NL → code aliases / symbol forms | Medium | **Not started** | Queries are embedded **as-is** in **`src/mcp-tools.ts`** / **`embedder.ts`** today — no alias or expansion step. **Planned tiers:** (1) **Deterministic** — camelCase ↔ snake_case, optional `::` for constants, small synonym / framework hints, reuse **`path_prefix`** as a signal; optionally different strings for **FTS** vs **embedding** to avoid diluting the vector. (2) **Gated / risky** — pseudo-relevance feedback (terms from top snippets) or **LLM** one-shot rewrite only when **`match_confidence`** is weak or top scores are tight (avoids steering off a bad first pass). **Pairs with cross-encoder:** expansion improves **recall into K**; cross-encoder improves **rank within K**. |
| **Path / language filtering** | Medium | **Partial** | **`codebase_search`** supports **`path_prefix`** (POSIX path under repo root) — see **`src/mcp.ts`**, applied in **`src/store.search()`** / **`mcp-tools.ts`**. Chunks store **`path`**; embedding tags include inferred **`lang`** from extension — **no** `language` or glob filter on the search tool (e.g. `*.ts` must be approximated via prefix or future work). **Related:** `CODEBASE_MCP_INDEX_EXCLUDE` (daemon) skips paths from the index, not a query-time filter. |
| **Result confidence / weak match signal** | Medium | **Done (heuristic)** | **`src/search-confidence.ts`**: `assessSearchMatchQuality` on the final top-`limit` list; MCP JSON includes `match_confidence`, `match_confidence_reasons`, `match_confidence_hint`, `top_primary_score`, `top_relative_separation`. Optional downgrades from **high** → **medium**: `CODEBASE_MCP_MATCH_CONF_AMBIG_LIT`, `CODEBASE_MCP_MATCH_CONF_XDOMAIN_EXT`. Other tunables: `CODEBASE_MCP_MATCH_CONF_WEAK` / `STRONG` / `GAP`. **Not a guarantee** of correctness. |
| **Cross-domain / literal disambiguation** (same token in many contexts) | Medium | **Partial** | Rerank + hybrid unchanged. **Match confidence (optional):** if a **high** was about to be reported, we may down-grade to **medium** for (a) *short single-token* queries, or (b) top-1 vs top-2 paths in *different* extension families (e.g. Ruby vs TS) — `CODEBASE_MCP_MATCH_CONF_AMBIG_LIT` / `..._XDOMAIN_EXT`. **Not** a full disambiguation model; planned upgrades: **Cross-encoder rerank** and **Query expansion** rows above. |
| **Test/spec path intent** in rerank | Small | **Partial** | If the **query** mentions `test` / `spec` / RSpec / Jest / etc., **`src/rerank.ts`** *boosts* `spec/`, `test/`, `__tests__` (otherwise they stay de-prioritized for generic queries). Toggle: `CODEBASE_MCP_TEST_PATH_QUERY_BOOST`. **Not** `path_prefix`; **not** perfect intent detection (e.g. “no tests”). |
| **Frontend (TS / React) path intent** in rerank | Small | **Partial** | If the **query** mentions React/TS UI idioms, **`src/rerank.ts`** nudges `components/`, `.tsx` / `.jsx`, `app/javascript/`, `frontend/`, `client/`, `web/`, `packages/ui`, `src/packs` (see `queryMentionsFrontendContext`, `isFrontendishPath`). Toggle: `CODEBASE_MCP_FRONTEND_PATH_QUERY_BOOST`. Does **not** fix silent queries; **not** a substitute for `path_prefix` to `src/components`. |
| **Definition vs usage** — boost canonical definition for “where is X defined?” | Big | **Partial (heuristic)** | **`src/tree-sitter-definitions.ts`** (supported langs) + regex merge in **`src/chunker.ts`**; **`src/definition-intent.ts`**; **`src/rerank.ts`**. Remaining gap: very dynamic metaprogramming, some Rails/Ruby cases vs MRI, LSP-level accuracy. Reindex when chunker changes. |

## Ruby: class / enum / struct — what can be done

The **~30%** gap is mostly **declarations that are not** a single line starting with `class`, `module`, or `def` — e.g. `Struct.new`, `Data.define`, Rails `enum`, nested `class << self`, metaprogramming, or **multiline** headers. Options below are ordered by **effort** and **fidelity** (all require **reindex** after any index-time change).

| Tier | Approach | Fidelity | Effort / tradeoffs |
|------|----------|----------|---------------------|
| **A. Regex in `chunker.ts`** (extend current Ruby branch) | **Done (initial):** `Const = Struct.new`, `Const = Data.define`, `Const = Class.new` / `Module.new` (optional `::`), Rails-style `enum :col` and `enum status:`. | **Low–medium** — still misses `class << self`, metaprogramming, some multiline headers, `include`. | **Low** — no new dependencies; **reindex** to refresh `definition_of`. |
| **B. Ruby (Former Ripper path)** | **Replaced** by a single **tree-sitter** stack: **`tree-sitter` + `tree-sitter-ruby`** in **`src/tree-sitter-loader.ts` / `tree-sitter-definitions.ts`**; merge with regex; in-memory cache. (Legacy MRI Ripper script removed — one path to maintain.) | **High** for structural declarations. | **Requires** `npm install` to build **native** grammar bindings; `CODEBASE_MCP_DEF_ENGINE=regex` or failed load → regex. |
| **C. Tree-sitter (unified grammars)** | **Done (initial):** TS/JS, Python, Ruby, Go, Java, Rust — visitors in **`src/tree-sitter-definitions.ts`**, `CODEBASE_MCP_DEF_ENGINE` & `CODEBASE_MCP_TREE_SITTER_MAX_BYTES`. | **High** for structure. | **Native** add-ons; extend visitors for edge cases; optional WASM path later for environments without a compiler. |
| **D. LSP / Solargraph (optional daemon)** | Point at a language server or `solargraph` JSON API for *definition* locations; merge into index on reindex. | **Highest** (project-aware) | **Very high** — extra service, `Gemfile` / workspace roots, not “local-only MCP” by default. |

**Recommendation:** keep **A** as an incremental lever; plan **B** or **C** for the “real” close of the ~30% gap (B if you want zero WASM and are OK requiring Ruby; C for multi-language and consistency with a future TS/JS pipeline). **D** only if the product becomes IDE-adjacent.

**Query side:** `parseDefinitionIntentQuery` is already language-agnostic; the missing piece is **index-time** `definition_of` on the right *line* for those declarations.

## Remaining gaps (field / review notes)

Consolidated product gaps not fully solved by heuristics above:

1. **Ruby (and similar) class / enum / struct declarations** — `tree-sitter-ruby` + merge covers most; edge cases and large files (see `CODEBASE_MCP_TREE_SITTER_MAX_BYTES`) may still use regex. See *Ruby: class / enum / struct* for historical tiers.
2. **Spec vs prod ranking** — When the *query* clearly targets tests (spec, RSpec, Jest, etc.), we **boost** `spec/`, `test/`, `__tests__` in **`rerank.ts`** (see `CODEBASE_MCP_TEST_PATH_QUERY_BOOST`). This does *not* fix “production implementation vs spec” disambiguation when the query is silent — that still relies on `path_prefix` and embeddings.
3. **Frontend (TS / React) vs backend (e.g. Ruby)** — **Vector + chunking** are shared; if embedder and chunk tags under-index UI idioms, **TS/React** queries can underperform vs Ruby in the same repo. Mitigations: better **path** / **ext** weighting, optional **`path_prefix`**, future **language** or **app** (e.g. `src/components/`) filter — not a single flag today.
4. **Cross-domain literal + confidence** — **Partially mitigated** by `MATCH_CONF_AMBIG_LIT` and `MATCH_CONF_XDOMAIN_EXT` in **`search-confidence.ts`** (downgrade **high** → **medium** with reasons). Gaps: still no detection of the wrong *single* top hit when the wrong domain “wins” clearly; **cross-encoder rerank (top-K)** and **query expansion** (see initiative table) are the main planned upgrades beyond heuristics / query entity routing.

## Semantic retrieval vs grep

Use both: they optimize for different jobs.

| Kind of question | Semantic search (`codebase_search`) | `grep` / ripgrep |
|------------------|--------------------------------------|------------------|
| Conceptual / intent (“how does billing work?”, “where is auth enforced?”) | **Stronger** — paraphrase and embedding match | Weak unless you already know exact words/paths |
| Exact symbol / string (known identifier) | **On par** in practice — FTS + lexical rerank help | **On par** — fast, predictable |
| Exhaustive enumeration (renames, callsite sweeps, “every reference”) | **Weaker** — ranked, approximate, not guaranteed complete | **Dominant** — deterministic, exhaustive, line-oriented |

Agents should still reach for grep (or the IDE’s reference search) when the task is **complete** coverage, not “most relevant few chunks.”

## Definition vs usage (largest structural gap)

The **single biggest limitation** for code search is **definition vs usage**: a symbol’s name appears in declarations, exports, imports, and call sites; neither vectors nor BM25 reliably encode “this chunk is the **canonical definition** of *X*.”

**Closing the gap (future work):**

1. **Index time** — Attach chunk-level metadata such as “this chunk contains the canonical definition of symbol *X*” (tree-sitter, LSP-style info, or language-specific heuristics). Store it in the index next to `path` / chunk text.
2. **Query time** — Detect **definition-shaped** queries (“where is `Foo` defined?”, “definition of …”, classifier on intent).
3. **Scoring** — Boost or rerank when resolved symbol + definition metadata + query intent align (not a blind global boost to arbitrary paths).

That improves “find the source of truth” without changing the fact that **grep still wins** for rename refactors and callsite sweeps.

## Quick file map

- Chunking & embed text: `src/chunker.ts`, `src/indexer.ts` (`embeddingTextForChunk`)
- Vector retrieval: `src/store.ts`
- Search pipeline: `src/mcp-tools.ts` (`runCodebaseSearch`)
- Rerank: `src/rerank.ts`
- Definition intent: `src/definition-intent.ts`
- Match quality: `src/search-confidence.ts`
- Tool API: `src/mcp.ts` (`path_prefix`, `limit`)
- Config: `src/config.ts` (e.g. `rerankCandidates`, `rerankEnabled`, `searchMatch*`, `matchConf*`, `testPathQueryBoost`, `frontendPathQueryBoost`, `codeAwareChunking`, `indexExcludeRelPosix`)

For end-to-end architecture (processes, diagrams, hybrid search flow), see **[`docs/architecture/README.md`](../architecture/README.md)**.

## Suggested next steps (not committed)

**Return on effort** (here): subjective **value gained versus engineering + runtime + maintenance cost** for this codebase—not financial ROI.

1. **Chunking (remaining)** — **Done (initial):** tree-sitter + regex merge + line windows + `chunkByLines()` fallback (`CODEBASE_MCP_CODE_AWARE_CHUNKING`, `CODEBASE_MCP_DEF_ENGINE`). **Still open:** import-graph-aware splits, dedicated **header + body** chunks, more languages / edge cases in **`tree-sitter-definitions.ts`**. **Return on effort:** **Medium** (import-graph / dual chunks are non-trivial; gains are incremental after the current tree-sitter path).
2. **Cross-encoder rerank** — Opt-in **top-K → top-N** pass (e.g. K=50, N=`limit`) with a small model such as **`BAAI/bge-reranker-base`** after fusion / heuristic rerank; tune **K**, batching, and timeouts for ~100–200ms class latency on target hardware. Highest impact where the correct chunk is already in the candidate list but not at **#1** (generic tokens, cross-domain literals). **Return on effort:** **High** (one integration surface, predictable quality lift on ordering; pays ops cost in latency + second model).
3. **Rerank (heuristic)** — Tighter **symbol/path** features on the existing path (import proximity, AST/signature overlap) where a cross-encoder is not desired or as a **pre-filter** before the learned reranker. **Return on effort:** **Medium** (fits current `rerank.ts` style; each signal needs tuning and tests; smaller upside than a cross-encoder for hard collisions).
4. **Query expansion** — Start with **deterministic** expansion behind a flag (casing, separators, light synonyms); add **gated** LLM or PRF only when confidence is weak; consider **split queries** for FTS vs embedding if expansion noise hurts vectors. **Return on effort:** **Medium** (deterministic pass is moderate cost / moderate recall gain; PRF / LLM tiers add product risk and latency—**Low** if shipped naïvely without gating).
5. **API** — Optional **`lang` / `ext`** or **glob** filter on `codebase_search` for monorepos (complements `path_prefix`). **Return on effort:** **High** (narrow tool + store surface; large user-facing win for scoping generic tokens without new models).
6. **Definitions** — Deeper than regex: tree-sitter / LSP for re-exports, barrel files, **Ruby class/enum/struct** declaration capture, and languages beyond current heuristics; refine `parseDefinitionIntentQuery` (see *Definition vs usage* and *Remaining gaps* above). **Return on effort:** **Medium** for more **tree-sitter** + query-intent polish in-repo; **Low** for a full **LSP** integration (very high ongoing cost for IDE-grade fidelity).
7. **Confidence (next)** — Deeper than `MATCH_CONF_*`: flag wrong **single** winner when the dominant score is still in the *wrong* domain, or add BM25/lexical clash signals. **Return on effort:** **Medium** (mostly heuristics on existing lists; improves agent UX but does not fix wrong top hit by itself).

---

_Last updated to reflect implementation as of the doc author pass; adjust rows when features land._

# Code-aware retrieval: roadmap & implementation status

High-ROI improvements for **semantic search over code** (same embedding model can still benefit). Status is for the **current `codebase_mcp` codebase**; update this file when behavior changes.

| Initiative | ROI (expected) | Status | Implementation notes |
|------------|----------------|--------|----------------------|
| **Chunking** — structure-aware splits, symbol + path in text | Biggest | **Partial** | **`src/chunker.ts`**: `chunkCodeAware()` uses **line-based windows** with **heuristic symbol lines** (regex) for JavaScript/TypeScript, Python, and a generic pass (e.g. `func`/`class`/`type`) — not full AST or tree-sitter boundaries. Large symbol spans are sub-split by line count. Fallback: `chunkByLines()`. Toggle: `CODEBASE_MCP_CODE_AWARE_CHUNKING` (default on). **`src/indexer.ts`** `embeddingTextForChunk()` prefixes each embedded string with **`path=…`**, optional **`lang=…`**, **`symbol=…`**, **`kind=…`**; optional **`def=…`** only if **`CODEBASE_MCP_EMBED_DEF_TAG=1`** (default off: definition metadata is **Lance + rerank**). **Not done:** module/import graph chunking, parser-backed function/class boundaries only, dedicated “header + body” chunks. |
| **Reranking** — code-sensitive signals | Big | **Partial** | **`src/rerank.ts`** fuses the **fused** search score (hybrid) or **vector** score with **lexical** match, **exact token** match, **path** match, **symbol-style** token bonus, and **`codePathPrior`**. `CODEBASE_MCP_RERANK` / `CODEBASE_MCP_RERANK_CANDIDATES` (default **100**). **Not done:** import proximity, AST/signature overlap, learn-to-rank, cross-encoder. |
| **Hybrid retrieval** — BM25 + vectors + RRF | Big | **Done (LanceDB)** | **`src/store.ts`**: LanceDB **FTS on `text`** (BM25-ordered) + **`vectorSearch`** + native **`RRFReranker`** (RRF). FTS index is created in the **writer** (`ensureFtsIndex` after `init` and after `addRows` when new data exists). **MCP read-only** uses hybrid only if the index already exists (start the **daemon** / indexer once to build it). Toggles: `CODEBASE_MCP_HYBRID`, `CODEBASE_MCP_RRF_K`, `CODEBASE_MCP_HYBRID_DEPTH`. On failure, search falls back to **vector-only**. |
| **Query expansion** — NL → code aliases / symbol forms | Medium | **Not started** | Queries are embedded **as-is** in **`src/mcp-tools.ts`** / **`embedder.ts`**. No alias tables or expansion step. |
| **Path / language filtering** | Medium | **Partial** | **`codebase_search`** supports **`path_prefix`** (POSIX path under repo root) — see **`src/mcp.ts`**, applied in **`src/store.search()`** / **`mcp-tools.ts`**. Chunks store **`path`**; embedding tags include inferred **`lang`** from extension — **no** `language` or glob filter on the search tool (e.g. `*.ts` must be approximated via prefix or future work). **Related:** `CODEBASE_MCP_INDEX_EXCLUDE` (daemon) skips paths from the index, not a query-time filter. |
| **Result confidence / weak match signal** | Medium | **Done (heuristic)** | **`src/search-confidence.ts`**: `assessSearchMatchQuality` on the final top-`limit` list; MCP JSON includes `match_confidence`, `match_confidence_reasons`, `match_confidence_hint`, `top_primary_score`, `top_relative_separation`. Optional downgrades from **high** → **medium**: `CODEBASE_MCP_MATCH_CONF_AMBIG_LIT`, `CODEBASE_MCP_MATCH_CONF_XDOMAIN_EXT`. Other tunables: `CODEBASE_MCP_MATCH_CONF_WEAK` / `STRONG` / `GAP`. **Not a guarantee** of correctness. |
| **Cross-domain / literal disambiguation** (same token in many contexts) | Medium | **Partial** | Rerank + hybrid unchanged. **Match confidence (optional):** if a **high** was about to be reported, we may down-grade to **medium** for (a) *short single-token* queries, or (b) top-1 vs top-2 paths in *different* extension families (e.g. Ruby vs TS) — `CODEBASE_MCP_MATCH_CONF_AMBIG_LIT` / `..._XDOMAIN_EXT`. **Not** a full disambiguation model; use cross-encoder / query refinement for the rest. |
| **Test/spec path intent** in rerank | Small | **Partial** | If the **query** mentions `test` / `spec` / RSpec / Jest / etc., **`src/rerank.ts`** *boosts* `spec/`, `test/`, `__tests__` (otherwise they stay de-prioritized for generic queries). Toggle: `CODEBASE_MCP_TEST_PATH_QUERY_BOOST`. **Not** `path_prefix`; **not** perfect intent detection (e.g. “no tests”). |
| **Frontend (TS / React) path intent** in rerank | Small | **Partial** | If the **query** mentions React/TS UI idioms, **`src/rerank.ts`** nudges `components/`, `.tsx` / `.jsx`, `app/javascript/`, `frontend/`, `client/`, `web/`, `packages/ui`, `src/packs` (see `queryMentionsFrontendContext`, `isFrontendishPath`). Toggle: `CODEBASE_MCP_FRONTEND_PATH_QUERY_BOOST`. Does **not** fix silent queries; **not** a substitute for `path_prefix` to `src/components`. |
| **Definition vs usage** — boost canonical definition for “where is X defined?” | Big | **Partial (heuristic)** | Regex `definition_of` in **`src/chunker.ts`** (incl. Ruby: `def` / `class` / `module`, `Name = Struct.new` / `Data.define` / `Class.new` / `Module.new`, Rails `enum :x` / `enum x:`); **`src/definition-intent.ts`**; **`src/rerank.ts`**. Remaining gap: metaprogramming, `class << self`, Ripper/tree-sitter/LSP (see *Ruby: class / enum / struct*). Reindex when chunker changes. |

## Ruby: class / enum / struct — what can be done

The **~30%** gap is mostly **declarations that are not** a single line starting with `class`, `module`, or `def` — e.g. `Struct.new`, `Data.define`, Rails `enum`, nested `class << self`, metaprogramming, or **multiline** headers. Options below are ordered by **effort** and **fidelity** (all require **reindex** after any index-time change).

| Tier | Approach | Fidelity | Effort / tradeoffs |
|------|----------|----------|---------------------|
| **A. Regex in `chunker.ts`** (extend current Ruby branch) | **Done (initial):** `Const = Struct.new`, `Const = Data.define`, `Const = Class.new` / `Module.new` (optional `::`), Rails-style `enum :col` and `enum status:`. | **Low–medium** — still misses `class << self`, metaprogramming, some multiline headers, `include`. | **Low** — no new dependencies; **reindex** to refresh `definition_of`. |
| **B. Ruby `Ripper` (subprocess)** | During indexing, when `ruby` is on `PATH`, run a tiny script: `Ripper::Sexp` or `ripper` gem–level walk → emit `(path, line, kind, name)` for `class`/`module`/`def` and optionally constant assignments to `Class.new` / `Struct`. | **High** for syntax Ripper supports (matches MRI). | **Medium** — spawn cost per file (batch or cache by content hash), Windows PATH, JRuby/TruffleRuby not targeted; keep pure-regex fallback if `ruby` missing. |
| **C. Tree-sitter (Ruby grammar)** | Add `web-tree-sitter` + prebuilt `tree-sitter-ruby` WASM; queries like `(class name: (constant) @c)`, `(module name: (constant) @m)`, `singleton_class?`. Map AST nodes to chunk start lines; fill `definition_of` / future columns. | **Very high** for structure; same approach scales to **TS/JS** for the roadmap. | **High** — wasm/binary weight, version pins, build pipeline, must stay fast for large repos. |
| **D. LSP / Solargraph (optional daemon)** | Point at a language server or `solargraph` JSON API for *definition* locations; merge into index on reindex. | **Highest** (project-aware) | **Very high** — extra service, `Gemfile` / workspace roots, not “local-only MCP” by default. |

**Recommendation:** keep **A** as an incremental lever; plan **B** or **C** for the “real” close of the ~30% gap (B if you want zero WASM and are OK requiring Ruby; C for multi-language and consistency with a future TS/JS pipeline). **D** only if the product becomes IDE-adjacent.

**Query side:** `parseDefinitionIntentQuery` is already language-agnostic; the missing piece is **index-time** `definition_of` on the right *line* for those declarations.

## Remaining gaps (field / review notes)

Consolidated product gaps not fully solved by heuristics above:

1. **Ruby (and similar) class / enum / struct declarations** — See *Ruby: class / enum / struct* above. Regex covers the easy part; **Ripper** or **tree-sitter** closes most of the rest.
2. **Spec vs prod ranking** — When the *query* clearly targets tests (spec, RSpec, Jest, etc.), we **boost** `spec/`, `test/`, `__tests__` in **`rerank.ts`** (see `CODEBASE_MCP_TEST_PATH_QUERY_BOOST`). This does *not* fix “production implementation vs spec” disambiguation when the query is silent — that still relies on `path_prefix` and embeddings.
3. **Frontend (TS / React) vs backend (e.g. Ruby)** — **Vector + chunking** are shared; if embedder and chunk tags under-index UI idioms, **TS/React** queries can underperform vs Ruby in the same repo. Mitigations: better **path** / **ext** weighting, optional **`path_prefix`**, future **language** or **app** (e.g. `src/components/`) filter — not a single flag today.
4. **Cross-domain literal + confidence** — **Partially mitigated** by `MATCH_CONF_AMBIG_LIT` and `MATCH_CONF_XDOMAIN_EXT` in **`search-confidence.ts`** (downgrade **high** → **medium** with reasons). Gaps: still no detection of the wrong *single* top hit when the wrong domain “wins” clearly; use cross-encoder / query entity routing for that.

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

1. **Chunking** — Optional **tree-sitter** (or similar) for top languages; keep line fallback for the long tail.
2. **Rerank** — Tighter **symbol/path** features or a **small cross-encoder** on the top K after fusion (especially for **cross-domain literal** queries where the current heuristic reranker cannot separate domains).
3. **Query** — Light expansion (synonyms, camelCase / snake_case flip) or a fixed **code** synonym list behind a flag; optional **one-shot query refinement** when `match_confidence` is low or top scores are tight.
4. **API** — Optional **`lang` / `ext`** or **glob** filter on `codebase_search` for monorepos (complements `path_prefix`).
5. **Definitions** — Deeper than regex: tree-sitter / LSP for re-exports, barrel files, **Ruby class/enum/struct** declaration capture, and languages beyond current heuristics; refine `parseDefinitionIntentQuery` (see *Definition vs usage* and *Remaining gaps* above).
6. **Confidence (next)** — Deeper than `MATCH_CONF_*`: flag wrong **single** winner when the dominant score is still in the *wrong* domain, or add BM25/lexical clash signals.

---

_Last updated to reflect implementation as of the doc author pass; adjust rows when features land._

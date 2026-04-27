import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Ignore } from 'ignore';
import type { AppConfig } from './config.js';
import { chunkByLines, chunkCodeAware, type TextChunk } from './chunker.js';
import { embedTexts, getEmbedder } from './embedder.js';
import type { MetaFile } from './meta.js';
import { writeMeta } from './meta.js';
import {
  isSafetyIgnored,
  relativePosix,
  shouldConsiderExtension,
} from './path-filters.js';
import { isCoveredByForceInclude } from './force-include.js';
import { isIgnored, normalizeIgnorePath } from './gitignore.js';
import { yieldToEventLoop } from './event-loop-yield.js';
import { logError, logInfo } from './log.js';
import type { ChunkRow } from './store.js';
import { ChunkStore } from './store.js';

/** Rough token-safe limit for MiniLM-class models (chars, not tokens). */
const MAX_CHUNK_CHARS = 12_000;

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Small files: one sync hash. Larger: incremental hash with yields so the daemon can still process IPC. */
const SHA256_INLINE_MAX_BYTES = 64 * 1024;
const SHA256_YIELD_EVERY_BYTES = 256 * 1024;

async function sha256HexWithYields(content: string): Promise<string> {
  const buf = Buffer.from(content, 'utf8');
  if (buf.length <= SHA256_INLINE_MAX_BYTES) {
    return createHash('sha256').update(buf).digest('hex');
  }
  const hash = createHash('sha256');
  for (let i = 0; i < buf.length; i += SHA256_YIELD_EVERY_BYTES) {
    hash.update(buf.subarray(i, i + SHA256_YIELD_EVERY_BYTES));
    if (i + SHA256_YIELD_EVERY_BYTES < buf.length) {
      await yieldToEventLoop();
    }
  }
  return hash.digest('hex');
}

function embeddingTextForChunk(relPath: string, chunk: TextChunk): string {
  const tags = [`path=${relPath}`];
  if (chunk.language) {
    tags.push(`lang=${chunk.language}`);
  }
  if (chunk.symbolName) {
    tags.push(`symbol=${chunk.symbolName}`);
  }
  if (chunk.symbolKind) {
    tags.push(`kind=${chunk.symbolKind}`);
  }
  return `[${tags.join('][')}]\n${chunk.text}`;
}

async function walkFiles(
  dir: string,
  watchRootAbs: string,
  ig: Ignore,
  forceIncludes: string[],
): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    const rel = normalizeIgnorePath(relativePosix(watchRootAbs, abs));
    if (isSafetyIgnored(rel)) {
      continue;
    }
    if (entry.isDirectory()) {
      const dirIgnored = isIgnored(ig, `${rel}/`, true);
      if (dirIgnored && !isCoveredByForceInclude(rel, forceIncludes)) {
        continue;
      }
      out.push(...(await walkFiles(abs, watchRootAbs, ig, forceIncludes)));
    } else {
      if (isIgnored(ig, rel, false) && !isCoveredByForceInclude(rel, forceIncludes)) {
        continue;
      }
      if (!shouldConsiderExtension(abs)) {
        continue;
      }
      out.push(abs);
    }
  }
  return out;
}

type IndexFileSource = 'fullscan' | 'watcher';

export class Indexer {
  private chain: Promise<void> = Promise.resolve();
  private meta: MetaFile;
  /** Count of files successfully re-indexed in the current pass (for progress logging). */
  private indexPassCount = 0;
  /** Files completed in the current `fullScan` (including skips); used for periodic progress. */
  private fullScanFilesCompleted = 0;
  /** In the current `fullScan`, how many files skipped read/embed via `fileStatCache` (stat+mtime). */
  private fullScanStatSkips = 0;
  /** In the current `fullScan`, how many files read+hashed, content same as `meta` (CPU-heavy, no embed). */
  private fullScanHashSkips = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly ig: Ignore,
    readonly store: ChunkStore,
    meta: MetaFile,
  ) {
    this.meta = meta;
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain
      .then(fn)
      .catch((error) => {
        logError('indexer', 'indexing task failed', error);
      });
  }

  private async persistMeta(): Promise<void> {
    await writeMeta(this.config.metaPathAbs, this.meta);
  }

  private setFileStatCache(
    rel: string,
    st: { size: number; mtimeMs: number },
  ): void {
    this.meta.fileStatCache[rel] = { size: st.size, mtimeMs: st.mtimeMs };
  }

  async indexAbsoluteFile(absPath: string, source: IndexFileSource = 'watcher'): Promise<void> {
    try {
      await this.runIndexAbsoluteFileBody(absPath, source);
    } finally {
      if (source === 'fullscan') {
        this.fullScanFilesCompleted += 1;
        const n = this.fullScanFilesCompleted;
        if (n === 1 || n % 50 === 0) {
          const st = this.fullScanStatSkips;
          const h = this.fullScanHashSkips;
          const e = this.indexPassCount;
          const other = n - st - h - e;
          logInfo(
            'indexer',
            `full scan: ${n} queued file(s) done; stat-skip ${st}; read+hash unchanged ${h} (uses CPU: read+sha256, no re-embed); re-embed ${e}; other ${other}`,
          );
        }
      }
    }
  }

  private async runIndexAbsoluteFileBody(absPath: string, source: IndexFileSource): Promise<void> {
    await yieldToEventLoop();
    const rel = normalizeIgnorePath(relativePosix(this.config.watchRootAbs, absPath));
    if (isSafetyIgnored(rel)) {
      return;
    }
    if (isIgnored(this.ig, rel, false) && !isCoveredByForceInclude(rel, this.config.forceIncludeRelPosix)) {
      return;
    }
    if (!shouldConsiderExtension(absPath)) {
      return;
    }
    let st: Awaited<ReturnType<typeof fs.stat>>;
    try {
      st = await fs.stat(absPath);
    } catch {
      await this.removeRelativePath(rel, { silent: true });
      return;
    }
    if (!st.isFile()) {
      return;
    }
    if (st.size > this.config.maxFileBytes) {
      if (this.config.logIndexEachFile) {
        logInfo('indexer', `skip (too large, ${st.size} bytes): ${rel}`);
      }
      return;
    }
    const fp = this.meta.fileStatCache[rel];
    if (
      fp !== undefined &&
      this.meta.fileHashes[rel] !== undefined &&
      st.size === fp.size &&
      st.mtimeMs === fp.mtimeMs
    ) {
      if (source === 'fullscan') {
        this.fullScanStatSkips += 1;
      }
      logInfo('indexer', `${rel}  [stat cache — no read]`);
      return;
    }
    logInfo('indexer', `${rel}  [read]`);
    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf8');
    } catch (e) {
      logError('indexer', `read failed, skipping: ${rel}`, e);
      return;
    }
    const hash = await sha256HexWithYields(content);
    if (this.meta.fileHashes[rel] === hash) {
      this.setFileStatCache(rel, st);
      if (source === 'fullscan') {
        this.fullScanHashSkips += 1;
      }
      logInfo('indexer', `${rel}  [hash match meta — no re-embed]`);
      if (source === 'watcher') {
        await this.persistMeta();
      }
      return;
    }
    logInfo('indexer', `${rel}  [re-embed: chunk + embed]`);
    if (content.length > 1_200_000) {
      logInfo(
        'indexer',
        `large file (${(content.length / 1_000_000).toFixed(1)}M chars) — full-scan “rechecked N” will advance after it finishes; chunking yields to IPC in chunks`,
      );
    }
    const extractor = await getEmbedder(this.config);
    if (content.length > 300_000) {
      await yieldToEventLoop();
    }
    const chunks = this.config.codeAwareChunking
      ? await chunkCodeAware(content, absPath, this.config.chunkLines, this.config.chunkOverlapLines)
      : await chunkByLines(content, this.config.chunkLines, this.config.chunkOverlapLines);
    if (content.length > 300_000) {
      await yieldToEventLoop();
    }
    if (chunks.length === 0) {
      logInfo('indexer', `${rel}  [no chunks after split — store cleared for path]`);
      await this.store.deleteByPath(rel);
      this.meta.fileHashes[rel] = hash;
      this.setFileStatCache(rel, st);
      if (source === 'watcher') {
        await this.persistMeta();
      }
      return;
    }
    const batchSize = 8;
    const totalBatches = Math.max(1, Math.ceil(chunks.length / batchSize));
    if (!this.config.logIndexEachFile) {
      logInfo('indexer', `re-embedding ${rel} (${chunks.length} chunks, ${totalBatches} batch${totalBatches === 1 ? '' : 'es'})…`);
    }
    const texts: string[] = [];
    for (let j = 0; j < chunks.length; j++) {
      if (j > 0 && j % 5_000 === 0) {
        await yieldToEventLoop();
      }
      const c = chunks[j]!;
      const embedText = embeddingTextForChunk(rel, c);
      texts.push(embedText.length > MAX_CHUNK_CHARS ? embedText.slice(0, MAX_CHUNK_CHARS) : embedText);
    }
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      if (totalBatches > 1 && !this.config.logIndexEachFile) {
        if (batchNum === 1 || batchNum === totalBatches || batchNum % 5 === 0) {
          logInfo('indexer', `embedding ${rel}: batch ${batchNum}/${totalBatches}`);
        }
      }
      const part = await embedTexts(extractor, batch, this.config.embeddingDim);
      vectors.push(...part);
    }
    if (vectors.length !== chunks.length) {
      throw new Error(`Embedding count mismatch: ${vectors.length} vs ${chunks.length}`);
    }
    await this.store.deleteByPath(rel);
    const rows: ChunkRow[] = chunks.map((c, i) => ({
      path: rel,
      start_line: c.startLine,
      end_line: c.endLine,
      text: c.text,
      vector: vectors[i]!,
    }));
    await this.store.addRows(rows);
    this.meta.fileHashes[rel] = hash;
    this.setFileStatCache(rel, st);
    this.meta.lastFullScanAt = new Date().toISOString();
    await this.persistMeta();
    this.indexPassCount += 1;
    logInfo('indexer', `${rel}  [embed done: ${chunks.length} chunk(s)]`);
    if (!this.config.logIndexEachFile && this.indexPassCount % 10 === 0) {
      logInfo('indexer', `progress: ${this.indexPassCount} file(s) re-indexed in this pass (last: ${rel})`);
    }
  }

  async removeRelativePath(relPosix: string, options?: { silent?: boolean }): Promise<void> {
    if (!options?.silent) {
      logInfo('indexer', `remove from index: ${relPosix}`);
    }
    delete this.meta.fileHashes[relPosix];
    delete this.meta.fileStatCache[relPosix];
    await this.store.deleteByPath(relPosix);
    await this.persistMeta();
  }

  scheduleIndexFile(absPath: string, source: IndexFileSource = 'watcher'): void {
    this.enqueue(() => this.indexAbsoluteFile(absPath, source));
  }

  scheduleRemove(absPath: string): void {
    this.enqueue(async () => {
      const rel = normalizeIgnorePath(relativePosix(this.config.watchRootAbs, absPath));
      await this.removeRelativePath(rel);
    });
  }

  async fullScan(): Promise<void> {
    const files = await walkFiles(
      this.config.watchRootAbs,
      this.config.watchRootAbs,
      this.ig,
      this.config.forceIncludeRelPosix,
    );
    this.indexPassCount = 0;
    this.fullScanFilesCompleted = 0;
    this.fullScanStatSkips = 0;
    this.fullScanHashSkips = 0;
    logInfo(
      'indexer',
      `full scan: rechecking ${files.length} file(s) under ${this.config.watchRootAbs} (unchanged: stat cache in meta skips read; content hash skips re-embed)`,
    );
    for (const abs of files) {
      this.scheduleIndexFile(abs, 'fullscan');
    }
    await this.chain;
    this.meta.lastFullScanAt = new Date().toISOString();
    await this.persistMeta();
    logInfo(
      'indexer',
      `full scan: queue drained; stat-skip ${this.fullScanStatSkips}; read+hash unchanged ${this.fullScanHashSkips}; re-embedded ${this.indexPassCount} (one meta.json write at end)`,
    );
  }

  getSnapshotStats(): {
    watchRoot: string;
    indexedFiles: number;
    embeddingModel: string;
    lastFullScanAt: string | null;
  } {
    return {
      watchRoot: this.config.watchRootAbs,
      indexedFiles: Object.keys(this.meta.fileHashes).length,
      embeddingModel: this.meta.embeddingModel,
      lastFullScanAt: this.meta.lastFullScanAt,
    };
  }

  async reconcile(): Promise<void> {
    logInfo('indexer', `reconcile: scanning tree under ${this.config.watchRootAbs}`);
    const files = new Set(
      await walkFiles(
        this.config.watchRootAbs,
        this.config.watchRootAbs,
        this.ig,
        this.config.forceIncludeRelPosix,
      ),
    );
    const rels = new Set(
      [...files].map((abs) =>
        normalizeIgnorePath(relativePosix(this.config.watchRootAbs, abs)),
      ),
    );
    const known = Object.keys(this.meta.fileHashes);
    let removed = 0;
    for (const rel of known) {
      if (!rels.has(rel)) {
        await this.removeRelativePath(rel, { silent: true });
        removed += 1;
      }
    }
    if (removed > 0) {
      logInfo('indexer', `reconcile: removed ${removed} stale path(s) from index`);
    }
    await this.fullScan();
    logInfo('indexer', 'reconcile: done');
  }
}

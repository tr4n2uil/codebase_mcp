import chokidar from 'chokidar';
import path from 'node:path';
import { toPosixPath } from './config.js';
import { isCoveredByForceInclude } from './force-include.js';
import type { AppConfig } from './config.js';
import type { Indexer } from './indexer.js';
import { normalizeIgnorePath } from './gitignore.js';

/** Path segments under the watch root we never attach watchers to (reduces EMFILE). */
const WATCH_IGNORE_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'bower_components',
  '.gradle',
  'Pods',
  'DerivedData',
  'vendor',
]);

function shouldIgnoreWatchPath(
  watchRootAbs: string,
  absolutePath: string,
  forceIncludes: string[],
): boolean {
  const root = path.resolve(watchRootAbs);
  const abs = path.resolve(absolutePath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..')) {
    return false;
  }
  const relPosix = normalizeIgnorePath(toPosixPath(rel));
  if (isCoveredByForceInclude(relPosix, forceIncludes)) {
    return false;
  }
  for (const segment of rel.split(path.sep)) {
    if (segment && WATCH_IGNORE_SEGMENTS.has(segment)) {
      return true;
    }
  }
  return false;
}

export function startWatcher(config: AppConfig, indexer: Indexer) {
  const ignored = (p: string): boolean =>
    shouldIgnoreWatchPath(config.watchRootAbs, p, config.forceIncludeRelPosix);

  const watcher = chokidar.watch(config.watchRootAbs, {
    persistent: true,
    ignoreInitial: true,
    ignored,
    usePolling: config.usePolling,
    interval: config.pollingIntervalMs,
    binaryInterval: config.pollingIntervalMs,
    awaitWriteFinish: {
      stabilityThreshold: 400,
      pollInterval: 100,
    },
  });

  watcher.on('error', (error: unknown) => {
    const err = error as NodeJS.ErrnoException;
    console.error('[codebase-mcp] watcher error:', err?.message ?? error);
    if (err?.code === 'EMFILE') {
      console.error(
        '[codebase-mcp] EMFILE (too many open files): use polling (default CODEBASE_MCP_USE_POLLING=true), ignore large dirs, or raise `ulimit -n`.',
      );
    }
  });

  watcher.on('all', (event, rawPath) => {
    if (!rawPath) {
      return;
    }
    const filePath = path.resolve(rawPath);
    if (shouldIgnoreWatchPath(config.watchRootAbs, filePath, config.forceIncludeRelPosix)) {
      return;
    }
    if (event === 'unlink') {
      indexer.scheduleRemove(filePath);
      return;
    }
    if (event === 'add' || event === 'change') {
      indexer.scheduleIndexFile(filePath);
    }
  });

  return watcher;
}

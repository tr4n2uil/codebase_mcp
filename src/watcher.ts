import chokidar from 'chokidar';
import type { Ignore } from 'ignore';
import path from 'node:path';
import { toPosixPath } from './config.js';
import { isCoveredByForceInclude } from './force-include.js';
import type { AppConfig } from './config.js';
import type { Indexer } from './indexer.js';
import { isIgnored, normalizeIgnorePath } from './gitignore.js';
import { logError, logInfo } from './log.js';
import { isUnderIndexDataDir } from './path-filters.js';

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
  indexExclude: Ignore,
  indexDirAbs: string,
  stats: { isDirectory: () => boolean } | undefined,
): boolean {
  const root = path.resolve(watchRootAbs);
  const abs = path.resolve(absolutePath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..')) {
    return false;
  }
  if (isUnderIndexDataDir(abs, indexDirAbs)) {
    return true;
  }
  const relPosix = normalizeIgnorePath(toPosixPath(rel));
  if (stats !== undefined) {
    if (isIgnored(indexExclude, relPosix, stats.isDirectory())) {
      return true;
    }
  } else if (isIgnored(indexExclude, relPosix, true) || isIgnored(indexExclude, relPosix, false)) {
    return true;
  }
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

export function startWatcher(config: AppConfig, indexer: Indexer, indexExclude: Ignore) {
  const ignored = (p: string, stats?: { isDirectory: () => boolean }): boolean =>
    shouldIgnoreWatchPath(
      config.watchRootAbs,
      p,
      config.workingDocsPathsRelPosix,
      indexExclude,
      config.indexDirAbs,
      stats,
    );

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

  logInfo('watcher', `started (polling=${config.usePolling} interval=${config.pollingIntervalMs}ms) on ${config.watchRootAbs}`);

  watcher.on('error', (error: unknown) => {
    const err = error as NodeJS.ErrnoException;
    logError('watcher', `error: ${err?.message ?? String(error)}`, error);
    if (err?.code === 'EMFILE') {
      logInfo(
        'watcher',
        'hint: use CODEBASE_MCP_USE_POLLING=true, ignore large dirs, or raise `ulimit -n`',
      );
    }
  });

  watcher.on('all', (event, rawPath) => {
    if (!rawPath) {
      return;
    }
    const filePath = path.resolve(rawPath);
    if (
      shouldIgnoreWatchPath(
        config.watchRootAbs,
        filePath,
        config.workingDocsPathsRelPosix,
        indexExclude,
        config.indexDirAbs,
        undefined,
      )
    ) {
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

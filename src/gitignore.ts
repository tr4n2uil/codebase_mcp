import fs from 'node:fs';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { toPosixPath } from './config.js';

const SAFETY_PATTERNS = [
  '.git/',
  '**/.git/**',
  'node_modules/',
  '**/node_modules/**',
  '*.pem',
  '.env',
  '.env.*',
];

export function createRootGitignoreFilter(watchRootAbs: string): Ignore {
  const ig = ignore();
  ig.add(SAFETY_PATTERNS);
  const gitignorePath = path.join(watchRootAbs, '.gitignore');
  try {
    const raw = fs.readFileSync(gitignorePath, 'utf8');
    ig.add(raw);
  } catch {
    // no .gitignore — safety patterns still apply
  }
  return ig;
}

/** Returns true if this path should be excluded (relative POSIX path from watch root). */
export function isIgnored(ig: Ignore, relPosix: string, isDirectory: boolean): boolean {
  // Empty = watch root (e.g. chokidar/polling may emit the root). Building `${''}/` would pass
  // '/' to `ignore`, which rejects non–path.relative() paths and throws RangeError.
  if (relPosix === '' || relPosix === '/') {
    return false;
  }
  const p = isDirectory && !relPosix.endsWith('/') ? `${relPosix}/` : relPosix;
  return ig.ignores(p);
}

export function normalizeIgnorePath(relPosix: string): string {
  return toPosixPath(relPosix.replace(/^\.\//, ''));
}

/** Gitignore-style patterns (repo-relative POSIX) applied only by codebase-mcp (not written to `.gitignore`). */
export function createIndexExcludeFilter(patterns: string[]): Ignore {
  const ig = ignore();
  for (const raw of patterns) {
    const t = raw.trim();
    if (t) {
      ig.add(t);
    }
  }
  return ig;
}

import path from 'node:path';
import { toPosixPath } from './config.js';

const TEXT_EXTENSIONS = new Set([
  'adoc',
  'bash',
  'c',
  'cc',
  'cfg',
  'cjs',
  'conf',
  'cpp',
  'css',
  'csv',
  'cxx',
  'dockerfile',
  'feature',
  'go',
  'graphql',
  'gql',
  'h',
  'hpp',
  'htm',
  'html',
  'ini',
  'java',
  'js',
  'jsx',
  'json',
  'kt',
  'md',
  'mdx',
  'mjs',
  'plist',
  'prisma',
  'proto',
  'py',
  'rb',
  'rake',
  'rbi',
  'gemspec',
  'rs',
  'rst',
  'scss',
  'sh',
  'sql',
  'svelte',
  'swift',
  'toml',
  'ts',
  'tsx',
  'tsv',
  'txt',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zsh',
]);

const BINARY_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'pdf',
  'zip',
  'gz',
  'tar',
  '7z',
  'rar',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'webm',
  'wasm',
  'so',
  'dylib',
  'dll',
  'exe',
  'bin',
  'pyc',
  'class',
  'jar',
  'lock',
]);

export function extensionOf(filePath: string): string {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    return '';
  }
  return base.slice(dot + 1).toLowerCase();
}

export function shouldConsiderExtension(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (base === 'dockerfile' || base === 'makefile' || base === 'rakefile' || base === 'gemfile') {
    return true;
  }
  const ext = extensionOf(filePath);
  if (BINARY_EXTENSIONS.has(ext)) {
    return false;
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    return true;
  }
  if (ext === '') {
    return ['dockerfile', 'makefile', 'gemfile', 'rakefile', 'license', 'notice', 'contributors', 'codeowners'].includes(base);
  }
  return false;
}

/** Hard safety rules in addition to .gitignore */
export function isSafetyIgnored(relPosix: string): boolean {
  const segments = relPosix.split('/');
  if (segments.some((s) => s === '.git' || s === 'node_modules')) {
    return true;
  }
  const lower = relPosix.toLowerCase();
  if (lower.endsWith('.pem') || lower.endsWith('.key') || lower.endsWith('.p12') || lower.endsWith('.pfx')) {
    return true;
  }
  if (lower.endsWith('.env') || lower.endsWith('.env.local') || lower.endsWith('.env.production')) {
    return true;
  }
  return false;
}

export function relativePosix(fromRootAbs: string, fileAbs: string): string {
  return toPosixPath(path.relative(fromRootAbs, fileAbs));
}

/**
 * True when `absPath` is exactly `indexDirAbs` or inside it (LanceDB, `meta.json`, `.logs/`).
 * Corpus indexing skips these paths so we never embed the vector store itself.
 */
export function isUnderIndexDataDir(absPath: string, indexDirAbs: string): boolean {
  const child = path.resolve(absPath);
  const root = path.resolve(indexDirAbs);
  if (child === root) {
    return true;
  }
  const sep = path.sep;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return child.startsWith(prefix);
}

import { isCoveredByForceInclude } from './force-include.js';
import type { SearchHit } from './store.js';

export type QueryClassifier = 'auto' | 'code' | 'config' | 'docs';

/** Chunks are grouped loosely for retrieval biasing — not a strict file-type system. */
export type HitContentBucket = 'code' | 'config' | 'docs';

const VALID_CLASSIFIERS = new Set<QueryClassifier>(['auto', 'code', 'config', 'docs']);

const DOC_EXTS = new Set(['md', 'mdx', 'markdown', 'rst', 'adoc']);

const CONFIG_EXTS = new Set([
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'tf',
  'tfvars',
  'hcl',
  'properties',
  'ini',
  'cfg',
  'conf',
]);

function fileBaseAndExt(relPath: string): { base: string; ext: string } {
  const norm = relPath.replace(/\\/g, '/');
  const seg = norm.split('/').pop() ?? norm;
  const dot = seg.lastIndexOf('.');
  if (dot <= 0) {
    return { base: seg.toLowerCase(), ext: '' };
  }
  return { base: seg.slice(0, dot).toLowerCase(), ext: seg.slice(dot + 1).toLowerCase() };
}

function looksLikeEnvFile(base: string): boolean {
  const b = base.toLowerCase();
  return b.startsWith('.env') || b === 'env' || b.endsWith('.env');
}

function trimmedLower(s: string | undefined): string | undefined {
  const t = s?.trim().toLowerCase();
  return t && t.length > 0 ? t : undefined;
}

/**
 * `query_classifier` and `search_focus` are aliases; at most one should be set, or both must agree.
 */
export function resolveQueryClassifierInput(args: {
  query_classifier?: string;
  search_focus?: string;
}): { ok: true; value: QueryClassifier } | { ok: false; error: string } {
  const a = trimmedLower(args.query_classifier);
  const b = trimmedLower(args.search_focus);
  if (a && b && a !== b) {
    return {
      ok: false,
      error:
        'query_classifier and search_focus disagree; pass only one (values: auto, code, config, docs).',
    };
  }
  const raw = (a ?? b ?? 'auto') as string;
  if (!VALID_CLASSIFIERS.has(raw as QueryClassifier)) {
    const shown = args.query_classifier ?? args.search_focus ?? raw;
    return {
      ok: false,
      error: `Unknown query_classifier "${shown}". Use auto | code | config | docs.`,
    };
  }
  return { ok: true, value: raw as QueryClassifier };
}

export function hitContentBucket(relPath: string, workingDocsPrefixes: string[]): HitContentBucket {
  if (workingDocsPrefixes.length > 0 && isCoveredByForceInclude(relPath, workingDocsPrefixes)) {
    return 'docs';
  }
  const { base, ext } = fileBaseAndExt(relPath);
  if (ext && CONFIG_EXTS.has(ext)) {
    return 'config';
  }
  if (looksLikeEnvFile(base)) {
    return 'config';
  }
  if (ext && DOC_EXTS.has(ext)) {
    return 'docs';
  }
  if (ext === 'txt' && (base === 'readme' || base === 'changelog' || base === 'contributing')) {
    return 'docs';
  }
  return 'code';
}

/**
 * Additive rerank bump when the agent sets an explicit search focus (`query_classifier` / `search_focus`).
 * Keeps scores on the same scale as other path priors in `rerank.ts`.
 */
export function queryClassifierPrior(bucket: HitContentBucket, focus: QueryClassifier): number {
  if (focus === 'auto') {
    return 0;
  }
  if (focus === bucket) {
    return 0.16;
  }
  if (focus === 'code') {
    return bucket === 'config' ? -0.1 : -0.14;
  }
  if (focus === 'config') {
    if (bucket === 'code') {
      return -0.07;
    }
    return -0.11;
  }
  /* focus === 'docs' */
  if (bucket === 'code') {
    return -0.09;
  }
  return -0.06;
}

/** When heuristic rerank is disabled, bias ordering using hybrid `score` + classifier prior only. */
export function applyQueryClassifierPrimarySort(
  hits: SearchHit[],
  focus: QueryClassifier,
  workingDocs: string[],
): SearchHit[] {
  if (focus === 'auto') {
    return hits;
  }
  return [...hits].sort((a, b) => {
    const pa = queryClassifierPrior(hitContentBucket(a.path, workingDocs), focus);
    const pb = queryClassifierPrior(hitContentBucket(b.path, workingDocs), focus);
    const sa = a.score + pa;
    const sb = b.score + pb;
    if (sb !== sa) {
      return sb - sa;
    }
    return b.score - a.score;
  });
}

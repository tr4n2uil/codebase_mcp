import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SymbolSpan } from './chunker-symbols.js';
import { hasRipperScriptOnDisk, ripperDefinitionsScriptPath } from './ripper-path.js';
import { logInfo } from './log.js';

/** Bump when `scripts/ripper_definitions.rb` output shape or logic changes. */
const RIPPER_CACHE_VERSION = 2;
const RIPPER_CACHE_MAX = 2_000;

const ripperResultCache = new Map<string, SymbolSpan[] | 'fail'>();
let rubyProbe: Promise<boolean> | null = null;
let didLogRipperUnavailable = false;
let didLogRipperScriptMissing = false;

function cacheKey(
  contentHash: string,
  maxBytes: number,
  timeoutMs: number,
  scriptPath: string,
): string {
  return `${RIPPER_CACHE_VERSION}\0${contentHash}\0${maxBytes}\0${timeoutMs}\0${scriptPath}`;
}

function cacheSet(key: string, value: SymbolSpan[] | 'fail'): void {
  if (ripperResultCache.size >= RIPPER_CACHE_MAX) {
    const first = ripperResultCache.keys().next();
    if (!first.done) {
      ripperResultCache.delete(first.value);
    }
  }
  ripperResultCache.set(key, value);
}

/** Probes `ruby` once per process. */
export function probeRubyAvailable(ruby: string = 'ruby'): Promise<boolean> {
  if (rubyProbe) {
    return rubyProbe;
  }
  rubyProbe = (async () => {
    try {
      await execFile(ruby, ['-e', 'exit 0'], { timeout: 3_000, windowsHide: true });
      return true;
    } catch {
      return false;
    }
  })();
  return rubyProbe;
}

function parseRipperJson(s: string): SymbolSpan[] {
  const t = s.trim();
  if (!t || t.length === 0) {
    return [];
  }
  const arr = JSON.parse(t) as unknown;
  if (!Array.isArray(arr)) {
    return [];
  }
  const out: SymbolSpan[] = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object') {
      continue;
    }
    const o = x as Record<string, unknown>;
    const line = o.line;
    const name = o.name;
    const kind = o.kind;
    if (typeof line !== 'number' || !Number.isFinite(line) || line < 1) {
      continue;
    }
    if (typeof name !== 'string' || name.length === 0) {
      continue;
    }
    if (typeof kind !== 'string' || kind.length === 0) {
      continue;
    }
    out.push({ name, kind, startLine: Math.floor(line) });
  }
  return out;
}

export type RubyRipperCallArgs = {
  content: string;
  contentHash: string;
  ruby: string;
  scriptPath: string;
  maxBytes: number;
  timeoutMs: number;
};

/**
 * Returns declaration spans for a Ruby file via Ripper subprocess, or `[]` on any failure
 * (caller falls back to regex).
 */
export async function getRubyDefinitionSpansViaRipper(args: RubyRipperCallArgs): Promise<SymbolSpan[]> {
  if (args.content.length > args.maxBytes) {
    return [];
  }
  if (!hasRipperScriptOnDisk()) {
    if (!didLogRipperScriptMissing) {
      didLogRipperScriptMissing = true;
      logInfo('chunker', `Ripper: script missing at ${args.scriptPath} (using regex for Ruby only)`);
    }
    return [];
  }

  const key = cacheKey(args.contentHash, args.maxBytes, args.timeoutMs, args.scriptPath);
  const hit = ripperResultCache.get(key);
  if (hit) {
    return hit === 'fail' ? [] : hit;
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'codebase-mcp-rip-'));
  const fpath = path.join(dir, 'in.rb');
  try {
    await writeFile(fpath, args.content, 'utf8');
    const { stdout } = await execFile(
      args.ruby,
      [args.scriptPath, fpath],
      {
        timeout: args.timeoutMs,
        maxBuffer: 12 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8' as const,
      },
    );
    const spans = parseRipperJson(String(stdout));
    cacheSet(key, spans);
    return spans;
  } catch (e) {
    cacheSet(key, 'fail');
    if (!didLogRipperUnavailable) {
      didLogRipperUnavailable = true;
      const msg = e instanceof Error ? e.message : String(e);
      logInfo('chunker', `Ripper: first failure (${msg}) — using regex for Ruby until restart`);
    }
    return [];
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

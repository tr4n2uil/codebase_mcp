function toPosixRel(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Split on comma or newline; normalize to repo-relative POSIX paths (no leading `./`). */
export function parseForceIncludeList(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,\n]/)) {
    const t = part.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!t || seen.has(t)) {
      continue;
    }
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Same parsing as `parseForceIncludeList` — for `CODEBASE_MCP_INDEX_EXCLUDE`. */
export function parseIndexExcludeList(raw: string | undefined): string[] {
  return parseForceIncludeList(raw);
}

/** True if `descendant` is `ancestor` or a path under `ancestor/` (POSIX, no trailing slash on either). */
function isUnderSubtree(ancestor: string, descendant: string): boolean {
  const a = ancestor.replace(/\/+$/, '');
  const d = descendant.replace(/\/+$/, '');
  return d === a || d.startsWith(`${a}/`);
}

/**
 * True when this repo-relative path should bypass .gitignore (and watcher segment skips)
 * because it lies on the path to or inside a forced-include entry.
 */
export function isCoveredByForceInclude(relPosix: string, includes: string[]): boolean {
  if (includes.length === 0) {
    return false;
  }
  const rel = toPosixRel(relPosix).replace(/^\.\/+/, '').replace(/\/+$/, '');
  return includes.some((inc) => {
    const ip = inc.replace(/^\.\/+/, '').replace(/\/+$/, '') || inc;
    if (!ip) {
      return false;
    }
    return isUnderSubtree(ip, rel) || isUnderSubtree(rel, ip);
  });
}

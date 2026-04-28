#!/usr/bin/env node
/**
 * Registers the codebase MCP in Claude Code: resolves `dist/main.js` (works with `npm -g` or npx)
 * and runs `claude mcp add` with `CODEBASE_MCP_ROOT` from the environment or the current working directory.
 *
 * **Idempotent:** runs `claude mcp remove --scope user` for `codebase_mcp` first (ignores failure if it was
 * not configured), then `claude mcp add` with the current env and `main.js` path so repeat runs refresh the entry.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_NAME = 'codebase_mcp';
const SCOPE = 'user';

const here = dirname(fileURLToPath(import.meta.url));
const mainJs = resolve(here, 'main.js');
if (!existsSync(mainJs)) {
  console.error(`claude-mcp-install: could not find main.js at ${mainJs}.`);
  process.exit(1);
}
const codeRoot = process.env.CODEBASE_MCP_ROOT?.trim()
  ? resolve(process.env.CODEBASE_MCP_ROOT.trim())
  : process.cwd();

function claude(args: string[], stdio: 'inherit' | 'pipe'): ReturnType<typeof spawnSync> {
  return spawnSync('claude', args, { stdio, env: process.env, shell: false });
}

/** Best-effort: clear an existing user-scoped entry so `add` always succeeds. */
claude(['mcp', 'remove', '--scope', SCOPE, SERVER_NAME], 'pipe');

const r = claude(
  [
    'mcp',
    'add',
    SERVER_NAME,
    '--scope',
    SCOPE,
    '-e',
    `CODEBASE_MCP_ROOT=${codeRoot}`,
    '--',
    'node',
    mainJs,
  ],
  'inherit',
);
if (r.error) {
  console.error(
    'claude-mcp-install: failed to run claude. Install Claude Code CLI and ensure `claude` is on your PATH.',
  );
  console.error((r.error as Error).message);
  process.exit(1);
}
if (r.status != null && r.status !== 0) {
  process.exit(r.status);
}

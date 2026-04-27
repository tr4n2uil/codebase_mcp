#!/usr/bin/env node
/**
 * CLI: send `reindex` to a running `codebase-mcp-daemon` (same `CODEBASE_MCP_ROOT` / index dir).
 * Does not start the daemon. For `CODEBASE_MCP_NO_DAEMON=1` (inline MCP + indexer), use reconciles
 * via the running process or touch files; this path expects the Unix socket / named pipe.
 */
import { loadConfig } from './config.js';
import { DaemonClient } from './daemon-client.js';
import { getDaemonListenPath } from './daemon-paths.js';

function printUsage(): void {
  const msg = `Usage: codebase-mcp-reindex [path]

  path   Optional. Repo-relative or absolute file to reindex. Omit for full reconcile.

  Requires: indexer daemon for this index (see README). Same env as the daemon, at minimum:
  CODEBASE_MCP_ROOT  Absolute path to the repo

  Optional: CODEBASE_MCP_INDEX_DIR  Override index directory (default: <repo>/.claude/codebase_mcp/db)
`;
  process.stdout.write(msg);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    /* full reconcile */
  } else if (argv[0] === '-h' || argv[0] === '--help') {
    printUsage();
    process.exit(0);
  } else if (argv[0]!.startsWith('-')) {
    process.stderr.write(`Unknown option: ${argv[0]}\n\n`);
    printUsage();
    process.exit(1);
  } else if (argv.length > 1) {
    process.stderr.write('Too many arguments. Pass a single file path, or none for full reconcile.\n\n');
    printUsage();
    process.exit(1);
  }

  const filePath = argv.length > 0 ? argv[0]! : undefined;

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    process.stderr.write(e instanceof Error ? `${e.message}\n` : String(e));
    process.exit(1);
    return;
  }

  const listenPath = getDaemonListenPath(config.indexDirAbs);
  let client: DaemonClient;
  try {
    client = await DaemonClient.connect(listenPath, 15_000);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    process.stderr.write(
      `Could not connect to the indexer daemon at:\n  ${listenPath}\n` +
        `Error: ${err}\n\n` +
        `Start the daemon (same CODEBASE_MCP_ROOT / index dir), e.g.:\n` +
        `  npx -y -p @tr4n2uil/codebase-mcp@latest -- codebase-mcp-daemon\n`,
    );
    process.exit(1);
    return;
  }

  try {
    const payload = filePath ? { path: filePath } : {};
    const resp = await client.call('reindex', payload);
    if (!resp.ok) {
      process.stderr.write(`reindex failed: ${resp.error}\n`);
      process.exit(1);
      return;
    }
    const result = resp.result as { content?: { type: string; text: string }[] };
    const first = result?.content?.[0];
    if (first?.type === 'text' && first.text) {
      process.stdout.write(`${first.text}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(resp.result, null, 2)}\n`);
    }
  } finally {
    client.destroy();
  }
}

void main().catch((e) => {
  process.stderr.write(e instanceof Error ? e.stack ?? e.message : String(e));
  process.stderr.write('\n');
  process.exit(1);
});

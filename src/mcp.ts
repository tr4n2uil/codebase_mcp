import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import type { AppConfig } from './config.js';
import type { Indexer } from './indexer.js';
import type { ChunkStore } from './store.js';
import type { CodebaseSearchArgs, McpTextContent } from './mcp-tools.js';
import {
  runCodebaseSearch,
  runCodebaseStats,
  runCodebaseStatsFromStore,
  runCodebaseReindex,
} from './mcp-tools.js';
import { DaemonClient } from './daemon-client.js';
import { logInfo } from './log.js';

type ToolResult = { content: McpTextContent[] };

function wrapToolLogging(config: AppConfig, backend: CodebaseMcpBackend): CodebaseMcpBackend {
  if (!config.logMcpTools) {
    return backend;
  }
  return {
    codebase_search: async (args) => {
      logInfo('mcp', 'tool codebase_search');
      return backend.codebase_search(args);
    },
    codebase_stats: async () => {
      logInfo('mcp', 'tool codebase_stats');
      return backend.codebase_stats();
    },
    codebase_reindex: async (args) => {
      logInfo('mcp', `tool codebase_reindex path=${args.path ?? '(reconcile all)'}`);
      return backend.codebase_reindex(args);
    },
  };
}

export interface CodebaseMcpBackend {
  codebase_search(args: CodebaseSearchArgs): Promise<ToolResult>;
  codebase_stats(): Promise<ToolResult>;
  codebase_reindex(args: { path?: string }): Promise<ToolResult>;
}

export function createLocalMcpBackend(
  config: AppConfig,
  indexer: Indexer,
  store: ChunkStore,
): CodebaseMcpBackend {
  return {
    codebase_search: (args) => runCodebaseSearch(config, store, args),
    codebase_stats: () => runCodebaseStats(indexer, store),
    codebase_reindex: (args) => runCodebaseReindex(config, indexer, args),
  };
}

export const DAEMON_REINDEX_HOWTO =
  'The indexer daemon is not running, so reindex is unavailable. ' +
  'From your repository root, start the daemon the same way as in the package README (e.g. `codebase-mcp-daemon`), ' +
  'using the same project root as this MCP.';

/**
 * Default MCP mode: search + stats run locally (LanceDB read + local query embedding);
 * `codebase_reindex` uses the daemon IPC if a client was connected at startup; otherwise
 * reindex returns instructions to start the daemon manually.
 */
export function createSharedDaemonMcpBackend(
  config: AppConfig,
  store: ChunkStore,
  client: DaemonClient | null,
): CodebaseMcpBackend {
  const mapError = (error: string): ToolResult => ({
    content: [{ type: 'text' as const, text: `Daemon error: ${error}` }],
  });
  return {
    codebase_search: (args) => runCodebaseSearch(config, store, args),
    codebase_stats: () => runCodebaseStatsFromStore(config, store),
    codebase_reindex: async (args) => {
      if (!client) {
        return { content: [{ type: 'text' as const, text: DAEMON_REINDEX_HOWTO }] };
      }
      const resp = await client.call('reindex', args);
      if (!resp.ok) {
        return mapError(resp.error);
      }
      return resp.result as ToolResult;
    },
  };
}

export async function runMcpServer(config: AppConfig, backend: CodebaseMcpBackend): Promise<void> {
  const b = wrapToolLogging(config, backend);
  const server = new McpServer({
    name: 'codebase-mcp',
    version: '1.0.0',
  });
  const codebaseSearchDescription =
    'Semantic search over the indexed repository: query embedded in-process; returns chunks (path, lines, snippet, scores, optional `match_confidence` / `definition_of`). Unscoped search may drop “working docs” (e.g. under `.claude/docs`); use optional args to scope, include those paths, or filter by file shape. Several filters together use AND.';
  const codebaseSearchInputSchema = {
    query: z.string().min(1).describe('Search text'),
    limit: z.number().int().min(1).max(50).optional().describe('Result cap (default 10)'),
    path_prefix: z.string().optional().describe('Repo-relative path prefix (POSIX)'),
    include_docs: z
      .boolean()
      .optional()
      .describe('When true, unscoped search also searches working-doc trees; ignored if `path_prefix` is set'),
    ext: z
      .union([z.string().min(1), z.array(z.string().min(1))])
      .optional()
      .describe('Allow only these file extensions (comma-separated or list)'),
    lang: z
      .string()
      .optional()
      .describe('Known language name (e.g. `ruby`); unknown → error'),
    glob: z
      .string()
      .optional()
      .describe('Glob filter (grep-like): `*.rb` matches nested Ruby files too; path globs like `app/**/*.rb` also work'),
  };

  server.registerTool(
    'codebase_search',
    {
      description: codebaseSearchDescription,
      inputSchema: codebaseSearchInputSchema,
    },
    async (args) => b.codebase_search(args),
  );
  server.registerTool(
    'codebase_find',
    {
      description: 'Alias of `codebase_search` for discoverability by code-search oriented agents.',
      inputSchema: codebaseSearchInputSchema,
    },
    async (args) => b.codebase_search(args),
  );

  server.registerTool(
    'codebase_stats',
    {
      description: 'Statistics about the local vector index for the configured repository.',
      inputSchema: {},
    },
    async () => b.codebase_stats(),
  );

  server.registerTool(
    'codebase_reindex',
    {
      description: 'Reindex the repository (requires the indexer daemon to be running — start it manually with the codebase-mcp-daemon npx command from the README; same env as MCP). Omit path for full reconcile.',
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe('Omit: reconcile the full repo. Set: reindex this file (repo-relative or absolute)'),
      },
    },
    async (args) => b.codebase_reindex(args),
  );

  const transport = new StdioServerTransport();
  logInfo('mcp', 'connecting stdio transport (waits for MCP client messages)');
  await server.connect(transport);
}

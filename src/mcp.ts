import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import type { AppConfig } from './config.js';
import type { Indexer } from './indexer.js';
import type { ChunkStore } from './store.js';
import type { McpTextContent } from './mcp-tools.js';
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
  codebase_search(args: { query: string; limit?: number; path_prefix?: string }): Promise<ToolResult>;
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
  'In a terminal, with CODEBASE_MCP_ROOT (and optional CODEBASE_MCP_INDEX_DIR) set to the same values as the MCP, run: ' +
  'npx -y -p @tr4n2uil/codebase-mcp@latest -- codebase-mcp-daemon';

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

  server.registerTool(
    'codebase_search',
    {
      description:
        'Semantic search over the indexed repository (LanceDB read in this process; query embedded locally). Set CODEBASE_MCP_ROOT to the repo root. Vector data defaults to <repo>/.claude/codebase_mcp/db (override with CODEBASE_MCP_INDEX_DIR). Start the indexer daemon separately (see codebase_reindex) so it can index and write the DB. JSON includes heuristic match quality fields: match_confidence (high|medium|low), match_confidence_reasons, match_confidence_hint, top_primary_score, top_relative_separation (omit with CODEBASE_MCP_MATCH_CONFIDENCE=0). Chunks may include definition_of when indexed with code-aware chunking (boosts “where is X defined?” style queries; see CODEBASE_MCP_DEF_BOOST).',
      inputSchema: {
        query: z.string().min(1).describe('Natural language search query'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
        path_prefix: z
          .string()
          .optional()
          .describe('Only chunks whose path starts with this prefix (POSIX, relative to repo root)'),
      },
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
      description:
        'Reindex the repository (requires the indexer daemon to be running — start it manually with the codebase-mcp-daemon npx command from the README; same env as MCP). Omit path for full reconcile.',
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe('Path to a file under the repo (absolute or relative to repo root)'),
      },
    },
    async (args) => b.codebase_reindex(args),
  );

  const transport = new StdioServerTransport();
  logInfo('mcp', 'connecting stdio transport (waits for MCP client messages)');
  await server.connect(transport);
}

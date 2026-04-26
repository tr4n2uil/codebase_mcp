import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import type { AppConfig } from './config.js';
import type { Indexer } from './indexer.js';
import type { ChunkStore } from './store.js';
import type { McpTextContent } from './mcp-tools.js';
import { runCodebaseSearch, runCodebaseStats, runCodebaseReindex } from './mcp-tools.js';
import { DaemonClient } from './daemon-client.js';

type ToolResult = { content: McpTextContent[] };

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

export function createRemoteMcpBackend(client: DaemonClient): CodebaseMcpBackend {
  const mapError = (error: string): ToolResult => ({
    content: [{ type: 'text' as const, text: `Daemon error: ${error}` }],
  });
  return {
    codebase_search: async (args) => {
      const resp = await client.call('search', args);
      if (!resp.ok) {
        return mapError(resp.error);
      }
      return resp.result as ToolResult;
    },
    codebase_stats: async () => {
      const resp = await client.call('stats');
      if (!resp.ok) {
        return mapError(resp.error);
      }
      return resp.result as ToolResult;
    },
    codebase_reindex: async (args) => {
      const resp = await client.call('reindex', args);
      if (!resp.ok) {
        return mapError(resp.error);
      }
      return resp.result as ToolResult;
    },
  };
}

export async function runMcpServer(config: AppConfig, backend: CodebaseMcpBackend): Promise<void> {
  const server = new McpServer({
    name: 'codebase-mcp',
    version: '1.0.0',
  });

  server.registerTool(
    'codebase_search',
    {
      description:
        'Semantic search over the indexed repository. Set CODEBASE_MCP_ROOT to the repo root; indexing respects .gitignore unless paths are listed in CODEBASE_MCP_FORCE_INCLUDE. Vector data defaults to tools/codebase-mcp/db/<repo>/ (override with CODEBASE_MCP_INDEX_DIR).',
      inputSchema: {
        query: z.string().min(1).describe('Natural language search query'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
        path_prefix: z
          .string()
          .optional()
          .describe('Only chunks whose path starts with this prefix (POSIX, relative to repo root)'),
      },
    },
    async (args) => backend.codebase_search(args),
  );

  server.registerTool(
    'codebase_stats',
    {
      description: 'Statistics about the local vector index for the configured repository.',
      inputSchema: {},
    },
    async () => backend.codebase_stats(),
  );

  server.registerTool(
    'codebase_reindex',
    {
      description:
        'Reindex the repository. Omit path to run a full reconcile (scan disk, remove stale paths, reindex changed files).',
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe('Path to a file under the repo (absolute or relative to repo root)'),
      },
    },
    async (args) => backend.codebase_reindex(args),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

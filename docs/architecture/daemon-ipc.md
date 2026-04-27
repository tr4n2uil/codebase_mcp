# Daemon IPC

When the **indexing daemon** is running, MCP clients that successfully connect to its socket can ask for **`reindex`**. Search and stats do **not** go through IPC; they use **read-only** Lance in the MCP process.

## Transport

- **Unix domain socket** (non-Windows) at `getDaemonListenPath(CODEBASE_MCP_INDEX_DIR)` under `.codebase-mcp-daemon/` (see `daemon-paths.ts`).
- **Windows** — uses a **named pipe** (same helper abstraction in code).

## Protocol

- **Newline-delimited JSON** — Each message is one JSON object per line (`encodeMessage` / `parseLine` in `ipc-protocol.ts`). `IpcCmd` is `ping` | `reindex`; each request/response has an `id` and `ok` + `result` or `error` on the wire.
- **Commands** — **`ping`** (health), **`reindex`** (optional payload with `path` for single file).

## Lifecycle

- **`runIndexingDaemon`** ( `run-indexing-daemon.ts` ) **starts the IPC server early**; `bootstrapIndexing` may still be in flight (so reindex can wait for the indexer to be ready; see server logs and connect timeouts in `daemon-client.ts` / `daemon-connect.ts` ).
- **Duplicate daemons** — If a socket is already live and answers **`ping`**, a second start exits **0** (idempotent) to avoid two writers.
- **Shutdown** — SIGINT/SIGTERM closes the IPC server and the watcher, then exits.

## MCP connection strategy

- `tryConnectDaemonClient` (and related) attempt a **bounded** connect + ping; on failure, MCP still runs, but `codebase_reindex` (full or single file) may return `DAEMON_REINDEX_HOWTO` instead of running work.

## Related code

| File | Role |
|------|------|
| `run-indexing-daemon.ts` | Bootstrap, reconcile interval, IPC server startup |
| `daemon-server.ts` | Accept connections, parse lines, call indexer, error handling (EPIPE-safe writes) |
| `daemon-client.ts` | `call` / `destroy`, timeouts |
| `daemon-connect.ts` | `tryConnectDaemonClient` for MCP startup |
| `mcp.ts` / `mcp-tools.ts` | `createSharedDaemonMcpBackend`, reindex over IPC |
| `ipc-protocol.ts` | Message contracts |

## Diagram (logical)

```mermaid
flowchart LR
  MCP[stdio MCP] -->|optional| SOCK[.codebase-mcp-daemon socket]
  SOCK --> SRV[daemon-server]
  SRV --> IDX[Indexer.reconcile or schedule file]
  IDX --> L[(Lance write)]
```

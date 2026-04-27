# Observability & logging

## Streams

- **stderr** — MCP and daemon use structured-ish **prefix logs** from `log.ts` (`logInfo`, `logError`, …) for operational messages: bootstrap, per-file index progress, embedding heartbeats, tool calls (when `CODEBASE_MCP_LOG_TOOLS` is on), and IPC.

## File mirroring

- **`logger.ts`** — When the index directory exists, stdio and stderr can be **mirrored** to:
  - **`<index>/.logs/mcp.log`** — MCP (stdio) process
  - **`<index>/.logs/daemon.log`** — daemon / `--daemon` process  
  Lines are prefixed with **`[pid=…] `** so restarts and multiple processes are distinguishable. See the root FAQ in **README** for the exact layout.

## Fatal diagnostics

- **`registerFatalProcessLogging()`** (from `main` / `daemon-cli`) logs **uncaughtException** and **unhandledRejection** with stack to help debug crashes during ONNX or IPC.

## Related code

- `log.ts` — `logInfo`, `logError`, `logWarn`
- `logger.ts` — `initFileLogging`, mirror stream, `registerFatalProcessLogging`

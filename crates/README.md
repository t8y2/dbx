# Crates

Rust crates for DBX live here.

## Directories

- `dbx-core/` - application orchestration: connections, queries, schema operations, data workflows, AI tools, administration, persistence, safety, and host services.
- `dbx-types/` - shared connection, query, metadata, and serialization contracts; generated database identities.
- `dbx-sql/` - SQL parsing, dialects, analysis, risk classification, DDL/DML generation, and schema diff planning.
- `dbx-drivers/` - native database adapters, database Agents, tunnels, execution budgets, and driver lifecycle.
- `dbx-formats/` - data formatting and file encoders, independent of database connections.
- `dbx-ai-provider/` - AI provider clients, CLI adapters, streaming, and token usage.
- `dbx-plugin-runtime/` - plugin packages, signatures, marketplace, subprocess sessions, and host requests.
- `dbx-platform/` - shared process, path, proxy, download, version, and host-prompt primitives.
- `dbx-web/` - the Docker/web backend service binary published as `dbx-web`.
- `dbx-cli/` - the command-line application.
- `dbx-mcp/` - the MCP service library and binary.
- `dbx-sqlite-worker/` - the isolated SQLite file-host worker and protocol.

The workspace root is defined in the repository-level `Cargo.toml`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for dependency rules, compatibility exports, feature selection, and validation commands.

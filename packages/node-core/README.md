# DBX Node Core

Shared Node.js runtime utilities for DBX CLI and DBX MCP Server.

This package reads DBX Desktop connection storage, redacts connection summaries, builds schema context, applies SQL safety rules, and executes supported direct database queries.

## Supported Runtime

Requires Node.js 22.13.0 or newer.

## Direct Query Support

Direct execution currently supports:

- PostgreSQL and Redshift
- MySQL-compatible databases, including MySQL, Doris, and StarRocks
- SQLite

Other DBX connection types can be routed through DBX Desktop bridge integrations used by the CLI and MCP server.

## Public Modules

```ts
import { createBackend, loadConnections, getDbxDiagnostics, evaluateSqlSafety, buildSchemaContext } from "@dbx-app/node-core";
```

The package is intended as a shared implementation layer for official DBX Node packages. Applications should prefer `@dbx-app/cli` for terminal workflows and `@dbx-app/mcp-server` for MCP clients.

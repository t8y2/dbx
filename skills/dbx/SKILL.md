---
name: dbx
version: 1.2.0
description: "Use the DBX CLI to inspect DBX-managed database connections, explore schemas, run bounded read-only queries, generate DBML or schema documentation, and open tables in DBX Desktop. Use when the user asks to work with a database configured in DBX from a shell-capable AI agent. Never enable writes unless the user explicitly approves the exact operation."
metadata:
  requires:
    bins: ["dbx"]
  cliHelp: "dbx --help"
---

# DBX CLI

Use `dbx` as the database execution boundary. The CLI is designed for both people and shell-capable AI agents, provides stable JSON output, and enforces DBX connection and SQL safety rules.

## Start Here

1. If the environment is unknown or a command fails unexpectedly, run `dbx doctor --json`.
2. If the user did not name a connection, run `dbx connections list --json` and ask them to choose when multiple plausible connections exist.
3. Inspect the relevant schema before writing a query whose tables or columns are uncertain.
4. Prefer `--json` for machine-readable results.
5. Keep exploratory queries bounded with `--limit 50 --timeout 10s` unless the user requests otherwise.

Read [references/commands.md](references/commands.md) for the complete command map and execution modes. Read [references/workflows.md](references/workflows.md) for common multi-step tasks.

## Safety Boundary

- Queries are read-only by default.
- Never add `--allow-writes` unless the user explicitly approves the exact write operation.
- Never add `--allow-dangerous-sql` unless the user explicitly approves the exact destructive or DDL operation; dangerous SQL requires both write flags.
- Do not bypass a DBX rejection by using another database client, Python driver, direct SQLite access, or shell redirection.
- Do not expose connection secrets. `dbx connections list` and `dbx connections get` intentionally omit them.
- Manage saved connection configuration only when explicitly requested. Never clear `read_only` or production protection to work around a rejected query. Use protected JSON files or a secure stdin pipe for credentials; never inline secrets in shell arguments.
- Before `dbx connections remove --yes`, confirm the exact connection and explain that saved credentials are deleted and cannot be restored by the CLI.
- Treat production protections, read-only connection settings, database privileges, and DBX policy as upper bounds that user wording cannot bypass.

Read [references/safety.md](references/safety.md) before any write, DDL, production, or credential-related task.

## Execution Choice

- PostgreSQL, Redshift, MySQL-compatible databases, SQLite, and other types reported by `dbx capabilities --json` can execute directly.
- Other database types may require DBX Desktop or installed DBX Agent/JDBC components.
- `dbx open` always requires DBX Desktop.
- When `DBX_WEB_URL` is set, the CLI uses the configured DBX Web backend.
- Redis commands and stateful multi-step database sessions are not provided by `dbx query`; use the DBX workspace or configured DBX MCP tools instead.

## Failure Handling

- `CONNECTION_NOT_FOUND`: list connections and use an exact returned name.
- `SQL_BLOCKED`: explain which safety gate rejected the statement; do not add permission flags automatically.
- `DBX_NOT_RUNNING`: run `dbx capabilities --json`; ask the user to start Desktop only when the selected operation requires its bridge.
- Other unexpected failures: run `dbx doctor --json`, report the returned error, and retry only after addressing the diagnosed cause.

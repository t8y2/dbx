# DBX CLI Safety Rules

## Read Operations

- Prefer explicit columns over `SELECT *` when the schema is known.
- Use a row limit and timeout for exploratory queries.
- Confirm the connection and database before querying when the user's target is ambiguous.
- Do not print connection passwords, tokens, or encrypted secret payloads.

## Write Operations

Before adding `--allow-writes`:

1. Show or summarize the exact statement and target connection.
2. Obtain explicit approval for that operation.
3. Verify the statement has a narrow predicate when modifying or deleting rows.
4. Preserve the CLI's row, timeout, production, read-only connection, and database privilege checks.

Do not interpret general statements such as "do whatever is needed" as approval for an unspecified database write.

## Dangerous SQL and DDL

`DROP`, `TRUNCATE`, `ALTER`, and equivalent dangerous operations require both `--allow-writes` and `--allow-dangerous-sql`. Obtain explicit approval for the exact operation and object before using either flag.

## Blocked Operations

If DBX returns `SQL_BLOCKED`, a production restriction, or a read-only error:

- Do not switch to another client or driver to bypass the restriction.
- Do not rewrite the statement to conceal its risk classification.
- Explain the rejection and ask the user to choose a permitted alternative.

Explicit transaction statements and stateful multi-step sessions are not supported by `dbx query`. Use DBX MCP stateful sessions or the DBX editor when the task genuinely requires a pinned session.

## Connection Bundle Imports

- Preview the exact export with `dbx connections import --file <path> --json`; add `--yes` only after the user approves applying that reviewed file
- Keep export contents and passphrases out of chat, argv, logs, and source control. Use owner-only files or the supported non-interactive secure stdin path; encrypted exports use `--passphrase-file`
- Do not weaken MCP read-only mode, tool allowlists, or connection scope to make import succeed
- Imports add saved configuration only. Do not claim imported endpoints work: no credential test, database connection, file copy, or driver installation occurs

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

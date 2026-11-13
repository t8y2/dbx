# SQL command console: release and compatibility notes

## Safety

- Console submissions use the shared read-only write-unlock and production SQL
  guards. Non-production dangerous SQL uses the same confirmation preference and
  danger dialog as the SQL editor. Production confirmation cannot be disabled by
  that preference and replaces the optional danger prompt, as in the editor.
- A console keeps its physical session between submissions, so server-side `USE`
  may differ from the database shown on its tab. Any production database marker
  therefore requires production confirmation for all mutations on that console's
  connection, even when the displayed database is not marked.
- Confirmation reviews the original input (or the SQL expanded by a standalone
  `/` or `RUN`). Safety classification separates actual statement boundaries and
  ignores client-only/read-metadata commands, so `DESC` or quoted `PROMPT` text
  cannot hide a following write. `EXEC`, `EXECUTE` and batch `RUN` remain reviewed.
- Declining an unlock/confirmation retains the command echo and adds a terminal
  notice that no SQL was sent. It does not add execution history or replace the
  last successful rerun target. A subsequent `/` or `RUN` reviews that successful
  target again; approval is not reused for a later submission.
- Cancellation, closing the tab or changing its execution context invalidates
  pending review and dismisses only that submission's dialogs. It cannot send the
  previously reviewed SQL to the replacement context.

## Shared-core behavior change

Client-command resolution is part of the core SQL execute path, not a terminal-UI
feature flag. MCP, web, CLI and other callers using that path inherit the commands
enabled for their database dialect:

- Oracle/YashanDB and the supported DM8 disql subset resolve `DESC`/`DESCRIBE`,
  `EXEC`/`EXECUTE`, `SHOW USER`, `PROMPT`, client `SET` options, `RUN` and
  `EXIT`/`QUIT`. Native server `SET` statements remain server SQL. Unsupported
  client commands/options are reported, not silently applied.
- PostgreSQL-family psql handling resolves `\d`/`\d+` and `\dt`/`\dt+` through
  catalog queries. This is not a complete psql implementation.
- Core `RUN` reuses a previous executed statement within the current batch;
  standalone console `/`/`RUN` uses that console's last successful statement.
- Core `EXIT`/`QUIT` stops the remaining statements in its batch. It does not
  terminate the host application or implement SQL*Plus's implicit commit behavior.
  Standalone `EXIT`/`QUIT` in the console UI closes that tab locally, including
  on MySQL; it does not change ordinary MySQL SQL execution for other callers.

Backend permissions/read-only enforcement still apply. Frontend production
markers do not establish production-confirmation policy for headless callers.

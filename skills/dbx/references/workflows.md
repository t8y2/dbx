# DBX CLI Workflows

## Explore Then Query

1. Use the connection named by the user. If none was named, run `dbx connections list --json`.
2. Run `dbx schema list <connection> --json` when the relevant tables are unknown.
3. Run `dbx schema describe <connection> <table> --json` for tables used by the query.
4. Draft a read-only statement using verified table and column names.
5. Execute with `--limit 50 --timeout 10s --json` unless the user requested different bounds.
6. Report the query, connection, row count, truncation state, and relevant results.

## Generate Prompt Context

1. Identify the smallest relevant table set.
2. Run `dbx context <connection> --tables table_a,table_b`.
3. Use the returned schema context to write or review SQL.
4. Execute the resulting query only if the user requested execution.

## Compare Schemas

1. Describe the source table with `dbx schema describe`.
2. Describe the target table separately.
3. Compare names, types, nullability, defaults, and ordering.
4. Report differences before proposing migration SQL.
5. Treat migration execution as a separate write or DDL approval.

## Generate DBML or HTML Documentation

1. List tables when the requested scope is unclear.
2. Use `--tables` to avoid documenting unrelated objects.
3. Use `dbx dbml` for editable relationship modeling.
4. Use `dbx docs` for standalone HTML documentation.
5. Supply `--notes` only when the requested annotation file exists.

## Recover From a Failure

1. Preserve the original error code and message.
2. Run `dbx doctor --json` for environment or bridge failures.
3. Run `dbx capabilities --json` when direct-versus-bridge support is unclear.
4. Correct the connection, option, or environment issue.
5. Retry once; if it still fails, report the remaining blocker without bypassing DBX.

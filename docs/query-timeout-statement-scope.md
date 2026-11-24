# Statement timeouts are scoped, not global

A single `query_timeout_secs` used to bound every statement the editor sent:
`SELECT`, `INSERT`, and `CREATE TABLE ... PARTITION BY` alike. It now bounds
reads only. This note records the reasoning so the next change to timeouts does
not undo it.

## The problem

A read timeout costs a retry. A write timeout costs certainty: `KILL QUERY` only
sets a flag, so the statement may commit before it notices, and either way the
client sees the same message. Retrying duplicates data; not retrying loses it.

A schema-change timeout is worse. Cancelling `ALTER TABLE` makes MySQL roll the
change back while it still holds metadata locks, so every later statement queues
behind it. The change may also already be in the binlog, so a replica that
applied it drifts away from the primary — and that drift is not self-healing.

Neither MySQL nor PostgreSQL imposes a build deadline on DDL. JDBC's
`Statement.setQueryTimeout()` defaults to `0` (no limit), and so does
PostgreSQL's `statement_timeout`. Desktop clients in this space do not arm an
automatic timer either; they give the user a cancel button. **Stopping a write is
a human decision, not a timer's.**

## What a statement gets

| Statement | Deadline | On deadline |
| --- | --- | --- |
| `SELECT` / `SHOW` / `EXPLAIN` | `query_timeout_secs` (default 60) | stop waiting and cancel the server statement |
| `INSERT` / `UPDATE` / `DELETE` / `MERGE` / `COPY` / `CALL` | `write_timeout_secs` (default 0 = unlimited) | stop waiting only, never cancel |
| `CREATE` / `ALTER` / `DROP` / `TRUNCATE` / ... | never | — |

The three states are modelled explicitly in `dbx_core::query::StatementTimeout`:

```rust
pub enum StatementTimeout {
    Cancel(Duration),   // reads: give up and cancel
    Detach(Duration),   // writes with a limit: stop waiting, leave the server alone
    Unlimited,          // schema changes, and writes by default
}
```

`server_budget()` returns `None` for `Detach`, which is what makes the difference
structural rather than a convention: an executor that must not cancel has no
budget to cancel with.

## Classification

`statement_scope()` decides which row of the table applies. The leading keyword is
checked **before** the AST on purpose: sqlparser cannot parse every vendor
extension (`ALTER TABLE ... ADD PARTITION`, Oracle packages, ClickHouse DDL), and
a statement that failed to parse must not silently fall back to the read
deadline. The AST (`classify_sql_risk_for_database`) refines the rest.

The frontend combines the keyword check with SQL risk classification. Its read
watchdog keeps the per-statement batch budget and leaves PostgreSQL row-stream
timeouts to the backend.

Tauri, DBX Web and local MCP can return after the write wait expires while their
runtime continues to drive the operation. The one-shot local CLI waits for the
write result before exiting. A transaction containing writes or DDL runs without
a DBX read deadline, since a read timeout would otherwise roll back earlier writes
in the same transaction. OceanBase MySQL uses the server's maximum session query
timeout whenever DBX has no statement deadline.

## Migration

None required. `query_timeout_secs` keeps its name and its default; its meaning
narrows to reads. `write_timeout_secs` is new, defaults to `0`, and old configs
deserialize to "writes are unlimited" — which is the behaviour this change
introduces.

Schema changes deliberately get **no** setting. There is no sensible default for
"how long may a rebuild take", so offering one only creates a way to get it
wrong.

## Testing

Unit tests:

- `dbx-core`: `statement_scope_classifies_ddl_writes_and_reads`,
  `schema_changes_are_never_bounded_by_any_timeout`,
  `writes_are_unlimited_by_default_and_detached_when_limited`,
  `reads_keep_the_cancel_semantics`, `detach_never_asks_the_server_to_cancel`.
- `apps/desktop`: `lib/__tests__/sql/queryTimeout.spec.ts`.

Live check against MySQL 8.x (`crates/dbx-core/tests/live_statement_timeout.rs`,
`#[ignore]`, needs `DBX_LIVE_TIMEOUT_MYSQL_*`):

```bash
cargo test -p dbx-core --test live_statement_timeout -- --ignored --test-threads=1
```

With a one second read budget it asserts that a 3s `SELECT SLEEP(3)` is cancelled,
while a 2s `INSERT ... SLEEP(2)` and a 2s `CREATE TABLE ... AS SELECT SLEEP(2)`
both complete.

## Rule for future changes

Any new absolute deadline must answer one question in its PR description: **what
happens to DDL?** If the answer is "it gets cancelled", the change reintroduces
this bug.

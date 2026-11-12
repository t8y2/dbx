# dbx-binlog

Experimental pure-Rust, offline MySQL binlog inspection and recovery planning.
This crate has no connection pool, database executor, Desktop command or Web route.

- `inspect` streams observational row callbacks and bounded diagnostics.
- `read_log` hashes the complete file and collects validated transaction boundaries.
- `RecoveryLog::matching_transactions` filters whole transactions.
- `plan_recovery` requires file-bound historical schema evidence and returns
  reverse-ordered typed actions; `RecoveryPlan::to_sql` renders manual-review SQL.

Run behavior tests with `cargo test -p dbx-binlog`. The standalone CLI and its
separate subprocess tests live under `../../examples/mysql-binlog-probe/`.
See that README for schema-manifest shape, conservative selection restrictions,
supported types and mandatory manual-execution preconditions.

Isolated MySQL 8.0.27 restore comparison now passes for the tested integer,
binary/text/NULL/DECIMAL, full JSON and modern microsecond temporal matrix.
The worker module provides paginated, precision-safe process IPC, tested through
the CLI subprocess. Desktop now uses the optional host module to isolate the
parser; Web does not expose it.

Shipping gates remain open: untrusted-parser fuzzing/resource audit, remaining
datatype support, cross-platform
distribution and signed/native WebView end-to-end execution validation. The
existing editor parser was checked against an actual generated export (7
statements, one intact procedure, no DELIMITER directives sent to the server). Successful unit
tests or artifact generation are not production recovery acceptance.

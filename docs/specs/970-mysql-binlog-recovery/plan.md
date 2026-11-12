# MySQL Binlog Recovery Technical Verification Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for this authorized
> first stage. Preserve this package; do not create a second specification.

**Goal:** Prove the pinned Rust parser can inspect local ROW logs without SQL
execution, while exposing the gaps that block trustworthy inverse SQL.

**Architecture:** A standalone, non-shipping Cargo package under
`examples/mysql-binlog-probe` uses the existing parser revision. A bounded frame
reader validates complete frames and CRC32 before handing them to the library.
A visitor observes decoded row changes without accumulating the full file.

**Tech Stack:** Rust 2021; mysql_common pinned to the existing revision with
`binlog` and the pure-Rust flate2 backend; crc32fast. No new external executable.

**Spec:** `spec.md`

## Global Constraints

- Local files only; no database connections, SQL generation or SQL execution.
- Maximum encoded event size: 16 MiB for the probe (not a MySQL format limit).
- Keep omitted columns distinct from SQL NULL; keep bytes and integers typed.
- Inspection success never means recovery is safe.
- No commit, push, PR, release or additional issue writeback is authorized.

## Review Focus

- A truncated final event must return an error, not normal EOF (Task 1).
- Corruption and huge declared sizes must fail before parser allocation (Task 1).
- FULL versus partial image bitmaps must be observable (Task 2).
- Non-UTF8 bytes, NULL and integers beyond JS precision must survive (Task 2).
- Unsupported events must be explicit and never imply SQL eligibility (Task 2).

### Task 1: Strict event framing

**Files:** `examples/mysql-binlog-probe/{Cargo.toml,src/lib.rs,tests/probe.rs}`

**Interfaces:** `inspect<R: Read>(input: R, on_row: impl FnMut(RowChange)) ->
io::Result<Inspection>`; `Inspection` exposes event counts and final position.

- [x] Add tests for valid empty log framing, invalid magic, truncated header/body,
  event size below 19, event size over 16 MiB and CRC corruption. The empty log
  still requires a format-description event; magic-only is not sufficient.
- [x] Run the package tests and observe the missing implementation failure.
- [x] Implement bounded frame reading and CRC32 verification before library use;
  reject missing/duplicate format-description events and invalid next positions.
- [x] Run package tests; record exact results in `progress.md`.

### Task 2: Row decoding and diagnostics

**Files:** `examples/mysql-binlog-probe/{src/lib.rs,src/main.rs,tests/probe.rs,README.md}`

**Interfaces:** `RowChange` owns its `BinlogRow` images, raw database/table names,
event position and before/after completeness flags. `Inspection` also exposes
decoded row/commit counts, partial-image count and unsupported event positions.

- [x] Author synthetic FDE/table-map/row/XID streams; assert INSERT/UPDATE/DELETE
  before/after values, partial bitmaps, SQL NULL, binary bytes and u64::MAX.
  Assert decoding fails when a table map is absent. Exercise chunked Read input.
- [x] Observe RED, then implement the visitor and diagnostics with no lossy
  string conversion or generic JSON-number intermediate.
- [x] Add a read-only CLI with nonzero error exit; output only aggregate counts.
- [x] Run `cargo test`, `cargo fmt --check`, and `cargo clippy --all-targets -- -D
  warnings` against the standalone manifest; test CLI success/error exits.

### Task 3: Feasibility evidence and follow-on gates

**Files:** this package's `progress.md`; probe README.

- [x] Run authored tests and available local dependency fixtures through the CLI;
  record pinned revision, observed output and unsupported cases without copying
  dependency fixtures into the repository.
- [x] Record real MySQL restore validation as unverified unless actually run in an
  isolated instance. Do not substitute synthetic fixtures for restore acceptance.
- [x] Self-review requirements/plan coverage and the diff; record risks and next
  shipping stages (transaction engine, trusted schema, inverse SQL, desktop UI,
  isolated restore matrix). Preserve all existing user changes.

## Self-Review

The first-stage plan covers inspection only. Product requirements for filtering,
transaction-safe selection, SQL generation, UI/export and real restore remain
explicitly deferred, not completed by successful parser tests.

## Stage 2: recovery engine (authorized continuation)

The stage-1 constraints above apply to the probe. The stage-2 scope in `spec.md`
now additionally permits reviewed SQL generation, never SQL execution. Keep
Tasks 1-3 complete; resume at Task 4 using executing-plans/TDD in this worktree.

### Task 4: Reusable parser and complete transactions

**Files:** create `crates/dbx-binlog/{Cargo.toml,src/lib.rs,src/reader.rs,src/transactions.rs}`;
modify root `Cargo.toml`, probe Cargo manifest/library; extend probe integration tests.

**Interfaces:** preserve `inspect`/`Inspection`/`RowChange`; add `read_log<R: Read>(R)
-> io::Result<RecoveryLog>`, `RecoveryLog::transactions() -> &[Transaction]` and
`RecoveryLog::sha256() -> &str`. Transaction exposes start/end offsets, time, GTID
and row changes; only `read_log` can construct a validated RecoveryLog.

- [x] Tests first: valid BEGIN/rows/XID, multiple transactions, GTID, rollback,
  nested BEGIN, orphan rows/commit and event-aligned open EOF; watch RED.
- [x] Move the proven framing/row parser without duplication, retain all stage-1
  tests, emit typed boundaries, hash the whole input, enforce materialization caps.
- [x] Run package tests. No commit/push.

### Task 5: Whole-transaction selection and historical schema validation

**Files:** `crates/dbx-binlog/src/{schema.rs,selection.rs}`; tests in the probe harness.

**Interfaces:** serde `SchemaManifest`/`TableSchema`/`ColumnSchema` and
`TransactionFilter`; `RecoveryLog::matching_transactions(&TransactionFilter)`;
`plan_recovery(&RecoveryLog, &SchemaManifest, &[u64]) -> Result<RecoveryPlan, String>`.

- [x] Tests first: whole cross-table transaction filter, positions/time/GTID;
  schema SHA/range/provenance/attestations, missing keys/names/signedness,
  partial images, unsupported events and later unselected table dependencies.
- [x] Implement conservative validation without current-schema inference. Preserve
  column wire metadata so type/width/signedness disagreements reject generation.
- [x] Verify all previous/new tests.

### Task 6: Typed inverse actions and guarded SQL

**Files:** `crates/dbx-binlog/src/{recovery.rs,sql.rs}`; probe integration tests.

**Interfaces:** `RecoveryPlan` returns ordered inverse transactions/actions and
`to_sql() -> Result<String, String>`; supported initial literals are typed integer,
binary/text and exact DECIMAL. Unsupported types return an error.

- [x] Tests first: DELETE/INSERT/UPDATE reversal, transaction and row reverse order,
  repeated changes, changed primary key, escaping identifiers/bytes, u64/DECIMAL
  precision, NULL, no-op UPDATE and conflict/rollback SQL structure.
- [x] Implement full expected-image guards, PK absence checks, per-transaction
  rollback/RESIGNAL, unique helper naming and explicit execution preconditions.
- [x] Test a small in-memory row-state replay against inverse actions; do not
  describe that test as MySQL SQL execution or real restoration acceptance.

### Task 7: Usable offline recovery CLI and review

**Files:** probe CLI/README, this progress ledger; native crate integration tests.

- [x] Add `transactions FILE` and `recover FILE SCHEMA_JSON START_POSITION...`
  commands. `recover` prints SQL only after the entire plan validates; bad input
  exits nonzero with no partial SQL. Add CLI behavior tests before implementation.
- [x] Run full standalone suite, formatting and Clippy; attempt native workspace
  package tests and report any environment/dependency gap distinctly.
- [x] Fresh independent whole-change review; fix important issues with regression
  evidence, update ledger and preserve all existing user work.

## Stage-2 Review Focus

- Cross-table filtering must not silently drop rows (Task 5).
- File SHA/range or metadata mismatch must never produce SQL (Task 5).
- Repeated modifications/key changes must reverse in exact order (Task 6).
- Conflict checks must stop the active transaction rather than skip a row (Task 6).
- CLI errors must not emit a partially valid SQL script (Task 7).

## Stage 3: real MySQL acceptance before runtime exposure

### Task 8: Reproducible isolated MySQL acceptance

**Files:** `examples/mysql-binlog-probe/tests/live_mysql.py`, engine regression
tests, this progress ledger. Runtime/dependencies live in task-owned ignored
`examples/mysql-binlog-probe/target/live-mysql/`, never user databases.

- [x] Obtain a portable official MySQL 8.0.27 runtime when no suitable local
  server exists. Start only a fresh task-owned data directory over a Unix socket
  with networking disabled; no services, system configuration or existing data.
- [x] Write an acceptance harness which snapshots schema and baseline before
  DML, rotates the test binlog, reads actual row transactions and renders inverse
  SQL, executes only against that owned instance, then compares every field.
- [x] Cover insert/delete/update, repeated edits/PK changes, zero AUTO_INCREMENT,
  exact DECIMAL/bytes/text/NULL and row conflicts/transaction rollback.
- [x] Feed observed failures into engine RED/GREEN regressions; preserve output
  evidence and stop only the task-owned server at test completion.

### Task 9: verified datatype expansion and parser resource guards

**Files:** `crates/dbx-binlog/src/{reader,schema,recovery,sql}.rs`, engine and live tests.

- [x] Add supported JSON/temporal cases only with lossless tests and actual
  server field-equality proof; keep partial JSON/unsupported forms fail-closed.
- [x] Bound table-map lifetime/count and encoded event/row metadata resources;
  test malicious/truncated metadata without claiming comprehensive fuzz coverage.
- [x] Run engine/CLI/live acceptance plus independent review; ledger actual scope.

### Task 10: Desktop preview/export (gated)

- [x] Expose local-file inspection in an isolated worker, not an in-process
  untrusted parser; bound requests/responses and retain exact byte/string values.
- [x] Add lazy-loaded Desktop-only preview/filter/whole-transaction selection,
  before/after display, explicit schema evidence and SQL export; no execution.
- [x] Mounted component, command-boundary and browser desktop/mobile validation,
  task-owned browser cleanup, full affected suites and independent review.

Do not treat Task 8/9 progress as Task 10 completion. No production DB access,
push, release, commit or unrequested remote issue writeback is authorized.


Task 10's local implementation/verification is complete. This does not mean
signed installers, every default feature/OS combination, production restoration
or comprehensive hostile-parser fuzzing are verified. See desktop-validation.json
for exact native-check flags, browser bridge boundary and remaining release gates.

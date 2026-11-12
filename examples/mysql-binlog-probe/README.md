# Experimental offline MySQL binlog recovery CLI

This standalone Cargo workspace belongs to issue
[#12838](https://github.com/t8y2/dbx/issues/12838). It is not linked into DBX,
does not connect to MySQL and never executes SQL. It now uses the reusable
`dbx-binlog` engine for complete-transaction preview and guarded SQL generation.
It is not a production recovery tool. Desktop now exposes an experimental
More-menu workbench using the same engine in an isolated worker; Web does not.

The dependency revision matches DBX's existing `mysql_common` pin. Its manifest
declares `MIT OR Apache-2.0`; enabling `binlog` adds bitvec/zstd. Shipping
cross-platform builds and the full transitive license inventory remain gates.
There is no external `mysqlbinlog` executable or text-output parsing dependency.

## Run

```sh
cargo test --manifest-path examples/mysql-binlog-probe/Cargo.toml
cargo test -p dbx-binlog
cargo run --manifest-path examples/mysql-binlog-probe/Cargo.toml -- /path/to/binlog.000001
cargo run --manifest-path examples/mysql-binlog-probe/Cargo.toml -- transactions /path/to/binlog.000001
cargo run --manifest-path examples/mysql-binlog-probe/Cargo.toml -- transactions /path/to/binlog.000001 '{"database":"test","table":"items"}'
cargo run --manifest-path examples/mysql-binlog-probe/Cargo.toml -- recover /path/to/binlog.000001 /path/to/historical-schema.json 207 418
```

Default inspection prints aggregate event/row counts, physical positions and
unsupported event diagnostics without cell contents. `transactions` prints
whole-transaction metadata and file SHA256 (positions are strings to avoid JS
precision loss). `recover` prints a complete SQL artifact only after validation;
that output necessarily contains restoration data and should be kept private.
Neither command writes output files by default. Run only against trusted
test files: the upstream parser has not been audited/fuzzed for untrusted input.

## Why a framing adapter?

The pinned library's `BinlogFile` iterator converts an `UnexpectedEof` into normal
EOF, and `Event::read` unwraps a body read. This probe first reads the entire
bounded event frame, rejects truncated input, validates its next position and
CRC32, then invokes the lower-level `EventStreamReader`. A bad checksum is not
automatically rejected by merely deserializing a library Event.

The 16 MiB event cap is a probe resource limit, not a MySQL format restriction.
Only checksum-enabled binlog-v4 logs are in this initial probe's scope.
Compressed transactions, partial-JSON events and other unsupported events must
remain explicit diagnostics. Raw identifiers/cell bytes are retained internally;
incomplete images are marked, not reconstructed from the current database.
Default inspection counters remain observational only. The recovery reader
additionally requires complete BEGIN/COMMIT boundaries, discards rolled-back
transactions, retains GTID identity, and refuses orphan/nested/open transactions.

The row visitor can run before an error later in the file. It is suitable for
inspection only: downstream code must not export or apply changes until the
entire required transaction/file scope has been validated. A decoded FULL image
is not evidence of historical column names, keys, schema stability or safe
recovery. Recovery generation uses a separate fully validated RecoveryLog and
historical schema, never the observational callback output.

## Historical schema contract

No live database structure is read or substituted. A JSON manifest requires:

- `version: 1`, `binlog_sha256` from the imported file, `valid_from`/`valid_to`
  physical offsets, a nonempty `provenance`, and `historical: true`.
- `tables`: database/table names, `engine: "InnoDB"`, explicit
  `no_triggers_or_foreign_keys: true`, ordered `columns` and `primary_key`
  zero-based column ordinals. Attestations must come from real historical
  evidence; a pasted current schema is not evidence.
- Each column has `name`, `wire_type`, `wire_metadata`, `unsigned`, `nullable`,
  `generated: false` and a tagged `kind`. Kinds are `{"type":"integer"}`,
  `{"type":"binary"}`, `{"type":"text","charset":"utf8mb4"}`, or
  `{"type":"decimal","precision":30,"scale":6}`.

Names, types/metadata, nullability, numeric signedness and primary-key membership
must agree with FULL row/table metadata. Logged charset metadata is checked when
present. This initial engine therefore requires richer table metadata than ROW
image FULL alone (normally `binlog_row_metadata=FULL`). Missing evidence refuses
generation rather than inferring a schema. Only ordinary InnoDB tables are in
scope; generated columns, triggers and FKs are excluded.

Supported wire types are integer TINY/SHORT/INT24/LONG/LONGLONG,
VARCHAR/VARBINARY, BLOB/TEXT, exact NEWDECIMAL, full JSON and
DATETIME2/TIMESTAMP2/TIME2 (fractional precision 0..6). Text charsets are utf8mb4,
utf8, ascii and latin1; byte and character capacity are checked. Unsupported
DATE, zero/invalid temporal values, legacy temporal encodings, ordinary FLOAT/DOUBLE,
ENUM/SET, geometry and other types refuse export. JSON opaque/typed values,
invalid/duplicate keys, partial updates and excessive depth/node counts refuse
export. JSON integers never pass through JS numbers. Temporal schema kinds are
`{"type":"date_time","precision":6}`, `{"type":"timestamp","precision":6}`,
`{"type":"time","precision":6}`; JSON is `{"type":"json"}`.

Filters select entire transactions, including other tables' rows. Export starts
must be unique, exact transaction start offsets. A later unselected transaction
on a selected table blocks export conservatively, even if its row keys differ.
Unsupported-event barriers after the schema's validity start block export.

## Generated SQL safety boundary

The SQL is a review artifact for a **fresh dedicated session** with stop-on-first-
error execution, routine privileges and complete metadata visibility. It uses a
nonce-named SQL SECURITY INVOKER helper, captures STRICT_ALL_TABLES and
NO_AUTO_VALUE_ON_ZERO at CREATE time, and restores caller SQL mode before CALL.
The helper normalizes TIMESTAMP conversion to UTC and restores the caller zone
on success, warnings and exceptions. CREATE failure can leave the dedicated session's mode changed; discard/restore
that session. CALL failure leaves the helper for explicit manual cleanup.

Each original transaction is reversed and committed separately; later failures
do not undo already committed inverse transactions. Metadata preflight, primary-
key absence/full post-image checks, affected-row checks, restored-image checks
and warning/exception handlers protect the active recovery transaction. No
REPLACE, INSERT IGNORE or disabled FK checks hide conflicts.

Independently verify there are no triggers or incoming/outgoing FKs: information-
schema visibility is privilege-filtered and a zero count alone is not proof.
DDL/helper creation implicitly commits, so never execute in a session with
existing work. Isolated MySQL 8.0.27 execution and field-by-field restoration
now pass for the tested matrix. This is not production/cross-platform acceptance;
do not execute experimental artifacts against production.

## Verification boundary

Tests author binary FDE/table-map/row frames from the MySQL wire layout and
exercise the actual pinned parser. No third-party server fixture is bundled.
Synthetic tests are not a substitute for MySQL 8.0.27 generate/recover/compare
acceptance tests. No user database, local DBX state or production connection
is read or changed by this package.

Follow-on design and evidence live in
`../../docs/specs/970-mysql-binlog-recovery/`.

## Isolated real-MySQL acceptance

```sh
python3 examples/mysql-binlog-probe/tests/live_mysql.py \
  --mysql-home /path/to/official/mysql-8.0.27 \
  --probe examples/mysql-binlog-probe/target/debug/dbx-mysql-binlog-probe \
  --artifacts examples/mysql-binlog-probe/target/live-mysql/runs
python3 -m unittest discover -s examples/mysql-binlog-probe/tests -p test_live_mysql.py
```

The harness ONLY creates a fresh data directory and socket-only owned server
(`--skip-networking`, `--mysqlx=OFF`, `--no-defaults`). It accepts no database
connection string. Schema is captured before DML and matched to the rotated
binlog. Every field is compared, including NULL/empty byte distinctions, JSON
large integers/nested values, DECIMAL and microsecond timestamps/timezones.
Runtime schema drift and post-image/PK conflicts with rollback are covered.
The server is terminated even if evidence persistence fails; artifacts remain
for inspection. No service installation or existing MySQL data is involved.

Same-session handler checks use `mysql --force` ONLY in controlled failure tests
to observe state after a deliberately failed CALL. Production SQL still requires
stop-on-first-error. The SQLWARNING case injects a warning into the generated
helper for handler coverage, rather than depending on lossy DML coercion.

## Experimental worker protocol

`--worker` reads one JSON request on stdin and writes one JSON response, without
banners. Actions: `list` (path/filter/offset), `details`
(path/sha256/start_position/offset), `generate`
(path/sha256/schema_path/start_positions). Integers/positions are strings, bytes
are hex and SQL NULL is explicit. Details/generation reject changed files by
SHA256. Limits: 64 KiB request, 8 MiB serialized response, 100 entries per page.
The standalone --worker entry does not itself enforce parent resource policy.
Desktop hosts it with a 60-second timeout, sampled 512 MiB RSS, bounded pipes
and cancellation; Web does not expose it. RSS is not a hard OS quota, and response
checks occur after serialization.

Inspection refuses files above 512 MiB, more than 1,000,000 events, 128 distinct
table-map IDs or 8 MiB of encoded table-map state (1 MiB each). These conservative
caps do not replace parser fuzzing or process isolation. Regular-file checks do
not eliminate filesystem races.

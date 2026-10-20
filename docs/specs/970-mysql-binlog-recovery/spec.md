# MySQL binlog recovery

Source: https://github.com/t8y2/dbx/issues/12838

Authorization: on 2026-10-20 the user approved the staged approach (technical
verification first, then a controlled MVP) and explicitly authorized `/claim`.
The issue text remains the product requirement; this file records its scope and
the technical-verification boundary, not a replacement product specification.

## Product scope

- Desktop imports local MySQL binlog files and streams ROW events.
- Filter by database, table, time, GTID/transaction and position; preview
  transaction boundaries, positions and available before/after images.
- Generate inverse ordinary-table DML only with complete recovery information:
  DELETE -> INSERT, INSERT -> DELETE, UPDATE -> previous values. Reverse both
  transaction and intra-transaction order while preserving boundaries.
- Require ROW + FULL images. Missing values, ambiguous historical schema,
  unreliable row identity and unsupported events must prevent unsafe generation.
  Current database metadata is not historical-schema evidence.
- Preserve identifiers, NULL, string/binary/JSON data, large integers,
  character sets and temporal values. Include conflict checks; never conceal
  conflicts with REPLACE or INSERT IGNORE.
- Preview/export `.sql` only. No automatic execution, production writes,
  DDL rollback or continuous remote subscription.
- Acceptance requires an isolated MySQL restore followed by field-by-field
  comparison, including repeated writes, transaction order, incomplete images,
  schema changes and primary-key conflicts.

## Stage 1: executable dependency probe

Use the existing pinned `mysql_common` revision
`47740d85a8277167a5717afac785d37b46a36296` with `binlog` enabled. Keep the probe
outside the shipping workspace until the feasibility and safety gates pass.
It must not connect to a database, generate SQL or imply recovery eligibility.

Prove event framing, CRC32 validation, row decoding, before/after column bitmaps,
byte-preserving cells and integer precision. Invalid magic, truncated headers or
bodies, oversized events, bad checksums and decoder errors must fail explicitly.
Use authored synthetic binary fixtures for reproducible tests; do not redistribute
third-party server fixtures without checking their individual provenance.

The diagnostic CLI prints counts/positions, not row contents. Incomplete images
and unsupported events may be inspected but are reported, never silently treated
as recoverable. No current-schema inference is permitted.

## Decisions still gated on evidence

- Core versus plugin, shipping dependency footprint and supported OS builds.
- Trusted historical schema input and exact mapping/verification contract.
- Transaction selection closure, cross-table dependencies, triggers and foreign
  keys; filtering must not silently create a partial rollback.
- Conflict-check script semantics and atomic abort behavior in the DBX editor.
- Full datatype/version matrix; compressed/XA/partial-JSON events may be rejected
  explicitly rather than partially handled.

Do not start the shipping MVP while these safety contracts are unresolved.
Stage 1 is a feasibility deliverable, not completion of issue #12838.

## Stage 2: recovery-engine development boundary

The user explicitly requested development to continue after the probe. Implement
the reusable engine in `crates/dbx-binlog`, without enabling it in Desktop/Web or
adding a database execution path. This is the next implementation slice, not
permission to bypass the shipping gates above.

- Collect only complete BEGIN/COMMIT (XID) transactions; rollbacks produce no
  recovery operations. GTID and physical offsets are retained. EOF with an open
  transaction, nested boundaries or rows outside a transaction fails closed.
- A preview filter matches whole transactions, never silently selects individual
  rows from a cross-table transaction. Export selection uses exact start offsets;
  unknown/duplicate/empty selections fail. Later unselected transactions touching
  a selected table block export conservatively until row dependency analysis is
  validated.
- Require an explicit historical-schema manifest, bound to the SHA256 of the
  entire imported file and a physical validity interval. Require a nonempty
  provenance statement and explicit attestations of historical validity,
  InnoDB/transactional tables, and no triggers/FKs. This is user-supplied evidence,
  not an automatically verified historical schema. Do not fetch live metadata.
- Require FULL images, named columns that agree with table-map metadata, explicit
  numeric signedness and a non-null primary key. Reject generated columns, schema
  mismatches and unsupported types/events. Begin with integer, binary/text and
  DECIMAL values; unsupported temporal/JSON/float/etc. must refuse export until
  verified rather than silently producing approximate SQL.
- Reverse transactions and rows. Inverse UPDATE/DELETE use the complete expected
  post-image as a byte-exact conflict condition and check affected-row counts;
  inverse INSERT checks the target primary key is absent. Never use REPLACE,
  INSERT IGNORE, LIMIT 1 or disabled FK checks to hide conflicts.
- SQL is a manual-review artifact only. An INVOKER-security helper procedure
  encloses per-original-transaction START TRANSACTION/COMMIT and has an exception
  handler that rolls back the active recovery transaction and RESIGNALs. DDL,
  CALL and DROP require a fresh dedicated autocommit session, CREATE ROUTINE
  privilege and stop-on-error script execution. Previously committed inverse
  transactions are NOT globally rolled back if a later transaction conflicts.
  These requirements must appear in the generated header; no automatic execution.
- The local CLI may print a preview or generated SQL; output to a file is an
  explicit shell redirection chosen by the user. No default output-file writes.
- Bound materialized recovery input to 50,000 rows, 10,000 transactions and 1,000
  unsupported-event barriers. Parser security/cross-platform/real restore gates
  still apply before Desktop exposure.

## Stage 3: verified type expansion and process protocol

Continue the same historical-schema, whole-transaction and manual-review-only
contracts. Add full JSON (wire type 245, metadata [4]), DATETIME2/TIMESTAMP2/TIME2
(18/17/19 with fractional precision 0..6).

- JSON retains i64/u64 integers and finite doubles without a JS-number path.
  Refuse opaque/typed JSON (embedded DECIMAL/temporal included), partial JSON,
  invalid UTF-8 keys, duplicate keys, depth >64 or >100,000 nodes. Validate raw
  keys and resource budgets before upstream DOM conversion.
- DATETIME validates calendar/range; zero/invalid dates refuse generation.
  TIMESTAMP uses explicit epoch seconds with UTC conversion; zero/out-of-range
  timestamps refuse generation. TIME checks the 838:59:59 endpoint and fraction.
  The helper restores caller timezone on success, exceptions and SQL warnings.
- DATE, legacy temporal encodings, ordinary FLOAT/DOUBLE columns, ENUM/SET,
  geometry, compressed transactions and partial JSON remain unsupported.
- Conservative inspection caps: file 512 MiB, event 16 MiB, 1,000,000 events,
  128 distinct cached table-map IDs, 8 MiB total encoded map state, 1 MiB per map.
  These are not complete memory/untrusted-parser safety guarantees.
- Single-request worker protocol: list/details/generate only, no execute/delete/
  write-file. Request <=64 KiB, serialized response <=8 MiB; row/transaction pages
  <=100. Positions/integers are strings, bytes are hex, SQL NULL differs from
  absent images. Details/generation require preview SHA256 to reject changed files.
- CLI --worker exercises the child-process protocol. Desktop host integration,
  enforced timeout/termination and browser-verified UI remain gates. Response
  byte limits are not peak-allocation bounds; regular-file checks do not eliminate
  filesystem races. Do not expose parser internals directly in the app process.


## Stage 4: Desktop integration (supersedes CLI-only notes above)

- Core engine is reused by Desktop only, through the same executable launched with
  --binlog-recovery-worker BEFORE backup/UI/storage initialization. Web exposes
  no corresponding route/menu. No AppState or connection pool is passed in.
- Internal Tauri commands: binlog_recovery_request(request_id, request),
  binlog_recovery_cancel(request_id), binlog_recovery_export(path, sql). Requests
  and responses preserve the existing single-request worker protocol.
- Parent host permits one job, uses 60-second timeout, sampled 512 MiB RSS,
  8 MiB stdout/64 KiB stderr bounds, and kills/reaps only its owned child. A bounded
  120-second cancellation tombstone registry handles cancel-before-admission.
  Sampling is not an OS hard memory quota; no broad hostile-input guarantee.
- SQL export writes a private temporary file in the chosen parent directory,
  syncs, then persists without replacing existing files or symlinks. Nonempty SQL
  <=8 MiB and a new .sql destination are required; nothing executes SQL.
- Desktop More menu lazily loads the responsive dialog. Native pickers select
  source/schema; SHA256 is visible. Filters select whole transactions, pages are
  100 entries, and details retain exact integer strings/hex/NULL/missing values.
  Without signedness, integer previews explicitly show ambiguous raw bit patterns.
- Historical schema confirmation and at least one transaction are mandatory to
  generate. Changing inputs invalidates SQL; closed/cancelled requests cannot
  repopulate the UI. Preview is read-only; export occurs only after the native save
  picker and checks its SQL snapshot is still current.
- English, simplified/traditional Chinese and bilingual usage docs are included;
  other locales retain the established English fallback. Actual browser checks
  cover English/Chinese, desktop/mobile and light/dark themes.
- Browser flow uses real component and actual parser subprocess through a local
  test bridge, NOT a packaged WebView. Native commands compile and parent-host
  behavior is tested independently. Release/signed-app smoke tests remain gates.

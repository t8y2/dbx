# Oracle to Xugu table transfer: phase-one validation

This adapter applies only to Oracle sources and native Xugu targets. It does
not enable Xugu to Oracle, OceanBase Oracle mode to Xugu, or Dameng to Xugu.
Existing transfer pairs retain their own conversion paths. No Go driver source
or dependency version is modified.

## Contract

- Tables only; structure and data, structure only, or data only.
- Append and overwrite only. No upsert or drop/rebuild.
- Preserve quoted source table and column spelling, including mixed case.
- Read source values through an Agent cursor, with bounded pages and explicit
  text projection for exact NUMBER and DATE/TIMESTAMP values.
- Oracle DATE maps to DATETIME(0), not date-only DATE.
- Carry SQL-level NULL/empty/nonempty LOB state in each Oracle cursor page;
  native decoding of an empty locator must not turn it into SQL NULL. Restore
  empty values and remove state columns before target validation and INSERTs.
- Explicitly bounded NUMBER(p,s), character lengths, RAW lengths, and timestamp
  precision are checked; never guess an unbounded NUMBER's decimal capacity.
- Ordinary primary/unique keys and indexes are rendered as Xugu DDL. Comments
  come from metadata. Source SQL is never executed verbatim on the target.
- Require exact Oracle DDL rather than the browser's simplified fallback;
  reconcile dependent index DDL with a complete, permission-scoped inventory.
- Unsupported definitions fail before target table creation or overwrite clear.
- Before overwrite, validate every selected source table and existing target's
  type/capacity. Scan all source pages for values the target SQL path cannot
  preserve. This preflight reads the source; it does not modify either database.
- Cancellation does not roll back batches already acknowledged by Xugu. Report
  the acknowledged row count rather than claiming an atomic rollback.

## Deliberate exclusions

Reject unbounded NUMBER, negative scale, scale greater than precision, decimal
FLOAT, timestamp precision above 6, timezone/local-timezone timestamps, LONG,
LONG RAW, BFILE, ROWID, spatial/UDT columns, generated/identity columns,
temporary/external/partitioned tables, foreign keys, CHECK constraints, complex
defaults and expression/specialized indexes until separate conversions are
validated. Rejection is not support for that feature.

Reject embedded NUL, supplementary Unicode characters, or CHAR/VARCHAR values
ending in spaces when the native Xugu SQL path would change them. Keep NULL,
empty LOB and empty binary distinct; never truncate a LOB to a preview length.
Reject non-finite binary floating-point values before overwrite clears a target.
Reject Oracle dates in 0001 BC before creating or clearing a target: Xugu's
documented BC range ends at 0002-01-01 BC. Never shift the year or replace the
value with NULL. Other supported BC dates and AD years 1 through 9999 must be
verified independently on the real target.

## Required real-database and packaged-UI matrix

No item below is a pass until the packaged DEV application performs the transfer
and an independent target query checks the resulting structure and values.

| Group | Cases |
| --- | --- |
| Pair boundaries | Oracle to Xugu accepted; reverse direction and other Oracle-family products refused; MySQL/Xugu existing paths unchanged |
| DDL | Uppercase, quoted mixed case, embedded quote, composite PK, unique key, ascending/descending ordinary index, table/column comments |
| Numbers | NUMBER(1,0), NUMBER(10,0), NUMBER(38,6), NUMBER(38,38); signs, zeros, full-width exact values, SQL NULL |
| Text | VARCHAR2 BYTE/CHAR, NVARCHAR2, CHAR/NCHAR, CLOB/NCLOB; Chinese, apostrophe, backslash, newline, long text exceeding 127134 characters |
| Binary | RAW(16), BLOB; zero bytes, non-UTF8 bytes, empty LOB and SQL NULL, large multi-page values |
| Temporal | DATE with time, TIMESTAMP(0/3/6), fractional seconds, BC and years 1/9999; verify in SQL to avoid confusing display-driver defects with stored values |
| Modes | New structure+data, structure only, data-only append and overwrite, empty table, no-PK table, multiple tables, more than 10000 rows |
| Fail-before-write | Unsupported source types, incomplete/mismatched DDL, narrower/NOT NULL target, required extra target column, missing metadata access, read-only target, unsafe text after the first page |
| Runtime | Cancel during source preflight and active transfer, query timeout, exact acknowledged partial row count and cursor cleanup, retry after a failed connection |

Use synthetic test objects only. Do not commit connection addresses, accounts,
passwords, real business data, or local configuration exports.

## Recorded packaged validation (2026-10-28)

The packaged DEV was tested against a real Oracle 12.1 source and native
Xugu target. These results do not claim coverage of every Oracle version.

- Automated transfer regression: 587 backend tests passed; 418 frontend tests
  across 18 files passed; frontend typecheck passed. The unmodified native
  Oracle Agent's focused DDL/cursor regression passed.
- An 18-column, five-row fixture passed exact positive/negative 38-digit
  decimal checks, Chinese text at declared lengths, RAW/binary values, finite
  binary floats, SQL NULLs, non-NULL empty BLOB/CLOB/NCLOB and 140000-length
  LOBs. BLOB content hash and every CLOB chunk were independently checked.
- Timestamp precision 0/3/6 was verified through target SQL equality, not its
  text display. Catalog checks confirmed column capacities, precision,
  primary/unique keys, a descending composite index and comments.
- A three-table task passed mixed-case/spaced identifiers, an empty table,
  a no-PK table and 10001 rows. Counts, distinct IDs, bounds, numeric totals
  and total CLOB length matched independently.
- Structure-only, data-only append, overwrite and data-only overwrite passed.
  Repeated PK append failed as expected with zero new rows; the original
  target rows remained intact.
- Cancellation during actual insertion stopped at 1919 acknowledged rows;
  the target contained exactly 1919 distinct rows. A subsequent data-only
  overwrite retry completed all 10001 rows with matching aggregates.
- Unsupported type/constraint definitions, NaN, unsafe text after row 1000,
  narrow or incompatible target columns and required extra columns were
  refused. Multi-table overwrite preflight retained the valid table's rows
  and an unsafe table's sentinel.
- A permitted non-SYSDBA target account copied five rows. A separate base
  account received permission denied for CREATE with zero writes; data-only
  transfer to a missing target stopped without creating it. No account was
  automatically granted additional privileges.
- Existing MySQL-to-Xugu regression copied a five-row mixed fixture, with
  independent binary, decimal, enum, JSON and CLOB/null checks matching the
  source. These are regression results, not an extension of MySQL support.
- A one-second operation override produced a real execute timeout before
  target clear. All 10001 existing target rows and aggregates remained intact.
  Immediate retry failed with `Agent stdin not available`; after explicitly
  disconnecting and reconnecting the Oracle source, normal-timeout retry
  completed 10001/10001 rows. Independent count, distinct IDs, numeric totals
  and total CLOB length matched. Automatic recovery is not claimed.
- A real date-edge test exposed Oracle year 1 BC passing preflight and then
  failing at the target. In the rebuilt DEV, the pair-local guard refused that
  value before execution confirmation; an independent target query confirmed
  the overwrite sentinel remained intact. A separate four-row transfer passed
  AD year 1, AD year 9999, a leap day and BC year 2, including microseconds.
  Every target date and timestamp matched an explicitly cast expected value.

Existing Xugu-to-Xugu regression completed five rows but **failed exact text
preservation**: a backslash-containing CLOB changed from length 12 to 13 and
JSON escapes were doubled. The generic Xugu formatter still doubles
backslashes; that code is identical in the base commit and this branch. The
new Oracle pair uses the existing pair-local literal writer instead. This
finding is not treated as a pass or silently included in the Oracle change.

Source-side restricted permissions were verified with a freshly created test
account in the same packaged DEV. Its live session reported zero enabled roles,
exactly two system privileges (CREATE SESSION and CREATE TABLE), and no ANY
privileges. It created its own seven-column table, primary key, descending index,
comments and three rows without catalog/DBA grants. Structure-and-data transfer
completed 3/3 rows in 26.6 seconds. Independent target SQL returned PASS for every
row: exact NUMBER(20,4), Chinese/apostrophe/backslash/newline text, binary bytes,
DATE time, TIMESTAMP microseconds, non-NULL empty CLOB/BLOB and SQL NULLs.
The target DDL also retained the primary key, descending index and comments.

The same ordinary source account received ORA-00942 when querying the separate
administrator-owned synthetic fixture. SYSTEM was absent from that account's
source-schema selector, so the inaccessible table could not be selected there.
This verifies login-scoped visibility and direct read denial; it does not claim
a forced unauthorized transfer was executed through a modified request. No
additional grants or automatic privilege escalation were used.

Source-preflight cancellation preserved all target rows but was initially
reported as a failed schema-object stage. After the Oracle-pair-only correction,
the newly rebuilt and restarted DEV correctly displayed Cancelled with zero
written rows. An independent aggregate assertion confirmed all 10001 target
rows, distinct IDs, numeric totals and CLOB lengths were unchanged.

## Final mainline preflight (2026-10-29)

The change was rebased without conflicts onto upstream main `f9f7dfed4`
(v0.6.61), preserving its new charset-transfer guards. On that baseline:

- Backend transfer regression: 589 passed, zero failed, using `cargo test
  -p dbx-core --no-default-features --features sqlite-bundled --lib data::transfer`.
- Frontend transfer regression: 421 passed across 19 files.
- Frontend typecheck passed with an 8 GiB Node heap limit.
- The unmodified native Oracle Agent's focused DDL/cursor regression passed.
- External caller compilation passed for the `live_mysql_transfer` and
  `live_sqlserver_transfer` integration targets with `sqlite-bundled`; these
  targets were compiled, not represented as additional live database runs.
- Changed frontend formatting/lint, changed Rust formatting and
  `git diff --check` passed. I18n autofill dry-run found no new source keys;
  the existing direction notice was updated directly in all 11 locales.

The packaged live checks above used v0.6.58 DEV before this rebase; they are
not represented as a new v0.6.61 packaged run. Mainline preflight results are
reported separately so the tested artifacts and code baselines remain clear.

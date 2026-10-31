# PostgreSQL to Xugu type coverage

This is the explicit reconciliation of the earlier migration-tool type review
with the native DBX adapter. A reference mapping is not evidence of correct data
transfer. "Pass" below means live values were transferred and checked; "reject"
means a transfer was refused before changing an existing target sentinel.

Source used for these tests: native PostgreSQL 12.16 with existing PostGIS types.
Target: native Xugu without spatial extensions. No compatible-product profiles
or XuguDB Agentic were used. Tests use synthetic, disposable objects only.

| Reference source type                                              | DBX result / mapping                     | Evidence                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| SMALLINT / INT2                                                    | SMALLINT                                 | Live values and bounds pass                                                                                        |
| INT / INTEGER / INT4                                               | INTEGER                                  | Live values and bounds pass                                                                                        |
| BIGINT / INT8                                                      | BIGINT                                   | Live bounds pass                                                                                                   |
| SERIAL / BIGSERIAL, BY DEFAULT integer identity                    | IDENTITY with original start/step        | Live sequence and packaged UI pass                                                                                 |
| SMALLSERIAL                                                        | Reject; Xugu SMALLINT cannot be IDENTITY | Live rejection pass; not silently widened                                                                          |
| OID                                                                | BIGINT                                   | Live unsigned 32-bit bounds pass; does not copy referenced large objects                                           |
| XID                                                                | BIGINT                                   | Live 0 and 4,294,967,295 pass; numeric representation only                                                         |
| XID8                                                               | Reject                                   | Unit rejection; source PG 12 does not have this type                                                               |
| NUMERIC(p,s), DECIMAL(p,s)                                         | NUMERIC(p,s), p <= 38, 0 <= s <= p       | Live exact values and bounds pass                                                                                  |
| NUMERIC without precision or p > 38                                | Reject                                   | Live rejection pass; no clamping, first-page inference or float conversion                                         |
| REAL / FLOAT4                                                      | FLOAT                                    | Live finite extrema/subnormal/zero pass                                                                            |
| DOUBLE PRECISION / FLOAT8                                          | DOUBLE                                   | Live finite extrema/subnormal/zero pass                                                                            |
| BOOLEAN                                                            | BOOLEAN                                  | Live true/false/NULL pass                                                                                          |
| CHAR / CHARACTER                                                   | CHAR(n)                                  | Live multibyte and length checks pass                                                                              |
| VARCHAR / CHARACTER VARYING                                        | VARCHAR(n), or CLOB if unbounded         | Live values, empty/NULL and long text pass                                                                         |
| NAME                                                               | VARCHAR(64)                              | Live Chinese/empty/NULL pass; trailing-space rejection pass                                                        |
| TEXT                                                               | CLOB                                     | Live complete large contents pass                                                                                  |
| BYTEA                                                              | BLOB                                     | Live complete binary contents, zeros, empty/NULL pass                                                              |
| JSON / JSONB                                                       | CLOB                                     | Live document/scalar/null/escape/large integer preservation pass                                                   |
| JSONPATH                                                           | CLOB                                     | Live PostgreSQL canonical text and NULL pass                                                                       |
| XML                                                                | CLOB                                     | Live document declaration, fragments, escapes and NULL pass; not native XML operators                              |
| UUID                                                               | VARCHAR(36)                              | Live canonical values and NULL pass                                                                                |
| DATE                                                               | DATE                                     | Live finite AD range, leap day and rejection checks pass                                                           |
| TIME(p), p <= 3                                                    | TIME(p)                                  | Live millisecond values pass; 24:00 rejected before overwrite                                                      |
| TIME / TIME(p), p > 3                                              | INTERVAL HOUR(2) TO SECOND(6)            | Live microseconds and 24:00 pass; target is an interval, not time-of-day                                           |
| TIMESTAMP without time zone                                        | DATETIME(p)                              | Live microseconds and AD boundaries pass                                                                           |
| TIMESTAMP WITH TIME ZONE                                           | DATETIME(p) WITH TIME ZONE, UTC          | Live DST transition and microseconds pass; infinite/out-of-range UTC rejected                                      |
| TIME WITH TIME ZONE, explicit p <= 3                               | TIME(p) WITH TIME ZONE                   | Live -12:59/+14:59 and fractional values pass; offset seconds and +15:00 rejected                                  |
| TIME WITH TIME ZONE, default/p > 3                                 | Reject                                   | Live rejection; Xugu cannot retain its fractional precision in native zoned TIME                                   |
| INTERVAL YEAR / MONTH / YEAR TO MONTH                              | INTERVAL YEAR(8) TO MONTH                | Every qualifier live-tested; positive/negative/max range pass                                                      |
| INTERVAL DAY through SECOND qualifiers                             | INTERVAL DAY(6) TO SECOND(6)             | Every qualifier live-tested; fractions and range pass; mixed-sign, overflow and >=24-hour time components rejected |
| Unqualified INTERVAL                                               | Reject                                   | Live rejection; independent months/days/microseconds cannot be collapsed safely                                    |
| BIT(n) / VARBIT(n)                                                 | BIT(n) / VARBIT(n), n <= 60,000          | Live leading zeros, empty/NULL, full 60,000-bit contents pass                                                      |
| Unbounded VARBIT                                                   | VARBIT(60000) with actual-value guard    | Live maximum pass and 60,001-bit rejection pass                                                                    |
| MONEY                                                              | Reject                                   | Live rejection; no assumed source locale or currency scale                                                         |
| INET / CIDR / MACADDR / MACADDR8                                   | Reject                                   | Each declaration live-tested for rejection                                                                         |
| INT4RANGE / INT8RANGE / NUMRANGE / DATERANGE / TSRANGE / TSTZRANGE | Reject                                   | Each declaration live-tested for rejection                                                                         |
| Multiranges                                                        | Reject                                   | Unit rejection only; introduced after tested source version                                                        |
| TSVECTOR / TSQUERY / PG_LSN                                        | Reject                                   | Each declaration live-tested for rejection                                                                         |
| GEOMETRY / GEOGRAPHY                                               | Reject                                   | Live source declaration rejection; no spatial transfer claim                                                       |
| Native POINT and other geometric types                             | Reject                                   | POINT live rejection; additional spellings unit-tested, not all live-tested                                        |
| Arrays                                                             | Reject                                   | INTEGER[] live rejection; not a claim about all element types/dimensions                                           |
| Enum / domain / composite / custom types                           | Reject                                   | Catalog class/namespace guards unit-tested; not all custom types live-tested                                       |

## Important limitations

- This is not support for every PostgreSQL type or version.
- A type being accepted does not mean every possible value, default expression,
  index, constraint or table feature is transferable. See the mapping contract.
- Text containing supplementary Unicode/NUL and trimming-sensitive VARCHAR/NAME
  values is rejected rather than silently altered by the current native path.
- A type stored as CLOB/VARCHAR/INTERVAL retains the stated content/value contract,
  not the full source type's operators, constraints or extension behavior.
- Overwrite is not atomic. A lost write response may mean the server applied the
  write. No automatic replay is performed; inspect the target before recovery.
- Packaged DEV tests and normal unit tests are separate from remote CI. No remote
  CI or PR outcome is implied by this local report.

See [the full test report](postgres-xugu-transfer.md),
[`live_postgres_xugu_transfer.rs`](../../crates/dbx-core/tests/live_postgres_xugu_transfer.rs),
and [`live_postgres_xugu_extended_types.rs`](../../crates/dbx-core/tests/live_postgres_xugu_extended_types.rs).

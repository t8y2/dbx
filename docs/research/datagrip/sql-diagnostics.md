# DataGrip SQL syntax diagnostics: independently documented behavior

Reference: DataGrip 2026.1.3, build `DB-261.24374.56`. Target dialects are PostgreSQL, MySQL, and SQLite. This document records behavior and evidence for DBX's independent implementation; it does not ship DataGrip code or artifacts.

## Evidence

- REA `rea-agents 6.9.0` recorded the shipped application inventory and Evidence bundle. JVM signatures/bytecode and local decompilation are used for parser/recovery control flow.
- DataGrip's own `Contents/bin/inspect.sh` runs the real parser and headless highlighting. Its JSON `Annotator.json` reports the line, offset, length, severity, and message of syntax errors. This is direct behavioral evidence, not a guess based on class names.
- The differential suite contains 64 valid/invalid cases across the three dialects, including Unicode, EOF, multiple independent statement errors, DML/DDL, JOIN, CTE, parameters, comments, quotes, and dialect-specific syntax.
- Headless inspection is isolated per case. A batch MySQL run exposed an IDE-lifecycle failure, so per-case projects are used and missing output is recorded rather than treated as valid SQL.

## Parser and error construction

The parser chain is:

```text
source text
  → dialect lexer
  → Pg/Mysql/Sqlite generated parser + dialect parser callbacks
  → tolerant PSI/AST with PsiErrorElement nodes
  → editor highlighting / inspections
  → message + source range
```

### Expected/found messages

`SqlParserUtil.markTokenAsUnexpected` reads the current token and uses `<EOF>` when no token exists. With an expected token it produces the localized unexpected-token/expected message; without one it reports the token as unexpected. `SqlParserUtil.error` marks a range as an error and optionally advances the lexer before closing the marker, preventing a non-advancing recovery loop.

Generated-parser failures also use the shared `ErrorState.currentFrame`, `errorReportedAt`, variant tracking, and `GeneratedParserUtilBase.report_error_`. `SqlGeneratedParserUtil.parseAndMarkError` conditionally adds an unexpected-content error only when the parser reports that the branch progressed beyond the previously reported error. The parser chooses between alternatives using parse progress and error position rather than blindly accepting the first branch.

Observed messages are concise expected/found forms such as:

```text
<expression> expected, got 'AND'
<expression> expected, got ')'
')' or ',' expected
```

The DBX implementation should expose structured expected/found fields and a display message. It should not depend on parsing a formatted error string to recover the location.

## Recovery and multiple errors

`SqlParser.parseStatementBlockBody` repeatedly parses nested statements and statement separators. If a nested parser makes no progress before EOF, `SqlParserUtil.markTokenAsUnexpectedAndAdvance` forces progress. Statement separators come from the active dialect. Recovery can also inspect raw whitespace/newline tokens and uses a `myStatementRecoverNewLine` guard.

`SqlGeneratedParserUtil` exposes statement/block recovery and synchronization predicates based on comma, right parenthesis, semicolon, and dialect statement separators. PostgreSQL adds psql/COPY-specific recovery, while MySQL handles DELIMITER and routine boundaries. Completion mode has separate logic so an unfinished editor token is not treated like a finished-file error in the same way.

For DBX, recovery must:

1. report the unexpected token or missing element with a precise span;
2. synchronize at a clause/statement boundary without consuming a valid following statement;
3. guarantee forward progress;
4. suppress cascades caused by the same parser failure;
5. allow independent errors in later statements;
6. bound work for malformed large documents.

## Highlight ranges

`SqlValidatingHighlightVisitor` is the SQL-specific visitor for dialect validation and delegates to the active dialect's validation delegate. Parser errors are also present as PSI error elements and are reported by the platform's highlighting/annotator pipeline. These are separate from `SqlResolveInspection`, which reports unknown tables/columns using schema/metadata resolution.

Headless `inspect.sh` distinguishes these outputs in separate files: `Annotator.json` contains syntax errors, while `SqlResolveInspection.json` contains unresolved references. DBX must preserve the same separation between syntax, semantic/metadata, and execution errors.

The observed range normally covers the unexpected token. A missing token at EOF can produce a zero-length position, so the editor adapter must deliberately choose a visible caret/character range without reading outside the document. Line/column conversion must account for CRLF and Unicode/UTF-16 offsets explicitly.

## Dialect ownership

| Dialect | Parser entry | Notable behavior to preserve |
| --- | --- | --- |
| PostgreSQL | `PgGeneratedParser` + `PgParser` / `PgParserBase` | psql/COPY recovery, dollar-quoted bodies, custom operators, parameters, RETURNING, and PL-aware parsing |
| MySQL | `MysqlGeneratedParser` + `MysqlParser` | DELIMITER, routine boundaries, user variables, strings/identifiers, REPLACE, and backtick quoting |
| SQLite | `SqliteGeneratedParser` + `SqliteParser` | SQLite statement separators, upsert, qualified names, and expression parsing |

The dialect parser classes supply custom productions and errors while sharing base recovery utilities. DBX should reuse its existing `sqlparser` dialect selection and token/span types where correct, then add explicit grammar-gap handling rather than silently falling back to a different dialect.

## DBX integration contract

Add a Rust `analyze_sql_syntax(sql, dialect)` API that returns a list of structured diagnostics:

```text
message
severity = error
span = 1-based inclusive SqlTextSpan
expected? = expected token/expression descriptions
found? = unexpected token text or EOF
```

Tauri and HTTP expose the same contract. The editor combines these with existing semantic and execution diagnostics while retaining worker-based statement/range preparation, debounce, viewport replacement, cancellation, stale-result checks, parameter masking, and IME/completion suppression.

Backend availability errors are not SQL syntax errors. A parser gap that deliberately accepts a known valid construct must not also produce a syntax diagnostic. Execution-error text mapping remains only a compatibility fallback for legacy result envelopes.

## Differential acceptance matrix

The final PR updates this table with exact results and any documented differences.

| Area | DataGrip evidence | DBX verification |
| --- | --- | --- |
| Valid SELECT/CTE/JOIN/DML/DDL | No syntax error in real inspection | No false positives in the valid corpus |
| Unexpected token/missing expression | Expected/found message and token offset | Structured message and matching range |
| Missing delimiter/parenthesis | Expected token message at the parser's insertion point | Visible range at the same logical position |
| EOF | Zero-length parser position observed where applicable | Safe visible EOF/caret mapping |
| Multiple statements | Independent errors can coexist | No stale/duplicate decorations after edits |
| Unicode/CRLF/parameters | Real source offsets | Correct UTF-16 and statement-relative mapping |
| Backend/semantic/execution separation | Separate inspection/highlight ownership | No backend failure or unknown-column duplication as a syntax error |

## Implementation verification

- The complete 64-case DataGrip result set is stored in `sql-diagnostics-corpus.json`, including missing headless-output markers; absence of an `Annotator.json` file is not treated as proof that input is valid.
- Rust: five `dbx-sql-core` syntax tests and two public `dbx-core` API/recovery tests pass. `cargo check -p dbx -p dbx-web` passes for the Tauri and HTTP registrations.
- Frontend: 13 diagnostics/editor test files, 259 tests, pass, covering structured ranges, EOF mapping, deduplication, backend failures, semantic/execution diagnostics, and existing worker behavior.
- `typecheck`, `lint`, and the production frontend build pass.

The independent implementation uses DBX's existing `sqlparser` dialects and grammar-gap rules, not the DataGrip parser itself. It reports the first parser failure per failing statement and recovers independently at later statement boundaries; it does not yet reproduce DataGrip's full list of alternative expected tokens or multiple independent errors within one statement. Dialect-specific parser coverage and exact wording can differ, and those differences must be evaluated against the recorded corpus rather than presented as exact parity.

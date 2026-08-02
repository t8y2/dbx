# ClickHouse SQL Syntax Highlighting Design

**Date:** 2026-07-29

## Goal

Give ClickHouse connections a dedicated SQL highlighting dialect in DBX's
CodeMirror query editors and DDL viewers. ClickHouse keywords, data types, and
common built-in functions should receive the same semantic colors that the
existing editor themes already assign to those token classes.

## Background

DBX currently has separate dialect-selection paths for SQL formatting and SQL
highlighting:

- `sqlFormatter.ts` maps ClickHouse to the formatter's native `clickhouse`
  language.
- `jdbcDialect.ts` maps ClickHouse to the generic `mysql` CodeMirror dialect
  name.
- `codemirrorSqlDialect.ts` does not recognize the ClickHouse database type and
  therefore selects `StandardSQL` as its parser base.
- the semantic table-name overlay receives the explicit `mysql` dialect and
  consequently applies MySQL rules to ClickHouse SQL.

This explains why formatting can look correct while highlighting does not.
Editor themes already distinguish keywords, types, functions, strings, and
identifiers; the parser is producing incomplete or incorrect token classes.

## Scope

Included:

- the main CodeMirror query editor
- CodeMirror-based DDL and SQL viewers that use the shared DBX dialect factory
- ClickHouse keyword, data-type, built-in-function, comment, and table-name
  classification
- focused parser and propagation tests

Not included:

- Shiki-rendered static SQL blocks in AI messages
- SQL formatting, execution, completion, or snippet behavior
- a complete ClickHouse grammar or query validator
- theme color changes

## Chosen Approach

Add `clickhouse` as a first-class DBX CodeMirror dialect name. Define its
CodeMirror dialect from `StandardSQL`, then extend the dialect specification
with ClickHouse-specific keywords, data types, and common built-in functions.

`StandardSQL` is the safer parser base than `MySQL` because ClickHouse and MySQL
do not share all lexical behavior. In particular, DBX already tests that
ClickHouse accepts `--` comments without the whitespace requirement used by the
CodeMirror MySQL dialect.

The vocabulary will be curated from the official ClickHouse SQL reference and
kept as named constants next to the existing PostgreSQL and SQL Server
extensions. Representative coverage includes:

- clauses and DDL terms such as `PREWHERE`, `ARRAY JOIN`, `ENGINE`,
  `PARTITION BY`, `SAMPLE BY`, `TTL`, `SETTINGS`, `CODEC`, and `FORMAT`
- types such as `UInt64`, `DateTime64`, `LowCardinality`, `Nullable`, `Map`,
  `Tuple`, `Nested`, `AggregateFunction`, and `SimpleAggregateFunction`
- common functions such as `toYYYYMM`, `uniqExact`, `argMax`, `groupArray`,
  `arrayJoin`, and `JSONExtractString`

This is vocabulary-driven syntax highlighting, not validation. Unknown future
functions will still parse as callable identifiers instead of breaking editor
input.

## Data Flow

1. A ClickHouse connection resolves to the new `clickhouse` CodeMirror dialect
   name in `jdbcDialect.ts`.
2. QueryEditor and DDL viewers pass that name and the ClickHouse database type
   into `createDbxCodeMirrorSqlDialect()`.
3. The dialect factory selects the dedicated ClickHouse specification.
4. CodeMirror's Lezer SQL parser assigns keyword, type, built-in, comment, and
   identifier tags.
5. Existing editor themes render those tags with their current colors.
6. The semantic overlay selects a ClickHouse adapter for table-name
   decorations instead of inheriting MySQL behavior accidentally.

## Semantic Adapter

Add a ClickHouse semantic dialect adapter rather than silently treating
ClickHouse as MySQL. It will support ClickHouse's backtick and double-quote
identifier quoting and use the project's existing default identifier
normalization unless a verified ClickHouse-specific rule is required.

This adapter is limited to tokenization and table-reference decoration. It does
not change query execution or attempt to model every ClickHouse alias-resolution
extension.

## Compatibility And Failure Behavior

- Existing MySQL, PostgreSQL, SQL Server, Oracle, SQLite, and generic database
  mappings remain unchanged.
- ClickHouse keeps its current `--SELECT 1` line-comment behavior.
- An unlisted ClickHouse keyword or function remains readable as an identifier;
  highlighting degrades locally without blocking editing.
- All changes remain frontend-only and require no persisted-setting migration.

## Testing

Use test-driven development:

1. Add parser tests that initially fail under the current StandardSQL fallback.
2. Assert representative ClickHouse terms produce keyword, type, and built-in
   parser nodes.
3. Retain and strengthen the line-comment regression test.
4. Assert the JDBC database-type mapping returns `clickhouse`.
5. Assert QueryEditor and DDL viewers pass the dedicated dialect through the
   shared factory.
6. Add semantic-dialect coverage for ClickHouse identifier quoting and
   selection.
7. Run focused tests, the relevant desktop test suite, and frontend typecheck.

## Alternatives Considered

### Extend the MySQL dialect

This is smaller but preserves known lexical mismatches and continues to make
ClickHouse behavior depend on unrelated MySQL changes.

### Integrate the ClickHouse lexer or WebAssembly

ClickHouse exposes native query-highlighting capabilities, including recent
lexer/WASM work. That route could eventually provide higher fidelity, but it
adds runtime, bundle-size, and CodeMirror syntax-tree integration costs that are
disproportionate to this focused highlighting fix.

## Success Criteria

- ClickHouse-specific clauses, types, and common functions are visually
  differentiated in query and DDL editors.
- ClickHouse no longer resolves to MySQL or generic StandardSQL by accident.
- existing dialect behavior and editor themes do not regress.
- the implementation is covered by focused parser, mapping, and semantic tests.

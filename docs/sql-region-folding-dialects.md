# SQL region folding: dialect coverage

Review date: 2026-10-13. Scope: Issue #12006, comment, string, identifier and dollar-delimited boundaries around region directives. This is a static source/documentation audit, not database certification. No build, test, type check, or server execution was performed.

## Design

`sqlRegionDialectPolicy.ts` explicitly classifies every registered database type. The dollar, string, block-comment and identifier policy tables all use exhaustive `satisfies Record<DatabaseType, ...>` declarations, which make a future type addition require a policy decision during normal type checking (not run in this task). Both the editor and statement-analysis worker resolve the same policy. SQL execution and statement splitting are unchanged. Block-comment nesting in highlighting now shares the region policy through a pinned CodeMirror patch.

- `tagged`: `$$...$$` and matching `$tag$...$tag$`; tags are case-sensitive and cannot begin with a digit.
- `bare`: only `$$...$$`; `$tag$` does not open a literal.
- `whitespace-bare`: only `$$...$$`, with preceding whitespace or beginning of input/line (H2).
- `none`: no dollar-string override; ordinary quotes/comments continue using the editor dialect. This is not a claim that every server version or compatibility mode lacks dollar quoting.
- `dialect`: generic JDBC and an editor without a concrete database use their selected PostgreSQL/ClickHouse dialect for tagged quoting; other selections disable it.

Snowflake additionally enables backslash escapes for strings in the region scanner; its quoted identifiers still use doubled delimiters. String-specific overrides are described below. String highlighting options are unchanged; block-comment nesting is synchronized as described below. MySQL keeps dollar quoting disabled so `DELIMITER $$` does not hide region markers.

## Evidence for dollar-string policies

| Sources | Policy and evidence |
| --- | --- |
| PostgreSQL family already mapped by DBX | `tagged`; preserve the existing family mapping and PostgreSQL literal semantics. [PostgreSQL lexical structure](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-DOLLAR-QUOTING). DBX's existing SQL statement-range fixtures cover PostgreSQL-family dollar-quoted routines. Compatibility modes still require manual confirmation. |
| DuckDB | `tagged`; [literal types](https://duckdb.org/docs/preview/sql/data_types/literal_types#dollar-quoted-string-literals). |
| ClickHouse | `tagged`; [heredoc syntax](https://clickhouse.com/docs/reference/syntax#heredoc). |
| Snowflake | `bare`, plus ordinary-string backslash escapes; [string constants](https://docs.snowflake.com/en/sql-reference/data-types-text#string-constants). |
| Cassandra | `bare`; [CQL definitions](https://cassandra.apache.org/doc/4.0/cassandra/cql/definitions.html) describe strings delimited by two dollar characters. |
| Vertica | `bare`; [24.1 dollar-quoted literals](https://docs.vertica.com/24.1.x/en/sql-reference/language-elements/literals/string-literals/dollar-quoted-string-literals/) documents the paired-dollar form, not named tags. |
| H2 | `whitespace-bare`; [SQL grammar](https://h2database.github.io/html/grammar.html#dollar_quoted_string). DBX ships H2 profiles 1.4.200, 2.1.214 and 2.4.240; those profiles share the `h2` database type. |
| Ignite 2 | `whitespace-bare` for its H2 engine; [Ignite SQL introduction](https://ignite.apache.org/docs/ignite2/latest/SQL/sql-introduction). Calcite is an alternative engine: its behavior is not inferred from H2. Ignite 3 remains separate. |
| Databend | `bare`; official [tokenizer](https://github.com/databendlabs/databend/blob/main/src/query/ast/src/parser/token.rs), `LiteralCodeString`, explicitly recognizes paired dollars. This covers code bodies as well as avoiding false regions in that token. |

## String-boundary audit

Both policy tables enumerate every current database type. String policies complement the dollar policies; they do not modify SQL execution, statement splitting or string highlighting.

| Policy / sources | Boundary handling and basis |
| --- | --- |
| `google`: BigQuery, Spanner (GoogleSQL) | Single/double strings, triple single/double strings, bytes and raw prefixes, escaped delimiters and backtick identifiers. A triple literal ends only at three matching unescaped quotes; individual quotes in its body do not close it. Raw prefixes affect decoding but still protect escaped quotes lexically. [BigQuery](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/lexical#string_and_bytes_literals), [Spanner](https://docs.cloud.google.com/spanner/docs/reference/standard-sql/lexical#string_and_bytes_literals). |
| `spark`: Spark, Databricks, Kyuubi default Spark engine | Single/double strings with backslash escapes; `r`/`R` raw strings disable quote escaping. Backtick identifiers use doubled backticks, not string escapes. No triple-string rule is inferred from GoogleSQL. [Spark grammar](https://github.com/apache/spark/blob/master/sql/api/src/main/antlr4/org/apache/spark/sql/catalyst/parser/SqlBaseLexer.g4), [Databricks strings](https://docs.databricks.com/aws/en/sql/language-manual/data-types/string-type). Kyuubi may route to other engines; engine-specific modes remain unverified. |
| `dual-backslash`: Hive, Argo, Transwarp, Impala, Databend, TDengine | Retain the existing DBX backslash-string family and also apply its escapes to double-quoted strings; backticks remain identifiers. TDengine is also confirmed by its [official tokenizer](https://github.com/taosdata/TDengine/blob/main/source/libs/parser/src/parTokenizer.c). |
| `escape`: PostgreSQL-compatible adapters, DuckDB, Vertica | Backslashes are enabled for a token-delimited `E`/`e` string prefix only. This was previously applied to every source. Ordinary standard strings and identifiers keep their normal boundaries. [PostgreSQL](https://www.postgresql.org/docs/current/sql-syntax-lexical.html), [DuckDB](https://duckdb.org/docs/preview/sql/data_types/literal_types), [Vertica](https://docs.vertica.com/23.4.x/en/sql-reference/language-elements/literals/string-literals/extended-string-literals/). Vendor compatibility modes retain the existing adapter assumptions. |
| `backslash`: Snowflake, Redshift | Ordinary single-quoted strings protect escaped quotes. Double-quoted identifiers do not inherit this setting. [Snowflake](https://docs.snowflake.com/en/sql-reference/data-types-text), [Redshift driver `escapeCatalogLiteral` documentation](https://github.com/aws/amazon-redshift-jdbc-driver/blob/master/src/main/java/com/amazon/redshift/jdbc/RedshiftDatabaseMetaData.java). |
| `clickhouse` | Backslashes protect delimiters in quoted identifiers as well as strings. Applies to generic ClickHouse editors too. [ClickHouse syntax](https://clickhouse.com/docs/reference/syntax#identifiers). |
| `firebird` | Recognize `q`/`Q` alternative strings using paired `[]`, `{}`, `()`, `<>` or a repeated delimiter. [Firebird 3+ alternative literals](https://firebirdsql.org/file/documentation/chunk/en/refdocs/fblangref30/fblangref30-commons.html). Existing Oracle-family adapters retain equivalent `q` and national `nq` handling with token-boundary checks. |
| `influxql`: InfluxDB | Single-quoted strings and double-quoted identifiers protect backslash-escaped delimiters. [InfluxQL specification](https://docs.influxdata.com/influxdb/v2/reference/syntax/influxql/spec/). The separate InfluxDB 3 SQL adapter is not assigned InfluxQL rules. |
| `metricsql`: VictoriaMetrics | Cover single, double and backtick delimiters using the quote-boundary behavior of the [MetricsQL lexer](https://github.com/VictoriaMetrics/metricsql/blob/master/lexer.go), including hash comments. |
| `iotdb` | Single/double strings use doubled delimiters; backticks protect identifiers. No backslash escaping is added. [IoTDB 2.x lexical rules](https://iotdb.apache.org/UserGuide/latest/SQL-Manual/Syntax-Rule.html). The table model also retains double-quoted identifier boundaries. |
| `adapter`: remaining sources | Reviewed against the existing editor adapter: MySQL-family strings and backticks; SQLite-family strings, double/backtick/bracket identifiers; SQL Server strings and bracket identifiers; Oracle-family alternative strings; generic standard single/double quoting. National, Unicode and hex introducers that keep ordinary quote boundaries need no new scanner state. No triple or raw rule is enabled without evidence. Generic JDBC, proprietary compatibility modes and unsupported query languages are not certified by this category. |

The registry inventory below is a configuration/call-chain audit of all sources, not a claim of server execution against all of them. The shared scanner was read for empty/unterminated literals, nested regions, escaped/doubled delimiters, multiline input, text following the closing delimiter, and ordinary/background editor consistency. No executable checks of these cases were run.

## Comment-rule audit

Comment rules now have their own exhaustive policy table, applied after string overrides in the same editor/worker resolver. The table below describes the scanner behavior; the inventory includes a comment-policy decision for every source. `legacy` means a source was inspected but its active engine/version semantics could not be established, so the previous scanner behavior is retained rather than inventing a compatibility guarantee.

| Policy | Line comments | Block comments |
| --- | --- | --- |
| `flat` | `--` | First `*/` closes the comment; inner `/*` is plain text |
| `nested` | `--` | Nested `/* ... */` |
| `mysql` | `--` followed by whitespace/control or end of line; `#` | Non-nesting; `/*!...*/` and `/*+...*/` stay comment regions for folding |
| `google` | `--`, `#` | Non-nesting |
| `clickhouse` | `--`, `//`, `# `, `#!` | Nested |
| `h2` | `--`, `//` | Nested |
| `slash-flat` | `--`, `//` | Non-nesting |
| `spark` | `--`; trailing backslash continues over LF | Nested; hint bodies remain protected from region directives |
| `metricsql` | `#` | No SQL block comments; `-- region` remains an editor directive only |
| `legacy` | Existing adapter's `--`, `#`, `//` settings | Previous nested behavior; not independently certified |
| `excluded` | Not used by region folding | Existing feature gate excludes this source |
| `dialect` | Selected editor dialect | Generic JDBC: MySQL, PostgreSQL, SQL Server or ClickHouse policy; not inferred from arbitrary JDBC targets |

Evidence and differences checked:

- [SQLite comments](https://www.sqlite.org/lang_comment.html) explicitly do not nest. This also selects the policy for DBX's SQLite-family adapters (`rqlite`, `turso`, `cloudflare-d1`). [MySQL 8.4](https://dev.mysql.com/doc/refman/8.4/en/comments.html) requires whitespace/control after `--` and documents non-nested blocks. Existing MySQL-family vendor mappings are retained, not independently certified for all server modes.
- [PostgreSQL](https://www.postgresql.org/docs/current/sql-syntax-lexical.html#SQL-SYNTAX-COMMENTS) and [SQL Server](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/slash-star-comment-transact-sql) support nested blocks. PostgreSQL-compatible products retain the existing family assumption. [QuestDB lexer helper](https://github.com/questdb/questdb/blob/master/core/src/main/java/io/questdb/griffin/SqlUtil.java) explicitly counts block openers; it is not assigned the SQLite rule.
- [ClickHouse](https://clickhouse.com/docs/reference/syntax#comments) supports nested blocks and all four line-comment forms above. A bare `#` is not generalized to a comment. [H2](https://h2database.github.io/html/grammar.html#comment) supports nested blocks and `//`; Ignite 2 follows its default H2 engine. Alternate Ignite engines remain unverified.
- [Spark lexer](https://github.com/apache/spark/blob/master/sql/api/src/main/antlr4/org/apache/spark/sql/catalyst/parser/SqlBaseLexer.g4) has recursive bracket comments and backslash-LF line continuation. [Databricks](https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-syntax-comment) explicitly documents nesting. Kyuubi follows its default Spark engine, not all possible engines.
- [Hive lexer](https://github.com/apache/hive/blob/master/parser/src/java/org/apache/hadoop/hive/ql/parse/HiveLexerParent.g) recursively recognizes `QUERY_HINT` blocks, including ordinary comments. Argo/Transwarp retain the existing Hive-family assumption. [Impala](https://github.com/apache/impala/blob/master/fe/src/main/jflex/sql-scanner.flex) instead ends its block at the first terminator.
- [Trino](https://github.com/trinodb/trino/blob/master/core/trino-grammar/src/main/antlr4/io/trino/grammar/sql/SqlBase.g4) uses a non-recursive block token; the `prestosql` adapter belongs to the same family. [Databend](https://github.com/databendlabs/databend/blob/main/src/query/ast/src/parser/token.rs), [TDengine](https://github.com/taosdata/TDengine/blob/main/source/libs/parser/src/parTokenizer.c), [Firebird](https://github.com/FirebirdSQL/firebird/blob/master/src/dsql/Parser.cpp) and [InfluxQL](https://github.com/influxdata/influxql/blob/master/scanner.go) also stop at the first terminator.
- [Oracle PL/SQL](https://docs.oracle.com/cd/B19306_01/appdev.102/b14261/comments.htm) disallows nested comments. Oracle-compatible vendor adapters retain this assumption; compatibility modes or configurable nesting require server-specific confirmation.
- [BigQuery](https://docs.cloud.google.com/bigquery/docs/reference/standard-sql/lexical#comments) and [Spanner](https://docs.cloud.google.com/spanner/docs/reference/standard-sql/lexical#comments) allow `#` but not nested blocks. [Cassandra lexer](https://github.com/apache/cassandra/blob/trunk/src/antlr/Lexer.g) includes `//` and a non-recursive block token.
- [Vertica SQL comments](https://docs.vertica.com/24.1.x/en/sql-reference/language-elements/expressions/comments/) support nesting; PL/vSQL has separate restrictions. [IBM JDBC comment rules](https://www.ibm.com/docs/en/db2/11.1?topic=programming-comments-in-jdbc-application) document nested blocks for DB2. Do not infer Informix brace comments from this: JDBC escape syntax and server modes differ.
- [Snowflake's official connector](https://github.com/snowflakedb/snowflake-connector-python/blob/main/src/snowflake/connector/util_text.py) handles `--`, `//` and first-terminator blocks; this is client-lexer evidence, not server certification. [Calcite grammar](https://github.com/apache/calcite/blob/main/core/src/main/codegen/templates/Parser.jj) supplies `--`, `//`, non-nesting blocks for the default Ignite 3/Kylin family assumption.
- [Doris lexer](https://github.com/apache/doris/blob/master/fe/fe-core/src/main/antlr4/org/apache/doris/nereids/DorisLexer.g4) recursively matches bracket comments and continues `--` comments over backslash-LF, so it uses the Spark comment profile independently of its string profile. [StarRocks lexer](https://github.com/StarRocks/starrocks/blob/main/fe/fe-grammar/src/main/antlr/com/starrocks/grammar/StarRocksLex.g4) accepts unspaced `--` and non-nested blocks/hints. Neither inherits MySQL whitespace or hash-comment rules.
- [Introduction to Teradata 15.10, p. 70](https://assets.teradata.com/pdf/TCPP/database/Intro_to_Teradata_15_10.pdf) disallows nested bracketed comments; Teradata uses the flat profile. Newer server modes remain subject to manual verification.
- [MetricsQL lexer](https://github.com/VictoriaMetrics/metricsql/blob/master/lexer.go) only treats `#` as a comment. SQL block markers must not create a persistent comment state in this editor.
- `saphana`, `exasol`, `access`, `informix`, `sundb`, `xugu`, `iotdb`, `iris`, `influxdb3` retain `legacy` explicitly: registry/adapter paths were checked, but complete comment semantics across their active driver modes were not established. Informix braces/JDBC escapes, IoTDB tree/table differences and InfluxDB 3 SQL/InfluxQL selection require a reliable mode signal before changing shared rules.

All comment bodies are scanned as text, not strings: quotes and alternative string delimiters inside comments do not change their boundaries. Conversely, comments inside a string/quoted identifier/dollar body never open a comment state. Hints and executable comments are opaque for custom region recognition; this does not change their execution semantics. Normal region directives are never parsed inside a continued line comment or any still-open block.

## Identifier-boundary audit

`SQL_REGION_IDENTIFIER_POLICIES` explicitly inventories all 86 registered types and is applied after string/comment profiles in the shared editor/worker resolver. It describes the editor's default dialect, not every server compatibility mode. The opening delimiter, closing delimiter, doubled closing delimiter and backslash handling were checked separately. A string's escape setting never enables escapes in a quoted identifier.

| Identifier policy | Boundaries and evidence |
| --- | --- |
| `sqlite` | Double quotes, backticks and brackets; doubled quotes/backticks escape themselves, but the **first** right bracket closes a bracketed identifier. Applies to SQLite, rqlite, Turso and Cloudflare D1. The CodeMirror SQLite adapter omits brackets, so the region policy supplies them explicitly. [SQLite quoting](https://www.sqlite.org/lang_keywords.html), [tokenizer requirements H41140–H41160](https://www.sqlite.org/draft/tokenreq.html). |
| `sqlserver` | Double quotes and brackets; `]]` escapes a right bracket. This remains different from SQLite. [SQL Server QUOTENAME](https://learn.microsoft.com/en-us/sql/t-sql/functions/quotename-transact-sql). |
| `access` | Brackets end at the first right bracket; double-quoted tokens retain their existing protected boundaries. Access names cannot contain brackets, so no SQL Server-style bracket escape is inferred. [Access SELECT](https://support.microsoft.com/en-us/access/access-sql-select-clause), [naming rules](https://support.microsoft.com/en-us/access/guidelines-for-naming-fields-controls-and-objects). |
| `double-backtick` | Both double quotes and backticks, using doubled delimiters and no backslash identifier escapes. H2's [tokenizer](https://github.com/h2database/h2database/blob/master/h2/src/main/org/h2/command/Tokenizer.java) accepts both in its regular mode; Ignite 2 follows the existing default H2 engine assumption. IoTDB retains its existing dual delimiter policy. H2 brackets depend on server compatibility mode and are deliberately not enabled globally. |
| `backtick` | MySQL-family, Hive-family, Spark-family, Databend and TDengine default mappings. A doubled backtick protects the delimiter; a backslash does not. [MySQL identifiers](https://dev.mysql.com/doc/refman/8.4/en/identifiers.html), the Spark/Doris/StarRocks lexer `BACKQUOTED_IDENTIFIER` rules and Databend lexer above support this distinction. Existing vendor-family assumptions remain mode-dependent. Double-quoted **strings** retain their string rules where supported. |
| `escaped-backtick` | GoogleSQL BigQuery/Spanner keep backtick identifiers with lexical backslash escapes, as documented in their lexical references above. |
| `escaped-double-backtick` | ClickHouse keeps double quotes/backticks and identifier backslash escapes. [ClickHouse identifiers](https://clickhouse.com/docs/reference/syntax#identifiers). |
| `escaped-double` | InfluxQL double-quoted identifiers retain their backslash protection, as confirmed by the InfluxQL scanner above. |
| `double` | PostgreSQL/Oracle/standard-SQL adapter families, plus other existing standard adapters: double-quoted tokens use doubled delimiters, without backslash identifier escapes. This records their current default mapping, not independent certification of all proprietary modes. Kylin's [SQL specification](https://kylin.apache.org/docs/query/specification/sql_spec/) documents double-quoted names. |
| `string-policy` | MetricsQL has no SQL delimited identifiers; its string policy continues protecting its quoted string tokens. |
| `dialect` | Generic JDBC retains the actual editor dialect's delimiters; no server-specific delimiter is inferred from the JDBC transport alone. |
| `excluded` | Existing region eligibility excludes these non-SQL/graph sources. |

The default profiles preserve previously supported delimiters and fix three missing forms: SQLite-family brackets, Access brackets and H2/default-Ignite-2 backticks. SQL Server's doubled right brackets are preserved. Brackets are not enabled for PostgreSQL, DuckDB or other array/subscript dialects. Quoted contents may contain apostrophes, comment openers, dollar delimiters or region-looking lines without opening a new scanner state.

Remaining mode limits are explicit: generic JDBC, H2 MSSQL mode, alternate Ignite/Kyuubi engines, and proprietary compatibility modes are not certified. Repository JDBC metadata can report a connection-specific quote (for example GaussDB/Kingbase MySQL modes), but this region resolver does not receive it. No speculative global bracket/backtick support is added to these default profiles. This audit does not claim that inherited proprietary mappings have been verified against every server.

## Complete registry inventory

The inventory below was read from `database-drivers.manifest.json`, the generated database-type union, existing dialect adapters, and the policy table. SQL eligibility uses the existing `sqlFileExecution` capability and excludes graph query editors. Excluded sources retain their existing behavior. A `none` row means no new dollar-string capability was established by this audit; it is not proof about undocumented/vendor-specific modes.

| Database type | Region entry | Dollar policy | String policy | Comment policy | Identifier policy | Review basis |
| --- | --- | --- | --- | --- | --- | --- |
| `mysql` | SQL | `none` | `adapter` | `mysql` | `backtick` | Existing adapter/registry; no dollar override |
| `postgres` | SQL | `tagged` | `escape` | `nested` | `double` | Existing PostgreSQL-family adapter |
| `sqlite` | SQL | `none` | `adapter` | `flat` | `sqlite` | Existing adapter/registry; no dollar override |
| `rqlite` | SQL | `none` | `adapter` | `flat` | `sqlite` | Existing adapter/registry; no dollar override |
| `turso` | SQL | `none` | `adapter` | `flat` | `sqlite` | Existing adapter/registry; no dollar override |
| `cloudflare-d1` | SQL | `none` | `adapter` | `flat` | `sqlite` | Existing adapter/registry; no dollar override |
| `redis` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `duckdb` | SQL | `tagged` | `escape` | `nested` | `double` | Official source above |
| `clickhouse` | SQL | `tagged` | `clickhouse` | `clickhouse` | `escaped-double-backtick` | Official source above |
| `sqlserver` | SQL | `none` | `adapter` | `nested` | `sqlserver` | Existing adapter/registry; no dollar override |
| `mongodb` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `dynamodb` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `oracle` | SQL | `none` | `adapter` | `flat` | `double` | Existing adapter/registry; no dollar override |
| `elasticsearch` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `easysearch` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `meilisearch` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `solr` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `couchdb` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `hbase` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `qdrant` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `chromadb` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `milvus` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `weaviate` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `doris` | SQL | `none` | `adapter` | `spark` | `backtick` | Existing adapter/registry; no dollar override |
| `starrocks` | SQL | `none` | `adapter` | `flat` | `backtick` | Existing adapter/registry; no dollar override |
| `manticoresearch` | SQL | `none` | `adapter` | `mysql` | `backtick` | Existing adapter/registry; no dollar override |
| `redshift` | SQL | `tagged` | `backslash` | `nested` | `double` | Existing PostgreSQL-family adapter |
| `dameng` | SQL | `none` | `adapter` | `flat` | `double` | Existing adapter/registry; no dollar override |
| `kingbase` | SQL | `tagged` | `escape` | `nested` | `double` | Existing PostgreSQL-family adapter |
| `highgo` | SQL | `tagged` | `escape` | `nested` | `double` | Existing PostgreSQL-family adapter |
| `uxdb` | SQL | `tagged` | `escape` | `nested` | `double` | Existing PostgreSQL-family adapter |
| `vastbase` | SQL | `tagged` | `escape` | `nested` | `double` | Existing PostgreSQL-family adapter |
| `goldendb` | SQL | `none` | `adapter` | `mysql` | `backtick` | Existing adapter/registry; no dollar override |
| `databend` | SQL | `bare` | `dual-backslash` | `flat` | `backtick` | Official source above |
| `gaussdb` | SQL | `tagged` | `escape` | `nested` | `double` | Existing PostgreSQL-family adapter |
| `kwdb` | SQL | `tagged` | `escape` | `nested` | `double` | Existing PostgreSQL-family adapter |
| `yashandb` | SQL | `none` | `adapter` | `flat` | `double` | Existing adapter/registry; no dollar override |
| `databricks` | SQL | `none` | `spark` | `spark` | `backtick` | Existing adapter/registry; no dollar override |
| `saphana` | SQL | `none` | `adapter` | `legacy` | `double` | Existing adapter/registry; no dollar override |
| `teradata` | SQL | `none` | `adapter` | `flat` | `double` | Existing adapter/registry; no dollar override |
| `vertica` | SQL | `bare` | `escape` | `nested` | `double` | Official source above |
| `firebird` | SQL | `none` | `firebird` | `flat` | `double` | Existing adapter/registry; no dollar override |
| `exasol` | SQL | `none` | `adapter` | `legacy` | `double` | Existing adapter/registry; no dollar override |
| `opengauss` | SQL | `tagged` | `escape` | `nested` | `double` | Existing PostgreSQL-family adapter |
| `questdb` | SQL | `tagged` | `adapter` | `nested` | `double` | Existing PostgreSQL-family adapter |
| `oceanbase-oracle` | SQL | `none` | `adapter` | `flat` | `double` | Existing adapter/registry; no dollar override |
| `gbase` | SQL | `none` | `adapter` | `mysql` | `backtick` | Existing adapter/registry; no dollar override |
| `gbase8s` | SQL | `none` | `adapter` | `legacy` | `double` | Upstream Informix descriptor; retain the Informix policy; server modes unverified |
| `gbase8c` | SQL | `tagged` | `escape` | `nested` | `double` | Upstream PostgreSQL descriptor and openGauss-based agent; family policy, compatibility modes unverified |
| `access` | SQL | `none` | `adapter` | `legacy` | `access` | Existing adapter/registry; no dollar override |
| `h2` | SQL | `whitespace-bare` | `adapter` | `h2` | `double-backtick` | Official source above |
| `snowflake` | SQL | `bare` | `backslash` | `slash-flat` | `double` | Official source above |
| `trino` | SQL | `none` | `adapter` | `flat` | `double` | Existing adapter/registry; no dollar override |
| `prestosql` | SQL | `none` | `adapter` | `flat` | `double` | Existing adapter/registry; no dollar override |
| `hive` | SQL | `none` | `dual-backslash` | `nested` | `backtick` | Existing adapter/registry; no dollar override |
| `argo` | SQL | `none` | `dual-backslash` | `nested` | `backtick` | Existing adapter/registry; no dollar override |
| `transwarp` | SQL | `none` | `dual-backslash` | `nested` | `backtick` | Existing adapter/registry; no dollar override |
| `kyuubi` | SQL | `none` | `spark` | `spark` | `backtick` | Existing adapter/registry; no dollar override |
| `impala` | SQL | `none` | `dual-backslash` | `flat` | `backtick` | Existing adapter/registry; no dollar override |
| `db2` | SQL | `none` | `adapter` | `nested` | `double` | Existing adapter/registry; no dollar override |
| `informix` | SQL | `none` | `adapter` | `legacy` | `double` | Existing adapter/registry; no dollar override |
| `neo4j` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `nebula` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `cassandra` | SQL | `bare` | `adapter` | `slash-flat` | `double` | Official source above |
| `bigquery` | SQL | `none` | `google` | `google` | `escaped-backtick` | Existing adapter/registry; no dollar override |
| `spanner` | SQL | `none` | `google` | `google` | `escaped-backtick` | Existing adapter/registry; no dollar override |
| `kylin` | SQL | `none` | `adapter` | `slash-flat` | `double` | Existing adapter/registry; no dollar override |
| `ignite` | SQL | `whitespace-bare` | `adapter` | `h2` | `double-backtick` | Official source above |
| `ignite3` | SQL | `none` | `adapter` | `slash-flat` | `double` | Existing adapter/registry; no dollar override |
| `sundb` | SQL | `none` | `adapter` | `legacy` | `double` | Existing adapter/registry; no dollar override |
| `oscar` | SQL | `none` | `adapter` | `flat` | `double` | Existing adapter/registry; no dollar override |
| `tdengine` | SQL | `none` | `dual-backslash` | `flat` | `backtick` | Existing adapter/registry; no dollar override |
| `xugu` | SQL | `none` | `adapter` | `legacy` | `double` | Existing adapter/registry; no dollar override |
| `etcd` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `zookeeper` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `nacos` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `consul` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `mq` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `mqtt` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `iotdb` | SQL | `none` | `iotdb` | `legacy` | `double-backtick` | Existing adapter/registry; no dollar override |
| `iris` | SQL | `none` | `adapter` | `legacy` | `double` | Existing adapter/registry; no dollar override |
| `influxdb` | SQL | `none` | `influxql` | `flat` | `escaped-double` | Existing adapter/registry; no dollar override |
| `influxdb3` | SQL | `none` | `adapter` | `legacy` | `double` | Existing adapter/registry; no dollar override |
| `victoriametrics` | SQL | `none` | `metricsql` | `metricsql` | `string-policy` | Existing adapter/registry; no dollar override |
| `jdbc` | SQL | `dialect` | `adapter` | `dialect` | `dialect` | Selected editor dialect; arbitrary JDBC server is not inferred |
| `spark` | SQL | `none` | `spark` | `spark` | `backtick` | Existing adapter/registry; no dollar override |
| `plugin` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |
| `salesforce` | Excluded | `none` | `adapter` | `excluded` | `excluded` | Excluded by current feature scope |

## Limits and manual acceptance

This inventory covers every current database type at the configuration/call-chain level. It does not establish live compatibility for every proprietary engine, version, server mode, plugin, or JDBC target. In particular, PostgreSQL-compatible products can expose Oracle modes; Ignite 2 can switch between H2 and Calcite; Kyuubi can route to engines other than its default Spark engine; generic JDBC does not identify every connected product through the editor dialect. No new dollar-quote syntax is enabled merely because a driver uses a PostgreSQL/MySQL wire protocol.

Manually check each policy with a multiline literal containing `-- region` and `-- endregion`: no custom fold should appear inside it, while a region following the literal should fold. For `bare` sources, a dollar-tagged identifier must not swallow later regions. Check H2 whitespace, MySQL `DELIMITER $$`, nested regions, quoted identifiers ending in backslash, and edits followed by changing dialect. Repeat with a document over 2,000 lines to cover the background path. These are suggested checks only; none were executed here.

Additional manual cases (not executed):

1. In BigQuery and Spanner, paste `SELECT ` followed by a triple-quoted multiline string containing `it's`, both region markers, and a closing triple delimiter. No custom region should appear inside; a region after the SELECT should fold. Repeat for triple double quotes and `r`, `b`, `br`, `rb` prefixes in either case.
2. Repeat with odd/even backslashes before the closing triple delimiter, including an escaped quote immediately followed by three closing quotes. Confirm scanning resumes after the actual close.
3. In Spark/Databricks/Kyuubi, use a raw literal ending with a backslash and then a normal region. It must not consume the region. Repeat with normal escaped single/double strings and backtick identifiers.
4. In Firebird and Oracle-family editors, place region markers after an ordinary apostrophe inside an alternative quoted body; only matching alternative delimiters should end it.
5. Compare `E` literals in PostgreSQL/DuckDB/Vertica with a standard-dialect identifier named `e` followed by a normal string. Verify escapes are not enabled globally. Check ClickHouse identifier escapes, InfluxQL strings/identifiers and MetricsQL backtick content.
6. Repeat each case after editing and switching dialect, then in a document over 2,000 lines. Include a normal nested region outside the string as the positive control.

Comment-specific manual acceptance (not executed):

- In SQLite and other `flat` sources: `/* mention /* */` followed by a normal region must allow that region to fold. Include the overlapping sequence `/*/*/`, consecutive comments and an empty `/**/`.
- In nested sources: put both region markers after an inner comment closes but before the outer comment closes. They must remain ignored. A region after the final close must fold.
- Put unmatched quotes and `/*` inside each supported line-comment form (`#`, `//`, `--`, ClickHouse `#!`). The following region must not be swallowed. In Spark, a line ending in backslash continues the comment, so its next-line region marker must be ignored; repeat with multiple continued lines.
- MySQL: compare `-- comment` with `--not-a-comment`; test whitespace/control after the dashes. The editor-only `--region` spelling remains recognized. Check hints and executable comments without executing SQL.
- Switch dialects and repeat in a document over 2,000 lines to exercise the shared background configuration. Keep a normal region outside each comment as a positive control.

Identifier-specific manual acceptance (not executed):

- On SQLite/rqlite/Turso/Cloudflare D1, enter `SELECT 1 AS [it's];` followed by a normal region. The region must fold. Repeat with double-quoted and backtick names, names containing `/*`, and a multiline bracketed name containing both region markers; only markers outside the name may fold.
- Distinguish the bracket closing rules without executing SQL: after `[a]]`, SQLite has already left the identifier, whereas SQL Server is still inside it. Put marker lines next and a final right bracket later; SQLite may recognize them, SQL Server must ignore them. This deliberately includes unfinished/invalid editor text to expose the boundary difference.
- On Access, a bracketed name containing an apostrophe must not swallow the following region. On H2/default Ignite 2, repeat with a backtick name containing an apostrophe and a doubled backtick.
- Check doubled double quotes/backticks and delimiters immediately after a backslash in each profile. MySQL/Spark identifiers do not inherit string backslash escaping; GoogleSQL/ClickHouse identifiers do retain their lexical escapes.
- Check PostgreSQL/DuckDB array brackets as a negative control, and repeat after edits, switching connections/dialects, and with over 2,000 lines for background analysis.

## Highlighting and built-in comment folding correction (2026-10-19)

The MySQL screenshot showed `/* text /* end */` followed by green SQL and a fold arrow on the single-line comment. Static comparison against HEAD `051cab88a3830595be001911c675b9f5e279b009` confirms the cause predates the region feature: installed `@codemirror/lang-sql` 6.10.0 unconditionally increments comment depth for every inner opener, and the baseline dialect factory did not override that behavior. The same incorrect BlockComment syntax node supplies both highlighting and built-in comment folding. The new region scanner already used the correct first-terminator rule, exposing the mismatch.

`patches/codemirror-lang-sql-6.10.0.patch` adds `nestedBlockComments` to both ESM/CommonJS tokenizers and both type declarations, defaulting to true for compatibility. The common dialect factory passes the same nesting decision as the region scanner. Flat comments now end at the first terminator, including overlapping `/*/*/`; nested dialects retain depth counting. Correcting the syntax node also removes the false multiline comment fold, without hiding fold controls or recoloring text after parsing.

All registered types were checked against the existing exhaustive comment table. Profiles `flat`, `mysql`, `google`, and `slash-flat` disable nesting in highlighting too. Profiles `nested`, `spark`, `clickhouse`, and `h2` retain nesting. `legacy` retains previous behavior pending engine/mode evidence. Generic editors use their selected dialect's nesting decision. Excluded/other query languages are not newly assigned SQL lexical semantics. This change synchronizes block nesting only, not every line-comment, literal or identifier difference of the upstream grammar.

The patch is registered in pnpm-workspace.yaml and pnpm-lock.yaml without changing dependency versions. Offline lockfile generation was attempted with scripts disabled but could not resolve existing @vitejs/plugin-vue metadata; the minimal patch hash and snapshot references were then updated using pnpm's SHA-256 format. The patch applicability was checked and the patch applied to the existing local SQL dependency for manual verification. No build, typecheck, test suite or SQL execution was performed. A clean dependency installation has not been verified.

Manual acceptance still required: reopen/restart the editor after loading the patched dependency, paste the MySQL-only example, and confirm line 46 has no fold arrow; SELECT on lines 48, 55, 62 and 67 has normal keyword highlighting; region arrows at 47, 54 and 61 remain. Check a true multiline comment still folds. Repeat first-terminator cases for the non-nesting profiles and a genuinely nested block for PostgreSQL/SQL Server/Doris/Spark/H2/ClickHouse. Repeat in the background-analysis path on a document over 2,000 lines. Existing Vite prebundled dependencies may need to be regenerated by the next normal development start; an already running page is not evidence that the patch has loaded.

## Execution gutter nested-comment correction (2026-10-19)

The PostgreSQL sample exposed a separate pre-existing defect: `splitSqlStatementRanges` in HEAD ends every block at the first `*/`, so an inner terminator exposes comment text as executable statements. The dependency patch only changes CodeMirror's syntax tree, not execution ranges. The gutter consumes `executableStatementRangeCacheForDoc` both locally and in the analysis worker.

`sqlBlockComments.ts` now derives explicit nesting support from the same exhaustive comment-policy table. The main splitter, trivia/keyword readers, soft statement starts, top-level word scanning, balanced parentheses and trailing-comment trimming honor nested depth. Hint/directive executable-start lookup and same-line cursor checks use the same closing-boundary helper. Unclosed outer blocks consume the remaining comment text rather than exposing it as SQL.

This covers the shared execution path for policies `nested`, `spark`, `clickhouse`, and `h2`: PostgreSQL, DuckDB, SQL Server, Redshift, Kingbase, HighGo, UXDB, Vastbase, GaussDB, KWDB, openGauss, Vertica, QuestDB, Hive, Argo, Transwarp, DB2, Spark, Databricks, Kyuubi, Doris, ClickHouse, H2 and Ignite. Unknown JDBC targets and `legacy` policies retain their existing execution behavior; they are not evidence of verified nesting support. The follow-up static review also covers routine comment boundaries: MySQL-style routine scanning receives the database type (notably for Doris) and carries block depth between incremental chunks; Oracle-style tokenization, body-keyword lookahead and PostgreSQL dollar-body prefix detection receive the same database policy, including GaussDB/openGauss compatibility paths. This does not establish full stored-routine syntax compatibility.

Static review only; no builds, typechecks, tests or SQL execution were run. Manual acceptance: in the PostgreSQL 22-line sample, lines 4 and 6 must lose their run buttons, while lines 8, 11, 17 and 21 retain execution targets. Region arrows remain at 7, 16 and 20. Also check comments between two statements, nested comments containing semicolons/SELECT/BEGIN/END/parentheses, three nesting levels, and an unclosed outer comment. Repeat on a long document to exercise worker analysis and use MySQL's first-terminator example as a non-nesting control.

Follow-up review: the remaining first-terminator searches in `sqlStatementRanges.ts` are confined to Elasticsearch REST preamble handling, not nested SQL dialects. Main splitting, soft splitting, SQL Server control-flow word scans, comment trimming, routine helpers and gutter/cache entry points were inspected without executing them. Additional manual checks should place nested comments containing misleading `BEGIN`, `END` and semicolons inside a Doris routine and an Oracle-style GaussDB/openGauss routine, with a normal statement after the routine; the comment contents must not create execution targets or terminate the routine. No build, test or typecheck was run.

## SQLite and ClickHouse screenshot follow-up

SQLite's region scanner correctly ignored the apostrophe in `[it's]`, but its CodeMirror dialect omitted `[` from identifier quotes. The shared dialect factory now takes supported identifier delimiters from the existing exhaustive identifier table, including SQLite/rqlite/Turso/Cloudflare D1, Access and H2/Ignite. This change synchronizes delimiter availability; it does not claim all vendor-specific escape rules have been synchronized.

ClickHouse's region scanner recognized `//`, `# ` and `#!`, while highlighting and execution scanning did not consistently do so. The factory now supplies the existing hash/slash comment settings. The dependency patch adds a default-off `clickHouseHashComments` setting in both module formats and declaration files, preserving the restricted ClickHouse hash prefixes rather than treating every hash as a comment. Patch hash and both lockfile references were updated.

Execution scanners now share slash-comment eligibility from the policy table: ClickHouse, H2/Ignite, Cassandra, Snowflake, Kylin and Ignite3. Main/soft splitting, word and parentheses scanning, trailing trivia, routine helpers, hint-leading executable offsets and cursor lookup were reviewed. ClickHouse hash-prefix filtering is also applied to execution scanning. This fixes the screenshot's false run button on line 11 and restores following execution ranges, without hiding gutter markers after parsing.

Manual acceptance (not run): SQLite line 1 remains a single-line comment without a fold; line 6 must not start a runaway string or multiline fold, and SELECT on 8/15/20/24 returns to keyword highlighting. Region arrows remain on 2/7/14/19/23. ClickHouse lines 11 and 16 must be complete single-line comments with neither run buttons nor fold arrows; SELECT on 8/13/18/22 must have normal coloring and execution targets. Region arrows remain on 7/12/17/21. Repeat unmatched quotes and block openers inside `//` on the other slash-comment sources; ordinary quoted URLs must stay literals. No build, test, typecheck or SQL execution was performed; dependency patch applicability and diff formatting were checked only. Reloading the changed dependency may require refreshing development prebundles.

### Confirmed stale ClickHouse dependency cache

Static inspection of the local Vite `deps/@codemirror_lang-sql.js` found `nestedBlockComments` but no `clickHouseHashComments`; its hash-comment branch still only checked `d.hashComments`. The installed source, both module formats and declarations already contain the new option, and the shared factory enables it for ClickHouse. Thus the local prebundle is stale, matching the screenshot where slash comments work but hash comments do not. The obsolete `node_modules/.vite/deps` directory was moved to a temporary backup; no development server, optimizer, build or tests were started. Restarting the development service and reloading the page remains manual acceptance work. The installed pnpm directory retains its prior patch-hash name because the existing dependency was patched in place; this inspection does not establish a fresh-install result.

### Reinstallation packaging review

The root manifest now pins lang-sql to 6.10.0 and the importer specifier matches the version-specific patch. Docker copies patches before pnpm installation. Nix dependency-input filters include patches so later patch-only changes trigger the existing hash maintenance path. Patch application to the unpatched distribution and SHA-256/lock references were checked statically. No installation or build was run; the Nix fixed-output dependency hash has not been recalculated and must be verified by the existing Nix maintenance workflow or a later authorized dependency build.

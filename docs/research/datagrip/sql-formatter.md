# DataGrip SQL formatter: independently documented behavior

Reference: DataGrip 2026.1.3, build `DB-261.24374.56`, on macOS arm64. Target dialects are PostgreSQL, MySQL, and SQLite. This is a behavioral specification for a clean implementation in DBX; it does not include DataGrip source, class files, jars, or decompiled method bodies.

## Evidence and limits

- REA `rea-agents 6.9.0` inspected `/Applications/DataGrip.app` and retained evidence bundle `ev_69a6d6ebe479a02ec6b42e3ee4241bd7f19bfde44c48f46347ba8a035b7690fd` (2,296/2,296 entries examined). REA records the shipped artifact and file inventory; it does not claim JVM method semantics.
- JVM evidence comes from class signatures and bytecode control flow, cross-checked with local Vineflower 1.12.0 output. Decompiler failures are treated as unknowns and checked with `javap`, not filled by guesses.
- A Java research harness dumped every public instance field of `SqlCodeStyleSettings` for Modern/Legacy and General/PostgreSQL/MySQL/SQLite: 1,624 rows including dialect hidden-field sets.
- `Contents/bin/format.sh` produced 43 input/output examples: 15 PostgreSQL, 14 MySQL, and 14 SQLite. These cover SELECT, JOIN, subqueries, CTE, INSERT, UPDATE, DELETE, CREATE TABLE, CASE, windows, comments, multiple statements, and dialect-specific syntax.
- The command-line formatter reliably applies the dialect mapping and default layout. During this investigation, custom SQL scheme fields did not affect its output even when generated with DataGrip's own serializer. Custom-setting behavior is therefore based on bytecode/harness evidence, not claimed as CLI-verified. UI/direct-model differential checks remain the follow-up for those settings.

## The formatter has two trees

DataGrip does not directly pretty-print the SQL syntax tree.

1. **Dialect lexer/parser → PSI/AST.** `SqlFormattingModelBuilder.createModel()` creates a read-only `SqlFile` through `SqlPsiFacade.createROFile`. The resulting `FileASTNode` contains statements, query/clause/expression nodes, identifiers, comments, tokens, and error nodes with source ranges. PostgreSQL, MySQL, and SQLite use their respective parser definitions and generated parsers.
2. **PSI/AST → formatter blocks.** `SqlFormattingModelMaker.makeModel(fileNode)` creates a root block and recursively maps syntax nodes to formatter-specific blocks. The block tree represents layout ownership, adjacency, and grouping rather than SQL semantics.
3. **Pre-format edits.** Before the final whitespace layout, `SqlPreFormatProcessor` / `SqlPreFormatter` can make narrowly scoped text edits. `SqlCasePreFormatter` handles keyword/identifier/type/builtin case and quoting; `SqlQueryPreFormatter` handles SELECT alias `AS` insertion/removal and comma movement around line comments. These edits are range-based and are distinct from block layout.
4. **Block analysis and output.** In reformat mode the root runs `grow()`, `analyze()`, and `refine()`. IntelliJ's document formatting model then uses block `Spacing`, `Wrap`, `Indent`, and `Alignment` to rewrite whitespace.

A query such as:

```sql
SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id
```

has query/projection/table/join/binary-expression PSI nodes, then a separate query block with output/from/join/on sections and token leaf blocks. Neither tree alone reproduces DataGrip output.

## Block factory and precedence

`SqlFormattingModelFun.instantiateDefaultBlock` resolves a node in this order:

1. DBMS-specific map from `SqlFormattingContext.dialectSpecificBlocks`;
2. `SqlFormatterHelper.basicBlockCreation` after element-type adjustment;
3. the first matching `SqlFormatterHelper.complexBlockCreation` record;
4. `COMMON_SIMPLE_ELEMENT_BLOCKS`;
5. common fallback factories for keywords, symbols, external tokens, errors, identifiers, unary/binary expressions, function calls, parenthesized expressions, routines, statements, drops, types, constraints, files, DDL, and unsorted/leaf nodes.

The common named map includes:

| PSI construct | Block |
| --- | --- |
| `AS` | `SqlAS` |
| block statement | `SqlBlockStatementBlock` |
| SELECT/query/UNION/INSERT/UPDATE/DELETE/VALUES/WITH query | `SqlQueryBlock` |
| MERGE / EXPLAIN | `SqlMergeBlock` / `SqlExplainPlanBlock` |
| parenthesized query | `SqlParenthesizedSubqueryBlock` |
| CASE expression / statement | `SqlCaseExpressionBlock` / `SqlCaseStatementBlock` |
| reference list | `SqlCortegeBlock` |
| CREATE TABLE / SCHEMA | `SqlCreateTableBlock` / `SqlCreateSchemaBlock` |
| column definition | `SqlColumnBlock` |
| foreign-key reference and constraint details | corresponding constraint blocks |
| ALTER TABLE / ALTER instruction | `SqlAlterTableBlock` / `SqlAlterInstructionBlock` |
| CREATE [MATERIALIZED] VIEW | `SqlViewBlock` |
| IF / THEN / ELSE / ELSEIF | fork/section blocks |
| FOR / WHILE / REPEAT | loop blocks |
| SET assignment | `SqlAssignmentBlock` |
| batch / trigger / exotic create / generic settings | corresponding statement blocks |
| type parameter list / DECLARE / size / IF EXISTS | corresponding type/declaration/phrase blocks |

`SqlNodeBlock` owns one AST node, `SqlRangeBlock` owns a source range and selected child nodes, and `SqlLeafBlock` owns one token. `FlowProcessor` applies each block's `FlowPattern` list to partition nodes into sections and assign `BlockRole`; flattening is selective, not a global AST-to-flat-token conversion.

### Target dialect overrides

| Dialect | Evidence | Formatting consequence |
| --- | --- | --- |
| PostgreSQL | `PgBaseFormatterHelper` maps lazy code blocks, trigger/event-trigger statements, and CREATE TYPE; `PgFormatterHelper` adds no further entries. `SqlQueryBlock` selects `postgresQueryPatterns`; `SqlCreateTableBlock` recognizes PostgreSQL inheritance and LIKE-table forms. | Common query/list algorithm plus PostgreSQL statement/block patterns and routine bodies. |
| MySQL | No MySQL formatter-helper override exists in the inspected MySQL jars. | Common block/layout algorithm; MySQL parser/PSI and identifier/casing behavior provide dialect differences. |
| SQLite | `SqliteFormatterHelper` maps CREATE VIRTUAL TABLE. `SqlCreateTableBlock` selectively flattens SQLite clauses/module references. | Common block/layout algorithm plus virtual-table/module handling. |

## Grow, analyze, and refine

### Grow

`SqlNodeBlock.grow()` lists children and invokes `FlowProcessor`; `SqlRangeBlock.grow()` processes its node range. Growth is lazy and idempotent. Blocks retain source ranges and can be flattened only when their dialect/type-specific predicate allows it.

### Analyze

`SqlFlowBlock.analyze()` first grows the block, recursively analyzes children, and propagates original user line breaks. It then computes `minLength`, `BlockShape`, roles, and collapse behavior.

For a normal flow block with multiple children:

```text
minLength = sum(child.minLength) + floor(childCount / 2)

if any child is expanded or a mandatory-following-newline token is present:
    shape = DECIDED_TO_MULTI_ROWS
else if minLength > rightMargin:
    shape = DECIDED_TO_MULTI_ROWS
else if user wrap requires expansion or preserved user breaks require it:
    shape = DECIDED_TO_MULTI_ROWS
else if minLength <= rightMargin * 3 / 5 and collapse is allowed:
    shape = DECIDED_TO_ONE_ROW
else if roles exist:
    shape = DECIDE_LATER
```

`SqlFormattingContext` sets `lengthThresholdMax = rightMargin` and `lengthThresholdMin = rightMargin * 3 / 5`. Indent-only/adjust mode uses original line breaks rather than full collapse decisions.

### Refine

Refinement configures a block when needed, recursively refines children, then patches child attributes. Shared operations distribute wrap/indent/alignment by role, create child/cascade wraps, and align left/right or tabular columns. Wrap settings map as follows:

| Setting | Wrap type |
| --- | --- |
| `1` (`EL_CHOP`) | `ALWAYS` |
| `2` (`EL_CHOP_LONG`) | `CHOP_DOWN_IF_LONG` |
| `3` (`EL_WRAP`) | `NORMAL` |
| unset/other | inherited or absent |

A multi-row query applies an always/chop wrap to sections. Query section alignment can be left, left with indented content, or right-aligned first words; right alignment computes the maximum section keyword length (with the DataGrip minimum) and applies space indents to shorter prefixes.

## Section rules that drive visible output

### SELECT and other comma/element lists

`WordAndListSection` counts prefix, elements, delimiters, line comments, and amendments. Comma placement resolves from section setting → query setting → original-style detection → trailing comma. The resolved values are leading, trailing, or Egyptian/special layout.

- In an undecided list, always/chop-long uses chop-down-if-long; wrap uses normal; short lists may stay collapsed up to the section's item threshold.
- In a forced multi-row list, always/chop-long becomes `ALWAYS`; other modes use `NORMAL`.
- Leading and trailing comma layouts assign different wraps/indents to element and delimiter roles. Required breaks around comments override compact spacing.
- SELECT additionally uses `SELECT_KEEP_N_ITEMS_IN_LINE`, `SELECT_NEW_LINE_AFTER_ALL_DISTINCT`, and `SELECT_ASTERISK_REGULAR`. An initial `*` can remain attached to SELECT even when ordinary elements would wrap.
- SELECT alias alignment (`SELECT_ALIGN_AS`) aligns `AS`/alias/equality roles only when the selected wrap mode permits it. SET uses the corresponding `SET_ALIGN_EQUAL_SIGN`; WITH uses `WITH_ALIGN_AS`; ORDER BY can align ASC/DESC.
- FROM resolves its list settings from `FROM_*` to query defaults and forces expansion for multiple joined sources. JOIN/ON placement is controlled by `FROM_WRAP_JOIN_1/2`, `FROM_WRAP_ON`, `FROM_INDENT_JOIN`, and `FROM_PLACE_ON`.

### WHERE / JOIN expressions

`WhereSection` determines whether the primary delimiter is AND or OR and flattens only binary-expression nodes containing that delimiter. This preserves expression precedence instead of splitting every nested AND indiscriminately. `WHERE_EL_LINE`, `WHERE_EL_WRAP`, and `WHERE_EL_BOUND` control line, wrap, and delimiter placement; the delimiter width is three for AND, two for OR, and one otherwise.

### CREATE TABLE

`SqlCreateTableBlock` separates the table header, parenthesized element list, AS/query, and postfix options.

- `TABLE_COLLAPSE` chooses chop-if-long versus always expansion; the default modern behavior requires expansion.
- `TABLE_OPENING` selects same-line, unindented, aligned, or indented opening behavior; `TABLE_CONTENT` and `TABLE_CLOSING` control the inner list and closing parenthesis.
- `SqlTableParenthesizedColumnsSection` creates `SqlColumnBlock` elements and always uses trailing delimiters.
- With at least two elements, `TABLE_TYPES_ALIGN`, `TABLE_DEFAULTS_ALIGN`, and `TABLE_NULLABILITIES_ALIGN` create shared alignments for type/generated clause, default, and nullability blocks. When both default and nullability alignment are enabled, their order is chosen by the majority of source column order.
- PostgreSQL LIKE/INHERITS and SQLite module/clause forms use the dialect-specific paths above.

### Spacing and line breaks

`SqlFlowBlock.getSpacing` handles comments, required preceding/following breaks, and otherwise delegates to `decideSpacing`. `decideSpacing` uses the next block's wrap and the adjacent leaf tokens:

- language-required token separation wins;
- periods have no surrounding spaces;
- assignment/operator and keyword/symbol rules choose space/no-space;
- error/amendment/unknown roles use safe spacing to avoid damaging incomplete SQL;
- wrap-as-needed/chop-if-needed can produce a space that is eligible for a newline; forced wraps produce a break.

`SqlFormattingContext` distinguishes safe spacing, forced break, no-space, auto spacing, and dependent line-feed spacing. Original line-break preservation is controlled by common `KEEP_LINE_BREAKS` (and always matters in adjust-only mode). Comment placement honors `KEEP_FIRST_COLUMN_COMMENT` and the configured retained blank-line count.

## Settings resolution and migration

`SqlFormattingContext` receives the dialect-specific settings class selected by `SqlCodeStyles`. If dialect settings have `USE_GENERAL_STYLE`, `SqlFormattingModelBuilder` uses the general SQL settings class. The context also obtains the corresponding common settings and indent options, right margin, `KEEP_LINE_BREAKS`, indentation/tab sizes, and continuation indent.

Current settings schema version is 7. Migration is sequential:

1. **v0 → v1:** derives query/list wrap, comma, join, expression, routine, and blank-line settings from legacy wrap/newline/common settings.
2. **v1 → v2:** initializes modern DDL defaults and derives table alignment, declaration, IF/loop, and expression spacing from legacy fields.
3. **v2 → v3:** swaps the historical 0/2 values for alias/keyword/type/identifier/quoted-identifier case and quote mode, but only for fields actually present in the loaded record.
4. **v3 → v4:** copies TYPE_CASE to CUSTOM_TYPE_CASE when present.
5. **v4 → v5:** resolves USE_GENERAL_STYLE from legacy USE_GENERIC_STYLE or whether the loaded option set is empty.
6. **v5 → v6:** migrates NEW_LINE_AROUND_SEMICOLON to script semicolon/blank-line settings when those newer fields are absent.
7. **v6 → v7:** no additional field rewrite in `afterLoaded`; the final version is set to 7. Manual edits also advance older records to 7.

A dialect settings object that was never loaded initializes `USE_GENERAL_STYLE = true`; a general settings object does not use that dialect default.

## Full settings inventory

The harness found 202 public instance fields (plus the dialect hidden-field report) per profile/dialect. The following inventory is exhaustive by name; deprecated fields are migration inputs rather than independent modern layout knobs.

| Group | Fields |
| --- | --- |
| Lifecycle/general | `myVersion`, `USE_GENERAL_STYLE`, `DISABLE_FORMATTING` |
| Case/quote | `KEYWORD_CASE`, `IDENTIFIER_CASE`, `TYPE_CASE`, `CUSTOM_TYPE_CASE`, `ALIAS_CASE`, `BUILT_IN_CASE`, `QUOTED_IDENTIFIER_CASE`, `ORIGINAL_CASE`, `QUOTE_IDENTIFIER`, `QUOTE_TYPE` |
| Query-wide | `QUERY_SECTION_1ST_WORD_ALIGN`, `QUERY_EL_LINE`, `QUERY_EL_COMMA`, `QUERY_IN_ONE_STRING`, `QUERY_TRUE_INDENT`, `QUERY_ALIGN_ELEMENTS`, `QUERY_ALIGN_LINE_COMMENTS` |
| Subquery | `SUBQUERY_OPENING`, `SUBQUERY_CONTENT`, `SUBQUERY_CLOSING`, `SUBQUERY_PAR_SPACE_BEFORE`, `SUBQUERY_PAR_SPACE_INSIDE`, `SUBQUERY_R_PAR_ALIGN` |
| INSERT | `INSERT_INTO_NL`, `INSERT_OPENING`, `INSERT_CONTENT`, `INSERT_CLOSING`, `INSERT_TABLE_EL_LINE`, `INSERT_VALUES_EL_LINE`, `INSERT_EL_WRAP`, `INSERT_EL_COMMA`, `INSERT_SPACE_WITHIN_PARENTHESES`, `INSERT_COLLAPSE_MULTI_ROW_VALUES`, `INSERT_MATRIX_ALIGN`, `INSERT_MATRIX_INCLUDING_HEADER`, `INSERT_MATRIX_MODE`, `INSERT_MATRIX_MIN_WIDENING_THRESHOLD`, `INSERT_MATRIX_BREAK_THRESHOLD` |
| SET / WITH | `SET_EL_LINE`, `SET_EL_WRAP`, `SET_EL_COMMA`, `SET_ALIGN_EQUAL_SIGN`, `WITH_EL_LINE`, `WITH_EL_WRAP`, `WITH_EL_COMMA`, `WITH_ALIGN_AS` |
| SELECT | `SELECT_EL_LINE`, `SELECT_EL_WRAP`, `SELECT_EL_COMMA`, `SELECT_NEW_LINE_AFTER_ALL_DISTINCT`, `SELECT_KEEP_N_ITEMS_IN_LINE`, `SELECT_USE_AS_WORD`, `SELECT_ALIGN_AS`, `SELECT_ASTERISK_REGULAR` |
| FROM / JOIN | `FROM_EL_LINE`, `FROM_EL_WRAP`, `FROM_EL_COMMA`, `FROM_WRAP_JOIN_1`, `FROM_WRAP_JOIN_2`, `FROM_WRAP_ON`, `FROM_ALIGN_JOIN_TABLES`, `FROM_ALIGN_ALIASES`, `FROM_INDENT_JOIN`, `FROM_ONLY_JOIN_INDENT`, `FROM_PLACE_ON` |
| WHERE / ORDER | `WHERE_EL_LINE`, `WHERE_EL_WRAP`, `WHERE_EL_BOUND`, `ORDER_EL_LINE`, `ORDER_EL_WRAP`, `ORDER_EL_COMMA`, `ORDER_ALIGN_ASC_DESC` |
| TABLE / ALTER | `TABLE_OPENING`, `TABLE_CONTENT`, `TABLE_CLOSING`, `TABLE_TYPES_ALIGN`, `TABLE_DEFAULTS_ALIGN`, `TABLE_NULLABILITIES_ALIGN`, `TABLE_COLLAPSE`, `TABLE_ALTER_INSTRUCTION_WRAP`, `TABLE_ALTER_INSTRUCTION_INDENT`, `TABLE_ALTER_INSTRUCTION_ALIGN`, `TABLE_ALTER_ITEM_WRAP`, `TABLE_ALTER_ITEM_INDENT`, `TABLE_ALTER_ITEM_ALIGN` |
| Constraints/postfix/schema/view | `CONSTRAINT_WRAP_1`, `CONSTRAINT_WRAP_2`, `CONSTRAINT_WRAP_3`, `CONSTRAINT_WRAP_4`, `POST_OPT_WRAP_1`, `POST_OPT_WRAP_2`, `POST_OPT_INDENT`, `POST_OPT_ALIGN`, `CREATE_SCHEMA_CONTENT_INDENT`, `CREATE_SCHEMA_BLANK_LINES_MIN`, `CREATE_SCHEMA_BLANK_LINES_MAX`, `VIEW_WRAP_AS`, `VIEW_WRAP_QUERY`, `VIEW_INDENT_QUERY` |
| Routine | `ROUTINE_ARG_OPENING`, `ROUTINE_ARG_CONTENT`, `ROUTINE_ARG_CLOSING`, `ROUTINE_ARG_WRAP`, `ROUTINE_ARG_COMMA`, `ROUTINE_ARG_SPACE_WITHIN_PARENTHESES`, `ROUTINE_ARG_ALIGN_TYPES`, `ROUTINE_AS_WRAP`, `ROUTINE_PG_L_QUOTE_WRAP_BEFORE`, `ROUTINE_PG_L_QUOTE_WRAP_AFTER`, `ROUTINE_PG_R_QUOTE_WRAP_BEFORE`, `ROUTINE_PG_R_QUOTE_WRAP_AFTER` |
| Script | `SCRIPT_STMT_SEMICOLON_WRAP`, `SCRIPT_STMT_FOLLOWS_BLANK_LINE` |
| Procedural/shared | `IMP_COMMON_WRAP_EVERY_STATEMENT`, `IMP_COMMON_KEEP_BLANK_LINES_IN_CODE`, `IMP_DECLARE_CONTENT_WRAP`, `IMP_DECLARE_EL_WRAP`, `IMP_DECLARE_ALIGN_TYPE`, `IMP_DECLARE_ALIGN_EQ`, `IMP_DECLARE_ALIGN_DEFAULT`, `IMP_DECLARE_ALIGN_LINE_COMMENTS`, `IMP_IF_THEN_WRAP_THEN`, `IMP_IF_THEN_WRAP_ELSE`, `IMP_IF_THEN_WRAP_INNER`, `IMP_IF_THEN_INDENT_THEN_ELSE`, `IMP_IF_THEN_INDENT_END`, `IMP_IF_THEN_COLLAPSE`, `IMP_LOOP_LOOP_WRAP`, `IMP_LOOP_LOOP_INDENT`, `IMP_LOOP_END_INDENT`, `IMP_LOOP_COLLAPSE` |
| Cortege/expression | `CORTEGE_SPACE_BEFORE_L_PAREN`, `CORTEGE_COMMA_1ST`, `CORTEGE_CLOSING`, `CORTEGE_SPACE_WITHIN_PARENTHESES`, `CORTEGE_SPACE_BEFORE_COMMA`, `CORTEGE_SPACE_AFTER_COMMA`, `EXPR_SPACE_AROUND_OPERATOR`, `EXPR_SPACE_WITHIN_PARENTHESES`, `EXPR_BINARY_OP_ALIGN`, `EXPR_CALL_SPACE_INSIDE_PARENTHESES`, `EXPR_CALL_SPACE_BEFORE_COMMA`, `EXPR_CALL_SPACE_AFTER_COMMA`, `EXPR_CASE_WHEN_WRAP`, `EXPR_CASE_WHEN_INDENT`, `EXPR_CASE_THEN_WRAP`, `EXPR_CASE_THEN_ALIGN`, `EXPR_CASE_ELSE_ALIGN_THEN`, `EXPR_CASE_END`, `EXPR_CASE_KEEP_NL_AFTER_THEN`, `EXPR_CASE_COLLAPSE` |
| Code-generation templates, not layout decisions | `INDEX_NAME_TEMPLATE`, `PRIMARY_KEY_NAME_TEMPLATE`, `FOREIGN_KEY_NAME_TEMPLATE` |
| Legacy settings used by migration | `USE_GENERIC_STYLE`, `SUBQUERY_L_PAR_NL_OUTSIDE`, `SUBQUERY_L_PAR_NL_INSIDE`, `SUBQUERY_R_PAR_NL_INSIDE`, `SUBQUERY_INDENT_INSIDE`, `SPACES_AROUND_OPERATORS`, `ALIGN_AS_IN_SELECT_STATEMENT`, `ALIGN_TYPE_IN_CREATE_STATEMENT`, `ALIGN_TYPE_IN_BLOCK_STATEMENT`, `ALIGN_TYPE_IN_ARGUMENT_DEFINITION`, `ALIGN_INSIDE_BINARY_EXPRESSION`, `ALIGN_INSIDE_QUERY_EXPRESSION`, `ALIGN_EQ_INSIDE_SET_CLAUSE`, `NEW_LINE_BEFORE_FROM`, `NEW_LINE_BEFORE_JOIN`, `NEW_LINE_BEFORE_JOIN_CONDITION`, `NEW_LINE_BEFORE_WHERE`, `NEW_LINE_BEFORE_GROUP_BY`, `NEW_LINE_BEFORE_ORDER_BY`, `NEW_LINE_BEFORE_HAVING`, `NEW_LINE_BEFORE_THEN`, `NEW_LINE_BEFORE_ELSE`, `NEW_LINE_BEFORE_OTHER_CLAUSES`, `NEW_LINE_BEFORE_COMMA`, `NEW_LINE_BEFORE_QUERY_INSIDE_PARENTHESIS`, `NEW_LINE_BEFORE_QUERY_INSIDE_DML`, `NEW_LINE_AROUND_SEMICOLON`, `INDENT_JOIN`, `INDENT_JOIN_CONDITION`, `INDENT_SELECT_INTO_CLAUSE`, `WRAP_INSIDE_CREATE_TABLE`, `WRAP_INSIDE_SELECT`, `WRAP_INSIDE_JOIN_EXPRESSION`, `WRAP_INSIDE_GROUP_BY`, `WRAP_INSIDE_WHERE`, `WRAP_INSIDE_ORDER_BY`, `WRAP_INSIDE_SET`, `WRAP_INSIDE_ARGUMENT_DEFINITION`, `WRAP_INSIDE_CALL_EXPRESSION`, `WRAP_INSIDE_VALUES_EXPRESSION`, `WRAP_VALUES_EXPRESSION`, `WRAP_PARENTHESIZED_EXPRESSION_INSIDE_VALUES`, `NEW_LINE_AFTER_SELECT`, `NEW_LINE_AFTER_SELECT_ITEM`, `NEW_LINE_AFTER_SELECT_2` |

## Differential observations

The default DataGrip output keeps input keyword case, starts major query sections at the left margin, indents a JOIN beneath the FROM table's alignment position, wraps additional AND conditions, and expands CREATE TABLE definitions into aligned columns. For example:

```sql
select u.id, u.name, o.total
from users u
         left join orders o on o.user_id = u.id
where u.active = true
  and o.total > 10
order by o.total desc;
```

The corpus also captures non-obvious dialect behavior. For example, SQLite's `ON CONFLICT ... DO UPDATE SET` currently formats the assignment without a space before the expression (`name =excluded.name`). Compatibility tests must preserve observed behavior where it is in scope rather than silently replacing it with a generic prettier style.

## Implementation status matrix

Implementation work is tracked in issue #14961. The final PR must update this section with per-feature results and explicit differences. No unsupported field may be silently accepted as if it had taken effect.

| Area | Analysis | DBX implementation |
| --- | --- | --- |
| Two-tree construction and block precedence | Complete for the core and three target dialect extension points | Implemented in the DBX AST adapter and FormatBlock tree |
| Grow/analyze/refine and shape thresholds | Complete | Implemented with cached flat text and per-block shape/wrap state |
| Query sections, lists, JOIN, WHERE, CTE, DML | Core rules and differential corpus complete | Implemented; 38/43 corpus cases are exact DataGrip matches |
| CREATE TABLE and alignment | Core rules and differential corpus complete | Implemented; five error-node/upsert differences are pinned explicitly |
| Case/AS/comma pre-format edits | Call chain and rule ownership complete | DBX case/comma settings are implemented; DataGrip-only AS/quote controls are not exposed |
| Modern/Legacy and general/dialect settings | Full public-field inventory and migration chain complete | Current DBX settings are mapped; DataGrip-only settings and external scheme migration are not accepted as active options |
| PostgreSQL routines/injected bodies | Entry points identified; not a first-phase behavior guarantee | Explicitly deferred |
| Procedural MySQL/SQLite extensions | Entry points identified; parser support matrix required before claiming support | Explicitly deferred |
| Arbitrary invalid SQL fragments | Error/safe-spacing blocks identified; exact DataGrip recovery must be checked case-by-case | Structured Worker parse error; existing editing/display original-text fallback |
| UI performance | Worker required because the existing formatter parses/prints synchronously on the caller thread | Dedicated persistent Worker for AST/blocks/printing and selection mapping; cancellation, timeout, stale-result and no-main-thread-retry tests |

The current differential suite has 44 passing assertions: 43 corpus cases plus the exact/documented count check. All 43 implementation results are idempotent. The five documented differences are PostgreSQL `pg_create_table` and `pg_returning`, MySQL `mysql_create_table`, and SQLite `sqlite_create_table` / `sqlite_upsert`; their reasons are stored beside the golden corpus and asserted independently from DataGrip's expected text.

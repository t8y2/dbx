# ClickHouse Function Completion Design

Date: 2026-07-30

## Summary

DBX currently provides database-specific static function completion for MySQL, PostgreSQL, SQLite, SQL Server, and Manticore Search. It also loads stored routines dynamically for selected databases. ClickHouse receives only the small common SQL function set, so native functions such as `toStartOfDay`, `uniqExact`, and `JSONExtractString` are absent.

This change adds a static, ClickHouse-specific function registry with broad official-function coverage, overload-aware signature help, ClickHouse parametric aggregate support, table-function completion, and aggregate combinator generation. It does not query the connected ClickHouse server.

## Goals

- Provide broad completion coverage for documented ClickHouse regular, aggregate, window, and table functions.
- Preserve canonical ClickHouse casing when inserting camelCase function names.
- Support multiple signatures per function and highlight the active parameter.
- Support ClickHouse functions with multiple parameter groups, such as `quantilesTDigest(levels...)(expression)`.
- Generate valid aggregate-combinator completions without storing an unbounded Cartesian product.
- Keep existing MySQL, PostgreSQL, SQLite, SQL Server, and Manticore Search completion behavior unchanged.
- Keep the ClickHouse inventory maintainable and isolated from the already large generic SQL completion module.

## Non-goals

- Query `system.functions`, `system.user_defined_functions`, or any other server metadata table.
- Complete server-defined UDFs in the first version.
- Treat operators, keywords, or data types as functions.
- Include undocumented internal functions without a stable user-facing interface.
- Migrate every existing database function inventory to the new representation in the same change.

## Existing Design to Reuse

`sqlCompletion.ts` already provides:

- database-specific function filtering;
- prefix matching and ranking;
- function snippets with CodeMirror placeholders;
- function-versus-keyword de-duplication;
- a signature tooltip driven by the cursor's active argument;
- regression coverage proving that database-specific functions do not leak across dialects.

The existing `DATABASE_FUNCTION_SIGNATURES` maps demonstrate the desired database isolation, but their `Map<string, string[]>` value type represents only one flat signature. ClickHouse requires a richer model because overloads and two-stage parameter lists are common.

The dynamic stored-routine path used by MySQL, PostgreSQL, SQL Server, and Oracle is not reused for built-in ClickHouse functions. Static built-in completion and dynamic stored-routine completion solve different problems.

## Architecture

Add a ClickHouse-specific directory:

```text
apps/desktop/src/lib/sql/clickhouse/
  functionTypes.ts
  regularFunctions.ts
  aggregateFunctions.ts
  tableFunctions.ts
  aggregateCombinators.ts
  functionRegistry.ts
```

Responsibilities:

- `functionTypes.ts` defines function, overload, parameter-group, category, and lifecycle-status types.
- `regularFunctions.ts` contains documented scalar functions, organized into readable category sections.
- `aggregateFunctions.ts` contains ordinary and parametric aggregate functions.
- `tableFunctions.ts` contains functions valid in table-target contexts such as `FROM` and `JOIN`.
- `aggregateCombinators.ts` defines suffix compatibility, ordering, signature transformations, and lazy generation.
- `functionRegistry.ts` merges definitions, validates lookup keys, performs case-insensitive lookup, preserves canonical names, and exposes prefix queries.
- `sqlCompletion.ts` adapts registry results into the existing generic completion item type and uses the richer signatures for tooltip rendering.

The ClickHouse module contains data and deterministic transformation logic only. It does not depend on Vue, CodeMirror, a connection, or backend APIs.

## Function Model

The shared model is:

```ts
interface SqlFunctionDefinition {
  name: string;
  category: SqlFunctionCategory;
  signatures: SqlFunctionSignature[];
  description?: string;
  preferredSignature?: number;
  aggregate?: boolean;
  status?: "stable" | "experimental" | "deprecated";
  aliases?: string[];
}

interface SqlFunctionSignature {
  parameterGroups: string[][];
  returnType?: string;
}
```

One parameter group represents an ordinary function:

```ts
{
  name: "toStartOfInterval",
  category: "date-time",
  signatures: [
    {
      parameterGroups: [["value", "INTERVAL x unit"]],
      returnType: "DateTime"
    },
    {
      parameterGroups: [["value", "INTERVAL x unit", "time_zone"]],
      returnType: "DateTime"
    }
  ]
}
```

Multiple groups represent a parametric aggregate:

```ts
{
  name: "quantilesTDigest",
  category: "aggregate",
  aggregate: true,
  signatures: [
    {
      parameterGroups: [
        ["level", "...levels"],
        ["expression"]
      ]
    }
  ]
}
```

`preferredSignature` selects the inserted snippet. When it is omitted, the first signature is preferred. Optional arguments remain visible in alternate signatures but are excluded from the default insertion when a shorter common form exists.

## Inventory Scope

The static inventory follows the public ClickHouse function reference and records the documentation snapshot date in source comments. It covers:

- regular scalar functions, including array, string, date/time, JSON, Map, Tuple, URL, IP, mathematical, hashing, encoding, conversion, Nullable, dictionary, geography, and related documented categories;
- regular and parametric aggregate functions;
- window functions;
- table functions;
- documented aliases with canonical insertion names;
- experimental and deprecated functions, marked with status and ranked below stable functions.

The official ClickHouse documentation separates regular, aggregate, table, window, and user-defined functions. The first version covers the first four static categories and excludes user-defined functions:

- <https://clickhouse.com/docs/reference/functions>
- <https://clickhouse.com/docs/reference/functions/aggregate-functions/combinators>

Every function must have an official name and an accurate parameter-group shape. A concise description is optional. When absent, the completion detail falls back to `ClickHouse · <category>` so full internationalization coverage is not required to ship the inventory.

The checked-in inventory also contains a category manifest that records the documentation pages used for the 2026-07-30 snapshot and the number of definitions in each category. Integrity tests use those checked-in category counts as minimum floors, so removing a documented batch requires an intentional manifest update rather than silently reducing coverage.

## Completion Behavior

Matching is case-insensitive, while labels and inserted text retain canonical ClickHouse casing. For example, `tostart` can match and insert `toStartOfDay(${value})`.

Each completion item displays:

- canonical function name;
- `ClickHouse` and the function category;
- the preferred signature;
- overload count when greater than one;
- experimental or deprecated status;
- a concise description when available.

Accepting a completion:

- inserts the preferred signature with CodeMirror placeholders;
- avoids adding a second opening parenthesis when the user already typed one;
- inserts `function()` for zero-argument functions;
- preserves multiple parameter groups for parametric functions;
- continues to use existing ranking history and prefix scoring.

ClickHouse-specific signatures override common SQL signatures for names shared with the common registry.

## Table Functions

Table functions are a distinct function kind. In ClickHouse table-target contexts, including `FROM` and `JOIN`, the provider includes matching table functions alongside tables and views. It does not include ordinary scalar or aggregate functions in those exclusive contexts.

Table-function completions use the same overload and placeholder model as regular functions. This requires a narrow exception to the existing `exclusiveTableSuggestions` path rather than globally enabling all functions after `FROM`.

## Signature Help

The generic signature-help result is extended from one flat signature to multiple overloads containing one or more parameter groups.

The resolver:

1. finds the function call that owns the cursor;
2. determines the active parameter group;
3. counts top-level commas only within that group;
4. ranks signatures that can accept the observed argument count first;
5. returns every matching overload for display;
6. highlights the active parameter in each displayed overload.

For `quantilesTDigest(0.5, 0.9)(value)`, the resolver recognizes both pairs of parentheses as one function call. It can distinguish the level list from the expression list.

Ordinary existing database functions are adapted as one overload with one parameter group, preserving their current behavior.

## Aggregate Combinators

Aggregate combinators are generated lazily from aggregate definitions. The rules describe:

- which base aggregates accept a combinator;
- valid suffix order;
- how parameter groups change;
- how return metadata changes;
- whether a combinator can be followed by another combinator.

The initial rule set covers the documented combinators, including `If`, `Array`, `Map`, `SimpleState`, `State`, `Merge`, `MergeState`, `ForEach`, `Distinct`, `OrDefault`, `OrNull`, and `Resample`.

Generation follows official ordering constraints. For example, `Array` precedes `If`, producing `uniqArrayIf`, while `uniqIfArray` is not generated. `If` appends a condition argument to the data-argument group. State and merge combinators transform the expected input or output shape rather than merely renaming the function.

The registry generates candidates only for the active prefix and enforces a deterministic maximum candidate count. It does not materialize every possible suffix permutation at module initialization.

## Ranking and Lifecycle Status

Stable direct functions rank above generated combinator variants when match quality is equal. Exact prefix and exact label matches continue to receive the existing strong boosts.

Generated variants remain competitive once the typed prefix includes their suffix. Experimental and deprecated entries receive a modest negative boost and a visible status label, but remain discoverable.

Aliases de-duplicate against canonical functions case-insensitively. An alias can match the typed prefix, but accepting it inserts the canonical ClickHouse function name and casing.

## Validation and Failure Handling

The static path has no network failures. Registry validation catches authoring problems:

- duplicate case-insensitive names;
- aliases colliding with canonical names;
- empty signature lists;
- empty parameter groups where they are not meaningful;
- out-of-range preferred signature indexes;
- invalid lifecycle status;
- illegal combinator ordering;
- combinator cycles;
- aliases that do not belong to a canonical definition.

Tests fail on invalid inventory data. At runtime, an isolated malformed entry is skipped rather than breaking the entire completion popup, while development builds may log a diagnostic.

## Testing Strategy

Implementation follows test-driven development: add one failing behavioral test, confirm the expected failure, add the minimum implementation, and keep the focused suite green before proceeding.

### Registry integrity

- canonical names and case-insensitive lookup keys are unique;
- every definition has at least one valid signature;
- preferred signature indexes are valid;
- every declared category has representative coverage;
- an expected inventory-size floor guards against accidental bulk deletion.

### Completion behavior

- `toStart` returns canonical camelCase ClickHouse functions;
- completion inserts the preferred placeholder template;
- an already typed `(` is not duplicated;
- common functions use ClickHouse-specific signatures;
- ClickHouse-only names do not appear for MySQL or PostgreSQL.

### Multiple signatures

- all overloads are available to signature help;
- overload ranking reacts to top-level comma count;
- active parameters are highlighted correctly;
- parametric aggregate calls distinguish the first and second parameter groups.

### Combinators

- valid examples such as `sumIf`, `uniqArrayIf`, and `quantilesState` are generated;
- invalid suffix orders such as `uniqIfArray` are not generated;
- `If` adds the condition parameter;
- generation respects its deterministic result bound.

### Table functions

- ClickHouse table functions appear in `FROM` and `JOIN`;
- scalar and aggregate functions remain excluded from exclusive table contexts;
- ordinary table and view completion continues to work.

### Regression coverage

- current MySQL function suggestions and special insertion templates remain unchanged;
- PostgreSQL, SQLite, SQL Server, and Manticore Search functions remain isolated;
- existing snippet, keyword, column, table, and routine completion tests remain green.

Final verification includes the focused SQL completion tests, frontend type checking, and the repository's relevant frontend test suite.

## Success Criteria

- A ClickHouse query can autocomplete representative functions from every supported category using canonical casing.
- Multiple overloads and current-parameter highlighting work for ordinary and parametric functions.
- Valid aggregate combinator variants are discoverable without invalid-order noise or eager combinatorial expansion.
- Table functions are suggested only where a table source is valid.
- No server query is required for built-in completion.
- Existing database-specific completion behavior remains covered by passing regression tests.

## Future Work

Possible follow-up work, intentionally excluded from this implementation:

- optional discovery of SQL or executable UDFs from ClickHouse system tables;
- a generated inventory pipeline sourced from an official machine-readable index;
- migration of other database function maps to the overload-aware registry;
- localized descriptions for the complete ClickHouse inventory.

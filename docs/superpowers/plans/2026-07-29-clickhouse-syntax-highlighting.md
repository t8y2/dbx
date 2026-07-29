# ClickHouse SQL Syntax Highlighting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated ClickHouse CodeMirror dialect so ClickHouse keywords, types, built-ins, comments, and table names receive correct editor highlighting.

**Architecture:** Keep DBX's existing CodeMirror/Lezer pipeline and define a ClickHouse dialect by extending `StandardSQL` with a curated ClickHouse vocabulary and lexical options. Route ClickHouse connections to that syntax dialect without widening the existing completion/formatting dialect, and add a ClickHouse semantic adapter selected before the legacy MySQL behavior dialect.

**Tech Stack:** TypeScript, Vue 3, CodeMirror 6 `@codemirror/lang-sql@6.10.0`, Lezer SQL parser, Vitest.

## Global Constraints

- Cover the main CodeMirror query editor and CodeMirror-based DDL/SQL viewers.
- Do not change Shiki-rendered static SQL blocks in AI messages.
- Do not change SQL formatting, execution, completion, snippets, or editor theme colors.
- Use `StandardSQL`, not `MySQL`, as the ClickHouse parser base.
- Preserve ClickHouse's compact `--SELECT 1` line-comment behavior.
- Add no runtime dependency and no persisted-setting migration.

---

## File Map

- Modify `apps/desktop/src/lib/editor/codemirrorSqlDialect.ts`: own the ClickHouse CodeMirror dialect name, vocabulary, lexical configuration, and parser factory selection.
- Modify `apps/desktop/src/lib/database/jdbcDialect.ts`: return the dedicated syntax dialect for native and inferred JDBC ClickHouse connections while retaining the existing three-value behavior dialect.
- Modify `apps/desktop/src/components/editor/QueryEditor.vue`: allow `clickhouse` only for the syntax-dialect prop.
- Modify `apps/desktop/src/components/layout/ContentArea.vue`: type the syntax dialect with the shared CodeMirror dialect type.
- Modify `packages/app-tests/codemirrorSqlDialect.test.ts`: verify vocabulary parser nodes, comments, and database-to-syntax propagation.
- Modify `packages/app-tests/jdbcDialect.test.ts`: verify inferred JDBC ClickHouse syntax selection.
- Modify `apps/desktop/src/lib/sql/semantic/dialect.ts`: own the ClickHouse semantic adapter and prioritize it for ClickHouse database types.
- Create `apps/desktop/src/lib/__tests__/sql/semantic/dialect.spec.ts`: verify adapter selection, quoting, and normalization.

### Task 1: Dedicated ClickHouse CodeMirror dialect

**Files:**

- Modify: `packages/app-tests/codemirrorSqlDialect.test.ts`
- Modify: `packages/app-tests/jdbcDialect.test.ts`
- Modify: `apps/desktop/src/lib/editor/codemirrorSqlDialect.ts`
- Modify: `apps/desktop/src/lib/database/jdbcDialect.ts`
- Modify: `apps/desktop/src/components/editor/QueryEditor.vue`
- Modify: `apps/desktop/src/components/layout/ContentArea.vue`

**Interfaces:**

- Produces: `CodeMirrorSqlDialectName = "mysql" | "postgres" | "sqlserver" | "clickhouse"`.
- Produces: `codeMirrorSqlDialectForConnection(connection): CodeMirrorSqlDialectName`.
- Preserves: `codeMirrorSqlDialect(dbType): "mysql" | "postgres" | "sqlserver"` for completion and formatting behavior.
- Consumes: `createDbxCodeMirrorSqlDialect(langSql, dialectName, databaseType)`.

- [ ] **Step 1: Write failing parser and mapping tests**

Extend `packages/app-tests/codemirrorSqlDialect.test.ts` with:

```ts
import { codeMirrorSqlDialect, codeMirrorSqlDialectForConnection } from "../../apps/desktop/src/lib/database/jdbcDialect.ts";

test("maps ClickHouse connections to the dedicated editor syntax dialect", () => {
  assert.equal(codeMirrorSqlDialectForConnection({ db_type: "clickhouse" }), "clickhouse");
  assert.equal(
    codeMirrorSqlDialectForConnection({
      db_type: "jdbc",
      connection_string: "jdbc:clickhouse://127.0.0.1:8123/default",
    }),
    "clickhouse",
  );
});

test("classifies ClickHouse-specific syntax", () => {
  const dialect = createDbxCodeMirrorSqlDialect(langSql, "clickhouse", "clickhouse");
  const sql = `
    CREATE TABLE events
    (
      id UInt64,
      created_at DateTime64(3),
      category LowCardinality(String),
      attributes Map(String, String)
    )
    ENGINE = MergeTree
    PARTITION BY toYYYYMM(created_at)
    ORDER BY id
    TTL created_at + INTERVAL 30 DAY
    SETTINGS index_granularity = 8192;

    SELECT uniqExact(id), argMax(category, created_at)
    FROM events
    PREWHERE created_at >= now() - INTERVAL 1 DAY
    ARRAY JOIN mapKeys(attributes) AS attribute_key
    LIMIT 10 BY category
    FORMAT JSONEachRow;
  `;

  for (const keyword of ["ENGINE", "PARTITION", "TTL", "SETTINGS", "PREWHERE", "ARRAY", "FORMAT"]) {
    assert.ok(countParsedNodes(dialect, sql, "Keyword", keyword) >= 1, keyword);
  }
  for (const type of ["UInt64", "DateTime64", "LowCardinality", "Map"]) {
    assert.equal(countParsedNodes(dialect, sql, "Type", type), 1, type);
  }
  for (const builtin of ["toYYYYMM", "uniqExact", "argMax", "mapKeys"]) {
    assert.equal(countParsedNodes(dialect, sql, "Builtin", builtin), 1, builtin);
  }
  assert.equal(countParsedNodes(dialect, "--SELECT 1", "LineComment", "--SELECT 1"), 1);
});
```

Extend `packages/app-tests/jdbcDialect.test.ts` with:

```ts
test("uses dedicated ClickHouse editor syntax for inferred JDBC connections", () => {
  const connection = {
    db_type: "jdbc" as const,
    connection_string: "jdbc:clickhouse://127.0.0.1:8123/default",
  };

  assert.equal(inferJdbcDialect(connection), "clickhouse");
  assert.equal(codeMirrorSqlDialectForConnection(connection), "clickhouse");
});
```

- [ ] **Step 2: Run the tests and verify the red state**

Run:

```bash
pnpm vitest run packages/app-tests/codemirrorSqlDialect.test.ts packages/app-tests/jdbcDialect.test.ts
```

Expected: FAIL because `"clickhouse"` is not accepted as a CodeMirror dialect name and ClickHouse connections currently return `"mysql"`.

- [ ] **Step 3: Add the ClickHouse dialect definition**

In `apps/desktop/src/lib/editor/codemirrorSqlDialect.ts`, extend the shared name and add focused vocabulary constants:

```ts
export type CodeMirrorSqlDialectName = "mysql" | "postgres" | "sqlserver" | "clickhouse";

const CLICKHOUSE_KEYWORDS = [
  "ATTACH",
  "DETACH",
  "OPTIMIZE",
  "SYSTEM",
  "KILL",
  "ENGINE",
  "PARTITION",
  "PRIMARY",
  "SAMPLE",
  "PREWHERE",
  "ARRAY",
  "GLOBAL",
  "FINAL",
  "WITH",
  "TOTALS",
  "ROLLUP",
  "CUBE",
  "LIMIT",
  "BY",
  "INTO",
  "OUTFILE",
  "COMPRESSION",
  "FORMAT",
  "SETTINGS",
  "TTL",
  "CODEC",
  "MATERIALIZED",
  "ALIAS",
  "PROJECTION",
  "INDEX",
  "GRANULARITY",
].join(" ");

const CLICKHOUSE_TYPES = [
  "Bool",
  "Int8",
  "Int16",
  "Int32",
  "Int64",
  "Int128",
  "Int256",
  "UInt8",
  "UInt16",
  "UInt32",
  "UInt64",
  "UInt128",
  "UInt256",
  "Float32",
  "Float64",
  "Decimal",
  "Decimal32",
  "Decimal64",
  "Decimal128",
  "Decimal256",
  "String",
  "FixedString",
  "Date",
  "Date32",
  "DateTime",
  "DateTime64",
  "Time",
  "Time64",
  "Enum8",
  "Enum16",
  "UUID",
  "IPv4",
  "IPv6",
  "Array",
  "Tuple",
  "Map",
  "Nested",
  "Nullable",
  "LowCardinality",
  "AggregateFunction",
  "SimpleAggregateFunction",
  "JSON",
  "Object",
  "Variant",
  "Dynamic",
  "Nothing",
].join(" ");

const CLICKHOUSE_BUILTINS = [
  "now",
  "today",
  "toDate",
  "toDateTime",
  "toDateTime64",
  "toYYYYMM",
  "count",
  "sum",
  "avg",
  "min",
  "max",
  "uniq",
  "uniqExact",
  "argMin",
  "argMax",
  "groupArray",
  "arrayJoin",
  "mapKeys",
  "mapValues",
  "JSONExtract",
  "JSONExtractString",
].join(" ");
```

Make `codeMirrorBaseDialect()` select `StandardSQL` for either an explicit
ClickHouse syntax name or `databaseType === "clickhouse"`:

```ts
if (databaseType) {
  if (databaseType === "clickhouse") return langSql.StandardSQL;
  // Existing database family checks remain in their current order.
}
if (dialectName === "clickhouse") return langSql.StandardSQL;
```

In `createDbxCodeMirrorSqlDialect()`, build ClickHouse-specific spec fields
without changing other dialects:

```ts
const isClickHouse = databaseType === "clickhouse" || dialectName === "clickhouse";

return langSql.SQLDialect.define({
  ...baseDialect.spec,
  keywords: [
    baseKeywords,
    DBX_COMMON_SQL_KEYWORDS,
    isClickHouse ? CLICKHOUSE_KEYWORDS : "",
    isPostgres ? POSTGRES_PLPGSQL_KEYWORDS : "",
    isSqlServer ? SQLSERVER_KEYWORDS : "",
  ]
    .filter(Boolean)
    .join(" "),
  types: [baseDialect.spec.types || "", isClickHouse ? CLICKHOUSE_TYPES : "", isPostgres ? POSTGRES_PLPGSQL_TYPES : ""]
    .filter(Boolean)
    .join(" ") || undefined,
  builtin: [baseDialect.spec.builtin || "", isClickHouse ? CLICKHOUSE_BUILTINS : "", isPostgres ? POSTGRES_PLPGSQL_BUILTIN : ""]
    .filter(Boolean)
    .join(" ") || undefined,
  identifierQuotes: isClickHouse ? '"`' : baseDialect.spec.identifierQuotes,
  backslashEscapes: isClickHouse ? true : baseDialect.spec.backslashEscapes,
  spaceAfterDashes: isClickHouse ? false : baseDialect.spec.spaceAfterDashes,
  doubleDollarQuotedStrings: false,
});
```

- [ ] **Step 4: Route ClickHouse only through the syntax-dialect channel**

In `apps/desktop/src/lib/database/jdbcDialect.ts`, import the type and keep the
existing behavior-dialect function narrow:

```ts
import type { CodeMirrorSqlDialectName } from "@/lib/editor/codemirrorSqlDialect";

export function codeMirrorSqlDialectForConnection(connection?: JdbcDialectConnection): CodeMirrorSqlDialectName {
  if (isJdbcAseProfile(connection)) return "sqlserver";
  const databaseType = effectiveDatabaseTypeForConnection(connection);
  if (databaseType === "clickhouse") return "clickhouse";
  return codeMirrorSqlDialect(databaseType);
}
```

In `apps/desktop/src/components/editor/QueryEditor.vue`, import the type and
change only the syntax prop:

```ts
import { createDbxCodeMirrorSqlDialect, type CodeMirrorSqlDialectName } from "@/lib/editor/codemirrorSqlDialect";

syntaxDialect?: CodeMirrorSqlDialectName;
```

In `apps/desktop/src/components/layout/ContentArea.vue`, import the same type and
change only the syntax computed value:

```ts
import type { CodeMirrorSqlDialectName } from "@/lib/editor/codemirrorSqlDialect";

const editorSyntaxDialect = computed<CodeMirrorSqlDialectName>(() => codeMirrorSqlDialectForConnection(props.activeConnection));
```

The existing `editorDialect` remains `"mysql" | "postgres" | "sqlserver"` so
completion, identifier quoting, and formatting behavior stay out of scope.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
pnpm vitest run packages/app-tests/codemirrorSqlDialect.test.ts packages/app-tests/jdbcDialect.test.ts
pnpm typecheck
```

Expected: both test files PASS and `vue-tsc` exits with code 0.

- [ ] **Step 6: Commit the dedicated parser**

```bash
git add apps/desktop/src/lib/editor/codemirrorSqlDialect.ts \
  apps/desktop/src/lib/database/jdbcDialect.ts \
  apps/desktop/src/components/editor/QueryEditor.vue \
  apps/desktop/src/components/layout/ContentArea.vue \
  packages/app-tests/codemirrorSqlDialect.test.ts \
  packages/app-tests/jdbcDialect.test.ts
git commit -m "feat(editor): add ClickHouse SQL highlighting"
```

### Task 2: ClickHouse semantic table-name adapter

**Files:**

- Create: `apps/desktop/src/lib/__tests__/sql/semantic/dialect.spec.ts`
- Modify: `apps/desktop/src/lib/sql/semantic/dialect.ts`

**Interfaces:**

- Produces: `SQL_SEMANTIC_DIALECTS.clickhouse: SqlSemanticDialectAdapter`.
- Preserves: `sqlSemanticDialectFor(options)` input type; ClickHouse is selected by `databaseType`, not by widening completion's three-value dialect.
- Consumes: `SqlSemanticDialectAdapter` and `defaultNormalize`.

- [ ] **Step 1: Write the failing semantic adapter test**

Create `apps/desktop/src/lib/__tests__/sql/semantic/dialect.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sqlSemanticDialectFor } from "@/lib/sql/semantic/dialect";

describe("ClickHouse semantic dialect", () => {
  it("takes precedence over the legacy MySQL behavior dialect", () => {
    const dialect = sqlSemanticDialectFor({
      databaseType: "clickhouse",
      dialect: "mysql",
    });

    expect(dialect.id).toBe("clickhouse");
    expect(dialect.identifierQuotes).toEqual([
      { open: "`", close: "`" },
      { open: '"', close: '"' },
    ]);
    expect(dialect.normalizeIdentifier("EventName")).toBe("EventName");
    expect(dialect.quoteIdentifier("event`name")).toBe("`event``name`");
  });
});
```

- [ ] **Step 2: Run the test and verify the red state**

Run:

```bash
pnpm vitest run apps/desktop/src/lib/__tests__/sql/semantic/dialect.spec.ts
```

Expected: FAIL because the returned adapter id is currently `"mysql"`.

- [ ] **Step 3: Implement the minimal ClickHouse semantic adapter**

Add this entry to `SQL_SEMANTIC_DIALECTS` in
`apps/desktop/src/lib/sql/semantic/dialect.ts`:

```ts
clickhouse: {
  id: "clickhouse",
  identifierQuotes: [
    { open: "`", close: "`" },
    { open: '"', close: '"' },
  ],
  supportsAsForTableAlias: true,
  projectionAliasVisibility: { where: false, groupBy: true, having: true, orderBy: true },
  normalizeIdentifier: defaultNormalize,
  quoteIdentifier: (identifier) => quoteWith(identifier, "`"),
  qualifierRole(parts, context) {
    if (context === "column") return parts.length >= 2 ? "table" : "table";
    if (context === "routine") return parts.length >= 2 ? "package" : "schema";
    return parts.length >= 1 ? "schema" : "unknown";
  },
},
```

Select it before the explicit three-value behavior dialect:

```ts
export function sqlSemanticDialectFor(options: { databaseType?: DatabaseType; dialect?: "mysql" | "postgres" | "sqlserver" }): SqlSemanticDialectAdapter {
  if (options.databaseType === "clickhouse") return SQL_SEMANTIC_DIALECTS.clickhouse;
  if (options.dialect && SQL_SEMANTIC_DIALECTS[options.dialect]) return SQL_SEMANTIC_DIALECTS[options.dialect];
  // Existing switch remains unchanged.
}
```

- [ ] **Step 4: Run semantic and parser regression tests**

Run:

```bash
pnpm vitest run \
  apps/desktop/src/lib/__tests__/sql/semantic/dialect.spec.ts \
  apps/desktop/src/lib/__tests__/sql/semantic/model.spec.ts \
  packages/app-tests/codemirrorSqlDialect.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit the semantic adapter**

```bash
git add apps/desktop/src/lib/sql/semantic/dialect.ts \
  apps/desktop/src/lib/__tests__/sql/semantic/dialect.spec.ts
git commit -m "feat(editor): add ClickHouse semantic SQL dialect"
```

### Task 3: Final verification and PR preparation

**Files:**

- Verify: all files changed by Tasks 1 and 2
- Verify: `docs/superpowers/specs/2026-07-29-clickhouse-syntax-highlighting-design.md`
- Verify: `docs/superpowers/plans/2026-07-29-clickhouse-syntax-highlighting.md`

**Interfaces:**

- Consumes: the dedicated ClickHouse parser and semantic adapter.
- Produces: a reviewed, tested branch ready for a GitHub pull request.

- [ ] **Step 1: Run the full relevant automated checks**

Run:

```bash
pnpm vitest run \
  packages/app-tests/codemirrorSqlDialect.test.ts \
  packages/app-tests/jdbcDialect.test.ts \
  apps/desktop/src/lib/__tests__/editor/codemirrorSqlDialect.spec.ts \
  apps/desktop/src/lib/__tests__/sql/semantic/dialect.spec.ts \
  apps/desktop/src/lib/__tests__/sql/semantic/model.spec.ts
pnpm typecheck
```

Expected: every Vitest file passes and typecheck exits with code 0.

- [ ] **Step 2: Review parser output and scope boundaries**

Run:

```bash
git diff main...HEAD --check
git diff main...HEAD --stat
git diff main...HEAD -- \
  apps/desktop/src/lib/editor/codemirrorSqlDialect.ts \
  apps/desktop/src/lib/database/jdbcDialect.ts \
  apps/desktop/src/lib/sql/semantic/dialect.ts
rg -n "clickhouse" apps/desktop/src/lib/sql/sqlHighlighter.ts
```

Expected: no whitespace errors; changes stay in the planned CodeMirror and
semantic paths; `sqlHighlighter.ts` has no new ClickHouse/Shiki modification.

- [ ] **Step 3: Perform a local correctness review**

Check each diff hunk against this exact checklist:

```text
[ ] ClickHouse uses StandardSQL, never MySQL, as its parser base.
[ ] Compact -- comments remain LineComment nodes.
[ ] Keywords, types, and built-ins are stored in separate spec fields.
[ ] Only syntaxDialect accepts the new clickhouse value.
[ ] Existing completion/formatting dialect types remain unchanged.
[ ] databaseType=clickhouse wins over dialect=mysql in semantic selection.
[ ] No dependency, persistence, theme, Shiki, execution, or formatter changes.
```

Expected: every item is satisfied; correct any violation and rerun Step 1.

- [ ] **Step 4: Push and create the pull request**

Run:

```bash
git status --short
git push -u origin codex/clickhouse-syntax-highlighting
gh pr create \
  --base main \
  --head codex/clickhouse-syntax-highlighting \
  --title "feat(editor): add dedicated ClickHouse SQL highlighting" \
  --body-file /tmp/dbx-clickhouse-highlighting-pr.md
```

Before the last command, create `/tmp/dbx-clickhouse-highlighting-pr.md` with:

```markdown
## Summary

- add a dedicated ClickHouse CodeMirror SQL dialect
- classify ClickHouse keywords, data types, and common built-in functions
- select a ClickHouse semantic adapter for table-name highlighting
- preserve existing completion, formatting, Shiki, and theme behavior

## Test plan

- `pnpm vitest run packages/app-tests/codemirrorSqlDialect.test.ts packages/app-tests/jdbcDialect.test.ts apps/desktop/src/lib/__tests__/editor/codemirrorSqlDialect.spec.ts apps/desktop/src/lib/__tests__/sql/semantic/dialect.spec.ts apps/desktop/src/lib/__tests__/sql/semantic/model.spec.ts`
- `pnpm typecheck`
```

Expected: the branch is pushed and GitHub returns a new PR URL.

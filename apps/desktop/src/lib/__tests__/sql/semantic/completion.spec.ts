import { describe, expect, it } from "vitest";
import { buildSqlCompletionItemsFromContext, getSqlCompletionContext, type SqlCompletionColumn, type SqlCompletionProviderInput } from "@/lib/sql/sqlCompletion";
import { sqlCompletionContextFromSemantic, sqlSemanticLocalColumnsByTable } from "@/lib/sql/semantic/completion";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import { sqlFixtureCursor } from "@/lib/sql/semantic/fixtures";
import type { DatabaseType } from "@/types/database";

function mergeColumns(...maps: Array<Map<string, SqlCompletionColumn[]> | undefined>): Map<string, SqlCompletionColumn[]> {
  const merged = new Map<string, SqlCompletionColumn[]>();
  for (const map of maps) {
    for (const [key, columns] of map ?? []) merged.set(key, columns);
  }
  return merged;
}

function semanticCompletion(markedSql: string, input: Partial<SqlCompletionProviderInput> = {}, options: { databaseType?: DatabaseType; dialect?: "mysql" | "postgres" | "sqlserver" } = {}) {
  const { sql, cursor } = sqlFixtureCursor(markedSql);
  const model = buildSqlSemanticModel(sql, cursor, options);
  const context = sqlCompletionContextFromSemantic(model, getSqlCompletionContext(sql, cursor, options));
  const columnsByTable = mergeColumns(sqlSemanticLocalColumnsByTable(model), input.columnsByTable);
  const items = buildSqlCompletionItemsFromContext(context, {
    tables: input.tables ?? [],
    objects: input.objects ?? [],
    columnsByTable,
    foreignKeysByTable: input.foreignKeysByTable,
    schemas: input.schemas,
    translations: input.translations,
    snippets: input.snippets,
    dialect: options.dialect,
    databaseType: options.databaseType,
    keywordCase: input.keywordCase,
    autoAliasTables: input.autoAliasTables,
  });
  return { sql, cursor, model, context, items };
}

describe("semantic SQL completion candidates", () => {
  it("does not mix SELECT aliases into a following UPDATE statement", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([
      ["codex_completion_a", [{ name: "id", table: "codex_completion_a", schema: "public" }]],
      ["codex_completion_b", [{ name: "id", table: "codex_completion_b", schema: "public" }]],
    ]);

    const { context, items } = semanticCompletion("SELECT ph.id FROM codex_completion_a AS ph;\n\nUPDATE codex_completion_b\nSET status = 0\nWHERE id|", { columnsByTable }, { databaseType: "postgres", dialect: "postgres" });

    expect(context.referencedTables).toEqual([expect.objectContaining({ name: "codex_completion_b" })]);
    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["id"]);
  });

  it("treats PostgreSQL hash operators as part of the preceding statement", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([
      ["codex_completion_a", [{ name: "legacy_id", table: "codex_completion_a", schema: "public" }]],
      ["codex_completion_b", [{ name: "current_id", table: "codex_completion_b", schema: "public" }]],
    ]);

    const { context, items } = semanticCompletion("SELECT ph.legacy_id # 1 FROM codex_completion_a AS ph;\nUPDATE codex_completion_b SET current_id = 0 WHERE ph.|", { columnsByTable }, { databaseType: "postgres", dialect: "postgres" });

    expect(context.statementKind).toBe("update");
    expect(context.referencedTables).toEqual([expect.objectContaining({ name: "codex_completion_b" })]);
    expect(items.filter((item) => item.type === "column").map((item) => item.label)).not.toContain("legacy_id");
  });

  it("ignores line-comment semicolons after a real statement boundary", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([
      ["codex_completion_a", [{ name: "legacy_id", table: "codex_completion_a", schema: "public" }]],
      ["codex_completion_b", [{ name: "current_id", table: "codex_completion_b", schema: "public" }]],
    ]);

    const { context, items } = semanticCompletion("SELECT ph.legacy_id FROM codex_completion_a AS ph; -- separator ; trailing words\nUPDATE codex_completion_b SET current_id = 0 WHERE current_|", { columnsByTable }, { databaseType: "postgres", dialect: "postgres" });

    expect(context.statementKind).toBe("update");
    expect(context.referencedTables).toEqual([expect.objectContaining({ name: "codex_completion_b" })]);
    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["current_id"]);
  });

  it("ignores block-comment semicolons after a real statement boundary", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([
      ["codex_completion_a", [{ name: "legacy_id", table: "codex_completion_a", schema: "public" }]],
      ["codex_completion_b", [{ name: "current_id", table: "codex_completion_b", schema: "public" }]],
    ]);

    const { context, items } = semanticCompletion("SELECT ph.legacy_id FROM codex_completion_a AS ph; /* separator ; trailing words */\nUPDATE codex_completion_b SET current_id = 0 WHERE current_|", { columnsByTable }, { databaseType: "postgres", dialect: "postgres" });

    expect(context.statementKind).toBe("update");
    expect(context.referencedTables).toEqual([expect.objectContaining({ name: "codex_completion_b" })]);
    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["current_id"]);
  });

  it("loads nested alias columns through the database-qualified metadata key", () => {
    const { context, items } = semanticCompletion(
      "SELECT * FROM aa.tb t WHERE EXISTS (SELECT 1 FROM aa.tb1 t1, aa.tb2 t2 WHERE t1.|)",
      {
        columnsByTable: new Map([["aa.tb1", [{ name: "id", table: "tb1", schema: "aa" }]]]),
      },
      { databaseType: "mysql", dialect: "mysql" },
    );

    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "tb1", schema: "aa", alias: "t1" })]));
    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["id"]);
  });

  it("suggests nested tables after a qualified comma", () => {
    const { context, items } = semanticCompletion("SELECT * FROM aa.tb t WHERE EXISTS (SELECT 1 FROM aa.tb1 t1, aa.|)", { tables: [{ name: "tb2", schema: "aa", type: "table" }] }, { databaseType: "mysql", dialect: "mysql" });

    expect(context.contextKind).toBe("table");
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ label: "tb2", type: "table" })]));
  });

  it.each([
    ["ordinary lowercase", "SELECT * FROM orders_alias a WHERE a.|", "ORDERS_ALIAS", false],
    ["quoted lowercase", 'SELECT * FROM "orders_alias" a WHERE a.|', "orders_alias", true],
    ["quoted mixed case", 'SELECT * FROM "Orders_Alias" a WHERE a.|', "Orders_Alias", true],
  ] as const)("preserves Oracle identifier semantics for %s aliases", (_label, markedSql, expectedName, expectedQuoted) => {
    const { context } = semanticCompletion(markedSql, {}, { databaseType: "oracle" });

    expect(context.referencedTables).toEqual([expect.objectContaining({ name: expectedName, nameQuoted: expectedQuoted, alias: "A" })]);
  });

  it("isolates SQL Server columns for database-qualified tables with the same schema and name", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([
      ["DatabaseA.OUT.orders", [{ name: "source_marker", table: "orders", schema: "OUT" }]],
      ["DatabaseB.OUT.orders", [{ name: "target_marker", table: "orders", schema: "OUT" }]],
    ]);
    const { context, items } = semanticCompletion("SELECT * FROM [DatabaseA].[OUT].[orders] a LEFT JOIN [DatabaseB].[OUT].[orders] b ON b.|", { columnsByTable }, { databaseType: "sqlserver", dialect: "sqlserver" });

    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "orders", database: "DatabaseB", schema: "OUT", alias: "b" })]));
    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["target_marker"]);
  });

  it("resolves columns after a full SQL Server database.schema.table qualifier", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([["DatabaseB.OUT.orders", [{ name: "target_marker", table: "orders", schema: "OUT" }]]]);
    const { context, items } = semanticCompletion("SELECT * FROM [DatabaseB].[OUT].[orders] WHERE [DatabaseB].[OUT].[orders].|", { columnsByTable }, { databaseType: "sqlserver", dialect: "sqlserver" });

    expect(context.qualifierParts).toEqual(["DatabaseB", "OUT", "orders"]);
    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["target_marker"]);
  });
  it.each([
    ["MySQL ORDER BY", "SELECT * FROM t LIMIT 100 or|", "mysql", "mysql", "ORDER BY"],
    ["PostgreSQL ON CONFLICT", "INSERT INTO t VALUES (1) on|", "postgres", "postgres", "ON CONFLICT"],
    ["Oracle EXECUTE IMMEDIATE", "exec|", "oracle", undefined, "EXECUTE IMMEDIATE"],
  ] as const)("keeps the longer %s keyword available before the current token is committed", (_label, sql, databaseType, dialect, expectedKeyword) => {
    const { context, items } = semanticCompletion(sql, {}, { databaseType, dialect });

    expect(context.suggestKeywords).toBe(false);
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ label: expectedKeyword, type: "keyword" })]));
  });

  it("does not offer keyword continuations for qualified column prefixes", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([["t", [{ name: "order_number", table: "t" }]]]);
    const { context, items } = semanticCompletion("SELECT * FROM t WHERE t.or|", { columnsByTable }, { databaseType: "mysql", dialect: "mysql" });

    expect(context.qualifier).toBe("t");
    expect(items.some((item) => item.label === "ORDER BY")).toBe(false);
  });

  it("stops offering ORDER BY as a prefix continuation after OR is committed with whitespace", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([["t", [{ name: "id", table: "t" }]]]);
    const { context, items } = semanticCompletion("SELECT * FROM t WHERE id = 1 OR |", { columnsByTable }, { databaseType: "mysql", dialect: "mysql" });

    expect(context.prefix).toBe("");
    expect(items.some((item) => item.label === "ORDER BY")).toBe(false);
    expect(items.some((item) => item.label === "id" && item.type === "column")).toBe(true);
  });

  it("keeps matching functions available in column expressions", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([
      [
        "routes",
        [
          { name: "start_sid", table: "routes" },
          { name: "start_dept", table: "routes" },
        ],
      ],
    ]);

    const { context, items } = semanticCompletion(
      "SELECT * FROM routes WHERE st_|",
      {
        columnsByTable,
        objects: [
          { name: "st_area", type: "function", dataType: "double precision" },
          { name: "st_refresh", type: "procedure" },
        ],
      },
      { databaseType: "postgres", dialect: "postgres" },
    );

    expect(context.contextKind).toBe("column");
    expect(context.suggestColumns).toBe(true);
    expect(context.suggestRoutines).toBe(true);
    expect(context.exclusiveRoutineSuggestions).toBe(false);
    expect(items.some((item) => item.label === "st_area" && item.type === "function")).toBe(true);
    expect(items.some((item) => item.label === "st_refresh")).toBe(false);
  });

  it("keeps alias-qualified column completion scoped to one row source", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([
      ["users", ["id", "name", "email"].map((name) => ({ name, table: "users" }))],
      ["orders", ["id", "total"].map((name) => ({ name, table: "orders" }))],
    ]);

    const { items } = semanticCompletion("SELECT * FROM users u JOIN orders o ON o.user_id = u.id WHERE u.|", { columnsByTable });

    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["id", "name", "email"]);
  });

  it.each([
    ["PostgreSQL", "postgres", "postgres"],
    ["SQL Server", "sqlserver", "sqlserver"],
  ] as const)("uses row-source aliases for %s self-join column collisions", (_label, databaseType, dialect) => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([["users", ["id", "name"].map((name) => ({ name, table: "users" }))]]);

    const { items } = semanticCompletion("SELECT * FROM users u JOIN users v ON u.id = v.id WHERE |", { columnsByTable }, { databaseType, dialect });
    const columns = items.filter((item) => item.type === "column");

    expect(columns.map((item) => item.label)).toEqual(expect.arrayContaining(["u.id", "u.name", "v.id", "v.name"]));
    expect(columns.find((item) => item.label === "u.id")?.apply).toBe("u.id");
    expect(columns.find((item) => item.label === "v.id")?.apply).toBe("v.id");
  });

  it("completes columns for aliases in comma-separated table lists", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([
      ["table_a", ["id", "name"].map((name) => ({ name, table: "table_a" }))],
      ["table_b", ["id", "status"].map((name) => ({ name, table: "table_b" }))],
    ]);

    const { context, items } = semanticCompletion("SELECT * FROM table_a a, table_b b WHERE a.id = b.|", { columnsByTable });

    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "table_b", alias: "b" })]));
    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["id", "status"]);
  });

  it("keeps a SELECT-list alias scoped when comma-separated sources follow the cursor", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([
      ["tb_kpi_set_score", ["id", "score_name"].map((name) => ({ name, table: "tb_kpi_set_score" }))],
      ["tb_kpi_set_score_detail", ["id", "fk_kpi_set_score_id", "detail_score"].map((name) => ({ name, table: "tb_kpi_set_score_detail" }))],
      ["tb_kpi_set_score_relationship", ["priority", "exclude_users_account"].map((name) => ({ name, table: "tb_kpi_set_score_relationship" }))],
    ]);

    const { context, items } = semanticCompletion(
      `SELECT
  b.|
FROM tb_kpi_set_score a,
  tb_kpi_set_score_detail b
WHERE a.id = b.fk_kpi_set_score_id`,
      { columnsByTable },
      { databaseType: "mysql", dialect: "mysql" },
    );

    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "tb_kpi_set_score_detail", alias: "b" })]));
    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["id", "fk_kpi_set_score_id", "detail_score"]);
  });

  it("completes correlation columns for generic PostgreSQL table functions", () => {
    const { context, items } = semanticCompletion("SELECT * FROM generate_series(1, 3) g(value) WHERE g.|", {}, { databaseType: "postgres", dialect: "postgres" });

    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "g", alias: "g" })]));
    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["value"]);
  });

  it("completes correlation columns after PostgreSQL WITH ORDINALITY", () => {
    const { items } = semanticCompletion("SELECT * FROM generate_series(1, 3) WITH ORDINALITY AS g(value, ord), orders o WHERE g.|", {}, { databaseType: "postgres", dialect: "postgres" });

    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["value", "ord"]);
  });

  it("completes later comma-separated sources after a joined table", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([["audit_log", ["event_id", "action"].map((name) => ({ name, table: "audit_log" }))]]);
    const { context, items } = semanticCompletion("SELECT * FROM users u JOIN orders o ON o.user_id = u.id, audit_log a WHERE a.|", { columnsByTable }, { databaseType: "postgres", dialect: "postgres" });

    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "audit_log", alias: "a" })]));
    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["event_id", "action"]);
  });

  it("completes correlation columns for aliased table sources", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([["table_a", ["source_id", "source_label"].map((name) => ({ name, table: "table_a" }))]]);
    const { items } = semanticCompletion("SELECT * FROM table_a a(id, label), table_b b WHERE a.|", { columnsByTable }, { databaseType: "postgres", dialect: "postgres" });

    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["id", "label"]);
  });

  it("loads real SQL Server columns after aliased table hints", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([["users", ["id", "name", "email"].map((name) => ({ name, table: "users" }))]]);

    const { items } = semanticCompletion("SELECT * FROM users u (NOLOCK) WHERE u.|", { columnsByTable }, { databaseType: "sqlserver", dialect: "sqlserver" });

    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["id", "name", "email"]);
  });

  it("merges partial PostgreSQL correlation names with metadata positionally", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([["users", ["id", "name", "email"].map((name) => ({ name, table: "users" }))]]);

    const { context, items } = semanticCompletion("SELECT * FROM users u(user_id) WHERE u.|", { columnsByTable }, { databaseType: "postgres", dialect: "postgres" });

    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "users", alias: "u", columns: undefined, columnAliases: ["user_id"] })]));
    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["user_id", "name", "email"]);
  });

  it("completes an unquoted SQL Server table named lateral", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([["lateral", ["id", "value"].map((name) => ({ name, table: "lateral" }))]]);

    const { context, items } = semanticCompletion("SELECT * FROM lateral l WHERE l.|", { columnsByTable }, { databaseType: "sqlserver", dialect: "sqlserver" });

    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "lateral", alias: "l" })]));
    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["id", "value"]);
  });

  it("uses CTE projected columns without remote metadata", () => {
    const { items, context } = semanticCompletion("WITH recent_orders(id, total) AS (SELECT id, total FROM orders) SELECT * FROM recent_orders ro WHERE ro.|");

    expect(context.exclusiveColumnSuggestions).toBe(true);
    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["id", "total"]);
  });

  it("uses subquery projected columns without remote metadata", () => {
    const { items } = semanticCompletion("SELECT * FROM (SELECT id, name AS user_name FROM users) sq WHERE sq.|");

    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["id", "user_name"]);
  });

  it("expands alias star from only the qualified row source", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([
      ["users", ["id", "name"].map((name) => ({ name, table: "users" }))],
      ["orders", ["id", "total"].map((name) => ({ name, table: "orders" }))],
    ]);

    const { context, items } = semanticCompletion("SELECT u.*| FROM users u JOIN orders o ON o.user_id = u.id", { columnsByTable });
    const star = items.find((item) => item.label === "* \u2192 columns");

    expect(context.qualifier).toBe("u");
    expect(star?.apply).toBe("id, u.name");
  });

  it("generates collision-free table aliases from semantic row sources", () => {
    const { items } = semanticCompletion("SELECT * FROM order_items oi JOIN ord|", {
      tables: [{ name: "order_items", type: "table" }],
      autoAliasTables: true,
    });

    expect(items.find((item) => item.label === "order_items")?.apply).toBe("order_items AS oi2");
  });

  it("preserves dialect-aware identifier quoting in apply text", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([["Order Details", [{ name: "User Name", table: "Order Details" }]]]);

    const { items } = semanticCompletion('SELECT od."User| FROM "Order Details" od', { columnsByTable }, { databaseType: "postgres", dialect: "postgres" });

    expect(items.find((item) => item.label === "User Name")?.apply).toBe('"User Name"');
  });

  it("suggests all target columns for insert column lists", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([["users", ["id", "name", "email"].map((name) => ({ name, table: "users" }))]]);

    const { context, items } = semanticCompletion("INSERT INTO users (|", { columnsByTable });

    expect(context.insertTable).toBe("users");
    expect(items.find((item) => item.type === "snippet" && item.label === "users.*")?.apply).toBe("id, name, email");
  });

  it("keeps partial INSERT INTO targets in table completion context", () => {
    const { context, items } = semanticCompletion("INSERT INTO ex|", {
      tables: [
        { name: "express", type: "table" },
        { name: "orders", type: "table" },
      ],
    });

    expect(context.suggestTables).toBe(true);
    expect(context.exclusiveTableSuggestions).toBe(true);
    expect(context.suggestColumns).toBe(false);
    expect(context.referencedTables).toEqual([]);
    expect(items.filter((item) => item.type === "table").map((item) => item.label)).toEqual(["express"]);
  });

  it("keeps partial SELECT FROM targets in table completion context", () => {
    const { context, items } = semanticCompletion("SELECT * FROM ex|", {
      tables: [
        { name: "express", type: "table" },
        { name: "orders", type: "table" },
      ],
    });

    expect(context.suggestTables).toBe(true);
    expect(context.exclusiveTableSuggestions).toBe(true);
    expect(context.qualifier).toBeUndefined();
    expect(context.qualifierParts).toBeUndefined();
    expect(items.filter((item) => item.type === "table").map((item) => item.label)).toEqual(["express"]);
  });

  it("keeps JOIN modifier completion in keyword context", () => {
    const { context, items } = semanticCompletion("SELECT * FROM users left |", {
      tables: [{ name: "orders", type: "table" }],
    });

    expect(context.suggestTables).toBe(false);
    expect(context.preferredKeywords).toContain("JOIN");
    expect(items[0]?.label).toBe("JOIN");
    expect(items.some((item) => item.type === "table")).toBe(false);
  });

  it("keeps table completion after completed LEFT JOIN", () => {
    const { context, items } = semanticCompletion("SELECT * FROM users left join |", {
      tables: [{ name: "orders", type: "table" }],
    });

    expect(context.suggestTables).toBe(true);
    expect(items.filter((item) => item.type === "table").map((item) => item.label)).toEqual(["orders"]);
  });
});

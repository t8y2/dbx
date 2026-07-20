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
  const context = sqlCompletionContextFromSemantic(model, getSqlCompletionContext(sql, cursor));
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

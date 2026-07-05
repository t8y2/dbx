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
  it("keeps alias-qualified column completion scoped to one row source", () => {
    const columnsByTable = new Map<string, SqlCompletionColumn[]>([
      ["users", ["id", "name", "email"].map((name) => ({ name, table: "users" }))],
      ["orders", ["id", "total"].map((name) => ({ name, table: "orders" }))],
    ]);

    const { items } = semanticCompletion("SELECT * FROM users u JOIN orders o ON o.user_id = u.id WHERE u.|", { columnsByTable });

    expect(items.filter((item) => item.type === "column").map((item) => item.label)).toEqual(["id", "name", "email"]);
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
});

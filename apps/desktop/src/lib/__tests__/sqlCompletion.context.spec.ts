import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems, getSqlCompletionContext } from "@/lib/sqlCompletion";

describe("sqlCompletion quoted schema qualifiers", () => {
  it("parses quoted PostgreSQL schema names before a dot", () => {
    const sql = 'SELECT *\nFROM "order-management".';
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.qualifier).toBe("order-management");
    expect(context.prefix).toBe("");
    expect(context.suggestTables).toBe(true);
    expect(context.exclusiveColumnSuggestions).toBe(false);
  });

  it("suggests tables after a quoted schema qualifier", () => {
    const sql = 'SELECT *\nFROM "order-management".';
    const items = buildSqlCompletionItems(sql, sql.length, {
      dialect: "postgres",
      tables: [
        { name: "orders", schema: "order-management", type: "table" },
        { name: "shipments", schema: "order-management", type: "table" },
      ],
      columnsByTable: new Map(),
    });

    expect(items.some((item) => item.label === "orders" && item.type === "table")).toBe(true);
    expect(items.some((item) => item.label === "shipments" && item.type === "table")).toBe(true);
  });
});

describe("sqlCompletion scoped context classification", () => {
  it("classifies JOIN table contexts", () => {
    const sql = "SELECT * FROM users u JOIN ";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.contextKind).toBe("join");
    expect(context.suggestTables).toBe(true);
    expect(context.exclusiveTableSuggestions).toBe(true);
  });

  it("classifies alias-qualified column contexts", () => {
    const sql = "SELECT * FROM users u WHERE u.";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.contextKind).toBe("alias_column");
    expect(context.qualifier).toBe("u");
    expect(context.suggestColumns).toBe(true);
  });

  it("classifies CALL routine contexts", () => {
    const sql = "CALL usp_";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.contextKind).toBe("exec");
    expect(context.suggestRoutines).toBe(true);
    expect(context.exclusiveRoutineSuggestions).toBe(true);
  });

  it("classifies INSERT column-list contexts", () => {
    const sql = "INSERT INTO dbo.Users (";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.contextKind).toBe("column");
    expect(context.insertSchema).toBe("dbo");
    expect(context.insertTable).toBe("users");
    expect(context.exclusiveColumnSuggestions).toBe(true);
  });

  it("classifies UPDATE SET column contexts", () => {
    const sql = "UPDATE dbo.Users SET ";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.contextKind).toBe("column");
    expect(context.updateTarget).toEqual({ schema: "dbo", table: "Users" });
    expect(context.suggestColumns).toBe(true);
  });

  it("extracts statement-local table aliases", () => {
    const sql = "SELECT * FROM dbo.Users u JOIN Orders AS o ON o.user_id = u.id WHERE u.";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ schema: "dbo", name: "Users", alias: "u" }), expect.objectContaining({ name: "Orders", alias: "o" })]));
  });

  it("exposes CTEs as table-like referenced tables", () => {
    const sql = "WITH recent_orders(id, total) AS (SELECT id, total FROM orders) SELECT * FROM recent_orders ro WHERE ro.";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "recent_orders", columns: ["id", "total"] }), expect.objectContaining({ name: "recent_orders", alias: "ro" })]));
  });

  it("extracts subquery aliases and projected columns", () => {
    const sql = "SELECT * FROM (SELECT id, name AS user_name FROM users) sq WHERE sq.";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "sq", alias: "sq", columns: ["id", "user_name"] })]));
  });
});

describe("sqlCompletion scoped metadata ranking", () => {
  it("ranks exact and prefix table matches ahead of contains/fuzzy matches", () => {
    const sql = "SELECT * FROM Temp";
    const items = buildSqlCompletionItems(sql, sql.length, {
      dialect: "sqlserver",
      tables: [
        { name: "ArchiveTempTable", schema: "dbo", type: "table" },
        { name: "TempAudit", schema: "dbo", type: "table" },
        { name: "Temp", schema: "dbo", type: "table" },
        { name: "Template", schema: "dbo", type: "table" },
      ],
      columnsByTable: new Map(),
    }).filter((item) => item.type === "table");

    expect(items.map((item) => item.label).slice(0, 3)).toEqual(["Temp", "Template", "TempAudit"]);
    expect(items.some((item) => item.label === "ArchiveTempTable")).toBe(true);
  });

  it("keeps large table catalogs bounded", () => {
    const tables = Array.from({ length: 500 }, (_, index) => ({ name: `TempTable_${String(index).padStart(3, "0")}`, schema: "dbo", type: "table" as const }));
    const sql = "SELECT * FROM Temp";
    const items = buildSqlCompletionItems(sql, sql.length, { dialect: "sqlserver", tables, columnsByTable: new Map() }).filter((item) => item.type === "table");

    expect(items.length).toBeLessThanOrEqual(200);
    expect(items[0]?.label).toBe("TempTable_000");
  });
});

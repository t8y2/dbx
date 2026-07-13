import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems, getSqlCompletionContext, shouldAutoOpenSqlCompletion } from "@/lib/sql/sqlCompletion";

describe("sqlCompletion keyword snippets", () => {
  it("auto-opens and suggests SELECT when typing sel", () => {
    const sql = "sel";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [],
      columnsByTable: new Map(),
    });

    expect(shouldAutoOpenSqlCompletion(sql, sql.length)).toBe(true);
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ label: "select *", type: "snippet" }), expect.objectContaining({ label: "SELECT", type: "keyword" })]));
  });
});

describe("sqlCompletion database functions", () => {
  it("suggests MySQL Unix timestamp functions with function snippets", () => {
    const fromUnixSql = "SELECT from_unix";
    const fromUnixItems = buildSqlCompletionItems(fromUnixSql, fromUnixSql.length, {
      databaseType: "mysql",
      tables: [],
      columnsByTable: new Map(),
    });
    const fromUnixTime = fromUnixItems.find((item) => item.label === "FROM_UNIXTIME");

    expect(fromUnixItems[0]).toBe(fromUnixTime);
    expect(fromUnixTime).toEqual(
      expect.objectContaining({
        type: "function",
        apply: "FROM_UNIXTIME(${unix_timestamp})",
      }),
    );

    const unixTimestampSql = "SELECT unix_time";
    const unixTimestampItems = buildSqlCompletionItems(unixTimestampSql, unixTimestampSql.length, {
      databaseType: "mysql",
      tables: [],
      columnsByTable: new Map(),
    });

    expect(unixTimestampItems[0]).toEqual(
      expect.objectContaining({
        label: "UNIX_TIMESTAMP",
        type: "function",
        apply: "UNIX_TIMESTAMP()",
      }),
    );
  });

  it("ranks MySQL function prefixes ahead of ordinary keyword prefixes", () => {
    const sql = "SELECT uni";
    const items = buildSqlCompletionItems(sql, sql.length, {
      databaseType: "mysql",
      tables: [],
      columnsByTable: new Map(),
    });

    expect(items.some((item) => item.type === "keyword")).toBe(true);
    expect(items[0]).toEqual(expect.objectContaining({ label: "UNIX_TIMESTAMP", type: "function" }));
  });

  it("does not expose MySQL-only functions to other databases", () => {
    const sql = "SELECT from_unix";
    const items = buildSqlCompletionItems(sql, sql.length, {
      databaseType: "postgres",
      tables: [],
      columnsByTable: new Map(),
    });

    expect(items.some((item) => item.label === "FROM_UNIXTIME")).toBe(false);
  });
});

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

describe("sqlCompletion table targets", () => {
  it("does not suggest aliases while completing an empty FROM target before LIMIT", () => {
    const sql = "SELECT *\nFROM \nLIMIT 100;";
    const cursor = "SELECT *\nFROM ".length;
    const items = buildSqlCompletionItems(sql, cursor, {
      tables: [{ name: "users", type: "table" }],
      columnsByTable: new Map(),
    });

    expect(items.some((item) => item.type === "snippet" && item.detail === "alias for LIMIT")).toBe(false);
    expect(items.some((item) => item.type === "table" && item.label === "users")).toBe(true);
  });
});

describe("sqlCompletion table aliases", () => {
  it("applies generated aliases to table completions when enabled", () => {
    const sql = "SELECT * FROM ord";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "order_items", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: true,
    });

    const table = items.find((item) => item.label === "order_items" && item.type === "table");
    expect(table?.apply).toBe("order_items AS oi");
  });

  it("omits AS from Oracle table alias completions", () => {
    const sql = "SELECT * FROM ord";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "order_items", type: "table" }],
      columnsByTable: new Map(),
      databaseType: "oracle",
      autoAliasTables: true,
    });

    const table = items.find((item) => item.label === "order_items" && item.type === "table");
    expect(table?.apply).toBe("order_items oi");
  });

  it("keeps plain table completions when generated aliases are disabled", () => {
    const sql = "SELECT * FROM ord";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "order_items", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: false,
    });

    const table = items.find((item) => item.label === "order_items" && item.type === "table");
    expect(table?.apply).toBe("order_items");
  });

  it("omits AS from Oracle alias suggestions", () => {
    const sql = "SELECT * FROM order_items ";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "order_items", type: "table" }],
      columnsByTable: new Map(),
      databaseType: "oracle",
    });

    const alias = items.find((item) => item.type === "snippet" && item.detail === "alias for order_items");
    expect(alias?.apply).toBe("oi ");
  });

  it("uses a numbered alias when the generated table alias already exists", () => {
    const sql = "SELECT * FROM order_items oi JOIN ord";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "order_items", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: true,
    });

    const table = items.find((item) => item.label === "order_items" && item.type === "table");
    expect(table?.apply).toBe("order_items AS oi2");
  });

  it("applies generated aliases in comma-separated FROM table lists", () => {
    const sql = "SELECT * FROM users u, ord";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "order_items", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: true,
    });

    const table = items.find((item) => item.label === "order_items" && item.type === "table");
    expect(table?.apply).toBe("order_items AS oi");
  });

  it("does not apply generated aliases to non-query table completions", () => {
    const sql = "INSERT INTO ord";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "order_items", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: true,
    });

    const table = items.find((item) => item.label === "order_items" && item.type === "table");
    expect(table?.apply).toBe("order_items");
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

  it("keeps alias-qualified column context after select-list subqueries", () => {
    const sql = `
      SELECT
        p.id,
        p.create_user_name 'creator',
        (SELECT t.\`code\` FROM sys_user t WHERE t.user_id = p.apply_user_id) 'creator_code',
        p.
      FROM sys_process p
      LIMIT 10
    `;
    const cursor = sql.indexOf("p.\n      FROM");
    const context = getSqlCompletionContext(sql, cursor + 2);

    expect(context.contextKind).toBe("alias_column");
    expect(context.qualifier).toBe("p");
    expect(context.suggestTables).toBe(false);
    expect(context.exclusiveTableSuggestions).toBe(false);
    expect(context.suggestColumns).toBe(true);
  });

  it("suggests alias columns after select-list subqueries instead of tables", () => {
    const sql = `
      SELECT
        p.id,
        p.create_user_name 'creator',
        (SELECT t.\`code\` FROM sys_user t WHERE t.user_id = p.apply_user_id) 'creator_code',
        p.
      FROM sys_process p
      LIMIT 10
    `;
    const cursor = sql.indexOf("p.\n      FROM") + 2;
    const items = buildSqlCompletionItems(sql, cursor, {
      dialect: "mysql",
      tables: [
        { name: "act_evt_log", type: "table" },
        { name: "sys_process", type: "table" },
        { name: "sys_user", type: "table" },
      ],
      columnsByTable: new Map([
        [
          "sys_process",
          [
            { name: "id", table: "sys_process" },
            { name: "create_user_name", table: "sys_process" },
            { name: "apply_user_id", table: "sys_process" },
          ],
        ],
        ["sys_user", [{ name: "code", table: "sys_user" }]],
      ]),
    });

    const columnLabels = items.filter((item) => item.type === "column").map((item) => item.label);
    expect(columnLabels).toEqual(expect.arrayContaining(["id", "create_user_name", "apply_user_id"]));
    expect(items[0]?.type).toBe("column");
    expect(items.some((item) => item.type === "table")).toBe(false);
    expect(items.some((item) => item.type === "keyword")).toBe(false);
  });

  it("classifies unqualified WHERE field input as column context", () => {
    const sql = "SELECT * FROM A1User WHERE userc";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.contextKind).toBe("column");
    expect(context.prefix).toBe("userc");
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "A1User" })]));
    expect(context.suggestColumns).toBe(true);
    expect(context.suggestRoutines).toBe(false);
  });

  it("auto-opens column completion after WHERE whitespace before LIMIT", () => {
    const sql = "SELECT *\nFROM t_0001 AS t0 WHERE \nLIMIT 100;";
    const cursor = "SELECT *\nFROM t_0001 AS t0 WHERE ".length;
    const context = getSqlCompletionContext(sql, cursor);

    expect(context.contextKind).toBe("column");
    expect(context.prefix).toBe("");
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "t_0001", alias: "t0" })]));
    expect(context.suggestColumns).toBe(true);
    expect(shouldAutoOpenSqlCompletion(sql, cursor)).toBe(true);
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
    expect(context.insertTable).toBe("Users");
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

  it("treats schema-qualified table prefixes in FROM as table completion input", () => {
    const sql = "SELECT * FROM dws_game_sdk_base.di";
    const context = getSqlCompletionContext(sql, sql.length);

    expect(context.qualifier).toBe("dws_game_sdk_base");
    expect(context.prefix).toBe("di");
    expect(context.suggestTables).toBe(true);
    expect(context.exclusiveTableSuggestions).toBe(true);
    expect(context.suggestColumns).toBe(true);
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

  it("suggests columns for cross-database qualified table references", () => {
    const sql = "SELECT * FROM current_orders WHERE reporting.orders.";
    const context = getSqlCompletionContext(sql, sql.length);
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [],
      columnsByTable: new Map([
        [
          "reporting.orders",
          [
            { name: "id", table: "orders", schema: "reporting", dataType: "int" },
            { name: "status", table: "orders", schema: "reporting", dataType: "varchar" },
          ],
        ],
        ["archive.orders", [{ name: "archived_at", table: "orders", schema: "archive", dataType: "datetime" }]],
      ]),
    });

    expect(context.qualifier).toBe("reporting.orders");
    expect(context.qualifierParts).toEqual(["reporting", "orders"]);
    expect(context.suggestColumns).toBe(true);
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ label: "id", type: "column" }), expect.objectContaining({ label: "status", type: "column" })]));
    expect(items.some((item) => item.label === "archived_at")).toBe(false);
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

  it("ranks real Oracle tables before built-in table functions in FROM contexts", () => {
    const sql = "SELECT * FROM ";
    const items = buildSqlCompletionItems(sql, sql.length, {
      databaseType: "oracle",
      tables: [{ name: "ORDERS_10K", schema: "DBX_TEST", type: "table" }],
      columnsByTable: new Map(),
    });

    expect(items.findIndex((item) => item.label === "ORDERS_10K")).toBeLessThan(items.findIndex((item) => item.label === "TABLE"));
  });
});

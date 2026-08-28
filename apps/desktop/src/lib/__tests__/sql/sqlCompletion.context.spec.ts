import { describe, expect, it } from "vitest";
import {
  buildPostgresSequenceLiteralCompletionItems,
  buildSelectStarExpansion,
  buildSqlCompletionItems,
  buildSqlCompletionItemsFromContext,
  getPostgresSequenceLiteralCompletionContext,
  getSqlCompletionContext,
  selectStarResultColumnsMatch,
  shouldAutoOpenSqlCompletion,
} from "@/lib/sql/sqlCompletion";
import { sqlCompletionContextFromSemantic } from "@/lib/sql/semantic/completion";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import { originForSqlCompletionProvider, originForTypedSqlCompletionStart, shouldAllowSqlCompletionTrigger, type SqlCompletionTriggerFacts } from "@/lib/sql/sqlCompletionTriggerPolicy";

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

describe("SQL Server datepart completion", () => {
  it.each(["DATEADD", "DATEDIFF", "DATEPART", "DATENAME"])("suggests datepart values for the first %s argument", (functionName) => {
    const sql = `SELECT ${functionName}(d`;
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [],
      columnsByTable: new Map(),
      databaseType: "sqlserver",
      dialect: "sqlserver",
      keywordCase: "lower",
    });

    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ label: "day", type: "keyword" }), expect.objectContaining({ label: "dayofyear", type: "keyword" })]));
    expect(items.some((item) => item.label === "deadlock_priority")).toBe(false);
  });

  it("auto-opens the datepart list immediately after the opening parenthesis", () => {
    const sql = "SELECT DATEADD(";

    expect(shouldAutoOpenSqlCompletion(sql, sql.length, { databaseType: "sqlserver", dialect: "sqlserver" })).toBe(true);
  });

  it("stops offering datepart values after the first argument", () => {
    const sql = "SELECT DATEADD(day, d";

    expect(getSqlCompletionContext(sql, sql.length, { databaseType: "sqlserver", dialect: "sqlserver" }).preferredValueKeywords).toBeUndefined();
  });

  it("does not apply SQL Server datepart values to other dialects", () => {
    const sql = "SELECT DATEADD(d";

    expect(getSqlCompletionContext(sql, sql.length, { databaseType: "mysql", dialect: "mysql" }).preferredValueKeywords).toBeUndefined();
  });
});

describe("MySQL DESCRIBE table completion", () => {
  it.each(["DESC", "DESCRIBE"])("treats %s as a table-name context", (keyword) => {
    const sql = `${keyword} ord`;
    const options = { databaseType: "mysql", dialect: "mysql" } as const;
    const context = sqlCompletionContextFromSemantic(buildSqlSemanticModel(sql, sql.length, options), getSqlCompletionContext(sql, sql.length, options));
    expect(context.suggestTables).toBe(true);
    expect(shouldAutoOpenSqlCompletion(sql, sql.length, options)).toBe(true);
    expect(
      buildSqlCompletionItemsFromContext(context, {
        tables: [{ name: "orders" }],
        columnsByTable: new Map(),
        ...options,
      }),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ label: "orders", type: "table" })]));
  });

  it("does not treat PostgreSQL ORDER BY DESC as a table-name context", () => {
    const sql = "SELECT * FROM users ORDER BY name DESC ord";
    const options = { databaseType: "postgres", dialect: "postgres" } as const;
    const context = sqlCompletionContextFromSemantic(buildSqlSemanticModel(sql, sql.length, options), getSqlCompletionContext(sql, sql.length, options));

    expect(context.suggestTables).toBe(false);
    expect(
      buildSqlCompletionItemsFromContext(context, {
        tables: [{ name: "orders" }],
        columnsByTable: new Map(),
        ...options,
      }).some((item) => item.type === "table"),
    ).toBe(false);
  });
});

describe("PostgreSQL sequence literal completion", () => {
  it.each(["nextval", "currval", "setval"])("recognizes the first %s regclass literal", (functionName) => {
    const sql = `SELECT ${functionName}('public.order_`;
    const context = getPostgresSequenceLiteralCompletionContext(sql, sql.length, "postgres");

    expect(context).toEqual(
      expect.objectContaining({
        prefix: "order_",
        schema: "public",
        schemaQuoted: false,
        nameQuoted: false,
      }),
    );
    expect(context?.from).toBe(sql.lastIndexOf("order_"));
    expect(shouldAutoOpenSqlCompletion(sql, sql.length, { databaseType: "postgres" })).toBe(true);
  });

  it("preserves quoted mixed-case schema and sequence identifiers", () => {
    const sql = `SELECT pg_catalog.nextval('"App"."Order`;
    const context = getPostgresSequenceLiteralCompletionContext(sql, sql.length, "postgres");

    expect(context).toEqual(
      expect.objectContaining({
        prefix: "Order",
        schema: "App",
        schemaQuoted: true,
        nameQuoted: true,
        nameQuoteClosed: false,
      }),
    );
    expect(
      buildPostgresSequenceLiteralCompletionItems(context!, [
        { name: "OrderSequence", schema: "App", type: "sequence" },
        { name: "order_sequence", schema: "App", type: "sequence" },
      ]),
    ).toEqual([
      expect.objectContaining({
        label: "OrderSequence",
        apply: 'OrderSequence"',
        replaceClosingQuote: '"',
        detail: "sequence in App",
      }),
    ]);
  });

  it("keeps doubled apostrophes inside the sequence identifier and escapes insertion", () => {
    const sql = `SELECT nextval('"customer''s_`;
    const context = getPostgresSequenceLiteralCompletionContext(sql, sql.length, "postgres");

    expect(context).toEqual(expect.objectContaining({ prefix: "customer's_", nameQuoted: true }));
    expect(buildPostgresSequenceLiteralCompletionItems(context!, [{ name: "customer's_seq", schema: "public", type: "sequence" }])).toEqual([expect.objectContaining({ label: "customer's_seq", apply: `customer''s_seq"` })]);
  });

  it("quotes an accepted mixed-case identifier in an unquoted literal", () => {
    const sql = "SELECT nextval('mix";
    const context = getPostgresSequenceLiteralCompletionContext(sql, sql.length, "postgres");

    expect(buildPostgresSequenceLiteralCompletionItems(context!, [{ name: "MixedSequence", schema: "public", type: "sequence" }])).toEqual([expect.objectContaining({ label: "MixedSequence", filterText: "MixedSequence", apply: '"MixedSequence"' })]);
  });

  it("does not expose sequence metadata through ordinary SQL object completion", () => {
    const sql = "SELECT order_";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [],
      objects: [{ name: "order_seq", schema: "public", type: "sequence" }],
      columnsByTable: new Map(),
      databaseType: "postgres",
      dialect: "postgres",
    });

    expect(items.some((item) => item.label === "order_seq")).toBe(false);
  });

  it.each([
    ["SELECT 'order_", "postgres"],
    ["SELECT nextval('order_", "mysql"],
    ["SELECT nextval('order_') || 'suffix", "postgres"],
    ["SELECT setval(42, 'order_", "postgres"],
    ["SELECT app.nextval('order_", "postgres"],
    ["SELECT app. nextval('order_", "postgres"],
    ["SELECT app.pg_catalog.nextval('order_", "postgres"],
    [`SELECT "PG_CATALOG".nextval('order_`, "postgres"],
    ["SELECT $$ nextval('order_", "postgres"],
    ["SELECT $body$ nextval('order_", "postgres"],
  ] as const)("does not enable sequence completion for unrelated literals: %s (%s)", (sql, databaseType) => {
    expect(getPostgresSequenceLiteralCompletionContext(sql, sql.length, databaseType)).toBeNull();
    expect(shouldAutoOpenSqlCompletion(sql, sql.length, { databaseType })).toBe(false);
  });
});

describe("SELECT star expansion", () => {
  it("reuses completion column ordering for an unqualified star", () => {
    const sql = "SELECT * FROM apis";
    const context = getSqlCompletionContext(sql, "SELECT *".length);

    expect(
      buildSelectStarExpansion(
        context,
        new Map([
          [
            "apis",
            [
              { name: "id", table: "apis" },
              { name: "created_at", table: "apis" },
              { name: "method", table: "apis" },
            ],
          ],
        ]),
      ),
    ).toBe("id, created_at, method");
  });

  it("expands a multi-table star with aliases and preserves duplicate column names", () => {
    const sql = "SELECT * FROM tVillage tV INNER JOIN tland tl ON tV.villageId = tl.villageId";
    const cursor = "SELECT *".length;
    const context = sqlCompletionContextFromSemantic(buildSqlSemanticModel(sql, cursor), getSqlCompletionContext(sql, cursor));

    expect(
      buildSelectStarExpansion(
        context,
        new Map([
          [
            "tVillage",
            [
              { name: "villageId", table: "tVillage" },
              { name: "villageName", table: "tVillage" },
            ],
          ],
          [
            "tland",
            [
              { name: "villageId", table: "tland" },
              { name: "landName", table: "tland" },
            ],
          ],
        ]),
      ),
    ).toBe("tV.villageId, tV.villageName, tl.villageId, tl.landName");
  });

  it("uses FROM/JOIN order even when the metadata map arrives in another order", () => {
    const sql = "SELECT * FROM tVillage tv INNER JOIN tland tl ON tv.villageId = tl.villageId";
    const cursor = "SELECT *".length;
    const context = sqlCompletionContextFromSemantic(buildSqlSemanticModel(sql, cursor), getSqlCompletionContext(sql, cursor));

    expect(
      buildSelectStarExpansion(
        context,
        new Map([
          [
            "tland",
            [
              { name: "landName", table: "tland" },
              { name: "villageId", table: "tland" },
            ],
          ],
          [
            "tVillage",
            [
              { name: "villageName", table: "tVillage" },
              { name: "villageId", table: "tVillage" },
            ],
          ],
        ]),
      ),
    ).toBe("tv.villageName, tv.villageId, tl.landName, tl.villageId");
  });

  it("preserves an alias while replacing only the star", () => {
    const sql = "SELECT ap.* FROM apis AS ap";
    const cursor = "SELECT ap.*".length;
    const context = sqlCompletionContextFromSemantic(buildSqlSemanticModel(sql, cursor), getSqlCompletionContext(sql, cursor));

    expect(
      buildSelectStarExpansion(
        context,
        new Map([
          [
            "apis",
            [
              { name: "id", table: "apis" },
              { name: "created_at", table: "apis" },
            ],
          ],
        ]),
      ),
    ).toBe("id, ap.created_at");
  });

  it.each([
    ["postgres", "postgres", '"Order Alias"', '"created at"'],
    ["mysql", "mysql", "`Order Alias`", "`created at`"],
    ["sqlserver", "sqlserver", "[Order Alias]", "[created at]"],
    ["oracle", "mysql", '"Order Alias"', '"created at"'],
  ] as const)("preserves a quoted %s alias for every expanded column", (databaseType, dialect, qualifierSql, quotedColumn) => {
    const sql = `SELECT ${qualifierSql}.* FROM orders AS ${qualifierSql}`;
    const cursor = sql.indexOf("*") + 1;
    const context = sqlCompletionContextFromSemantic(buildSqlSemanticModel(sql, cursor, { databaseType, dialect }), getSqlCompletionContext(sql, cursor, { databaseType, dialect }));

    expect(
      buildSelectStarExpansion(
        context,
        new Map([
          [
            "orders",
            [
              { name: "id", table: "orders" },
              { name: "created at", table: "orders" },
            ],
          ],
        ]),
        dialect,
        qualifierSql,
        databaseType,
      ),
    ).toBe(`id, ${qualifierSql}.${quotedColumn}`);
  });

  it("expands an unqualified star from result columns when the table has an alias", () => {
    const sql = "select *\nfrom apis as ap\nlimit 100;";
    const cursor = "select *".length;
    const context = sqlCompletionContextFromSemantic(buildSqlSemanticModel(sql, cursor), getSqlCompletionContext(sql, cursor));

    expect(
      buildSelectStarExpansion(
        context,
        new Map([
          [
            "apis",
            [
              { name: "id", table: "apis" },
              { name: "created_at", table: "apis" },
              { name: "updated_at", table: "apis" },
              { name: "deleted_at", table: "apis" },
              { name: "method", table: "apis" },
            ],
          ],
        ]),
      ),
    ).toBe("id, created_at, updated_at, deleted_at, method");
  });

  it("accepts result columns only when their source still contains the target star", () => {
    const currentSql = "select * from apis;\nselect * from users;";
    const sourceStatement = "select * from users";
    const sourceFrom = currentSql.lastIndexOf("select");
    const targetFrom = currentSql.lastIndexOf("*");

    expect(selectStarResultColumnsMatch({ currentSql, targetFrom, targetTo: targetFrom + 1, statementSql: sourceStatement, sourceStatement, sourceFrom, sourceTo: sourceFrom + sourceStatement.length })).toBe(true);
    expect(selectStarResultColumnsMatch({ currentSql, targetFrom: currentSql.indexOf("*"), targetTo: currentSql.indexOf("*") + 1, statementSql: "select * from apis", sourceStatement, sourceFrom, sourceTo: sourceFrom + sourceStatement.length })).toBe(false);
  });

  it("rejects stale and incomplete result source metadata", () => {
    expect(selectStarResultColumnsMatch({ currentSql: "select * from users", targetFrom: 7, targetTo: 8, statementSql: "select * from users", sourceStatement: "select * from apis" })).toBe(false);
    expect(selectStarResultColumnsMatch({ currentSql: "select * from users", targetFrom: 7, targetTo: 8, statementSql: "select * from users", sourceStatement: "select * from users", sourceFrom: 0 })).toBe(false);
  });
});

describe("sqlCompletion database functions", () => {
  it("suggests ClickHouse functions with canonical casing and preferred placeholders", () => {
    const sql = "SELECT tostart";
    const items = buildSqlCompletionItems(sql, sql.length, {
      databaseType: "clickhouse",
      tables: [],
      columnsByTable: new Map(),
      functionCase: "lower",
    });

    expect(items.find((item) => item.label === "toStartOfDay")).toMatchObject({
      type: "function",
      apply: "toStartOfDay(${value})",
    });
  });

  it("uses exact ClickHouse window function placeholders", () => {
    const denseRankSql = "SELECT dense_";
    const denseRankItems = buildSqlCompletionItems(denseRankSql, denseRankSql.length, {
      databaseType: "clickhouse",
      tables: [],
      columnsByTable: new Map(),
    });
    expect(denseRankItems.find((item) => item.label === "dense_rank")?.apply).toBe("dense_rank()");

    const ntileSql = "SELECT nti";
    const ntileItems = buildSqlCompletionItems(ntileSql, ntileSql.length, {
      databaseType: "clickhouse",
      tables: [],
      columnsByTable: new Map(),
    });
    expect(ntileItems.find((item) => item.label === "ntile")?.apply).toBe("ntile(${buckets})");
  });

  it("does not leak ClickHouse-only functions to MySQL", () => {
    const sql = "SELECT tostart";
    const items = buildSqlCompletionItems(sql, sql.length, {
      databaseType: "mysql",
      tables: [],
      columnsByTable: new Map(),
    });

    expect(items.some((item) => item.label === "toStartOfDay")).toBe(false);
  });

  it("suggests only ClickHouse table functions alongside tables after FROM", () => {
    const sql = "SELECT * FROM num";
    const items = buildSqlCompletionItems(sql, sql.length, {
      databaseType: "clickhouse",
      tables: [{ name: "number_events", type: "table" }],
      columnsByTable: new Map(),
    });

    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ label: "numbers", type: "function" }), expect.objectContaining({ label: "number_events", type: "table" })]));
    expect(items.some((item) => item.label === "toStartOfDay")).toBe(false);
  });

  it("does not insert a duplicate opening parenthesis before an existing call", () => {
    const sql = "SELECT toStart()";
    const cursor = "SELECT toStart".length;
    const items = buildSqlCompletionItems(sql, cursor, {
      databaseType: "clickhouse",
      tables: [],
      columnsByTable: new Map(),
    });

    expect(items.find((item) => item.label === "toStartOfDay")?.apply).toBe("toStartOfDay");
  });

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
  it("suggests tables after a database qualifier in an EXISTS table list", () => {
    const sql = "SELECT * FROM aa.tb t WHERE EXISTS (SELECT 1 FROM aa.tb1 t1, aa.";
    const context = getSqlCompletionContext(sql, sql.length);
    const items = buildSqlCompletionItems(sql, sql.length, {
      databaseType: "mysql",
      tables: [{ name: "tb2", schema: "aa", type: "table" }],
      columnsByTable: new Map(),
    });

    expect(context.qualifier).toBe("aa");
    expect(context.suggestTables).toBe(true);
    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ label: "tb2", type: "table" })]));
  });

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
  it("uses initials from all words for generated aliases", () => {
    const sql = "SELECT * FROM mat";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "materials_order_item", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: true,
    });

    const table = items.find((item) => item.label === "materials_order_item" && item.type === "table");
    expect(table?.apply).toBe("materials_order_item AS moi");
  });

  it("uses every word initial for longer multi-word names", () => {
    const sql = "SELECT * FROM sup";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "super_long_customer_order_history_archive_snapshot_daily_replica", type: "table" }],
      columnsByTable: new Map(),
      autoAliasTables: true,
    });

    const table = items.find((item) => item.label === "super_long_customer_order_history_archive_snapshot_daily_replica" && item.type === "table");
    expect(table?.apply).toBe("super_long_customer_order_history_archive_snapshot_daily_replica AS slcohasdr");
  });

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
    expect(context.suggestRoutines).toBe(true);
  });

  it("classifies unqualified WHERE field input as column context for unquoted non-ASCII table/schema names", () => {
    const options = { databaseType: "mysql" } as const;

    const tableOnly = getSqlCompletionContext("SELECT * FROM 用户表 WHERE ", "SELECT * FROM 用户表 WHERE ".length, options);
    expect(tableOnly.contextKind).toBe("column");
    expect(tableOnly.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "用户表" })]));
    expect(tableOnly.suggestColumns).toBe(true);

    const withSchema = getSqlCompletionContext("SELECT * FROM 中文库.用户表 WHERE ", "SELECT * FROM 中文库.用户表 WHERE ".length, options);
    expect(withSchema.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ schema: "中文库", name: "用户表" })]));
    expect(withSchema.suggestColumns).toBe(true);
  });

  it("does not treat a non-ASCII 'from' phrase inside a string literal as a referenced table", () => {
    const sql = "SELECT * FROM real_table WHERE note = 'from 测试表' AND ";
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "real_table" })]));
    expect(context.referencedTables.some((t) => t.name === "测试表")).toBe(false);
  });

  it("does not treat a non-ASCII 'from' phrase inside a line comment as a referenced table", () => {
    const sql = "SELECT *\nFROM real_table\n-- from 测试表\nWHERE ";
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "real_table" })]));
    expect(context.referencedTables.some((t) => t.name === "测试表")).toBe(false);
  });

  it("does not treat a 'from' phrase inside a block comment as a referenced table", () => {
    const sql = "SELECT *\nFROM real_table\n/* from ghost_table */\nWHERE ";
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "real_table" })]));
    expect(context.referencedTables.some((t) => t.name === "ghost_table")).toBe(false);
  });

  it("does not let a quote inside a line comment desync literal/comment masking", () => {
    const sql = "SELECT * FROM real_table -- it's a comment\nWHERE ";
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "real_table" })]));
  });

  it("does not let a comment-like sequence inside a string literal swallow real SQL", () => {
    const sql = "SELECT * FROM t1 WHERE note = '-- not a comment' AND ";
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "t1" })]));
  });

  it("does not match unquoted non-ASCII table names for ANSI-strict dialects", () => {
    const sql = "SELECT * FROM 用户表 WHERE ";
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "clickhouse" });
    expect(context.referencedTables.some((t) => t.name === "用户表")).toBe(false);
  });

  it("masks a double-quoted value right after an operator from being read as a table reference (mysql)", () => {
    const sql = 'SELECT * FROM real_table WHERE note = "from 测试表" AND ';
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "real_table" })]));
    expect(context.referencedTables.some((t) => t.name === "测试表")).toBe(false);
  });

  it("treats a double-quoted FROM target as a table reference regardless of MySQL's sql_mode (position-aware masking)", () => {
    // sql_mode (and therefore whether "..." is ANSI_QUOTES identifier quoting or a string literal)
    // isn't observable at parse time, so "..." right after FROM/JOIN/UPDATE/etc. is always treated
    // as a potential table identifier -- matching ANSI_QUOTES-enabled MySQL -- while "..." elsewhere
    // (function args, CASE branches, operator-adjacent values) is still masked as a value, matching
    // MySQL's actual default sql_mode. See maskSqlLiteralsAndComments's doc comment.
    const sql = 'SELECT * FROM "orders" WHERE ';
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "orders" })]));
  });

  it("keeps resolving a double-quoted FROM target as a table when a comment sits between FROM and it (mysql)", () => {
    const sql = 'SELECT * FROM /* c */ "orders" WHERE ';
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "orders" })]));
  });

  it("resolves a double-quoted, dotted schema-qualified table reference (mysql)", () => {
    const sql = 'SELECT * FROM "db"."orders" WHERE ';
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ schema: "db", name: "orders" })]));
  });

  it("resolves both an unquoted and a double-quoted table across a JOIN, alongside a plain alias (mysql)", () => {
    const sql = 'SELECT * FROM a JOIN "orders" o ON a.id = o.id WHERE ';
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "a" }), expect.objectContaining({ name: "orders", alias: "o" })]));
  });

  it("resolves a double-quoted UPDATE target as a referenced table while still masking a double-quoted value in SET (mysql)", () => {
    const sql = 'UPDATE "orders" SET status = "x" WHERE ';
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "orders" })]));
    expect(context.referencedTables.some((t) => t.name === "x")).toBe(false);
  });

  it("does not desync the token stream on a backslash-escaped quote inside a double-quoted value (mysql)", () => {
    const sql = 'SELECT * FROM real_table WHERE note = "she said \\"hi\\"" ';
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "real_table" })]));
    expect(context.preferredKeywords).toEqual(expect.arrayContaining(["AND", "OR"]));
  });

  it("does not desync the token stream on a backslash-escaped quote inside a double-quoted value (hive)", () => {
    // Hive isn't in MYSQL_DASH_COMMENT_DIALECTS, so "..." here is (and was, before this fix) always
    // a quoted_identifier, masked only via the operator-adjacency fallback -- this test isn't about
    // that masking decision, it's about whether reading the "..." span itself (now always routed
    // through readQuotedString, see tokens.ts) still finds the true closing quote for a
    // mysqlBackslashEscape dialect outside MYSQL_DASH_COMMENT_DIALECTS. Before this fix, hive read
    // "..." with the doubled-quote-only reader regardless of mysqlBackslashEscape, so this span
    // would desync at the first backslash-escaped quote and corrupt everything parsed after it.
    const sql = 'SELECT * FROM real_table WHERE note = "she said \\"hi\\"" ';
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "hive" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "real_table" })]));
    expect(context.preferredKeywords).toEqual(expect.arrayContaining(["AND", "OR"]));
  });

  it("masks a double-quoted string used as a function argument from being read as a table reference (mysql)", () => {
    const sql = 'SELECT CONCAT("from ghost_table", name) FROM real_table WHERE ';
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "real_table" })]));
    expect(context.referencedTables.some((t) => t.name === "ghost_table")).toBe(false);
  });

  it("masks a double-quoted CASE branch value from being read as a table reference (mysql)", () => {
    const sql = 'SELECT CASE WHEN enabled THEN "from ghost_case" ELSE "ok" END FROM real_table WHERE ';
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "real_table" })]));
    expect(context.referencedTables.some((t) => t.name === "ghost_case")).toBe(false);
  });

  it("masks a double-quoted string nested inside a parenthesized expression from being read as a table reference (mysql)", () => {
    const sql = 'SELECT * FROM real_table WHERE (status = "open" AND note = CONCAT("from ghost_nested", 1)) AND ';
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "real_table" })]));
    expect(context.referencedTables.some((t) => t.name === "ghost_nested")).toBe(false);
  });

  it("masks a double-quoted value right after an operator from being read as a table reference (postgres)", () => {
    const sql = 'SELECT * FROM real_table WHERE note = "from 测试表" AND ';
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "postgres" });
    // Postgres treats "..." as a quoted identifier, not a string literal -- but a "..." span
    // right after "=" is unambiguously a value position regardless of dialect, so this is masked
    // the same way as mysql above, not left as a (harmless but avoidable) false-positive parse.
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "real_table" })]));
    expect(context.referencedTables.some((t) => t.name === "测试表")).toBe(false);
  });

  it("keeps a double-quoted table name intact for dialects where they aren't string literals (postgres)", () => {
    const sql = 'SELECT * FROM "orders" WHERE ';
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "postgres" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "orders", nameQuoted: true })]));
  });

  it("does not let a MySQL backslash-escaped quote desync the literal scan", () => {
    const sql = "SELECT * FROM t1 WHERE note = 'it\\'s a test' UNION SELECT * FROM real_table2 WHERE ";
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "t1" }), expect.objectContaining({ name: "real_table2" })]));
  });

  it("does not treat MySQL's unspaced '--' double-negation as a comment", () => {
    const sql = "SELECT * FROM t1 WHERE x = 1--1 FROM real_table3 WHERE ";
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "t1" }), expect.objectContaining({ name: "real_table3" })]));
  });

  it("still treats a bare '--' as a comment for non-MySQL dialects", () => {
    const sql = "SELECT * FROM t1 WHERE x = 1--1 FROM real_table3 WHERE ";
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "postgres" });
    expect(context.referencedTables.some((t) => t.name === "real_table3")).toBe(false);
  });

  it("does not let a doubled single-quote escape desync the literal scan", () => {
    const sql = "SELECT * FROM t1 WHERE note = 'it''s a test' AND ";
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "t1" })]));
  });

  it("does not let a backslash-escaped quote desync the literal scan for MySQL-family dialects outside the dash-comment allowlist (hive)", () => {
    const sql = "SELECT * FROM t1 WHERE note = 'it\\'s a test' UNION SELECT * FROM real_table2 WHERE ";
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "hive" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "t1" }), expect.objectContaining({ name: "real_table2" })]));
  });

  it("defaults to ASCII-only unquoted identifiers when databaseType is not yet known", () => {
    const sql = "SELECT * FROM 用户表 WHERE ";
    const context = getSqlCompletionContext(sql, sql.length, {});
    expect(context.referencedTables.some((t) => t.name === "用户表")).toBe(false);
  });

  it("does not let a special character inside a double-quoted qualified table name desync the scan (postgres)", () => {
    const sql = 'SELECT * FROM "mydb"."orders" WHERE ';
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "postgres" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ schema: "mydb", name: "orders" })]));
  });

  it("does not let a special character inside a backtick-quoted qualified table name desync the scan (mysql)", () => {
    const sql = "SELECT * FROM `mydb`.`orders` WHERE ";
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.referencedTables).toEqual(expect.arrayContaining([expect.objectContaining({ schema: "mydb", name: "orders" })]));
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

  it("does not let a trailing comment's stray 'and'/'or' text suppress the AND/OR keyword suggestion", () => {
    const sql = "SELECT * FROM t WHERE id = 1 # mentions where and or\n";
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.preferredKeywords).toEqual(expect.arrayContaining(["AND", "OR"]));
  });

  it("does not let a special character inside a backtick-quoted table name break WHERE-clause keyword detection", () => {
    const sql = "SELECT * FROM `my's table` t WHERE t.id = 1 ";
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "mysql" });
    expect(context.preferredKeywords).toEqual(expect.arrayContaining(["AND", "OR"]));
  });

  it("does not let a trailing comment's stray 'where' text auto-open column completion with no active clause", () => {
    const sql = "SELECT * FROM t_0001 t0 -- mentions where\n";
    const cursor = sql.length;
    expect(shouldAutoOpenSqlCompletion(sql, cursor, { databaseType: "mysql" })).toBe(false);
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

  it("preserves SQL Server database and omitted schema in legacy table references", () => {
    const sql = "SELECT * FROM BarDB..orders AS o WHERE o.";
    const context = getSqlCompletionContext(sql, sql.length, { databaseType: "sqlserver" });

    expect(context.referencedTables).toEqual([expect.objectContaining({ database: "BarDB", schema: "dbo", name: "orders", alias: "o" })]);
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

  it("scopes CTE bodies out of the outer query's referenced tables", () => {
    const sql = "WITH cte AS (SELECT id, name FROM orders) SELECT id, na FROM cte";
    const cursor = sql.indexOf(" FROM cte");
    const context = getSqlCompletionContext(sql, cursor);

    expect(context.referencedTables.map((table) => table.name)).toEqual(["cte"]);
  });

  it("suggests bare CTE column names instead of forcing a cte. qualifier (issue #7396)", () => {
    const sql = "WITH cte AS (SELECT id, name FROM orders) SELECT id, na FROM cte";
    const cursor = sql.indexOf(" FROM cte");
    const items = buildSqlCompletionItems(sql, cursor, {
      tables: [],
      columnsByTable: new Map([
        [
          "orders",
          [
            { name: "id", table: "orders", dataType: "int" },
            { name: "name", table: "orders", dataType: "text" },
          ],
        ],
        [
          "cte",
          [
            { name: "id", table: "cte" },
            { name: "name", table: "cte" },
          ],
        ],
      ]),
    });

    expect(items).toEqual(expect.arrayContaining([expect.objectContaining({ label: "name", type: "column" })]));
    expect(items.filter((item) => item.type === "column").map((item) => item.label)).not.toContain("orders.name");
  });

  it("keeps the CTE body's own tables while completing inside that body", () => {
    const sql = "WITH cte AS (SELECT id, na FROM orders) SELECT * FROM cte";
    const cursor = sql.indexOf(" FROM orders");
    const context = getSqlCompletionContext(sql, cursor);

    expect(context.referencedTables.map((table) => table.name)).toEqual(expect.arrayContaining(["orders", "cte"]));
  });

  it("keeps the underlying table when a CTE body projects an unresolved star", () => {
    const sql = "WITH cte AS (SELECT * FROM orders) SELECT na FROM cte";
    const cursor = sql.indexOf(" FROM cte");
    const context = getSqlCompletionContext(sql, cursor);

    expect(context.referencedTables.map((table) => table.name)).toEqual(expect.arrayContaining(["orders", "cte"]));
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
  it("shows a table metadata detail in the completion item", () => {
    const sql = "SELECT * FROM orders";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [{ name: "orders", type: "table", detail: "→ Customer orders" }],
      columnsByTable: new Map(),
    }).filter((item) => item.type === "table");

    expect(items).toEqual([expect.objectContaining({ label: "orders", detail: "→ Customer orders" })]);
  });

  it("hides the redundant table type while preserving view and schema details", () => {
    const simpleItems = buildSqlCompletionItems("SELECT * FROM orders", "SELECT * FROM orders".length, {
      tables: [{ name: "orders", schema: "public", type: "table" }],
      columnsByTable: new Map(),
    }).filter((item) => item.type === "table");

    expect(simpleItems.find((item) => item.label === "orders")?.detail).toBeUndefined();

    const viewItems = buildSqlCompletionItems("SELECT * FROM order_view", "SELECT * FROM order_view".length, {
      tables: [{ name: "order_view", schema: "public", type: "view" }],
      columnsByTable: new Map(),
    }).filter((item) => item.type === "table");

    expect(viewItems.find((item) => item.label === "order_view")?.detail).toBe("view");

    const duplicateItems = buildSqlCompletionItems("SELECT * FROM orders", "SELECT * FROM orders".length, {
      tables: [
        { name: "orders", schema: "archive", type: "table" },
        { name: "orders", schema: "sales", type: "table" },
      ],
      columnsByTable: new Map(),
    }).filter((item) => item.type === "table");

    expect(duplicateItems.map((item) => item.detail).sort()).toEqual(["archive.orders", "sales.orders"]);

    const annotatedDuplicateItems = buildSqlCompletionItems("SELECT * FROM orders", "SELECT * FROM orders".length, {
      tables: [
        { name: "orders", schema: "archive", type: "table", detail: "→ Archived orders" },
        { name: "orders", schema: "sales", type: "table", detail: "→ Current orders" },
      ],
      columnsByTable: new Map(),
    }).filter((item) => item.type === "table");

    expect(annotatedDuplicateItems.map((item) => item.detail).sort()).toEqual(["archive.orders  → Archived orders", "sales.orders  → Current orders"]);
  });

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

  it("qualifies same-name PostgreSQL tables from different schemas", () => {
    const sql = "SELECT * FROM shared";
    const items = buildSqlCompletionItems(sql, sql.length, {
      databaseType: "postgres",
      dialect: "postgres",
      tables: [
        { name: "shared", schema: "public", type: "table" },
        { name: "shared", schema: "reporting", type: "table" },
      ],
      columnsByTable: new Map(),
    }).filter((item) => item.type === "table");

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.apply).sort()).toEqual(["public.shared", "reporting.shared"]);
  });

  it("qualifies same-name tables for generic metadata providers", () => {
    const sql = "SELECT * FROM orders";
    const items = buildSqlCompletionItems(sql, sql.length, {
      tables: [
        { name: "orders", schema: "archive", type: "table" },
        { name: "orders", schema: "sales", type: "table" },
      ],
      columnsByTable: new Map(),
    }).filter((item) => item.type === "table");

    expect(items.map((item) => item.apply).sort()).toEqual(["archive.orders", "sales.orders"]);
  });

  it("preserves Oracle current-schema and SQL Server unique-table insertion", () => {
    const oracleItems = buildSqlCompletionItems("SELECT * FROM ORDERS", "SELECT * FROM ORDERS".length, {
      databaseType: "oracle",
      tables: [
        { name: "ORDERS", schema: "APP", type: "table" },
        { name: "ORDERS", schema: "REPORTING", type: "table" },
      ],
      columnsByTable: new Map(),
      currentSchema: "APP",
    }).filter((item) => item.type === "table");
    const sqlServerItems = buildSqlCompletionItems("SELECT * FROM Orders", "SELECT * FROM Orders".length, {
      databaseType: "sqlserver",
      dialect: "sqlserver",
      tables: [{ name: "Orders", schema: "dbo", type: "table" }],
      columnsByTable: new Map(),
    }).filter((item) => item.type === "table");

    expect(oracleItems.map((item) => item.apply).sort()).toEqual(["ORDERS", "REPORTING.ORDERS"]);
    expect(sqlServerItems).toEqual([expect.objectContaining({ label: "Orders", apply: "Orders" })]);
  });
});

describe("shouldAllowSqlCompletionTrigger", () => {
  const typingFacts = (overrides: Partial<SqlCompletionTriggerFacts> = {}): SqlCompletionTriggerFacts => ({
    origin: "typing",
    hasIdentifierPrefix: false,
    qualifierTriggered: false,
    useDatabasePrefix: null,
    ...overrides,
  });

  const explicitFacts = (overrides: Partial<SqlCompletionTriggerFacts> = {}): SqlCompletionTriggerFacts => ({
    origin: "explicit",
    hasIdentifierPrefix: false,
    qualifierTriggered: false,
    useDatabasePrefix: null,
    ...overrides,
  });

  describe("explicit", () => {
    it("allows explicit completion in any mode", () => {
      expect(shouldAllowSqlCompletionTrigger("manual", explicitFacts())).toBe(true);
      expect(shouldAllowSqlCompletionTrigger("require-prefix", explicitFacts())).toBe(true);
      expect(shouldAllowSqlCompletionTrigger("positional", explicitFacts())).toBe(true);
    });
  });

  describe("manual", () => {
    it("rejects all typing completions", () => {
      expect(shouldAllowSqlCompletionTrigger("manual", typingFacts())).toBe(false);
      expect(shouldAllowSqlCompletionTrigger("manual", typingFacts({ hasIdentifierPrefix: true }))).toBe(false);
      expect(shouldAllowSqlCompletionTrigger("manual", typingFacts({ qualifierTriggered: true }))).toBe(false);
      expect(shouldAllowSqlCompletionTrigger("manual", typingFacts({ useDatabasePrefix: "m" }))).toBe(false);
      expect(shouldAllowSqlCompletionTrigger("manual", typingFacts({ positionalEligible: true }))).toBe(false);
    });
  });

  describe("require-prefix", () => {
    it("allows when identifier prefix is non-empty", () => {
      expect(shouldAllowSqlCompletionTrigger("require-prefix", typingFacts({ hasIdentifierPrefix: true }))).toBe(true);
    });

    it("allows when qualifier is triggered (dot with qualifier)", () => {
      expect(shouldAllowSqlCompletionTrigger("require-prefix", typingFacts({ qualifierTriggered: true }))).toBe(true);
    });

    it("allows when useDatabasePrefix is non-empty", () => {
      expect(shouldAllowSqlCompletionTrigger("require-prefix", typingFacts({ useDatabasePrefix: "m" }))).toBe(true);
      expect(shouldAllowSqlCompletionTrigger("require-prefix", typingFacts({ useDatabasePrefix: "Bar" }))).toBe(true);
    });

    it("rejects empty prefix, no qualifier, no useDatabasePrefix", () => {
      expect(shouldAllowSqlCompletionTrigger("require-prefix", typingFacts())).toBe(false);
    });

    it("rejects empty useDatabasePrefix (USE<space> without prefix)", () => {
      expect(shouldAllowSqlCompletionTrigger("require-prefix", typingFacts({ useDatabasePrefix: "" }))).toBe(false);
    });

    it("does not use positionalEligible", () => {
      // Even if positionalEligible is true, require-prefix ignores it.
      expect(shouldAllowSqlCompletionTrigger("require-prefix", typingFacts({ positionalEligible: true }))).toBe(false);
    });
  });

  describe("positional", () => {
    it("allows when positionalEligible is true", () => {
      expect(shouldAllowSqlCompletionTrigger("positional", typingFacts({ positionalEligible: true }))).toBe(true);
    });

    it("allows when useDatabasePrefix is set (even empty)", () => {
      expect(shouldAllowSqlCompletionTrigger("positional", typingFacts({ useDatabasePrefix: "" }))).toBe(true);
      expect(shouldAllowSqlCompletionTrigger("positional", typingFacts({ useDatabasePrefix: "m" }))).toBe(true);
    });

    it("rejects when positionalEligible is false and no useDatabasePrefix", () => {
      expect(shouldAllowSqlCompletionTrigger("positional", typingFacts({ positionalEligible: false }))).toBe(false);
    });

    it("rejects when positionalEligible is undefined and no useDatabasePrefix", () => {
      expect(shouldAllowSqlCompletionTrigger("positional", typingFacts())).toBe(false);
    });
  });
});

describe("originForTypedSqlCompletionStart", () => {
  it("starts a new automatic session as typing", () => {
    expect(originForTypedSqlCompletionStart(null)).toBe("typing");
  });

  it("preserves the origin of an active completion session", () => {
    expect(originForTypedSqlCompletionStart("typing")).toBe("typing");
    expect(originForTypedSqlCompletionStart("explicit")).toBe("explicit");
  });
});

describe("originForSqlCompletionProvider", () => {
  it("classifies an unmarked provider call from CodeMirror", () => {
    expect(originForSqlCompletionProvider(null, false)).toBe("typing");
    expect(originForSqlCompletionProvider(null, true)).toBe("explicit");
  });

  it("preserves the active session independently of the current provider flag", () => {
    expect(originForSqlCompletionProvider("typing", true)).toBe("typing");
    expect(originForSqlCompletionProvider("explicit", false)).toBe("explicit");
  });
});

import { describe, expect, it } from "vitest";
import { buildPostgresSequenceLiteralCompletionItems, buildSelectStarExpansion, buildSqlCompletionItems, getPostgresSequenceLiteralCompletionContext, getSqlCompletionContext, selectStarResultColumnsMatch, shouldAutoOpenSqlCompletion } from "@/lib/sql/sqlCompletion";
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

import { describe, expect, it } from "vitest";
import { batchColumnSelectionColumnList } from "@/lib/editor/batchColumnSelection";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import { sqlCompletionContextFromSemantic } from "@/lib/sql/semantic/completion";
import { buildSelectStarExpansion, buildSqlCompletionItems, buildSqlCompletionItemsFromContext, getSqlCompletionContext, quoteSqlIdentifier } from "@/lib/sql/sqlCompletion";

describe("quoteSqlIdentifier oracle folding polarity", () => {
  it.each([
    ["ID", "ID"],
    ["V$SESSION", "V$SESSION"],
    ["ACCOUNT$SYS", "ACCOUNT$SYS"],
    ["Id", '"Id"'],
    ["id", '"id"'],
    ["SELECT", '"SELECT"'],
    ["_SYS", '"_SYS"'],
    ['we"ird', '"we""ird"'],
  ] as const)("quotes %s as %s for the oracle apply dialect", (identifier, expected) => {
    expect(quoteSqlIdentifier(identifier, "oracle")).toBe(expected);
  });

  it.each([
    ["upper", "Id", '"Id"'],
    ["mysql", "Id", "Id"],
    ["postgres", "Id", '"Id"'],
    ["postgres", "order", '"order"'],
    ["postgres", "article", "article"],
  ] as const)("keeps neighbour dialects unchanged: %s %s -> %s", (dialect, identifier, expected) => {
    expect(quoteSqlIdentifier(identifier, dialect)).toBe(expected);
  });
});

describe("oracle completion apply identifiers", () => {
  // Reproduction for #9526: the reported table stores mixed-case names quoted,
  // so bare inserts fold to the wrong (uppercase) name and fail with ORA-00904.
  const oracleInput = {
    databaseType: "oracle" as const,
    tables: [{ name: "BomTemplate", schema: "ZTZS_ERP2", type: "table" as const }],
    columnsByTable: new Map([
      [
        "BomTemplate",
        [
          { name: "Id", table: "BomTemplate" },
          { name: "NO", table: "BomTemplate" },
        ],
      ],
    ]),
    schemas: ["ZTZS_ERP2"],
  };

  it("quotes a mixed-case column suggestion after WHERE", () => {
    const sql = "SELECT * FROM BomTemplate WHERE Id";
    const items = buildSqlCompletionItems(sql, sql.length, oracleInput);
    const column = items.find((item) => item.label === "Id");
    expect(column?.apply).toBe('"Id"');
  });

  it("keeps an all-uppercase column suggestion bare", () => {
    const sql = "SELECT * FROM BomTemplate WHERE N";
    const items = buildSqlCompletionItems(sql, sql.length, oracleInput);
    const column = items.find((item) => item.label === "NO");
    expect(column?.apply).toBe("NO");
  });

  it("quotes a mixed-case routine suggestion", () => {
    const sql = "CALL GetBo";
    const items = buildSqlCompletionItems(sql, sql.length, {
      databaseType: "oracle" as const,
      tables: [],
      columnsByTable: new Map(),
      objects: [{ name: "GetBom", type: "procedure" }],
    });
    const routine = items.find((item) => item.label === "GetBom");
    expect(routine?.apply).toBe('"GetBom"()');
  });
});

describe("oracle completion with identifier quoting disabled (#9735)", () => {
  const sql = "SELECT t.c FROM abc t";
  const cursor = "SELECT t.c".length;
  const input = {
    databaseType: "oracle" as const,
    tables: [{ name: "abc", type: "table" as const }],
    columnsByTable: new Map([["abc", [{ name: "col1", table: "abc" }]]]),
  };
  const applyOf = (extra: { quoteIdentifiers?: boolean }) => buildSqlCompletionItems(sql, cursor, { ...input, ...extra }).find((item) => item.label === "col1")?.apply;

  it("keeps lowercase columns bare when quoting is disabled", () => {
    expect(applyOf({ quoteIdentifiers: false })).toBe("col1");
  });

  it("still quotes lowercase columns by default and when quoting is enabled", () => {
    expect(applyOf({})).toBe('"col1"');
    expect(applyOf({ quoteIdentifiers: true })).toBe('"col1"');
  });
});

// #11330 / #15190: batch-selected columns repeat the qualifier the user already
// typed. Re-quoting it turned `FROM orders ap` into `"ap".COL`, which Oracle
// resolves as a different identifier, so everything after the first column broke.
describe("oracle batch-selected column qualifier", () => {
  const input = {
    databaseType: "oracle" as const,
    tables: [{ name: "orders", type: "table" as const }],
    columnsByTable: new Map([
      [
        "orders",
        [
          { name: "ID", table: "orders" },
          { name: "STATUS", table: "orders" },
        ],
      ],
    ]),
    schemas: ["hr"],
  };
  const batchColumns = (sql: string, cursor: number) => buildSqlCompletionItems(sql, cursor, input).filter((item) => item.type === "column");

  it("reuses a bare lowercase alias exactly as written", () => {
    const columns = batchColumns("SELECT ap. FROM orders ap", "SELECT ap.".length);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.every((item) => item.batchSelectionMode === "select")).toBe(true);
    expect(columns.every((item) => item.batchSelectionQualifier === "ap")).toBe(true);
    // The issue symptom: only columns after the first one get the qualifier.
    expect(batchColumnSelectionColumnList(["ID", "STATUS"], "select", columns[0]!.batchSelectionQualifier)).toBe("ID, ap.STATUS");
  });

  it("reuses an all-uppercase bare alias bare", () => {
    const columns = batchColumns("SELECT AP. FROM orders AP", "SELECT AP.".length);
    expect(columns.every((item) => item.batchSelectionQualifier === "AP")).toBe(true);
  });

  it("keeps the quotes of a qualifier that was quoted in the document", () => {
    const columns = batchColumns('SELECT "orders". FROM "orders"', 'SELECT "orders".'.length);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.every((item) => item.batchSelectionQualifier === '"orders"')).toBe(true);
  });

  it("reuses a multi-part qualifier part by part", () => {
    const columns = batchColumns("SELECT hr.orders. FROM hr.orders", "SELECT hr.orders.".length);
    expect(columns.every((item) => item.batchSelectionQualifier === "hr.orders")).toBe(true);
  });

  it("never sets a qualifier for insert column lists", () => {
    const columns = batchColumns("INSERT INTO orders (", "INSERT INTO orders (".length);
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.every((item) => item.batchSelectionMode === "insert")).toBe(true);
    expect(columns.every((item) => item.batchSelectionQualifier === undefined)).toBe(true);
  });

  // Same defect on the non-batch path: with two joined sources and no typed
  // qualifier, every column was emitted as `"ap".COL`.
  it("qualifies columns with the alias as written when two tables are joined", () => {
    const sql = "SELECT * FROM orders ap JOIN users u ON ap.ID = u.EMAIL WHERE ";
    const items = buildSqlCompletionItems(sql, sql.length, {
      databaseType: "oracle" as const,
      tables: [
        { name: "orders", type: "table" as const },
        { name: "users", type: "table" as const },
      ],
      columnsByTable: new Map([
        ["orders", [{ name: "ID", table: "orders" }]],
        ["users", [{ name: "EMAIL", table: "users" }]],
      ]),
    });

    const applies = items.filter((item) => item.type === "column").map((item) => item.apply);
    expect(applies).toEqual(expect.arrayContaining(["ap.ID", "u.EMAIL"]));
    expect(applies.some((apply) => apply?.includes('"'))).toBe(false);
  });
});

describe("oracle unquoted alias and table qualifier completion (#15725)", () => {
  const joinedColumns = new Map([
    [
      "table_a",
      [
        { name: "ID", table: "table_a", dataType: "NUMBER" },
        { name: "COLUMN1", table: "table_a", dataType: "VARCHAR2" },
      ],
    ],
    [
      "table_b",
      [
        { name: "ID", table: "table_b", dataType: "NUMBER" },
        { name: "TABLE_A_ID", table: "table_b", dataType: "NUMBER" },
        { name: "COLUMN2", table: "table_b", dataType: "VARCHAR2" },
      ],
    ],
  ]);

  const joinedTables = [
    { name: "TABLE_A", type: "table" as const },
    { name: "TABLE_B", type: "table" as const },
  ];

  it("does not add double quotes to lowercase aliases in SELECT column, star, and alias.* completions", () => {
    const sql = "select    from table_a ta\nleft join table_b tb on 1=1";
    const cursor = "select   ".length;
    const items = buildSqlCompletionItems(sql, cursor, {
      databaseType: "oracle",
      tables: joinedTables,
      columnsByTable: joinedColumns,
    });

    const columnApplies = items.filter((item) => item.type === "column").map((item) => item.apply);
    expect(columnApplies).toEqual(expect.arrayContaining(["ta.COLUMN1", "tb.COLUMN2"]));
    expect(columnApplies.some((apply) => apply?.includes('"'))).toBe(false);

    const taAll = items.find((item) => item.label === "ta.*");
    expect(taAll?.apply).toBe("ta.ID, ta.COLUMN1");

    const starSql = "select * from table_a ta\nleft join table_b tb on 1=1";
    const starContext = getSqlCompletionContext(starSql, "select *".length, { databaseType: "oracle" });
    // Even if aliasSql is absent, unquoted alias `ta` must stay bare.
    const contextWithoutAliasSql = {
      ...starContext,
      referencedTables: starContext.referencedTables.map((ref) => ({ ...ref, aliasSql: undefined })),
    };
    expect(buildSelectStarExpansion(contextWithoutAliasSql, joinedColumns, "oracle", undefined, "oracle")).toBe("ta.ID, ta.COLUMN1, tb.ID, tb.TABLE_A_ID, tb.COLUMN2");
  });

  it("does not add double quotes to bare lowercase table names without aliases across columns, star expansion, and JOIN ON", () => {
    const selectSql = "select    from table_a\nleft join table_b on 1=1";
    const selectItems = buildSqlCompletionItems(selectSql, "select   ".length, {
      databaseType: "oracle",
      tables: joinedTables,
      columnsByTable: joinedColumns,
    });

    const columnApplies = selectItems.filter((item) => item.type === "column").map((item) => item.apply);
    expect(columnApplies).toEqual(expect.arrayContaining(["table_a.COLUMN1", "table_b.COLUMN2"]));
    expect(columnApplies.some((apply) => apply?.includes('"'))).toBe(false);

    const tableAll = selectItems.find((item) => item.label === "table_a.*");
    expect(tableAll?.apply).toBe("table_a.ID, table_a.COLUMN1");

    const starSql = "select * from table_a\nleft join table_b on 1=1";
    const starContext = getSqlCompletionContext(starSql, "select *".length, { databaseType: "oracle" });
    expect(buildSelectStarExpansion(starContext, joinedColumns, "oracle", undefined, "oracle")).toBe("table_a.ID, table_a.COLUMN1, table_b.ID, table_b.TABLE_A_ID, table_b.COLUMN2");

    const joinSql = "select * from table_a\nleft join table_b on ";
    const joinItems = buildSqlCompletionItems(joinSql, joinSql.length, {
      databaseType: "oracle",
      tables: joinedTables,
      columnsByTable: joinedColumns,
      foreignKeysByTable: new Map([["table_b", [{ name: "FK_TABLE_B_TABLE_A", column: "TABLE_A_ID", ref_table: "TABLE_A", ref_column: "ID" }]]]),
    });
    const fkCondition = joinItems.find((item) => item.detail?.includes("foreign key"));
    expect(fkCondition?.apply).toBe("table_b.TABLE_A_ID = table_a.ID");
    const heuristicCondition = joinItems.find((item) => item.type === "snippet" && item.apply === "table_a.ID = table_b.TABLE_A_ID");
    expect(heuristicCondition).toBeDefined();
  });

  it("preserves double quotes when the alias or table name was explicitly quoted in the query", () => {
    const quotedTableSql = 'select    from "table_a"\nleft join table_b on 1=1';
    const quotedTableItems = buildSqlCompletionItems(quotedTableSql, "select   ".length, {
      databaseType: "oracle",
      tables: joinedTables,
      columnsByTable: joinedColumns,
    });

    const columnApplies = quotedTableItems.filter((item) => item.type === "column").map((item) => item.apply);
    expect(columnApplies).toEqual(expect.arrayContaining(['"table_a".COLUMN1', "table_b.COLUMN2"]));

    const quotedAliasWhereSql = 'select * from table_a "ta"\nleft join table_b tb on 1=1 where ';
    const semanticContext = sqlCompletionContextFromSemantic(buildSqlSemanticModel(quotedAliasWhereSql, quotedAliasWhereSql.length, { databaseType: "oracle" }), getSqlCompletionContext(quotedAliasWhereSql, quotedAliasWhereSql.length, { databaseType: "oracle" }));
    const quotedAliasWhereItems = buildSqlCompletionItemsFromContext(semanticContext, {
      databaseType: "oracle",
      tables: joinedTables,
      columnsByTable: joinedColumns,
    });
    const quotedAliasWhereApplies = quotedAliasWhereItems.filter((item) => item.type === "column").map((item) => item.apply);
    expect(quotedAliasWhereApplies).toEqual(expect.arrayContaining(['"ta".COLUMN1', "tb.COLUMN2"]));

    const quotedAliasSubquerySql = 'select    from table_a "ta"\nleft join (select id, column2 from table_b) tb on 1=1';
    const quotedAliasSelectItems = buildSqlCompletionItems(quotedAliasSubquerySql, "select   ".length, {
      databaseType: "oracle",
      tables: joinedTables,
      columnsByTable: joinedColumns,
    });
    const quotedAliasSelectApplies = quotedAliasSelectItems.filter((item) => item.type === "column").map((item) => item.apply);
    expect(quotedAliasSelectApplies).toEqual(expect.arrayContaining(['"ta".COLUMN1', "tb.COLUMN2"]));
    const quotedAliasAll = quotedAliasSelectItems.find((item) => item.label === "ta.*");
    expect(quotedAliasAll?.apply).toBe('"ta".ID, "ta".COLUMN1');

    const quotedAliasStarSql = 'select * from table_a "ta"\nleft join (select id, column2 from table_b) tb on 1=1';
    const quotedAliasStarContext = getSqlCompletionContext(quotedAliasStarSql, "select *".length, { databaseType: "oracle" });
    expect(buildSelectStarExpansion(quotedAliasStarContext, joinedColumns, "oracle", undefined, "oracle")).toBe('"ta".ID, "ta".COLUMN1, tb.ID, tb.COLUMN2');
  });
});

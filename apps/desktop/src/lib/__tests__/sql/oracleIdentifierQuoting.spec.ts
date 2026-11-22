import { describe, expect, it } from "vitest";
import { batchColumnSelectionColumnList } from "@/lib/editor/batchColumnSelection";
import { buildSqlCompletionItems, quoteSqlIdentifier } from "@/lib/sql/sqlCompletion";

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

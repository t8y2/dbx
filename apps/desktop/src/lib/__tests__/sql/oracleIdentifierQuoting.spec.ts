import { describe, expect, it } from "vitest";
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

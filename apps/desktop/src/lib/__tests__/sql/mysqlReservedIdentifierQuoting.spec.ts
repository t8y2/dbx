import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems, prepareSqlCompletionReplacement } from "@/lib/sql/sqlCompletion";
import { quoteTableIdentifierIfNeeded } from "@/lib/table/tableSelectSql";

// MySQL reserved words used as column names must arrive backticked — from
// completion applies and from generated data-tab SQL alike. These specs pin
// the reserved-word list in sqlIdentifier.ts against the reported scenario
// (a `call` column on MySQL completing bare and failing to parse).
const mysqlInput = {
  databaseType: "mysql" as const,
  tables: [{ name: "dxcc_exceptions", type: "table" as const }],
  columnsByTable: new Map([
    [
      "dxcc_exceptions",
      [
        { name: "call", table: "dxcc_exceptions" },
        { name: "status", table: "dxcc_exceptions" },
      ],
    ],
  ]),
};

describe("mysql reserved-word column completion quoting", () => {
  it("backticks a `call` column suggested after WHERE", () => {
    const sql = "SELECT * FROM dxcc_exceptions WHERE call";
    const items = buildSqlCompletionItems(sql, sql.length, mysqlInput);
    const column = items.find((item) => item.type === "column" && item.label === "call");
    expect(column?.apply).toBe("`call`");
  });

  it.each(["set", "update", "condition", "read", "system", "lead"] as const)("backticks the reserved word %s used as a column", (word) => {
    const sql = `SELECT * FROM dxcc_exceptions WHERE ${word}`;
    const items = buildSqlCompletionItems(sql, sql.length, {
      ...mysqlInput,
      columnsByTable: new Map([["dxcc_exceptions", [{ name: word, table: "dxcc_exceptions" }]]]),
    });
    expect(items.find((item) => item.type === "column" && item.label === word)?.apply).toBe(`\`${word}\``);
  });

  it("keeps a non-reserved column suggestion bare", () => {
    const sql = "SELECT * FROM dxcc_exceptions WHERE status";
    const items = buildSqlCompletionItems(sql, sql.length, mysqlInput);
    expect(items.find((item) => item.type === "column" && item.label === "status")?.apply).toBe("status");
  });

  it("backticks the column of an alias-qualified suggestion without touching the typed qualifier", () => {
    const sql = "SELECT * FROM dxcc_exceptions d WHERE d.call";
    const items = buildSqlCompletionItems(sql, sql.length, mysqlInput);
    expect(items.find((item) => item.type === "column" && item.label === "call")?.apply).toBe("`call`");
  });

  it("keeps `call` bare on postgres, where CALL is not reserved", () => {
    const sql = "SELECT * FROM dxcc_exceptions WHERE call";
    const items = buildSqlCompletionItems(sql, sql.length, { ...mysqlInput, databaseType: "postgres" as const });
    expect(items.find((item) => item.type === "column" && item.label === "call")?.apply).toBe("call");
  });

  it("backticks the mysql-only reserved words trigger and while", () => {
    const columns = [
      { name: "trigger", table: "dxcc_exceptions" },
      { name: "while", table: "dxcc_exceptions" },
    ];
    const input = { ...mysqlInput, columnsByTable: new Map([["dxcc_exceptions", columns]]) };
    for (const name of ["trigger", "while"]) {
      const sql = `SELECT * FROM dxcc_exceptions WHERE ${name}`;
      const items = buildSqlCompletionItems(sql, sql.length, input);
      expect(items.find((item) => item.type === "column" && item.label === name)?.apply, name).toBe(`\`${name}\``);
    }
  });
});

describe("mysql reserved-word quoting beyond completion", () => {
  it("backticks reserved columns in generated data-tab SQL and keeps plain ones bare", () => {
    expect(quoteTableIdentifierIfNeeded("mysql", "call")).toBe("`call`");
    expect(quoteTableIdentifierIfNeeded("mysql", "status")).toBe("status");
  });

  it("does not double-wrap a backticked apply when the user already typed the opening backtick", () => {
    const sql = "SELECT * FROM dxcc_exceptions WHERE `ca";
    const cursor = sql.length;
    const prepared = prepareSqlCompletionReplacement(sql, cursor, { prefix: "ca", qualifier: undefined, replacementRange: { start: sql.indexOf("`"), end: cursor }, selectListWildcardAfterCursor: undefined }, [{ label: "call", type: "column", apply: "`call`", boost: 1 }]);
    expect(prepared.from).toBe(sql.indexOf("`"));
    expect(prepared.items[0]?.apply).toBe("`call`");
  });
});

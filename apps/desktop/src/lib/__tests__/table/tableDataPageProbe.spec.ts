import { describe, expect, it } from "vitest";
import { mysqlTablePageBaseSql } from "@/lib/table/tableDataPageProbe";

describe("MySQL table data page probe", () => {
  it("preserves filters, sorting and nested limits when removing the generated page", () => {
    const base = "SELECT `limit`, id FROM apis WHERE note = 'LIMIT 55' AND id IN (SELECT id FROM allowed LIMIT 3) ORDER BY id";
    expect(mysqlTablePageBaseSql(`${base} LIMIT 55 OFFSET 110;`, 55, 110)).toBe(base);
    expect(mysqlTablePageBaseSql(`${base} LIMIT 55;`, 55, 0)).toBe(base);
  });

  it("keeps MySQL escaped strings and comments out of the page clause", () => {
    const base = "SELECT id FROM apis WHERE note = 'it\\'s LIMIT 55' /* LIMIT 55 */ ORDER BY id";
    expect(mysqlTablePageBaseSql(`${base} LIMIT 55;`, 55, 0)).toBe(base);
  });

  it.each(["SELECT * FROM apis LIMIT 54;", "SELECT * FROM apis LIMIT 55 OFFSET 55;", "SELECT * FROM apis LIMIT 55 FOR UPDATE;", "SELECT * FROM apis LIMIT 55; SELECT 1;", "SELECT * FROM apis WHERE note = 'LIMIT 55';"])("leaves unmatched bounds or unsupported suffixes unchanged: %s", (sql) => {
    expect(mysqlTablePageBaseSql(sql, 55, 0)).toBeUndefined();
  });
});

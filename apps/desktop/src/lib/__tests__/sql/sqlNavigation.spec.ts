import { describe, expect, it } from "vitest";
import { extractIdentifierAt, extractIdentifierDetailsAt, isSqlKeyword, matchTable, splitQualifiedIdentifier } from "@/lib/sql/sqlNavigation";

describe("extractIdentifierAt", () => {
  it("extracts unquoted qualified identifiers", () => {
    const sql = "select * from MAAC00.Accounts";

    expect(extractIdentifierAt(sql, sql.indexOf("Accounts"))).toBe("MAAC00.Accounts");
  });

  it("extracts backtick-quoted qualified identifiers", () => {
    const sql = "select * from `MAAC00`.Accounts";

    expect(extractIdentifierAt(sql, sql.indexOf("Accounts"))).toBe("MAAC00.Accounts");
    expect(extractIdentifierAt(sql, sql.indexOf("MAAC00"))).toBe("MAAC00.Accounts");
  });

  it("preserves quote metadata for quoted keyword identifiers", () => {
    const sql = "SELECT * FROM `group` LIMIT 100;";

    expect(extractIdentifierDetailsAt(sql, sql.indexOf("group"))).toEqual({
      identifier: "group",
      quoted: true,
    });
    expect(matchTable(extractIdentifierAt(sql, sql.indexOf("group")) ?? "", [{ name: "group" }])).toEqual({ name: "group" });
  });

  it("marks unquoted keyword identifiers as unquoted", () => {
    const sql = "SELECT dept, COUNT(*) FROM users GROUP BY dept;";
    const extracted = extractIdentifierDetailsAt(sql, sql.indexOf("GROUP"));

    expect(extracted).toEqual({
      identifier: "GROUP",
      quoted: false,
    });
    expect(extracted && isSqlKeyword(extracted.identifier)).toBe(true);
  });

  it("extracts double-quoted qualified identifiers", () => {
    const sql = 'select * from "MAAC00"."Accounts"';

    expect(extractIdentifierAt(sql, sql.indexOf("Accounts"))).toBe("MAAC00.Accounts");
  });
});

describe("splitQualifiedIdentifier", () => {
  it("splits quoted and multi-part identifiers", () => {
    expect(splitQualifiedIdentifier('catalog."MAAC00".Accounts')).toEqual(["catalog", "MAAC00", "Accounts"]);
    expect(splitQualifiedIdentifier("`MAAC00`.Accounts")).toEqual(["MAAC00", "Accounts"]);
  });
});

describe("matchTable", () => {
  it("matches schema-qualified table identifiers", () => {
    const table = { schema: "MAAC00", name: "Accounts" };

    expect(matchTable("maac00.accounts", [table])).toBe(table);
  });

  it("matches catalog.schema.table identifiers against schema-scoped tables", () => {
    const table = { schema: "MAAC00", name: "Accounts" };

    expect(matchTable("catalog.maac00.accounts", [table])).toBe(table);
  });

  it("matches quoted schema-qualified table identifiers", () => {
    const table = { schema: "MAAC00", name: "Accounts" };

    expect(matchTable("`MAAC00`.Accounts", [table])).toBe(table);
  });

  it("does not treat non-schema qualifiers as table matches", () => {
    expect(matchTable("u.users", [{ schema: "public", name: "users" }])).toBeNull();
  });
});

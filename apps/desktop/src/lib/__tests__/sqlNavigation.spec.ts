import { describe, expect, it } from "vitest";
import { extractIdentifierAt, matchTable, splitQualifiedIdentifier } from "@/lib/sqlNavigation";

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

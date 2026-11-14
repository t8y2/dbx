import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems } from "@/lib/sql/sqlCompletion";

describe("MySQL keyword completion", () => {
  function labelsFor(prefix: string, databaseType: "mysql" | "postgres" = "mysql"): string[] {
    return buildSqlCompletionItems(prefix, prefix.length, {
      databaseType,
      tables: [],
      columnsByTable: new Map(),
    }).map((item) => item.label);
  }

  // Regression for #13008: `SHOW BINARY LOGS` and `SHOW BINLOG EVENTS` had no
  // candidates at all, because neither phrase existed in MYSQL_SQL_KEYWORDS.
  it.each([
    ["logs", "BINARY LOGS"],
    ["binlog", "BINLOG EVENTS"],
    ["events", "BINLOG EVENTS"],
  ])("offers %s as the %s phrase", (prefix, phrase) => {
    expect(labelsFor(prefix)).toContain(phrase);
  });

  it("offers the REGEXP and RLIKE pattern operators", () => {
    expect(labelsFor("regexp")[0]).toBe("REGEXP");
    expect(labelsFor("rlike")).toContain("RLIKE");
  });

  // #14598: IGNORE INDEX and USE INDEX are the other two MySQL index hints.
  it.each([
    ["IGNORE", "IGN"],
    ["USE", "US"],
  ])("prioritizes INDEX after %s and offers the full index hint phrase", (hint, partial) => {
    expect(labelsFor(`SELECT * FROM orders ${hint} `)[0]).toBe("INDEX");
    expect(labelsFor(`SELECT * FROM orders ${hint} I`)[0]).toBe("INDEX");
    expect(labelsFor(`SELECT * FROM orders ${partial}`)[0]).toBe(`${hint} INDEX`);
    expect(labelsFor(`SELECT * FROM orders o JOIN items i ON i.order_id = o.id ${partial}`)).toContain(`${hint} INDEX`);
  });

  it("does not treat INSERT IGNORE or a USE statement as an index hint", () => {
    expect(labelsFor("INSERT IGNORE ")[0]).not.toBe("INDEX");
    expect(labelsFor("USE ")[0]).not.toBe("INDEX");
  });

  it("keeps the index hint phrases out of other dialects", () => {
    expect(labelsFor("SELECT * FROM orders IGN", "postgres")).not.toContain("IGNORE INDEX");
    expect(labelsFor("SELECT * FROM orders US", "postgres")).not.toContain("USE INDEX");
  });

  it("prioritizes INDEX after FORCE and offers the full FORCE INDEX phrase", () => {
    expect(labelsFor("SELECT * FROM orders FORCE ")[0]).toBe("INDEX");
    expect(labelsFor("SELECT * FROM orders FORCE I")[0]).toBe("INDEX");
    expect(labelsFor("SELECT * FROM orders FORC")[0]).toBe("FORCE INDEX");
  });

  it("keeps the MySQL-only phrases out of other dialects", () => {
    expect(labelsFor("binlog", "postgres")).not.toContain("BINLOG EVENTS");
    expect(labelsFor("logs", "postgres")).not.toContain("BINARY LOGS");
    expect(labelsFor("rlike", "postgres")).not.toContain("RLIKE");
  });
});

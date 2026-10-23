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

  it("keeps the MySQL-only phrases out of other dialects", () => {
    expect(labelsFor("binlog", "postgres")).not.toContain("BINLOG EVENTS");
    expect(labelsFor("logs", "postgres")).not.toContain("BINARY LOGS");
    expect(labelsFor("rlike", "postgres")).not.toContain("RLIKE");
  });
});

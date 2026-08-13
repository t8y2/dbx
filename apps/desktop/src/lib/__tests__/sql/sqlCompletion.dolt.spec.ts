import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems } from "@/lib/sql/sqlCompletion";

function completionLabels(sql: string, driverProfile: string): string[] {
  return buildSqlCompletionItems(sql, sql.length, {
    tables: [],
    objects: [],
    columnsByTable: new Map(),
    databaseType: "mysql",
    driverProfile,
  }).map((item) => item.label);
}

describe("Dolt SQL completion", () => {
  it("suggests Dolt routines for the Dolt profile", () => {
    expect(completionLabels("DOLT_BR", "dolt")).toContain("DOLT_BRANCH");
    expect(completionLabels("CALL DOLT_CH", "dolt")).toContain("DOLT_CHECKOUT");
  });

  it("does not expose Dolt routines to standard MySQL", () => {
    expect(completionLabels("DOLT_BR", "mysql")).not.toContain("DOLT_BRANCH");
    expect(completionLabels("CALL DOLT_CH", "mysql")).not.toContain("DOLT_CHECKOUT");
  });
});

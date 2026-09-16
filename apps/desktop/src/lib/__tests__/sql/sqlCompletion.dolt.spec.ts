import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems, shouldAutoOpenSqlCompletion, type SqlCompletionObject, type SqlCompletionTable } from "@/lib/sql/sqlCompletion";

function completionItems(sql: string, driverProfile: string, tables: SqlCompletionTable[] = [], objects: SqlCompletionObject[] = []) {
  return buildSqlCompletionItems(sql, sql.length, {
    tables,
    objects,
    columnsByTable: new Map(),
    databaseType: "mysql",
    driverProfile,
  });
}

function completionLabels(sql: string, driverProfile: string): string[] {
  return completionItems(sql, driverProfile).map((item) => item.label);
}

describe("Dolt SQL completion", () => {
  it("suggests Dolt routines for the Dolt profile", () => {
    expect(completionLabels("DOLT_BR", "dolt")).toContain("DOLT_BRANCH");
    expect(completionLabels("CALL DOLT_CH", "dolt")).toContain("DOLT_CHECKOUT");
    expect(completionLabels("CALL DOLT_STASH", "dolt")).toContain("DOLT_STASH");
    expect(completionLabels("HAS_ANC", "dolt")).toContain("HAS_ANCESTOR");
    expect(completionLabels("DOLT_PREVIEW_MERGE_C", "dolt")).toContain("DOLT_PREVIEW_MERGE_CONFLICTS");
  });

  it("does not expose Dolt routines to standard MySQL", () => {
    expect(completionLabels("DOLT_BR", "mysql")).not.toContain("DOLT_BRANCH");
    expect(completionLabels("CALL DOLT_CH", "mysql")).not.toContain("DOLT_CHECKOUT");
  });

  it("filters Dolt routines by CALL, SELECT, and table contexts", () => {
    expect(shouldAutoOpenSqlCompletion("CALL ", "CALL ".length, { databaseType: "mysql" })).toBe(true);
    expect(completionLabels("CALL ", "dolt")).toContain("DOLT_CHECKOUT");

    const callLabels = completionLabels("CALL DOLT_", "dolt");
    expect(callLabels).toContain("DOLT_CHECKOUT");
    expect(callLabels).not.toContain("DOLT_HASHOF");
    expect(callLabels).not.toContain("DOLT_LOG");

    const selectLabels = completionLabels("SELECT DOLT_", "dolt");
    expect(selectLabels).toContain("DOLT_HASHOF");
    expect(selectLabels).not.toContain("DOLT_CHECKOUT");
    expect(selectLabels).not.toContain("DOLT_LOG");

    const fromItems = completionItems("SELECT * FROM DOLT_", "dolt");
    expect(fromItems.find((item) => item.label === "DOLT_LOG")).toMatchObject({ detail: "Dolt table function", type: "table" });
    expect(fromItems.map((item) => item.label)).not.toContain("DOLT_CHECKOUT");
    expect(fromItems.map((item) => item.label)).not.toContain("DOLT_HASHOF");
  });

  it("marks Dolt system tables and keeps user tables ahead of them", () => {
    const items = completionItems("SELECT * FROM ", "dolt", [{ name: "dolt_log" }, { name: "orders" }]).filter((item) => item.type === "table");
    const userTableIndex = items.findIndex((item) => item.label === "orders");
    const systemTableIndex = items.findIndex((item) => item.label === "dolt_log");

    expect(items[systemTableIndex]).toMatchObject({ detail: "Dolt system table" });
    expect(userTableIndex).toBeGreaterThanOrEqual(0);
    expect(systemTableIndex).toBeGreaterThan(userTableIndex);
    expect(completionItems("SELECT * FROM dolt_", "mysql", [{ name: "dolt_log" }]).find((item) => item.label === "dolt_log")?.detail).not.toBe("Dolt system table");
  });

  it("does not change package completion for other database families", () => {
    const labels = buildSqlCompletionItems("SELECT DBMS_", "SELECT DBMS_".length, {
      tables: [],
      objects: [{ name: "DBMS_OUTPUT", type: "package" }],
      columnsByTable: new Map(),
      databaseType: "oracle",
    }).map((item) => item.label);

    expect(labels).toContain("DBMS_OUTPUT");
  });
});

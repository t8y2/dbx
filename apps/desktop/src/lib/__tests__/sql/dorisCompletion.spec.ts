import { describe, expect, it } from "vitest";
import { buildSqlCompletionItems, getSqlFunctionSignatureHelp } from "@/lib/sql/sqlCompletion";
import { buildSqlSemanticModel } from "@/lib/sql/semantic/model";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { resolveSqlDialectId, sqlReferenceAnalysisDialectFor } from "@/lib/sql/semantic/dialect";

describe("Doris and SelectDB SQL assistance", () => {
  it.each(["doris", "selectdb"])("routes the %s profile to Doris assistance", (driver_profile) => {
    expect(effectiveDatabaseTypeForConnection({ db_type: "mysql", driver_profile })).toBe("doris");
  });

  it.each(["BITMAP_UNION_COUNT", "HLL_UNION_AGG", "ARRAY_MAP", "JSON_EXTRACT_STRING", "DATE_TRUNC", "PERCENTILE_APPROX", "EXPLODE_SPLIT"])("offers %s with an insertable signature", (name) => {
    const sql = `SELECT ${name.slice(0, -1)}`;
    const items = buildSqlCompletionItems(sql, sql.length, { databaseType: "doris", tables: [], columnsByTable: new Map() });
    expect(items).toContainEqual(expect.objectContaining({ label: name, type: "function", apply: expect.stringContaining(`${name}(`) }));
    const call = `SELECT ${name}(`;
    expect(getSqlFunctionSignatureHelp(call, call.length, "doris")).not.toBeNull();
  });

  it.each(["doris", "starrocks"] as const)("offers MySQL date and interval functions with proper templates for %s", (databaseType) => {
    const addItems = buildSqlCompletionItems("SELECT date_ad", 14, { databaseType, tables: [], columnsByTable: new Map() });
    expect(addItems).toContainEqual(expect.objectContaining({ label: "DATE_ADD", type: "function", apply: "DATE_ADD(${date}, INTERVAL ${expr} ${unit})" }));

    const subItems = buildSqlCompletionItems("SELECT date_su", 14, { databaseType, tables: [], columnsByTable: new Map() });
    expect(subItems).toContainEqual(expect.objectContaining({ label: "DATE_SUB", type: "function", apply: "DATE_SUB(${date}, INTERVAL ${expr} ${unit})" }));

    const addDateItems = buildSqlCompletionItems("SELECT addda", 12, { databaseType, tables: [], columnsByTable: new Map() });
    expect(addDateItems).toContainEqual(expect.objectContaining({ label: "ADDDATE", type: "function", apply: "ADDDATE(${date}, INTERVAL ${expr} ${unit})" }));

    const extractItems = buildSqlCompletionItems("SELECT extra", 12, { databaseType, tables: [], columnsByTable: new Map() });
    expect(extractItems).toContainEqual(expect.objectContaining({ label: "EXTRACT", type: "function", apply: "EXTRACT(${unit} FROM ${date})" }));

    const call = "SELECT DATE_ADD(created_at, ";
    const help = getSqlFunctionSignatureHelp(call, call.length, databaseType);
    expect(help).not.toBeNull();
    expect(help?.name).toBe("DATE_ADD");
    expect(help?.parameters).toEqual(["date", "INTERVAL expr unit"]);
    expect(help?.activeParameter).toBe(1);
  });

  it("ranks a matching column ahead of a function prefix match", () => {
    const sql = "SELECT bitmap_ FROM events";
    const items = buildSqlCompletionItems(sql, sql.indexOf(" FROM"), {
      databaseType: "doris",
      tables: [{ name: "events" }],
      columnsByTable: new Map([["events", [{ name: "bitmap_value", table: "events", dataType: "BITMAP" }]]]),
    });
    expect(items.findIndex((item) => item.label === "bitmap_value")).toBeGreaterThanOrEqual(0);
    expect(items.findIndex((item) => item.label === "BITMAP_UNION_COUNT")).toBeGreaterThan(items.findIndex((item) => item.label === "bitmap_value"));
  });

  it("retains a Doris parser dialect instead of falling back to MySQL", () => {
    expect(sqlReferenceAnalysisDialectFor({ databaseType: "doris", fallbackDialect: "mysql" })).toBe("doris");
  });

  it("models chained LATERAL VIEW outputs as local columns", () => {
    const sql = "SELECT e, part FROM events t LATERAL VIEW explode(t.tags) a AS e LATERAL VIEW explode_split(t.name, ',') b AS part";
    const model = buildSqlSemanticModel(sql, sql.indexOf("e,") + 1, { databaseType: "doris", dialect: "doris" });
    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ name: "a", kind: "table_function", columns: ["e"] }), expect.objectContaining({ name: "b", kind: "table_function", columns: ["part"] })]));
  });

  it("keeps the Doris semantic adapter on the real editor dialect shape", () => {
    // QueryEditor passes the MySQL fallback dialect for Doris connections; the databaseType must
    // still win so the doris adapter (LATERAL VIEW modeling, ...) is not masked by "mysql".
    expect(resolveSqlDialectId({ databaseType: "doris", dialect: "mysql" })).toBe("doris");
    expect(resolveSqlDialectId({ databaseType: "starrocks", dialect: "mysql" })).toBe("doris");
  });

  it("treats # as a line comment for Doris", () => {
    const tokens = tokenizeSqlSemantic("SELECT 1 # trailing note\nFROM t", "doris");
    expect(tokens).toContainEqual(expect.objectContaining({ kind: "comment", text: "# trailing note" }));
  });

  it("models LATERAL VIEW columns under the editor dialect shape", () => {
    const sql = "SELECT e FROM events t LATERAL VIEW explode(t.tags) a AS e";
    const model = buildSqlSemanticModel(sql, sql.indexOf("e") + 1, { databaseType: "doris", dialect: "mysql" });
    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ name: "a", kind: "table_function", columns: ["e"] })]));
  });

  it("models LATERAL VIEW OUTER like the plain form", () => {
    const sql = "SELECT e FROM events t LATERAL VIEW OUTER explode(t.tags) a AS e";
    const model = buildSqlSemanticModel(sql, sql.indexOf("e") + 1, { databaseType: "doris", dialect: "mysql" });
    expect(model.rowSources).toEqual(expect.arrayContaining([expect.objectContaining({ name: "a", kind: "table_function", columns: ["e"] })]));
  });
});

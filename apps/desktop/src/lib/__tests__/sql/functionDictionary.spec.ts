import { describe, expect, it } from "vitest";
import { getFunctionDictionary, getFunctionDictionaryForConnection } from "@/lib/sql/functionDictionary";
import { getSqlFunctionSignatureEntries } from "@/lib/sql/sqlCompletion";

describe("function dictionary", () => {
  it("serves ClickHouse from the function registry with categories, signatures and aliases", () => {
    const dictionary = getFunctionDictionary("clickhouse");
    expect(dictionary).not.toBeNull();
    expect(dictionary!.total).toBeGreaterThan(1000);
    expect(dictionary!.groups.map((group) => group.id)).toContain("conversion");

    const conversion = dictionary!.groups.find((group) => group.id === "conversion")!;
    const toInt32 = conversion.entries.find((entry) => entry.name === "toInt32");
    expect(toInt32).toMatchObject({ name: "toInt32", group: "conversion" });
    expect(toInt32!.signature).toBe("toInt32(argument, ...arguments)");

    const quantile = dictionary!.groups.find((group) => group.id === "aggregate")!.entries.find((entry) => entry.name === "quantile");
    expect(quantile?.aliases).toContain("median");
    expect(quantile?.overloadCount).toBeGreaterThan(1);

    expect(dictionary!.total).toBe(dictionary!.groups.reduce((sum, group) => sum + group.entries.length, 0));
  });

  it("renders one signature per definition and reports extra overloads separately", () => {
    const dictionary = getFunctionDictionary("clickhouse")!;
    const lagInFrame = dictionary.groups.find((group) => group.id === "window")!.entries.find((entry) => entry.name === "lagInFrame");
    expect(lagInFrame?.signature).toBe("lagInFrame(value)");
    expect(lagInFrame?.overloadCount).toBe(3);
  });

  it("serves SQL dialects from the completion signature tables", () => {
    const mysql = getFunctionDictionary("mysql");
    expect(mysql).not.toBeNull();
    const dateFormat = mysql!.groups[0]!.entries.find((entry) => entry.name === "DATE_FORMAT");
    expect(dateFormat?.signature).toBe("DATE_FORMAT(date, format)");

    const postgres = getFunctionDictionary("postgres");
    expect(postgres).not.toBeNull();
    expect(postgres!.groups).toHaveLength(1);
    expect(postgres!.groups[0]!.entries.length).toBeGreaterThan(5);
  });

  it("adds a driver-profile group when the profile contributes routine signatures", () => {
    const dictionary = getFunctionDictionary("mysql", "dolt");
    expect(dictionary).not.toBeNull();
    const profileGroup = dictionary!.groups.find((group) => group.id === "driver-profile");
    expect(profileGroup).toBeDefined();
    expect(profileGroup!.entries.length).toBeGreaterThan(0);
  });

  it("serves MongoDB operators grouped by table with details", () => {
    const dictionary = getFunctionDictionary("mongodb");
    expect(dictionary).not.toBeNull();
    expect(dictionary!.groups.map((group) => group.id)).toEqual(["query", "update", "push", "pipeline", "accumulator", "expression"]);
    const eq = dictionary!.groups.find((group) => group.id === "query")!.entries.find((entry) => entry.name === "$eq");
    expect(eq?.detail).toBeTruthy();
  });

  it("serves Redis commands grouped by command group with argument-count hints", () => {
    const dictionary = getFunctionDictionary("redis");
    expect(dictionary).not.toBeNull();
    expect(dictionary!.total).toBeGreaterThan(300);
    const stringGroup = dictionary!.groups.find((group) => group.id === "string")!;
    const get = stringGroup.entries.find((entry) => entry.name === "GET");
    expect(get?.argsHint).toBe("1");
    const mset = stringGroup.entries.find((entry) => entry.name === "MSET");
    expect(mset?.argsHint).toBe("2+");
  });

  it("returns null for database types without built-in function data", () => {
    expect(getFunctionDictionary(undefined)).toBeNull();
    expect(getFunctionDictionary("elasticsearch")).toBeNull();
    expect(getFunctionDictionary("duckdb")).toBeNull();
    expect(getFunctionDictionary("oracle")).toBeNull();
  });

  it("resolves driver-profile variants through the connection helper", () => {
    expect(getFunctionDictionaryForConnection({ db_type: "mysql", driver_profile: "starrocks" })).toBeNull();
    expect(getFunctionDictionaryForConnection({ db_type: "clickhouse" })!.databaseType).toBe("clickhouse");
    const gbaseAsMysql = getFunctionDictionaryForConnection({ db_type: "gbase" });
    expect(gbaseAsMysql?.databaseType).toBe("mysql");
    expect(getFunctionDictionaryForConnection(undefined)).toBeNull();
  });

  it("exposes the completion signature view only for dialects with dedicated tables", () => {
    expect(getSqlFunctionSignatureEntries("sqlite")).not.toBeNull();
    expect(getSqlFunctionSignatureEntries("dameng")).toBeNull();
    expect(getSqlFunctionSignatureEntries(undefined)).toBeNull();
  });
});

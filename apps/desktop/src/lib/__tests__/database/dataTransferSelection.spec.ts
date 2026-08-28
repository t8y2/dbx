import { describe, expect, it } from "vitest";
import { decodeTransferDatabaseOption, encodeTransferDatabaseOptions, isSameTransferDatabase, isTransferDatabaseSelected, normalizeTransferCatalog, type TransferDatabaseSelection } from "@/lib/database/dataTransferSelection";
import { TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE } from "@/lib/database/defaultDatabase";
import type { CatalogInfo } from "@/types/database";

function catalog(name: string, catalog_type: string): CatalogInfo {
  return { name, catalog_type, is_current: false };
}

function selection(overrides: Partial<TransferDatabaseSelection> = {}): TransferDatabaseSelection {
  return {
    connectionId: "connection-1",
    catalog: "",
    catalogs: [],
    database: "sales",
    ...overrides,
  };
}

describe("data transfer database selection", () => {
  it("keeps a Kingbase default database distinct from no selection", () => {
    const options = encodeTransferDatabaseOptions("kingbase", [""]);

    expect(options).toEqual([TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE]);
    expect(isTransferDatabaseSelected(options[0])).toBe(true);
    expect(isTransferDatabaseSelected("")).toBe(false);
    expect(decodeTransferDatabaseOption("kingbase", options[0])).toBe("");
  });

  it("uses the tree-schema default database contract for PostgreSQL", () => {
    const [option] = encodeTransferDatabaseOptions("postgres", [""]);

    expect(option).toBe(TREE_SCHEMA_DEFAULT_DATABASE_SELECT_VALUE);
    expect(decodeTransferDatabaseOption("postgres", option)).toBe("");
  });

  it.each(["kingbase", "dameng", "mysql", "mongodb", "starrocks"] as const)("preserves named %s databases", (databaseType) => {
    expect(encodeTransferDatabaseOptions(databaseType, ["app", "analytics"])).toEqual(["app", "analytics"]);
    expect(decodeTransferDatabaseOption(databaseType, "analytics")).toBe("analytics");
  });

  it("normalizes empty, Doris internal, and StarRocks default catalogs", () => {
    expect(normalizeTransferCatalog("", [])).toBe("");
    expect(normalizeTransferCatalog("internal", [])).toBe("");
    expect(normalizeTransferCatalog("default_catalog", [catalog("default_catalog", "Internal")])).toBe("");
  });

  it("treats internal catalog aliases as the same transfer database", () => {
    expect(isSameTransferDatabase(selection(), selection({ catalog: "internal", catalogs: [catalog("internal", "internal")] }))).toBe(true);
    expect(isSameTransferDatabase(selection(), selection({ catalog: "default_catalog", catalogs: [catalog("default_catalog", "Internal")] }))).toBe(true);
  });

  it("keeps different external catalogs distinct", () => {
    expect(isSameTransferDatabase(selection({ catalog: "iceberg", catalogs: [catalog("iceberg", "Iceberg")] }), selection({ catalog: "hive", catalogs: [catalog("hive", "Hive")] }))).toBe(false);
  });

  it("compares connection and database fields without concatenation collisions", () => {
    expect(isSameTransferDatabase(selection({ connectionId: "ab", database: "c" }), selection({ connectionId: "a", database: "bc" }))).toBe(false);
  });
});

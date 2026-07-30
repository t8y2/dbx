import { describe, expect, it } from "vitest";
import { isSameTransferDatabase, normalizeTransferCatalog, type TransferDatabaseSelection } from "@/lib/database/dataTransferSelection";
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

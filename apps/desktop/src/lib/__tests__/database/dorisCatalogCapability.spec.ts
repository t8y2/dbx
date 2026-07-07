import { describe, expect, it } from "vitest";
import { connectionIsDorisFamilyCatalogCapable, isDorisFamilyCatalogCapable, isInternalDorisCatalog } from "@/lib/database/databaseFeatureSupport";
import type { ConnectionConfig } from "@/types/database";

function conn(db_type: ConnectionConfig["db_type"], driver_profile?: string | null): Pick<ConnectionConfig, "db_type" | "driver_profile"> {
  return { db_type, driver_profile: driver_profile ?? null };
}

describe("isDorisFamilyCatalogCapable", () => {
  it("matches Doris and StarRocks by db_type", () => {
    expect(isDorisFamilyCatalogCapable("doris")).toBe(true);
    expect(isDorisFamilyCatalogCapable("starrocks")).toBe(true);
  });

  it("matches Doris / SelectDB / StarRocks driver profiles", () => {
    expect(isDorisFamilyCatalogCapable("mysql", "doris")).toBe(true);
    expect(isDorisFamilyCatalogCapable("mysql", "selectdb")).toBe(true);
    expect(isDorisFamilyCatalogCapable("mysql", "starrocks")).toBe(true);
  });

  it("excludes ManticoreSearch (no catalog concept)", () => {
    expect(isDorisFamilyCatalogCapable("manticoresearch")).toBe(false);
    expect(isDorisFamilyCatalogCapable("mysql", "manticoresearch")).toBe(false);
  });

  it("excludes plain MySQL / Postgres", () => {
    expect(isDorisFamilyCatalogCapable("mysql")).toBe(false);
    expect(isDorisFamilyCatalogCapable("postgres")).toBe(false);
  });
});

describe("connectionIsDorisFamilyCatalogCapable", () => {
  it("returns false for undefined connection", () => {
    expect(connectionIsDorisFamilyCatalogCapable(undefined)).toBe(false);
  });

  it("returns true for a Doris connection", () => {
    expect(connectionIsDorisFamilyCatalogCapable(conn("doris"))).toBe(true);
  });

  it("returns false for a plain MySQL connection", () => {
    expect(connectionIsDorisFamilyCatalogCapable(conn("mysql"))).toBe(false);
  });
});

describe("isInternalDorisCatalog", () => {
  it("detects Doris internal catalog by type", () => {
    expect(isInternalDorisCatalog("internal", "internal")).toBe(true);
  });

  it("detects StarRocks internal catalog by type (case-insensitive)", () => {
    expect(isInternalDorisCatalog("Internal", "default_catalog")).toBe(true);
    expect(isInternalDorisCatalog("INTERNAL", "default_catalog")).toBe(true);
  });

  it("treats external catalogs as non-internal", () => {
    expect(isInternalDorisCatalog("iceberg", "iceberg_catalog")).toBe(false);
    expect(isInternalDorisCatalog("hive", "hive_catalog")).toBe(false);
    // A catalog literally named `internal` but with an external type is not built-in.
    expect(isInternalDorisCatalog("iceberg", "internal")).toBe(false);
  });

  it("falls back to the Doris name when the type is absent", () => {
    expect(isInternalDorisCatalog("", "internal")).toBe(true);
    expect(isInternalDorisCatalog(null, "internal")).toBe(true);
    expect(isInternalDorisCatalog("", "default_catalog")).toBe(false);
    expect(isInternalDorisCatalog(undefined, undefined)).toBe(false);
  });
});

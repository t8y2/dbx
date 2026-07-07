import { describe, expect, it } from "vitest";
import { connectionIsDorisFamilyCatalogCapable, isDorisFamilyCatalogCapable } from "@/lib/database/databaseFeatureSupport";
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

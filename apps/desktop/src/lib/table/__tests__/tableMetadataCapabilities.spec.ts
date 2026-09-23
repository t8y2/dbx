import { describe, expect, it } from "vitest";
import { getTableMetadataCapabilities, isStructureMetadataTabSupported } from "@/lib/table/tableMetadataCapabilities";

describe("tableMetadataCapabilities", () => {
  it("exposes only collection indexes for MongoDB table information", () => {
    expect(getTableMetadataCapabilities("mongodb")).toEqual({
      columns: false,
      indexes: true,
      foreignKeys: false,
      constraints: false,
      triggers: false,
      partitions: false,
      ddl: false,
    });
  });

  it("exposes structured constraints only for dialects that implement list_constraints", () => {
    expect(getTableMetadataCapabilities("oracle").constraints).toBe(true);
    expect(getTableMetadataCapabilities("postgres").constraints).toBe(true);
    expect(getTableMetadataCapabilities("kingbase").constraints).toBe(true);
    expect(getTableMetadataCapabilities("vastbase").constraints).toBe(true);
    expect(getTableMetadataCapabilities("opengauss").constraints).toBe(true);
    expect(getTableMetadataCapabilities("sqlserver").constraints).toBe(true);
    expect(getTableMetadataCapabilities("mysql").constraints).toBe(false);
    expect(getTableMetadataCapabilities(undefined).constraints).toBe(false);
  });

  it("exposes partitions only for dialects with declarative partitioning metadata", () => {
    expect(getTableMetadataCapabilities("postgres").partitions).toBe(true);
    expect(getTableMetadataCapabilities("kingbase").partitions).toBe(true);
    expect(getTableMetadataCapabilities("mysql").partitions).toBe(false);
    expect(getTableMetadataCapabilities("oracle").partitions).toBe(false);
    // openGauss-based engines use a different partition catalog and stay off.
    expect(getTableMetadataCapabilities("opengauss").partitions).toBe(false);
    expect(getTableMetadataCapabilities("vastbase").partitions).toBe(false);
    expect(getTableMetadataCapabilities("gaussdb").partitions).toBe(false);
    expect(getTableMetadataCapabilities(undefined).partitions).toBe(false);
  });

  it("shows the Partitions tab for PostgreSQL in both edit and create mode only", () => {
    const postgres = getTableMetadataCapabilities("postgres");
    expect(isStructureMetadataTabSupported("partitions", postgres, false)).toBe(true);
    // Create mode declares `PARTITION BY` instead of reading the catalog.
    expect(isStructureMetadataTabSupported("partitions", postgres, true)).toBe(true);

    const mysql = getTableMetadataCapabilities("mysql");
    expect(isStructureMetadataTabSupported("partitions", mysql, false)).toBe(false);
    // The DDL tab has no create-mode baseline; the partitions tab does.
    expect(isStructureMetadataTabSupported("ddl", postgres, true)).toBe(false);
  });
});

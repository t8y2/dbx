import { describe, expect, it } from "vitest";
import { transferObjectFamily, transferObjectKindsForDatabase, transferObjectMetadataTarget, requiresTransferSchemaObjectPlan, isSameTransferFamily, crossFamilyTransferableKinds, isTransferPairSupported, TransferObjectFamily } from "@/lib/database/transferObjectKinds";
import { manifestDatabaseTypes } from "@/lib/database/databaseDriverManifest";
import { supportsTransfer } from "@/lib/database/databaseFeatureSupport";
import type { DatabaseType } from "@/types/database";

const TABLE_ONLY_TRANSFER_DATABASES: DatabaseType[] = ["sqlite", "rqlite", "turso", "cloudflare-d1", "duckdb", "clickhouse", "mongodb", "highgo", "vastbase", "goldendb", "yashandb", "questdb", "h2", "hive", "argo", "transwarp", "kyuubi", "impala", "db2", "iris", "spark", "xugu"];

describe("transferObjectKinds", () => {
  it.each(["oracle", "oceanbase-oracle"] as const)("exposes type parts for %s with mandatory plans and exact metadata identity", (databaseType) => {
    expect(crossFamilyTransferableKinds(databaseType, databaseType)).toEqual(expect.arrayContaining(["TYPE", "TYPE_BODY"]));
    expect(crossFamilyTransferableKinds(databaseType, "dameng")).not.toContain("TYPE");
    expect(crossFamilyTransferableKinds(databaseType, "mysql")).not.toContain("TYPE_BODY");
    for (const kind of ["TYPE", "TYPE_BODY"] as const) {
      expect(requiresTransferSchemaObjectPlan(kind)).toBe(true);
      expect(transferObjectMetadataTarget(kind, "Case Owner")).toEqual({ objectType: kind, schema: "Case Owner" });
    }
  });
  it("keeps public and private synonym metadata scopes distinct", () => {
    expect(transferObjectMetadataTarget("SYNONYM", "Case Owner")).toEqual({ objectType: "SYNONYM", schema: "Case Owner" });
    expect(transferObjectMetadataTarget("PUBLIC_SYNONYM", "Case Owner")).toEqual({ objectType: "SYNONYM", schema: "PUBLIC" });
    expect(transferObjectMetadataTarget("SYNONYM", "PUBLIC")).toBeUndefined();
    expect(transferObjectMetadataTarget("SYNONYM", "__public")).toBeUndefined();
    expect(transferObjectMetadataTarget("SYNONYM", "public")).toEqual({ objectType: "SYNONYM", schema: "public" });
    expect(requiresTransferSchemaObjectPlan("SYNONYM")).toBe(true);
    expect(requiresTransferSchemaObjectPlan("PUBLIC_SYNONYM")).toBe(true);
  });

  it("keeps database links outside sidebar metadata listing", () => {
    expect(transferObjectMetadataTarget("DB_LINK", "Case Owner")).toBeUndefined();
    expect(transferObjectMetadataTarget("PUBLIC_DB_LINK", "Case Owner")).toBeUndefined();
  });

  it.each(["oracle", "oceanbase-oracle"] as const)("exposes separate synonym scopes for %s without allowing unrelated targets", (source) => {
    expect(crossFamilyTransferableKinds(source, "oracle")).toEqual(expect.arrayContaining(["SYNONYM", "PUBLIC_SYNONYM"]));
    expect(crossFamilyTransferableKinds(source, "dameng")).not.toContain("SYNONYM");
    expect(crossFamilyTransferableKinds(source, "mysql")).not.toContain("PUBLIC_SYNONYM");
  });
  it("groups databases into transfer families", () => {
    expect(transferObjectFamily("mysql")).toBe(TransferObjectFamily.Mysql);
    expect(transferObjectFamily("kingbase")).toBe(TransferObjectFamily.Postgres);
    expect(transferObjectFamily("dameng")).toBe(TransferObjectFamily.Oracle);
    expect(transferObjectFamily("sqlserver")).toBe(TransferObjectFamily.SqlServer);
    expect(transferObjectFamily("sqlite")).toBeUndefined();
  });

  it("returns per-family object kinds", () => {
    expect(transferObjectKindsForDatabase("mysql")).toEqual(["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"]);
    expect(transferObjectKindsForDatabase("postgres")).toEqual(["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE"]);
    expect(transferObjectKindsForDatabase("oracle")).toEqual(["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "TYPE", "TYPE_BODY", "PACKAGE", "PACKAGE_BODY", "SYNONYM", "PUBLIC_SYNONYM", "DB_LINK", "PUBLIC_DB_LINK"]);
    expect(transferObjectKindsForDatabase("sqlserver")).toEqual(["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE"]);
  });

  it.each(TABLE_ONLY_TRANSFER_DATABASES)("falls back to tables for transfer-capable %s databases", (dbType) => {
    expect(transferObjectKindsForDatabase(dbType)).toEqual(["TABLE"]);
  });

  it("covers every transfer-capable database outside the richer object families", () => {
    const manifestTypes = manifestDatabaseTypes().filter((dbType) => supportsTransfer(dbType) && !transferObjectFamily(dbType));
    expect([...manifestTypes].sort()).toEqual([...TABLE_ONLY_TRANSFER_DATABASES].sort());
  });

  it("does not expose objects for databases without transfer support", () => {
    expect(transferObjectKindsForDatabase("redis")).toEqual([]);
    expect(transferObjectKindsForDatabase(undefined)).toEqual([]);
  });

  it("detects same-family transfers", () => {
    expect(isSameTransferFamily("mysql", "mysql")).toBe(true);
    expect(isSameTransferFamily("mysql", "postgres")).toBe(false);
    expect(isSameTransferFamily("oracle", "dameng")).toBe(true);
    expect(isSameTransferFamily("postgres", "sqlite")).toBe(false);
    expect(isSameTransferFamily("sqlserver", "sqlserver")).toBe(true);
    expect(isSameTransferFamily("sqlserver", "mysql")).toBe(false);
  });

  it.each(["oracle", "oceanbase-oracle"] as const)("selects package parts for %s without widening Dameng support", (databaseType) => {
    expect(transferObjectKindsForDatabase(databaseType)).toEqual(expect.arrayContaining(["PACKAGE", "PACKAGE_BODY"]));
    expect(crossFamilyTransferableKinds(databaseType, "oceanbase-oracle")).toEqual(expect.arrayContaining(["PACKAGE", "PACKAGE_BODY"]));
    expect(crossFamilyTransferableKinds(databaseType, "dameng")).not.toContain("PACKAGE");
    expect(crossFamilyTransferableKinds("dameng", databaseType)).not.toContain("PACKAGE_BODY");
  });

  it("allows Xugu transfer only between two Xugu connections", () => {
    expect(isTransferPairSupported("xugu", "xugu")).toBe(true);
    expect(isTransferPairSupported("xugu", "postgres")).toBe(false);
    expect(isTransferPairSupported("mysql", "xugu")).toBe(false);
    expect(isTransferPairSupported("mysql", "postgres")).toBe(true);
    expect(isTransferPairSupported(undefined, "xugu")).toBe(true);
  });

  it("limits cross-family transferable kinds to sequences only", () => {
    // mysql participates: VIEW is disabled (query body not translated) and
    // mysql has no sequences on either side
    expect(crossFamilyTransferableKinds("mysql", "dameng")).toEqual([]);
    expect(crossFamilyTransferableKinds("dameng", "mysql")).toEqual([]);
    expect(crossFamilyTransferableKinds("mysql", "sqlserver")).toEqual([]);
    // sqlserver <-> dameng: sequences only (plain DDL)
    expect(crossFamilyTransferableKinds("sqlserver", "dameng")).toEqual(["SEQUENCE"]);
    expect(crossFamilyTransferableKinds("dameng", "sqlserver")).toEqual(["SEQUENCE"]);
    // same family: all source kinds
    const same = crossFamilyTransferableKinds("mysql", "mysql");
    expect(same).toContain("TRIGGER");
    expect(same).toContain("EVENT");
    // transfer-capable database without a modeled cross-family executor
    expect(crossFamilyTransferableKinds("sqlite", "mysql")).toEqual([]);
  });
});

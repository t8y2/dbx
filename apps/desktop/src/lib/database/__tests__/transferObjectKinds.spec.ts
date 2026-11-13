import { describe, expect, it } from "vitest";
import { transferObjectFamily, transferObjectKindsForDatabase, isSameTransferFamily, crossFamilyTransferableKinds, isTransferPairSupported, TransferObjectFamily, transferSchemasForDatabase } from "@/lib/database/transferObjectKinds";
import { XUGU_PUBLIC_SYNONYM_SCOPE, XUGU_SCHEDULER_JOB_SCOPE } from "@/lib/sidebar/xuguPublicSynonyms";
import { manifestDatabaseTypes } from "@/lib/database/databaseDriverManifest";
import { supportsTransfer } from "@/lib/database/databaseFeatureSupport";
import type { DatabaseType } from "@/types/database";

const TABLE_ONLY_TRANSFER_DATABASES: DatabaseType[] = ["sqlite", "rqlite", "turso", "cloudflare-d1", "duckdb", "clickhouse", "mongodb", "highgo", "vastbase", "goldendb", "yashandb", "questdb", "h2", "hive", "argo", "transwarp", "kyuubi", "impala", "db2", "iris", "spark"];

describe("transferObjectKinds", () => {
  it("keeps Xugu synthetic scopes out of both transfer schema selectors without filtering other engines", () => {
    const schemas = ["APP", "SYSDBA", XUGU_PUBLIC_SYNONYM_SCOPE, XUGU_SCHEDULER_JOB_SCOPE];
    expect(transferSchemasForDatabase("xugu", schemas)).toEqual(["APP", "SYSDBA"]);
    expect(transferSchemasForDatabase("postgres", schemas)).toBe(schemas);
    expect(transferSchemasForDatabase("mysql", schemas)).toBe(schemas);
  });
  it("offers exact package kinds only when both actual products support them", () => {
    for (const source of ["oracle", "oceanbase-oracle"] as const) {
      expect(transferObjectKindsForDatabase(source)).toEqual(expect.arrayContaining(["PACKAGE", "PACKAGE_BODY"]));
      for (const target of ["oracle", "oceanbase-oracle"] as const) expect(crossFamilyTransferableKinds(source, target)).toEqual(expect.arrayContaining(["PACKAGE", "PACKAGE_BODY"]));
      for (const target of ["dameng", "xugu", "mysql", "postgres"] as const) {
        expect(crossFamilyTransferableKinds(source, target)).not.toContain("PACKAGE");
        expect(crossFamilyTransferableKinds(target, source)).not.toContain("PACKAGE_BODY");
      }
    }
    expect(transferObjectKindsForDatabase("dameng")).not.toContain("PACKAGE");
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
    expect(transferObjectKindsForDatabase("oracle")).toEqual(["TABLE", "VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "PACKAGE", "PACKAGE_BODY"]);
    expect(transferObjectKindsForDatabase("sqlserver")).toEqual(["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE"]);
  });

  it.each(TABLE_ONLY_TRANSFER_DATABASES)("falls back to tables for transfer-capable %s databases", (dbType) => {
    expect(transferObjectKindsForDatabase(dbType)).toEqual(["TABLE"]);
  });

  it("covers every transfer-capable database outside the richer object families", () => {
    const manifestTypes = manifestDatabaseTypes().filter((dbType) => dbType !== "xugu" && supportsTransfer(dbType) && !transferObjectFamily(dbType));
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

  it("allows native MySQL to Xugu tables without opening other Xugu directions", () => {
    expect(isTransferPairSupported("xugu", "xugu")).toBe(true);
    expect(isTransferPairSupported("xugu", "postgres")).toBe(false);
    expect(isTransferPairSupported("mysql", "xugu")).toBe(true);
    expect(isTransferPairSupported("xugu", "mysql")).toBe(false);
    expect(isTransferPairSupported("doris", "xugu")).toBe(false);
    expect(isTransferPairSupported("starrocks", "xugu")).toBe(false);
    expect(isTransferPairSupported("mysql", "postgres")).toBe(true);
    expect(isTransferPairSupported(undefined, "xugu")).toBe(true);
  });

  it("keeps native Xugu schema objects and engine-pair boundaries intact", () => {
    const kinds = ["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE", "PACKAGE", "SYNONYM"];
    expect(transferObjectKindsForDatabase("xugu")).toEqual(kinds);
    expect(crossFamilyTransferableKinds("xugu", "xugu")).toEqual(kinds);
    expect(transferObjectKindsForDatabase("xugu")).not.toContain("PACKAGE_BODY");
    for (const engine of ["postgres", "mysql", "oracle", "dameng", "sqlserver"] as const) {
      expect(crossFamilyTransferableKinds("xugu", engine)).toEqual([]);
      expect(crossFamilyTransferableKinds(engine, "xugu")).toEqual([]);
      if (engine === "oracle") expect(transferObjectKindsForDatabase(engine)).toContain("PACKAGE");
      else expect(transferObjectKindsForDatabase(engine)).not.toContain("PACKAGE");
      expect(transferObjectKindsForDatabase(engine)).not.toContain("SYNONYM");
    }
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

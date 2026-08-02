import { describe, expect, it } from "vitest";
import { transferObjectFamily, transferObjectKindsForDatabase, isSameTransferFamily, crossFamilyTransferableKinds, TransferObjectFamily } from "@/lib/database/transferObjectKinds";

describe("transferObjectKinds", () => {
  it("groups databases into transfer families", () => {
    expect(transferObjectFamily("mysql")).toBe(TransferObjectFamily.Mysql);
    expect(transferObjectFamily("kingbase")).toBe(TransferObjectFamily.Postgres);
    expect(transferObjectFamily("dameng")).toBe(TransferObjectFamily.Oracle);
    expect(transferObjectFamily("sqlserver")).toBe(TransferObjectFamily.SqlServer);
    expect(transferObjectFamily("sqlite")).toBeUndefined();
  });

  it("returns per-family object kinds", () => {
    expect(transferObjectKindsForDatabase("mysql")).toEqual(["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "EVENT"]);
    expect(transferObjectKindsForDatabase("postgres")).toContain("SEQUENCE");
    expect(transferObjectKindsForDatabase("dameng")).toContain("TRIGGER");
    expect(transferObjectKindsForDatabase("sqlserver")).toEqual(["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER", "SEQUENCE"]);
    expect(transferObjectKindsForDatabase("sqlite")).toEqual([]);
  });

  it("detects same-family transfers", () => {
    expect(isSameTransferFamily("mysql", "mysql")).toBe(true);
    expect(isSameTransferFamily("mysql", "postgres")).toBe(false);
    expect(isSameTransferFamily("oracle", "dameng")).toBe(true);
    expect(isSameTransferFamily("postgres", "sqlite")).toBe(false);
    expect(isSameTransferFamily("sqlserver", "sqlserver")).toBe(true);
    expect(isSameTransferFamily("sqlserver", "mysql")).toBe(false);
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
    // unsupported db
    expect(crossFamilyTransferableKinds("sqlite", "mysql")).toEqual([]);
  });
});

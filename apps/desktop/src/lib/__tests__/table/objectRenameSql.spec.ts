import { describe, expect, it } from "vitest";

import { databaseRenameMaintenanceDatabase, supportsDatabaseRename, supportsObjectRename } from "@/lib/table/objectRenameSql";

describe("Inceptor object rename", () => {
  it("exposes table rename without enabling unsupported object or database renames", () => {
    expect(supportsObjectRename("transwarp", "TABLE")).toBe(true);
    expect(supportsObjectRename("transwarp", "VIEW")).toBe(false);
    expect(supportsObjectRename("transwarp", "PROCEDURE")).toBe(false);
    expect(supportsObjectRename("transwarp", "FUNCTION")).toBe(false);
    expect(supportsDatabaseRename("transwarp")).toBe(false);
  });
});

describe("StarRocks object rename", () => {
  it("enables table rename only", () => {
    expect(supportsObjectRename("starrocks", "TABLE")).toBe(true);
    for (const objectType of ["VIEW", "MATERIALIZED_VIEW", "PROCEDURE", "FUNCTION", "EVENT"] as const) {
      expect(supportsObjectRename("starrocks", objectType)).toBe(false);
    }
    expect(supportsDatabaseRename("starrocks")).toBe(false);
  });
});

describe("database rename", () => {
  it("chooses a maintenance database outside the rename target", () => {
    expect(databaseRenameMaintenanceDatabase("admin", "application")).toBe("admin");
    expect(databaseRenameMaintenanceDatabase("application", "application")).toBe("postgres");
    expect(databaseRenameMaintenanceDatabase(undefined, "application")).toBe("postgres");
    expect(databaseRenameMaintenanceDatabase("postgres", "postgres")).toBe("template1");
    expect(databaseRenameMaintenanceDatabase("template1", "postgres")).toBe("template1");
  });

  it("does not expose database rename for YashanDB", () => {
    expect(supportsDatabaseRename("postgres")).toBe(true);
    expect(supportsDatabaseRename("yashandb")).toBe(false);
  });
});

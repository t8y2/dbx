import { describe, expect, it } from "vitest";
import { driverProfileCompletionObjects, driverProfileCompletionTableMetadata, driverProfileCompletionTables, driverProfileDatabaseWorkspace, driverProfileExtension, driverProfileObjectTreeProfileForConnection } from "@/lib/database/driverProfileExtensions";
import type { ConnectionConfig } from "@/types/database";

const completionContext = {
  statementKind: "select" as const,
  suggestTables: false,
  suggestRoutines: true,
  exclusiveRoutineSuggestions: false,
  prefix: "DOLT_",
  openingParenAfterCursor: false,
};

function connection(driverProfile: string): ConnectionConfig {
  return {
    id: driverProfile,
    name: driverProfile,
    db_type: "mysql",
    driver_profile: driverProfile,
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    password: "",
    database: "app",
    external_config: { doltShowSystemTables: true },
  };
}

describe("driverProfileExtensions", () => {
  it("resolves Dolt capabilities through the generic registry", () => {
    expect(driverProfileExtension("DOLT")?.id).toBe("dolt");
    expect(driverProfileObjectTreeProfileForConnection(connection("dolt"))?.groupOverrides.map((group) => group.nodeType)).toEqual(["group-tables", "group-dolt-system-tables"]);
    expect(driverProfileCompletionObjects("dolt", completionContext).map((object) => object.name)).toContain("DOLT_HASHOF");
    expect(driverProfileCompletionTables("dolt", { ...completionContext, suggestTables: true }).map((table) => table.name)).toContain("DOLT_LOG");
    expect(driverProfileCompletionTableMetadata("dolt", "dolt_log")).toEqual({ detail: "Dolt system table", boost: -1200 });
    const workspace = driverProfileDatabaseWorkspace("dolt");
    expect(workspace).toMatchObject({
      mode: "dolt-version-control",
      menuLabelKey: "doltVersionControl.open",
      tabTitleKey: "doltVersionControl.title",
      tabScope: "connection",
      entryScopes: ["connection", "database"],
    });
    expect(workspace?.resolveTarget?.("inventory", "connection")).toEqual({ database: "inventory" });
    expect(workspace?.resolveTarget?.("inventory/feature/orders", "connection")).toEqual({ database: "inventory" });
    expect(workspace?.resolveTarget?.("inventory/feature/orders", "database")).toEqual({ database: "inventory", branch: "feature/orders" });
  });

  it("leaves ordinary MySQL without profile capabilities", () => {
    expect(driverProfileExtension("mysql")).toBeUndefined();
    expect(driverProfileObjectTreeProfileForConnection(connection("mysql"))).toBeUndefined();
    expect(driverProfileCompletionObjects("mysql", completionContext)).toEqual([]);
    expect(driverProfileCompletionTables("mysql", { ...completionContext, suggestTables: true })).toEqual([]);
    expect(driverProfileCompletionTableMetadata("mysql", "dolt_log")).toBeUndefined();
    expect(driverProfileDatabaseWorkspace("mysql")).toBeUndefined();
  });
});

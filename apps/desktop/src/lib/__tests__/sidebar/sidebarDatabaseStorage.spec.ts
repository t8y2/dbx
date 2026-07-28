import { describe, expect, it } from "vitest";
import { applySidebarDatabaseStorage, applySidebarTableStorage, formatSidebarObjectStorage, sidebarDatabaseNames, sidebarTableStorageScopes, supportsSidebarDatabaseStorage, supportsSidebarTableStorage } from "@/lib/sidebar/sidebarDatabaseStorage";
import type { ConnectionConfig, TreeNode } from "@/types/database";

function config(dbType: ConnectionConfig["db_type"]): ConnectionConfig {
  return { id: "connection", name: "connection", db_type: dbType } as ConnectionConfig;
}

describe("sidebar database storage", () => {
  it("keeps database totals PostgreSQL-specific while reusing supported table statistics", () => {
    expect(supportsSidebarDatabaseStorage(config("postgres"))).toBe(true);
    expect(supportsSidebarDatabaseStorage(config("mysql"))).toBe(false);
    expect(supportsSidebarDatabaseStorage({ ...config("postgres"), driver_profile: "cockroachdb" })).toBe(false);

    for (const dbType of ["mysql", "postgres", "sqlserver", "oracle", "clickhouse", "dameng", "gaussdb", "kingbase", "gbase"] as const) {
      expect(supportsSidebarTableStorage(config(dbType))).toBe(true);
    }
    expect(supportsSidebarTableStorage(config("jdbc"))).toBe(false);
    expect(supportsSidebarTableStorage({ ...config("postgres"), driver_profile: "cockroachdb" })).toBe(false);
    expect(supportsSidebarTableStorage({ ...config("gbase"), driver_profile: "gbase8s" })).toBe(false);
  });

  it("requests and applies only visible database nodes", () => {
    const nodes: TreeNode[] = [
      { id: "a", label: "app", type: "database", connectionId: "connection", database: "app" },
      { id: "b", label: "hidden", type: "database", connectionId: "connection", database: "hidden" },
      { id: "utility", label: "users", type: "user-admin", connectionId: "connection" },
    ];
    expect(sidebarDatabaseNames(nodes)).toEqual(["app", "hidden"]);
    expect(applySidebarDatabaseStorage(nodes, [{ name: "app", size_bytes: 2048 }])).toBe(true);
    expect(nodes[0].sizeBytes).toBe(2048);
    expect(nodes[1].sizeBytes).toBeUndefined();
  });

  it("keeps unavailable values blank and formats known sizes compactly", () => {
    expect(formatSidebarObjectStorage(null)).toBe("");
    expect(formatSidebarObjectStorage(0)).toBe("0 B");
    expect(formatSidebarObjectStorage(1536)).toBe("1.5 KB");
    expect(formatSidebarObjectStorage(15 * 1024 * 1024)).toBe("15 MB");
    expect(formatSidebarObjectStorage(15.25 * 1024 * 1024)).toBe("15.3 MB");
  });

  it("collects table scopes and applies PostgreSQL table sizes without crossing schemas", () => {
    const publicTable: TreeNode = { id: "public-users", label: "users", type: "table", connectionId: "connection", database: "app", schema: "public" };
    const auditTable: TreeNode = { id: "audit-users", label: "users", type: "table", connectionId: "connection", database: "app", schema: "audit" };
    const nodes: TreeNode[] = [
      { id: "public", label: "public", type: "schema", connectionId: "connection", database: "app", schema: "public", children: [publicTable] },
      { id: "audit", label: "audit", type: "schema", connectionId: "connection", database: "app", schema: "audit", children: [auditTable] },
    ];

    expect(sidebarTableStorageScopes([publicTable, auditTable])).toEqual([
      { connectionId: "connection", database: "app", schema: "public" },
      { connectionId: "connection", database: "app", schema: "audit" },
    ]);
    expect(applySidebarTableStorage(nodes, { connectionId: "connection", database: "app", schema: "public" }, [{ name: "users", schema: "public", total_bytes: 8192 }])).toBe(true);
    expect(publicTable.sizeBytes).toBe(8192);
    expect(auditTable.sizeBytes).toBeUndefined();
  });

  it("applies database-scoped MySQL statistics to tree nodes without a schema", () => {
    const table: TreeNode = { id: "products", label: "products", type: "table", connectionId: "connection", database: "shop" };
    expect(applySidebarTableStorage([table], { connectionId: "connection", database: "shop", schema: "" }, [{ name: "products", schema: "shop", total_bytes: 49152 }])).toBe(true);
    expect(table.sizeBytes).toBe(49152);
  });
});

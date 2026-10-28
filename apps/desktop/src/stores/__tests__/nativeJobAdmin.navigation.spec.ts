import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionConfig } from "@/types/database";
import { activeTabSidebarTarget } from "@/lib/sidebar/sidebarActiveTabTarget";
import { treeNodeRowAction } from "@/lib/sidebar/treeNodeClick";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";

const mocks = vi.hoisted(() => ({
  saveOpenTabsState: vi.fn().mockResolvedValue(undefined),
  loadSchemaCache: vi.fn().mockResolvedValue(null),
  saveSchemaCache: vi.fn().mockResolvedValue(undefined),
  listSchemas: vi.fn().mockResolvedValue(["Owner"]),
  listDatabases: vi.fn().mockResolvedValue([{ name: "DB" }]),
  saveSidebarLayout: vi.fn().mockResolvedValue(undefined),
  checkConnectionHealth: vi.fn().mockResolvedValue(undefined),
  listInstalledAgents: vi.fn().mockResolvedValue([]),
  deleteSchemaCachePrefix: vi.fn().mockResolvedValue(undefined),
  saveConnectionDatabaseInfo: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/backend/api", () => mocks);
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
  setActivePinia(createPinia());
});

describe("native Job navigation through the real stores", () => {
  async function stores(db_type: ConnectionConfig["db_type"], overrides: Partial<ConnectionConfig> = {}) {
    const { useConnectionStore } = await import("@/stores/connectionStore");
    const { useQueryStore } = await import("@/stores/queryStore");
    const connection = { id: "c", name: "Test", db_type, host: "localhost", port: 1521, username: "Owner", password: "", database: "Service-not-owner", ...overrides };
    const connections = useConnectionStore();
    connections.addEphemeralConnection(connection);
    connections.treeNodes = [{ id: "c", label: "Test", type: "connection", connectionId: "c", children: [] }];
    return { connections, queries: useQueryStore() };
  }
  it("reuses one connection-level tab and sends new exact selections without mutating the caller", async () => {
    const { queries } = await stores("oracle");
    const first = { kind: "scheduler" as const, owner: "Owner.One", name: 'Job,"One' };
    const id = queries.openDatabaseJobAdmin("c", first);
    first.owner = "Changed outside";
    expect(queries.tabs[0]).toMatchObject({ id, mode: "database-jobs", database: "", nativeJobAdmin: { owner: "Owner.One", name: 'Job,"One' } });
    const again = queries.openDatabaseJobAdmin("c", { kind: "legacy", jobId: "900719925474099312345" });
    expect(again).toBe(id);
    expect(queries.tabs).toHaveLength(1);
    expect(queries.tabs[0]?.nativeJobAdmin).toEqual({ kind: "legacy", jobId: "900719925474099312345" });
    expect(activeTabSidebarTarget(queries.tabs[0])).toEqual({ type: "management", connectionId: "c", nodeType: "database-job-admin" });
    expect(treeNodeRowAction("database-job-admin", false, "double", "oracle")).toBe("toggle");
  }, 30_000);
  it("keeps the existing Dameng tab entry and does not create a second parallel page", async () => {
    const { queries } = await stores("dameng");
    const old = queries.openDamengJobAdmin("c");
    expect(queries.openDatabaseJobAdmin("c")).toBe(old);
    expect(queries.tabs).toHaveLength(1);
    expect(queries.tabs[0]?.mode).toBe("dameng-jobs");
  });
  it("replaces the Job utility category after actual JDBC metadata without replacing loaded nodes", async () => {
    const { connections, queries } = await stores("jdbc", { driver_label: "Dameng", connection_string: "jdbc:oceanbase://host/db" });
    await connections.loadDatabases("c", { force: true });
    const node = connections.treeNodes[0]!;
    node.isExpanded = true;
    const metadataChild = node.children!.find((child) => child.type !== "dameng-job-admin")!;
    expect(node.children!.some((child) => child.type === "dameng-job-admin")).toBe(true);
    await connections.updateConnectionDatabaseInfo("c", { productName: "OceanBase", compatibilityMode: "oracle" });
    expect(connections.treeNodes[0]).toBe(node);
    expect(node.isExpanded).toBe(true);
    expect(node.children).toContain(metadataChild);
    expect(node.children!.filter((child) => child.type === "database-job-admin" || child.type === "dameng-job-admin").map((child) => child.type)).toEqual(["database-job-admin"]);
    queries.openDatabaseJobAdmin("c");
    expect(queries.tabs[0]?.mode).toBe("database-jobs");
    await connections.updateConnectionDatabaseInfo("c", { productName: "OceanBase" });
    expect(connections.treeNodes[0]).toBe(node);
    expect(node.children).toContain(metadataChild);
    expect(node.children!.some((child) => child.type === "database-job-admin" || child.type === "dameng-job-admin")).toBe(false);
  });
  it("adds JDBC Job access when background mode arrives and ignores a changed-config response", async () => {
    const { connections } = await stores("jdbc", { connection_string: "jdbc:oceanbase://host/db" });
    await connections.loadDatabases("c", { force: true });
    const node = connections.treeNodes[0]!;
    expect(node.children!.some((child) => child.type === "database-job-admin")).toBe(false);
    await connections.updateConnectionDatabaseInfo("c", { productName: "OceanBase", compatibilityMode: "oracle" });
    expect(node.children!.filter((child) => child.type === "database-job-admin")).toHaveLength(1);
    const config = connections.getConfig("c")!;
    const fingerprint = connectionConfigFingerprint(config);
    let finish!: () => void;
    mocks.saveConnectionDatabaseInfo.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = connections.updateConnectionDatabaseInfo("c", { productName: "OceanBase", compatibilityMode: "mysql" }, fingerprint);
    config.username = "Changed";
    finish();
    await pending;
    expect(connections.getConfig("c")?.database_info?.compatibilityMode).toBe("oracle");
    expect(node.children!.filter((child) => child.type === "database-job-admin")).toHaveLength(1);
  });
  it.each(["oracle", "oceanbase-oracle", "dameng", "xugu"] as const)("adds only the intended utility entry for %s and never duplicates it on reload", async (type) => {
    const { connections } = await stores(type);
    await connections.loadDatabases("c", { force: true });
    await connections.loadDatabases("c", { force: true });
    const entries = connections.treeNodes[0]?.children?.filter((node) => node.type === "database-job-admin" || node.type === "dameng-job-admin");
    expect(entries?.map((node) => node.type)).toEqual(type === "dameng" ? ["dameng-job-admin"] : type === "xugu" ? [] : ["database-job-admin"]);
  });
});

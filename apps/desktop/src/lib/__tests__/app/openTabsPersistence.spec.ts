import { describe, expect, it } from "vitest";
import { serializeOpenTabs, restoreOpenTabsPayload } from "@/lib/app/openTabsPersistence";
import type { QueryTab } from "@/types/database";

function queryTab(overrides: Partial<QueryTab>): QueryTab {
  return {
    id: "t1",
    title: "query_1",
    connectionId: "c1",
    database: "db",
    mode: "query",
    sql: "",
    isExecuting: false,
    ...overrides,
  } as QueryTab;
}

function roundTrip(tabs: QueryTab[]) {
  const saved = serializeOpenTabs(tabs);
  return restoreOpenTabsPayload({ tabs: saved, activeTabId: tabs[0]?.id ?? null }).tabs;
}

describe("openTabsPersistence originalSql round-trip", () => {
  it("preserves per-tab output view state across a round-trip", () => {
    const [restored] = roundTrip([queryTab({ uiState: { activeOutputView: "chart", resultPaneOpen: false } })]);

    expect(restored.uiState).toEqual({ activeOutputView: "chart", resultPaneOpen: false });
  });

  it("preserves namespaced special-page state across a round-trip", () => {
    const uiState = {
      page: {
        etcd: {
          EtcdKeyBrowser: { mode: "search", searchQuery: "orders" },
          KvKeyBrowser: { selectedKey: "/orders/42", expandedGroupIds: ["group:/orders"] },
        },
      },
    };
    const [restored] = roundTrip([queryTab({ mode: "etcd", uiState })]);

    expect(restored.uiState).toEqual(uiState);
  });

  it("drops invalid per-tab output view state while restoring", () => {
    const [restored] = restoreOpenTabsPayload({
      tabs: [{ id: "t1", title: "query_1", connectionId: "c1", database: "db", mode: "query", sql: "", uiState: { activeOutputView: "invalid", resultPaneOpen: "false" } }],
      activeTabId: "t1",
    }).tabs;

    expect(restored.uiState).toBeUndefined();
  });

  it("keeps clean saved SQL tabs eligible for file hydration", () => {
    const [restored] = roundTrip([queryTab({ savedSqlId: "saved", sql: "SELECT 1", originalSql: "SELECT 1" })]);
    expect(restored.sql).toBe("");
    expect(restored.originalSql).toBeUndefined();
  });

  it("preserves read-only source intent without adding editable source metadata", () => {
    const [restored] = roundTrip([queryTab({ sourceView: true, sql: "CREATE SEQUENCE seq_users" })]);
    expect(restored.sourceView).toBe(true);
    expect(restored.objectSource).toBeUndefined();
  });

  it("preserves the DDL viewer identity needed for read-only tabs", () => {
    const ddlViewer = { schema: "public", tableName: "users", objectType: "VIEW" as const, formatDialect: "postgres" as const };
    const [restored] = roundTrip([queryTab({ sourceView: true, ddlViewer, sql: "CREATE VIEW users AS SELECT 1" })]);

    expect(restored.ddlViewer).toEqual(ddlViewer);
  });

  it("does not persist a pending object-source tab without its in-flight request", () => {
    const pending = queryTab({
      id: "pending-source",
      title: "Source - v_orders",
      sourceView: true,
      sourceLoad: {
        startedAt: Date.now(),
        request: { name: "v_orders", objectType: "VIEW" },
      },
    });

    expect(serializeOpenTabs([pending])).toEqual([]);
  });

  it("keeps legacy query tabs without source intent compatible", () => {
    const [restored] = roundTrip([queryTab({ sql: "SELECT 1" })]);
    expect(restored.sourceView).toBeUndefined();
  });

  it("restores a clean prefilled query tab as clean (sql === originalSql)", () => {
    const sql = 'SELECT * FROM "public"."users"';
    const [restored] = roundTrip([queryTab({ sql, originalSql: sql })]);
    expect(restored.sql).toBe(sql);
    expect(restored.originalSql).toBe(sql);
    expect(restored.sql === restored.originalSql).toBe(true);
  });

  it("restores a user-edited scratch query tab as dirty (originalSql stays empty)", () => {
    const [restored] = roundTrip([queryTab({ sql: "SELECT 1", originalSql: "" })]);
    expect(restored.sql).toBe("SELECT 1");
    expect(restored.originalSql).toBe("");
    expect(restored.sql === restored.originalSql).toBe(false);
  });

  it("restores an empty new query tab as clean", () => {
    const [restored] = roundTrip([queryTab({ sql: "", originalSql: "" })]);
    expect(restored.sql).toBe("");
    expect(restored.originalSql).toBe("");
  });

  it("falls back to empty originalSql for old saved state without the field (backward compat)", () => {
    const [restored] = restoreOpenTabsPayload({
      tabs: [{ id: "t1", title: "query_1", connectionId: "c1", database: "db", mode: "query", sql: "SELECT 1" }],
      activeTabId: "t1",
    }).tabs;
    expect(restored.sql).toBe("SELECT 1");
    expect(restored.originalSql).toBe("");
  });

  it("does not persist the transient result execution target", () => {
    const tab = queryTab({ activeResultRunId: "run-1", executingResultRunId: "run-1", isExecuting: true });
    const [saved] = serializeOpenTabs([tab]);
    const [restored] = restoreOpenTabsPayload({
      tabs: [{ ...saved, executingResultRunId: "run-1" }],
      activeTabId: tab.id,
    }).tabs;

    expect(saved).not.toHaveProperty("executingResultRunId");
    expect(restored.executingResultRunId).toBeUndefined();
    expect(restored.isExecuting).toBe(false);
  });

  it("does not resume a MONITOR stream when restoring tabs", () => {
    const tab = queryTab({ sql: "MONITOR", redisMonitorActive: true, isExecuting: true });
    const [saved] = serializeOpenTabs([tab]);
    const [restored] = roundTrip([tab]);
    expect(saved).not.toHaveProperty("redisMonitorActive");
    expect(restored.redisMonitorActive).toBe(false);
    expect(restored.isExecuting).toBe(false);
  });

  it("preserves an external Doris catalog across tab restore", () => {
    const [restored] = roundTrip([queryTab({ database: "dbx_catalog_completion", catalog: "dbx_mysql_catalog" })]);

    expect(restored.database).toBe("dbx_catalog_completion");
    expect(restored.catalog).toBe("dbx_mysql_catalog");
  });

  it("preserves external file versions and acknowledged state across tab restore", () => {
    const version = { sizeBytes: 9, modifiedNs: "100", contentHash: "original" };
    const ignoredVersion = { sizeBytes: 9, modifiedNs: "200", contentHash: "changed" };
    const [restored] = roundTrip([
      queryTab({
        sql: "SELECT 1",
        originalSql: "SELECT 1",
        externalSqlPath: "/tmp/query.sql",
        externalSqlFileVersion: version,
        externalSqlIgnoredFileVersion: ignoredVersion,
        externalSqlFileMissing: true,
      }),
    ]);

    expect(restored.externalSqlFileVersion).toEqual(version);
    expect(restored.externalSqlIgnoredFileVersion).toEqual(ignoredVersion);
    expect(restored.externalSqlFileMissing).toBe(true);
  });

  it("preserves the disk baseline for a dirty external file after an ignored change", () => {
    const version = { sizeBytes: 9, modifiedNs: "100", contentHash: "original" };
    const ignoredVersion = { sizeBytes: 9, modifiedNs: "200", contentHash: "changed" };
    const [restored] = roundTrip([
      queryTab({
        sql: "SELECT 2",
        originalSql: "SELECT 1",
        externalSqlPath: "/tmp/query.sql",
        externalSqlFileVersion: version,
        externalSqlIgnoredFileVersion: ignoredVersion,
      }),
    ]);

    expect(restored.sql).toBe("SELECT 2");
    expect(restored.originalSql).toBe("SELECT 1");
    expect(restored.externalSqlIgnoredFileVersion).toEqual(ignoredVersion);
  });

  it("preserves the disk baseline for a dirty external file acknowledged as missing", () => {
    const [restored] = roundTrip([
      queryTab({
        sql: "SELECT 2",
        originalSql: "SELECT 1",
        externalSqlPath: "/tmp/query.sql",
        externalSqlFileMissing: true,
      }),
    ]);

    expect(restored.sql).toBe("SELECT 2");
    expect(restored.originalSql).toBe("SELECT 1");
    expect(restored.externalSqlFileMissing).toBe(true);
  });

  it("preserves plugin workbench identity and connection-safe context", () => {
    const [restored] = roundTrip([
      queryTab({
        id: "plugin-tab",
        title: "Hello connection · Workbench",
        connectionId: "plugin-connection",
        database: "",
        mode: "plugin-workbench",
        pluginWorkbench: {
          pluginId: "dbx.example.hello",
          contributionId: "dbx.example.hello.main",
          context: {
            connectionId: "plugin-connection",
            providerId: "hello.connection",
            connectionType: "hello",
          },
        },
      }),
    ]);

    expect(restored.mode).toBe("plugin-workbench");
    expect(restored.pluginWorkbench).toEqual({
      pluginId: "dbx.example.hello",
      contributionId: "dbx.example.hello.main",
      context: {
        connectionId: "plugin-connection",
        providerId: "hello.connection",
        connectionType: "hello",
      },
    });
  });

  it("preserves a result-view tab's entry contribution id and result snapshot", () => {
    const [restored] = roundTrip([
      queryTab({
        id: "plugin-result-view",
        title: "Chart",
        connectionId: "plugin-connection",
        database: "dbx_test",
        mode: "plugin-workbench",
        pluginWorkbench: {
          pluginId: "dbx.example.graph",
          contributionId: "dbx.example.graph.chart",
          context: {
            connectionId: "plugin-connection",
            database: "dbx_test",
            sql: "SELECT 1",
            result: { columns: ["id"], rows: [[1]], truncated: false },
          },
        },
      }),
    ]);

    // `contributionId` names the entry contribution, not a workbench: a restored
    // result-view tab must keep its own id so the renderer can resolve it again.
    expect(restored.pluginWorkbench?.contributionId).toBe("dbx.example.graph.chart");
    expect(restored.pluginWorkbench?.context).toEqual({
      connectionId: "plugin-connection",
      database: "dbx_test",
      sql: "SELECT 1",
      result: { columns: ["id"], rows: [[1]], truncated: false },
    });
  });

  it("preserves host-owned plugin filesystem navigation", () => {
    const [restored] = roundTrip([
      queryTab({
        id: "plugin-files",
        title: "Object storage · Files",
        connectionId: "plugin-connection",
        database: "",
        mode: "plugin-filesystem",
        pluginFilesystem: {
          pluginId: "dbx.example.storage",
          providerId: "dbx.example.storage.files",
          rootUri: "s3://bucket/",
          currentUri: "s3://bucket/reports/",
        },
      }),
    ]);

    expect(restored.mode).toBe("plugin-filesystem");
    expect(restored.pluginFilesystem).toEqual({
      pluginId: "dbx.example.storage",
      providerId: "dbx.example.storage.files",
      rootUri: "s3://bucket/",
      currentUri: "s3://bucket/reports/",
    });
  });
});

describe("openTabsPersistence detached connection tabs", () => {
  it("preserves the original connection name of a kept SQL tab across a round-trip", () => {
    const [restored] = roundTrip([queryTab({ connectionId: "deleted-conn", detachedConnectionName: "prod" })]);

    expect(restored.connectionId).toBe("deleted-conn");
    expect(restored.detachedConnectionName).toBe("prod");
  });

  it("keeps a detached SQL tab even though its connection no longer exists", () => {
    const saved = serializeOpenTabs([queryTab({ id: "orphan", connectionId: "deleted-conn", detachedConnectionName: "prod" })]);

    const { tabs } = restoreOpenTabsPayload({ tabs: saved, activeTabId: "orphan" }, { validConnectionIds: ["other-conn"] });

    // SQL 页签不受 validConnectionIds 过滤，删除连接后保留下来的草稿页签才能跨重启存活。
    expect(tabs.map((tab) => tab.id)).toEqual(["orphan"]);
    expect(tabs[0].detachedConnectionName).toBe("prod");
  });

  it("omits the detached connection name when the tab is bound to a live connection", () => {
    const [saved] = serializeOpenTabs([queryTab({})]);

    expect(saved.detachedConnectionName).toBeUndefined();
  });
});

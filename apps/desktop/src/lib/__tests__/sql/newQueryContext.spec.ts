import { describe, expect, it } from "vitest";
import { buildSelectAllSql, isNewQueryPrefillSupported, resolveNewQueryInitialSql, resolveNewQueryTable, resolveNewQueryTarget } from "@/lib/sql/newQueryContext";
import type { ResolveNewQueryTableInput } from "@/lib/sql/newQueryContext";
import type { QueryTab, TreeNode } from "@/types/database";

function dataTab(overrides: Partial<Pick<QueryTab, "mode" | "connectionId" | "database" | "schema" | "tableMeta" | "structureTableName" | "title">> = {}): ResolveNewQueryTableInput["activeTab"] {
  return {
    mode: "data",
    connectionId: "conn-1",
    database: "app_db",
    schema: "public",
    title: "users",
    tableMeta: { schema: "public", tableName: "users", columns: [], primaryKeys: [] },
    ...overrides,
  };
}

function tableNode(overrides: Partial<Pick<TreeNode, "type" | "connectionId" | "database" | "schema" | "catalog" | "tableName" | "label">> = {}): ResolveNewQueryTableInput["selectedTreeNode"] {
  return { type: "table", connectionId: "conn-1", database: "app_db", schema: "public", tableName: "orders", label: "orders", ...overrides };
}

describe("resolveNewQueryTarget", () => {
  it("inherits an external catalog from the active object browser", () => {
    expect(
      resolveNewQueryTarget({
        activeTab: {
          connectionId: "conn-1",
          database: "bi",
          objectBrowser: { catalog: "paimon_catalog" },
        },
        connections: [{ id: "conn-1", host: "localhost", database: "", db_type: "starrocks" }],
        preferredSource: "tab",
      }),
    ).toEqual({
      connectionId: "conn-1",
      database: "bi",
      schema: undefined,
      catalog: "paimon_catalog",
      shouldRefreshDefaultDatabase: false,
    });
  });

  it("inherits an external catalog from active table metadata", () => {
    expect(
      resolveNewQueryTarget({
        activeTab: {
          connectionId: "conn-1",
          database: "bi",
          tableMeta: {
            catalog: "paimon_catalog",
            tableName: "events",
            columns: [],
            primaryKeys: [],
          },
        },
        connections: [{ id: "conn-1", host: "localhost", database: "", db_type: "starrocks" }],
      })?.catalog,
    ).toBe("paimon_catalog");
  });

  it("repairs a stale SQLite file path inherited from an active tab", () => {
    expect(
      resolveNewQueryTarget({
        activeTab: {
          connectionId: "conn-sqlite",
          database: "/tmp/stale.sqlite",
        },
        connections: [{ id: "conn-sqlite", host: "/tmp/stale.sqlite", database: "/tmp/stale.sqlite", db_type: "sqlite" }],
      }),
    ).toEqual({
      connectionId: "conn-sqlite",
      database: "main",
      schema: undefined,
      catalog: undefined,
      shouldRefreshDefaultDatabase: false,
    });
  });

  it("preserves an attached SQLite database alias inherited from an active tab", () => {
    expect(
      resolveNewQueryTarget({
        activeTab: {
          connectionId: "conn-sqlite",
          database: "analytics.db",
        },
        connections: [{ id: "conn-sqlite", host: "primary.db", database: undefined, db_type: "sqlite" }],
      })?.database,
    ).toBe("analytics.db");
  });

  it("uses the configured default schema when no explicit schema context exists", () => {
    expect(
      resolveNewQueryTarget({
        activeConnectionId: "conn-1",
        connections: [{ id: "conn-1", host: "localhost", database: "app", default_schema: "archive", db_type: "postgres" }],
      }),
    ).toMatchObject({ connectionId: "conn-1", database: "app", schema: "archive" });
  });

  it("keeps an explicitly selected schema ahead of the configured default", () => {
    expect(
      resolveNewQueryTarget({
        selectedTreeNode: { connectionId: "conn-1", database: "app", schema: "reporting" },
        connections: [{ id: "conn-1", host: "localhost", database: "app", default_schema: "archive", db_type: "postgres" }],
        preferredSource: "sidebar",
      })?.schema,
    ).toBe("reporting");
  });
});

describe("resolveNewQueryTable", () => {
  it("resolves the table from an active data tab", () => {
    const table = resolveNewQueryTable({ activeTab: dataTab(), preferredSource: "tab" });
    expect(table).toEqual({ connectionId: "conn-1", database: "app_db", schema: "public", catalog: undefined, tableName: "users" });
  });

  it("returns null when a data tab has no loaded tableMeta (still loading or errored)", () => {
    // A data tab's title is schema/catalog-qualified (e.g. "public.events"), so it must
    // not be used as a bare table name - require the loaded tableMeta instead.
    const table = resolveNewQueryTable({
      activeTab: { mode: "data", connectionId: "conn-1", database: "app_db", schema: "public", title: "public.events" },
      preferredSource: "tab",
    });
    expect(table).toBeNull();
  });

  it("resolves the table from an active structure tab", () => {
    const table = resolveNewQueryTable({
      activeTab: { mode: "structure", connectionId: "conn-1", database: "app_db", schema: "public", structureTableName: "users" },
      preferredSource: "tab",
    });
    expect(table).toEqual({ connectionId: "conn-1", database: "app_db", schema: "public", catalog: undefined, tableName: "users" });
  });

  it("returns null for a query tab with no table context", () => {
    const table = resolveNewQueryTable({
      activeTab: { mode: "query", connectionId: "conn-1", database: "app_db", schema: "public", title: "query_1" },
      preferredSource: "tab",
    });
    expect(table).toBeNull();
  });

  it("resolves the table from a selected sidebar table/view/materialized_view node", () => {
    expect(resolveNewQueryTable({ selectedTreeNode: tableNode(), preferredSource: "sidebar" })?.tableName).toBe("orders");
    expect(resolveNewQueryTable({ selectedTreeNode: tableNode({ type: "view" }), preferredSource: "sidebar" })?.tableName).toBe("orders");
    expect(resolveNewQueryTable({ selectedTreeNode: tableNode({ type: "materialized_view" }), preferredSource: "sidebar" })?.tableName).toBe("orders");
  });

  it("uses the node label when tableName is absent", () => {
    const table = resolveNewQueryTable({
      selectedTreeNode: { type: "table", connectionId: "conn-1", database: "app_db", schema: "public", label: "by_label" },
      preferredSource: "sidebar",
    });
    expect(table?.tableName).toBe("by_label");
  });

  it("ignores sidebar nodes that are not tables", () => {
    const table = resolveNewQueryTable({
      selectedTreeNode: { type: "schema", connectionId: "conn-1", label: "public" },
      preferredSource: "sidebar",
    });
    expect(table).toBeNull();
  });

  it("prefers the active tab when preferredSource is 'tab'", () => {
    const table = resolveNewQueryTable({ activeTab: dataTab(), selectedTreeNode: tableNode(), preferredSource: "tab" });
    expect(table?.tableName).toBe("users");
  });

  it("prefers the sidebar node when preferredSource is 'sidebar'", () => {
    const table = resolveNewQueryTable({ activeTab: dataTab(), selectedTreeNode: tableNode(), preferredSource: "sidebar" });
    expect(table?.tableName).toBe("orders");
  });

  it("falls back to the secondary context when the primary has no table", () => {
    const table = resolveNewQueryTable({
      activeTab: { mode: "query", connectionId: "conn-1", database: "app_db", title: "query_1" },
      selectedTreeNode: tableNode(),
      preferredSource: "tab",
    });
    expect(table?.tableName).toBe("orders");
  });

  it("returns null when no context is available", () => {
    expect(resolveNewQueryTable({})).toBeNull();
    expect(resolveNewQueryTable({ activeTab: null, selectedTreeNode: null })).toBeNull();
  });
});

describe("buildSelectAllSql", () => {
  it("builds a MetricsQL range query for VictoriaMetrics metrics", () => {
    expect(buildSelectAllSql("victoriametrics", { tableName: "flag" })).toBe('{__name__="flag"}[1h]');
  });

  it("quotes a MySQL table with backticks", () => {
    expect(buildSelectAllSql("mysql", { tableName: "users" })).toBe("SELECT * FROM `users`");
  });

  it("ignores the schema for non-schema-aware databases like MySQL", () => {
    expect(buildSelectAllSql("mysql", { schema: "mydb", tableName: "users" })).toBe("SELECT * FROM `users`");
  });

  it("qualifies and quotes a PostgreSQL table with its schema", () => {
    expect(buildSelectAllSql("postgres", { schema: "public", tableName: "users" })).toBe('SELECT * FROM "public"."users"');
  });

  it("bracket-quotes a SQL Server table", () => {
    expect(buildSelectAllSql("sqlserver", { schema: "dbo", tableName: "users" })).toBe("SELECT * FROM [dbo].[users]");
    expect(buildSelectAllSql("sqlserver", { tableName: "users" })).toBe("SELECT * FROM [users]");
  });

  it("escapes embedded quote characters", () => {
    expect(buildSelectAllSql("mysql", { tableName: "a`b" })).toBe("SELECT * FROM `a``b`");
    expect(buildSelectAllSql("postgres", { tableName: 'a"b' })).toBe('SELECT * FROM "a""b"');
  });
  it("qualifies a StarRocks external-catalog table with catalog and database", () => {
    expect(buildSelectAllSql("starrocks", { catalog: "paimon_catalog", database: "bi", tableName: "events" })).toBe("SELECT * FROM `paimon_catalog`.`bi`.`events`");
  });
  it("uses the driver-reported identifier quote for Kingbase MySQL compat mode", () => {
    expect(buildSelectAllSql("kingbase", { schema: "audit_schema", tableName: "events" }, "`")).toBe("SELECT * FROM `audit_schema`.`events`");
  });
  it("uses the driver-reported identifier quote for Kingbase PostgreSQL mode", () => {
    expect(buildSelectAllSql("kingbase", { schema: "audit_schema", tableName: "events" }, '"')).toBe('SELECT * FROM "audit_schema"."events"');
  });
  it("falls back to double quotes for Kingbase when no identifier quote is reported", () => {
    expect(buildSelectAllSql("kingbase", { schema: "audit_schema", tableName: "events" })).toBe('SELECT * FROM "audit_schema"."events"');
  });
});

describe("isNewQueryPrefillSupported", () => {
  it("disables the prefill for Neo4j (Cypher, not SQL)", () => {
    expect(isNewQueryPrefillSupported("neo4j")).toBe(false);
  });

  it("enables the prefill for standard SQL databases", () => {
    expect(isNewQueryPrefillSupported("mysql")).toBe(true);
    expect(isNewQueryPrefillSupported("postgres")).toBe(true);
    expect(isNewQueryPrefillSupported("sqlserver")).toBe(true);
    expect(isNewQueryPrefillSupported("sqlite")).toBe(true);
    expect(isNewQueryPrefillSupported("clickhouse")).toBe(true);
  });

  it("enables the prefill when the database type is unknown", () => {
    expect(isNewQueryPrefillSupported(undefined)).toBe(true);
  });
});

describe("resolveNewQueryInitialSql", () => {
  it("prefills SQL from the active table when enabled", () => {
    expect(
      resolveNewQueryInitialSql({
        activeTab: dataTab(),
        prefillEnabled: true,
        targetConnectionId: "conn-1",
        targetDatabase: "app_db",
        databaseType: "postgres",
      }),
    ).toBe('SELECT * FROM "public"."users"');
  });

  it("leaves new queries empty when the setting is disabled", () => {
    expect(
      resolveNewQueryInitialSql({
        activeTab: dataTab(),
        prefillEnabled: false,
        targetConnectionId: "conn-1",
        targetDatabase: "app_db",
        databaseType: "postgres",
      }),
    ).toBeUndefined();
  });

  it("does not prefill a table from another connection", () => {
    expect(
      resolveNewQueryInitialSql({
        activeTab: dataTab({ connectionId: "conn-2" }),
        prefillEnabled: true,
        targetConnectionId: "conn-1",
        targetDatabase: "app_db",
        databaseType: "postgres",
      }),
    ).toBeUndefined();
  });

  it("does not prefill a table from another database on the same connection", () => {
    expect(
      resolveNewQueryInitialSql({
        activeTab: { mode: "query", connectionId: "conn-1", database: "db_a", title: "query_1" },
        selectedTreeNode: tableNode({ database: "db_b" }),
        preferredSource: "tab",
        prefillEnabled: true,
        targetConnectionId: "conn-1",
        targetDatabase: "db_a",
        databaseType: "mysql",
      }),
    ).toBeUndefined();
  });

  it("leaves new queries empty without a table context", () => {
    expect(
      resolveNewQueryInitialSql({
        prefillEnabled: true,
        targetConnectionId: "conn-1",
        targetDatabase: "app_db",
        databaseType: "postgres",
      }),
    ).toBeUndefined();
  });

  it("does not prefill for unsupported database types (e.g. Neo4j)", () => {
    expect(
      resolveNewQueryInitialSql({
        activeTab: dataTab(),
        prefillEnabled: true,
        targetConnectionId: "conn-1",
        targetDatabase: "app_db",
        databaseType: "neo4j",
      }),
    ).toBeUndefined();
  });
});

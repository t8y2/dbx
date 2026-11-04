import { describe, expect, it } from "vitest";
import { activeTabSidebarTarget, matchesTarget, findNodePathForActiveTab, expandSidebarLocatePath } from "@/lib/sidebar/sidebarActiveTabTarget";
import { oracleSchemaJobGroups, nativeJobObjectNode } from "@/lib/sidebar/oracleObjectNavigation";
import { findLoadedTableTargetForCandidate, queryCursorTableCandidate } from "@/lib/sql/queryCursorTableTarget";
import type { QueryTab, TreeNode } from "@/types/database";

describe("sidebar active-tab targets", () => {
  it("locates scoped jobs by schema, kind and exact selection instead of the removed global entry", () => {
    const schema: TreeNode = { id: "schema", type: "schema", label: "A", connectionId: "c", database: "DB", schema: "A" };
    schema.children = oracleSchemaJobGroups(schema);
    const legacy = schema.children[0]!.children![3]!;
    const scheduler = schema.children[0]!.children![0]!;
    const selection = { kind: "scheduler" as const, owner: "A", name: "SAME" };
    scheduler.children = [nativeJobObjectNode(scheduler, selection, "SAME")];
    legacy.children = [nativeJobObjectNode(legacy, { kind: "legacy", jobId: "900719925474099312345" }, "SAME")];
    const tab = { mode: "database-jobs", connectionId: "c", database: "DB", nativeJobPage: { schema: "A", kind: "scheduler", schedulerCategory: "regular" }, nativeJobAdmin: selection } as QueryTab;
    const path = findNodePathForActiveTab(tab, [schema])!;
    expect(path.map((node) => node.type)).toEqual(["schema", "native-job-scheduler", "native-job-group", "native-job"]);
    expandSidebarLocatePath(path, (node) => node.type === "schema" || node.type === "native-job-group");
    expect(schema.children[0]?.isExpanded).toBe(true);
    expect(scheduler.isExpanded).toBe(true);
    expect(scheduler.children[0]?.isExpanded).toBe(false);
    const target = activeTabSidebarTarget(tab)!;
    expect(matchesTarget(legacy.children[0]!, target)).toBe(false);
    expect(matchesTarget({ ...scheduler.children[0]!, database: "Other" }, target)).toBe(false);
    expect(matchesTarget({ ...scheduler.children[0]!, nativeJobPage: { schema: "B", kind: "scheduler" }, nativeJobSelection: { ...selection, owner: "B" } }, target)).toBe(false);
    expect(findNodePathForActiveTab({ ...tab, nativeJobAdmin: undefined }, [schema])?.at(-1)).toBe(scheduler);
    expect(activeTabSidebarTarget({ ...tab, nativeJobPage: undefined })).toEqual({ type: "connection", connectionId: "c" });
  });
  it("locates an old unclassified Scheduler page at the job parent without guessing a style", () => {
    const schema: TreeNode = { id: "schema", type: "schema", label: "A", connectionId: "c", database: "DB", schema: "A" };
    schema.children = oracleSchemaJobGroups(schema);
    for (const nativeJobAdmin of [undefined, { kind: "scheduler" as const, owner: "A", name: "OLD" }]) {
      const tab = { mode: "database-jobs", connectionId: "c", database: "DB", nativeJobPage: { schema: "A", kind: "scheduler" }, nativeJobAdmin } as QueryTab;
      expect(findNodePathForActiveTab(tab, [schema])?.at(-1)).toBe(schema.children[0]);
      expect(schema.children[0]!.children!.every((node) => !matchesTarget(node, activeTabSidebarTarget(tab)!))).toBe(true);
    }
  });
  it("selects the connection node for a database-browser tab", () => {
    const target = activeTabSidebarTarget({ mode: "databases", connectionId: "pg-1" } as QueryTab);

    expect(target).toEqual({ type: "connection", connectionId: "pg-1" });
    expect(matchesTarget({ id: "connection:pg-1", label: "Postgres", type: "connection", connectionId: "pg-1" } as TreeNode, target!)).toBe(true);
    expect(matchesTarget({ id: "connection:pg-2", label: "Other", type: "connection", connectionId: "pg-2" } as TreeNode, target!)).toBe(false);
  });

  it("selects the Meilisearch system-management leaf for its dedicated tab", () => {
    const target = activeTabSidebarTarget({ mode: "meilisearch-system", connectionId: "meili-1" } as QueryTab);
    expect(target).toEqual({ type: "meilisearch-system", connectionId: "meili-1" });
    expect(matchesTarget({ id: "meili-system", label: "meilisearch.systemManagement", type: "meilisearch-system", connectionId: "meili-1" }, target!)).toBe(true);
  });

  it("locates a query context only in its exact catalog", () => {
    const target = activeTabSidebarTarget({ mode: "query", connectionId: "doris-1", catalog: "hive", database: "analytics" } as QueryTab);
    const hiveDatabase = { id: "hive:analytics", label: "analytics", type: "database", connectionId: "doris-1", catalog: "hive", database: "analytics" } as TreeNode;
    const icebergDatabase = { ...hiveDatabase, id: "iceberg:analytics", catalog: "iceberg" };
    const defaultDatabase = { ...hiveDatabase, id: "default:analytics", catalog: undefined };

    expect(matchesTarget(hiveDatabase, target!)).toBe(true);
    expect(matchesTarget(icebergDatabase, target!)).toBe(false);
    expect(matchesTarget(defaultDatabase, target!)).toBe(false);
  });

  it("uses data-tab table metadata as the locate identity after a reload", () => {
    const target = activeTabSidebarTarget({
      mode: "data",
      connectionId: "dm-1",
      database: "SERVICE_DB",
      schema: "APP_OWNER",
      title: "ORDERS",
      sql: "SELECT * FROM APP_OWNER.ORDERS",
      tableMeta: {
        database: "APP_OWNER",
        schema: "APP_OWNER",
        tableName: "ORDERS",
        tableType: "TABLE",
        columns: [{ name: "ID", data_type: "INTEGER", is_nullable: false, column_default: null, is_primary_key: true, extra: null }],
        primaryKeys: ["ID"],
      },
    } as QueryTab);

    expect(target).toEqual({ type: "table", connectionId: "dm-1", database: "APP_OWNER", schema: "APP_OWNER", tableName: "ORDERS" });
    expect(matchesTarget({ id: "dm-1:APP_OWNER:APP_OWNER:tables:ORDERS", label: "ORDERS", type: "table", connectionId: "dm-1", database: "APP_OWNER", schema: "APP_OWNER" } as TreeNode, target!)).toBe(true);
    expect(matchesTarget({ id: "dm-1:SERVICE_DB", label: "SERVICE_DB", type: "database", connectionId: "dm-1", database: "SERVICE_DB" } as TreeNode, target!)).toBe(false);
  });
});

describe("locating workspace tabs", () => {
  it("uses the object browser namespace instead of the tab display title", () => {
    const target = activeTabSidebarTarget({ mode: "objects", connectionId: "conn", database: "db", title: "renamed", objectBrowser: { schema: "public", catalog: "external" } } as QueryTab);
    expect(target).toEqual({ type: "query-context", connectionId: "conn", database: "db", schema: "public", catalog: "external" });
    expect(matchesTarget({ type: "schema", connectionId: "conn", database: "db", schema: "public", label: "public", catalog: "external" } as TreeNode, target!)).toBe(true);
  });

  it("locates a saved query by its execution context without changing its saved-file association", () => {
    const tab = { mode: "query", connectionId: "conn", database: "DB", schema: "A", catalog: "catalog", savedSqlId: "retained-file", sql: "SELECT 'draft'" } as QueryTab;
    expect(activeTabSidebarTarget(tab)).toEqual({ type: "query-context", connectionId: "conn", database: "DB", schema: "A", catalog: "catalog" });
    expect(tab).toMatchObject({ savedSqlId: "retained-file", sql: "SELECT 'draft'" });
  });

  it.each(["database", "mongo-db", "vector-database"] as const)("locates an object browser in a %s tree", (type) => {
    const target = activeTabSidebarTarget({ mode: "objects", connectionId: "conn", database: "db" } as QueryTab);
    expect(matchesTarget({ type, connectionId: "conn", database: "db", label: "db" } as TreeNode, target!)).toBe(true);
  });

  it("locates Redis by database number, independent of its alias and key count", () => {
    const target = activeTabSidebarTarget({ mode: "redis", connectionId: "conn", database: "0" } as QueryTab);
    expect(matchesTarget({ type: "redis-db", connectionId: "conn", database: "0", label: "Cache (123)" } as TreeNode, target!)).toBe(true);
    expect(matchesTarget({ type: "redis-db", connectionId: "conn", database: "1", label: "Cache (123)" } as TreeNode, target!)).toBe(false);
  });

  it("locates structure tabs by their object identity and catalog", () => {
    const target = activeTabSidebarTarget({ mode: "structure", connectionId: "conn", database: "db", catalog: "external", structureTableName: "orders", title: "renamed" } as QueryTab);
    const node = { type: "table", connectionId: "conn", database: "db", catalog: "external", label: "orders" } as TreeNode;
    expect(matchesTarget(node, target!)).toBe(true);
    expect(matchesTarget({ ...node, catalog: "other" }, target!)).toBe(false);
  });

  it.each(["mysql-dashboard", "postgres-dashboard", "xugu-dashboard", "nacos-dashboard", "solr-admin", "processlist"] as const)("locates the connection for %s", (mode) => {
    const target = activeTabSidebarTarget({ mode, connectionId: "conn" } as QueryTab);
    expect(target).toEqual({ type: "connection", connectionId: "conn" });
    expect(matchesTarget({ id: "conn", label: "renamed", type: "connection", connectionId: "conn" }, target!)).toBe(true);
    expect(matchesTarget({ id: "other", label: "renamed", type: "connection", connectionId: "other" }, target!)).toBe(false);
    expect(activeTabSidebarTarget({ mode, connectionId: "" } as QueryTab)).toBeNull();
  });

  it.each(["mq", "redis-dashboard", "plugin-workbench"] as const)("locates the connection for %s without an object target", (mode) => {
    expect(activeTabSidebarTarget({ mode, connectionId: "conn" } as QueryTab)).toEqual({ type: "connection", connectionId: "conn" });
    expect(activeTabSidebarTarget({ mode, connectionId: "" } as QueryTab)).toBeNull();
  });
});

describe("table locate candidates", () => {
  it("keeps catalog scope from the query through loaded-node resolution", () => {
    const candidate = queryCursorTableCandidate({ mode: "query", connectionId: "conn", catalog: "hive", database: "db", sql: "SELECT * FROM orders" } as QueryTab, "doris");
    expect(candidate?.catalog).toBe("hive");
    const wrong = { type: "table", connectionId: "conn", database: "db", catalog: "iceberg", label: "orders" } as TreeNode;
    expect(findLoadedTableTargetForCandidate([wrong], candidate!)).toBeNull();
    expect(findLoadedTableTargetForCandidate([wrong, { ...wrong, catalog: "hive" }], candidate!)?.type).toBe("table");
  });

  it("accepts the database as the effective schema for schema-less table nodes", () => {
    const target = findLoadedTableTargetForCandidate([{ type: "table", connectionId: "conn", database: "db", label: "orders" } as TreeNode], { connectionId: "conn", database: "db", schema: "db", tableName: "orders" });
    expect(target?.type).toBe("table");
  });
});

describe("management page sidebar targets", () => {
  it.each([
    ["users", "user-admin"],
    ["xugu-users", "xugu-user-admin"],
    ["dameng-users", "dameng-users"],
    ["dameng-roles", "dameng-roles"],
    ["dameng-jobs", "dameng-job-admin"],
  ] as const)("locates %s at its connection instead of the retired %s node", (mode, nodeType) => {
    const target = activeTabSidebarTarget({ mode, connectionId: "conn" } as QueryTab);
    expect(target).toEqual({ type: "connection", connectionId: "conn" });
    const node = { id: "management", type: nodeType, connectionId: "conn", label: "translated label" } as TreeNode;
    expect(matchesTarget(node, target!)).toBe(false);
    expect(matchesTarget({ ...node, type: "connection" }, target!)).toBe(true);
    expect(matchesTarget({ ...node, connectionId: "other" }, target!)).toBe(false);
    expect(activeTabSidebarTarget({ mode, connectionId: "" } as QueryTab)).toBeNull();
  });
});

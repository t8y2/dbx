import { strict as assert } from "node:assert";
import { test } from "vitest";
import { activeTabSidebarTarget, findNodePathForTarget, findSidebarConnectionNode, findSidebarNodeForActiveTab, findSidebarNodeForTarget, scrollTopForSidebarNode, shouldScrollActiveSidebarSelection } from "../../apps/desktop/src/lib/sidebar/sidebarActiveTabTarget.ts";
import { buildTreeNodesFromLayout, expandGroups } from "../../apps/desktop/src/lib/sidebar/sidebarLayout.ts";
import { flattenTree } from "../../apps/desktop/src/composables/useFlatTree.ts";
import type { FlatTreeNode } from "../../apps/desktop/src/composables/useFlatTree.ts";
import type { ConnectionConfig, QueryTab, SidebarLayout, TreeNode } from "../../apps/desktop/src/types/database.ts";

function flat(node: TreeNode, depth = 0): FlatTreeNode {
  return { id: node.id, node, depth, type: node.type };
}

test("findSidebarConnectionNode resolves grouped roots without scanning descendants", () => {
  const groupedConnection: TreeNode = {
    id: "conn-grouped",
    label: "Grouped",
    type: "connection",
    connectionId: "conn-grouped",
    children: [
      {
        id: "conn-grouped:app",
        label: "app",
        type: "database",
        connectionId: "conn-grouped",
        database: "app",
      },
    ],
  };
  const nestedGroups: TreeNode[] = [
    {
      id: "group-outer",
      label: "Outer",
      type: "connection-group",
      children: [
        {
          id: "group-inner",
          label: "Inner",
          type: "connection-group",
          children: [groupedConnection],
        },
      ],
    },
  ];

  assert.equal(findSidebarConnectionNode(nestedGroups, "conn-grouped"), groupedConnection);
  assert.equal(findSidebarConnectionNode(nestedGroups, "missing"), null);
  assert.equal(
    findSidebarConnectionNode(
      [
        {
          id: "conn-root",
          label: "Root",
          type: "connection",
          connectionId: "conn-root",
          children: [
            {
              id: "conn-nested-decoy",
              label: "Decoy",
              type: "connection",
              connectionId: "conn-grouped",
            },
          ],
        },
        ...nestedGroups,
      ],
      "conn-grouped",
    ),
    groupedConnection,
  );
});

test("findNodePathForTarget handles loaded, unloaded, and MySQL schema fallback trees", () => {
  const cases = [
    {
      name: "nested table path",
      tree: [
        {
          id: "conn-1",
          label: "mysql.example.test",
          type: "connection",
          connectionId: "conn-1",
          isExpanded: true,
          children: [
            {
              id: "conn-1:__user_admin",
              label: "tree.userAdmin",
              type: "user-admin",
              connectionId: "conn-1",
              database: "",
              isExpanded: false,
            },
            {
              id: "conn-1:app",
              label: "app",
              type: "database",
              connectionId: "conn-1",
              database: "app",
              isExpanded: true,
              children: [
                {
                  id: "conn-1:app:__tables",
                  label: "tree.tables",
                  type: "group-tables",
                  connectionId: "conn-1",
                  database: "app",
                  isExpanded: true,
                  children: [
                    {
                      id: "conn-1:app:__tables:users",
                      label: "users",
                      type: "table",
                      connectionId: "conn-1",
                      database: "app",
                      isExpanded: false,
                      children: [],
                      pinned: false,
                    },
                  ],
                  pinned: false,
                },
              ],
              pinned: false,
            },
          ],
          pinned: false,
        },
      ],
      target: {
        type: "table",
        connectionId: "conn-1",
        database: "app",
        tableName: "users",
      },
      expectedPath: ["conn-1", "conn-1:app", "conn-1:app:__tables", "conn-1:app:__tables:users"],
    },
    {
      name: "unloaded connection tree",
      tree: [
        {
          id: "mysql-conn-1",
          label: "mysql.example.test",
          type: "connection",
          connectionId: "mysql-conn-1",
          isExpanded: false,
          children: [
            {
              id: "mysql-conn-1:__user_admin",
              label: "tree.userAdmin",
              type: "user-admin",
              connectionId: "mysql-conn-1",
              database: "",
              isExpanded: false,
            },
          ],
          pinned: false,
        },
      ],
      target: {
        type: "query-context",
        connectionId: "mysql-conn-1",
        database: "app_prd",
      },
      expectedPath: null,
    },
    {
      name: "MySQL schema fallback to database",
      tree: [
        {
          id: "mysql-conn-1",
          label: "mysql.example.test",
          type: "connection",
          connectionId: "mysql-conn-1",
          isExpanded: true,
          children: [
            {
              id: "mysql-conn-1:app_dev",
              label: "app_dev",
              type: "database",
              connectionId: "mysql-conn-1",
              database: "app_dev",
              isExpanded: true,
              children: [
                {
                  id: "mysql-conn-1:app_dev:__tables",
                  label: "tree.tables",
                  type: "group-tables",
                  connectionId: "mysql-conn-1",
                  database: "app_dev",
                  isExpanded: true,
                  children: [
                    {
                      id: "mysql-conn-1:app_dev:__tables:enum_info",
                      label: "enum_info",
                      type: "table",
                      tableType: "BASE TABLE",
                      connectionId: "mysql-conn-1",
                      database: "app_dev",
                      isExpanded: false,
                      children: [],
                      pinned: false,
                    },
                  ],
                  pinned: false,
                },
              ],
              pinned: false,
            },
          ],
        },
      ],
      target: {
        type: "table",
        connectionId: "mysql-conn-1",
        database: "app_dev",
        schema: "app_dev",
        tableName: "enum_info",
      },
      expectedPath: ["mysql-conn-1", "mysql-conn-1:app_dev", "mysql-conn-1:app_dev:__tables", "mysql-conn-1:app_dev:__tables:enum_info"],
    },
  ] satisfies Array<{
    name: string;
    tree: TreeNode[];
    target: Parameters<typeof findNodePathForTarget>[0];
    expectedPath: string[] | null;
  }>;

  for (const item of cases) {
    const path = findNodePathForTarget(item.target, item.tree);
    assert.deepEqual(path?.map((node) => node.id) ?? null, item.expectedPath, item.name);
  }
});

test("data tabs target the matching visible table or view node", () => {
  const tab: QueryTab = {
    id: "tab-1",
    title: "users",
    connectionId: "conn-1",
    database: "app",
    sql: "",
    isExecuting: false,
    mode: "data",
    tableMeta: { schema: "public", tableName: "users", columns: [], primaryKeys: [] },
  };
  const users: TreeNode = {
    id: "users-node",
    label: "users",
    type: "table",
    connectionId: "conn-1",
    database: "app",
    schema: "public",
  };

  assert.deepEqual(activeTabSidebarTarget(tab), {
    type: "table",
    connectionId: "conn-1",
    database: "app",
    schema: "public",
    tableName: "users",
  });
  assert.equal(findSidebarNodeForActiveTab(tab, [flat(users)])?.id, "users-node");
});

test("mongo tabs target the matching visible collection node", () => {
  const tab: QueryTab = {
    id: "tab-1",
    title: "app.events",
    connectionId: "conn-1",
    database: "app",
    sql: "events",
    isExecuting: false,
    mode: "mongo",
  };
  const collection: TreeNode = {
    id: "events-node",
    label: "events",
    type: "mongo-collection",
    connectionId: "conn-1",
    database: "app",
  };

  assert.equal(findSidebarNodeForActiveTab(tab, [flat(collection)])?.id, "events-node");
});

test("HBase tabs target the matching table in their namespace", () => {
  const tab: QueryTab = {
    id: "tab-hbase",
    title: "events",
    connectionId: "conn-hbase",
    database: "analytics",
    sql: "events",
    isExecuting: false,
    mode: "hbase",
  };
  const table: TreeNode = {
    id: "hbase-events",
    label: "events",
    type: "table",
    connectionId: "conn-hbase",
    database: "analytics",
  };

  assert.deepEqual(activeTabSidebarTarget(tab), {
    type: "hbase-table",
    connectionId: "conn-hbase",
    namespace: "analytics",
    tableName: "events",
  });
  assert.equal(findSidebarNodeForActiveTab(tab, [flat(table)])?.id, "hbase-events");
});

test("GridFS tabs target the shared GridFS sidebar entry", () => {
  const managerTab: QueryTab = {
    id: "tab-gridfs",
    title: "GridFS",
    connectionId: "conn-1",
    database: "app",
    sql: "",
    isExecuting: false,
    mode: "mongo-gridfs" as QueryTab["mode"],
  };
  const bucketTab: QueryTab = {
    id: "tab-bucket",
    title: "app.receipts",
    connectionId: "conn-1",
    database: "app",
    sql: "receipts",
    isExecuting: false,
    mode: "mongo-bucket",
    mongoBucket: {
      bucketName: "receipts",
    },
  };
  const gridFsNode: TreeNode = {
    id: "gridfs-node",
    label: "GridFS",
    type: "mongo-gridfs" as TreeNode["type"],
    connectionId: "conn-1",
    database: "app",
  };

  assert.deepEqual(activeTabSidebarTarget(managerTab), {
    type: "mongo-gridfs",
    connectionId: "conn-1",
    database: "app",
  });
  assert.deepEqual(activeTabSidebarTarget(bucketTab), {
    type: "mongo-gridfs",
    connectionId: "conn-1",
    database: "app",
  });
  assert.equal(findSidebarNodeForActiveTab(managerTab, [flat(gridFsNode)])?.id, "gridfs-node");
  assert.equal(findSidebarNodeForActiveTab(bucketTab, [flat(gridFsNode)])?.id, "gridfs-node");
});

test("MQ tabs with a selected tenant target the matching tenant node", () => {
  const tab: QueryTab = {
    id: "tab-1",
    title: "Apache Pulsar Admin",
    connectionId: "conn-1",
    database: "",
    sql: "",
    isExecuting: false,
    mode: "mq",
    mqTenant: "public",
  };
  const tenant: TreeNode = {
    id: "tenant-node",
    label: "public",
    type: "mq-tenant",
    connectionId: "conn-1",
    mqTenant: "public",
  };

  assert.deepEqual(activeTabSidebarTarget(tab), {
    type: "mq-tenant",
    connectionId: "conn-1",
    tenant: "public",
  });
  assert.equal(findSidebarNodeForActiveTab(tab, [flat(tenant)])?.id, "tenant-node");
});

test("ZooKeeper tabs target the matching visible zookeeper root node", () => {
  const tab: QueryTab = {
    id: "tab-1",
    title: "ZooKeeper Keys",
    connectionId: "conn-1",
    database: "",
    sql: "",
    isExecuting: false,
    mode: "zookeeper",
  };
  const root: TreeNode = {
    id: "zookeeper-root",
    label: "Keys",
    type: "zookeeper-root",
    connectionId: "conn-1",
  };

  assert.deepEqual(activeTabSidebarTarget(tab), {
    type: "zookeeper-root",
    connectionId: "conn-1",
  });
  assert.equal(findSidebarNodeForActiveTab(tab, [flat(root)])?.id, "zookeeper-root");
});

test("Nacos tabs target the matching namespace node", () => {
  const tab: QueryTab = {
    id: "tab-1",
    title: "Nacos:dev",
    connectionId: "conn-1",
    database: "",
    sql: "",
    isExecuting: false,
    mode: "nacos",
    nacosNamespace: "dev",
    nacosNamespaceName: "Development",
  };
  const namespace: TreeNode = {
    id: "namespace-node",
    label: "Development",
    type: "nacos-namespace",
    connectionId: "conn-1",
    nacosNamespace: "dev",
  };

  assert.deepEqual(activeTabSidebarTarget(tab), {
    type: "nacos-namespace",
    connectionId: "conn-1",
    namespace: "dev",
  });
  assert.equal(findSidebarNodeForActiveTab(tab, [flat(namespace)])?.id, "namespace-node");
});

test("saved SQL tabs target the matching visible saved SQL file node", () => {
  const tab: QueryTab = {
    id: "tab-1",
    title: "report.sql",
    connectionId: "conn-1",
    database: "app",
    sql: "select 1",
    savedSqlId: "sql-1",
    isExecuting: false,
    mode: "query",
  };
  const file: TreeNode = { id: "file-node", label: "report.sql", type: "saved-sql-file", connectionId: "conn-1", database: "app", savedSqlId: "sql-1" };
  const queries: TreeNode = {
    id: "queries-node",
    label: "tree.queries",
    type: "saved-sql-root",
    connectionId: "conn-1",
    database: "app",
    children: [file],
  };
  const database: TreeNode = {
    id: "database-node",
    label: "app",
    type: "database",
    connectionId: "conn-1",
    database: "app",
    children: [queries],
  };
  const connection: TreeNode = {
    id: "conn-1",
    label: "Local",
    type: "connection",
    connectionId: "conn-1",
    children: [database],
  };

  assert.deepEqual(activeTabSidebarTarget(tab), { type: "saved-sql-file", savedSqlId: "sql-1" });
  assert.equal(findSidebarNodeForActiveTab(tab, [flat(file)])?.id, "file-node");
  assert.deepEqual(
    findNodePathForTarget(activeTabSidebarTarget(tab)!, [connection])?.map((node) => node.id),
    ["conn-1", "database-node", "queries-node", "file-node"],
  );
});

test("query tabs target their database node in the sidebar", () => {
  const tab: QueryTab = {
    id: "tab-1",
    title: "Query 1",
    connectionId: "conn-1",
    database: "app",
    sql: "select 1",
    isExecuting: false,
    mode: "query",
  };

  assert.deepEqual(activeTabSidebarTarget(tab), {
    type: "query-context",
    connectionId: "conn-1",
    catalog: undefined,
    database: "app",
    schema: undefined,
  });
});

test("query tabs without connectionId have no sidebar target", () => {
  const tab: QueryTab = {
    id: "tab-1",
    title: "Query 1",
    connectionId: "",
    database: "",
    sql: "select 1",
    isExecuting: false,
    mode: "query",
  };

  assert.equal(activeTabSidebarTarget(tab), null);
});
test("sidebar target lookup only uses the current flat visible tree", () => {
  const tab: QueryTab = {
    id: "tab-1",
    title: "users",
    connectionId: "conn-1",
    database: "app",
    sql: "",
    isExecuting: false,
    mode: "data",
    tableMeta: { tableName: "users", columns: [], primaryKeys: [] },
  };
  const collapsedParentOnly: TreeNode = {
    id: "db-node",
    label: "app",
    type: "database",
    connectionId: "conn-1",
    database: "app",
  };

  assert.equal(findSidebarNodeForActiveTab(tab, [flat(collapsedParentOnly)]), null);
});

test("sidebar node scrolling keeps visible rows in place and reveals hidden rows", () => {
  assert.equal(scrollTopForSidebarNode({ index: 2, currentScrollTop: 0, viewportHeight: 140 }), 0);
  assert.equal(scrollTopForSidebarNode({ index: 20, currentScrollTop: 0, viewportHeight: 140 }), 448);
  assert.equal(scrollTopForSidebarNode({ index: 1, currentScrollTop: 280, viewportHeight: 140 }), 28);
  assert.equal(scrollTopForSidebarNode({ index: 11, currentScrollTop: 300, viewportHeight: 140, topOcclusionHeight: 28 }), 280);
});

test("sidebar node scrolling supports top and smart locate alignment", () => {
  assert.equal(scrollTopForSidebarNode({ index: 20, currentScrollTop: 0, viewportHeight: 140, align: "top" }), 560);
  assert.equal(scrollTopForSidebarNode({ index: 20, currentScrollTop: 0, viewportHeight: 140, align: "smart" }), 523);
  assert.equal(scrollTopForSidebarNode({ index: 11, currentScrollTop: 300, viewportHeight: 140, topOcclusionHeight: 28, align: "smart" }), 252);
  assert.equal(scrollTopForSidebarNode({ index: 0, currentScrollTop: 300, viewportHeight: 140, topOcclusionHeight: 28, align: "smart" }), 0);
});

test("sidebar node scrolling centers explicit tab locate with sticky and boundary clamping", () => {
  assert.equal(scrollTopForSidebarNode({ index: 20, currentScrollTop: 0, viewportHeight: 140, align: "center" }), 504);
  assert.equal(scrollTopForSidebarNode({ index: 11, currentScrollTop: 0, viewportHeight: 140, topOcclusionHeight: 28, align: "center" }), 238);
  assert.equal(scrollTopForSidebarNode({ index: 0, currentScrollTop: 300, viewportHeight: 140, topOcclusionHeight: 28, align: "center" }), 0);
  assert.equal(scrollTopForSidebarNode({ index: 20, currentScrollTop: 0, viewportHeight: 140, scrollHeight: 588, align: "center" }), 448);
});

test("active sidebar selection only scrolls on tab or setting changes", () => {
  assert.equal(
    shouldScrollActiveSidebarSelection({
      activeTabId: "tab-1",
      previousActiveTabId: "tab-1",
      autoSelectEnabled: true,
      previousAutoSelectEnabled: true,
    }),
    false,
  );
  assert.equal(
    shouldScrollActiveSidebarSelection({
      activeTabId: "tab-2",
      previousActiveTabId: "tab-1",
      autoSelectEnabled: true,
      previousAutoSelectEnabled: true,
    }),
    true,
  );
  assert.equal(
    shouldScrollActiveSidebarSelection({
      activeTabId: "tab-1",
      previousActiveTabId: "tab-1",
      autoSelectEnabled: true,
      previousAutoSelectEnabled: false,
    }),
    true,
  );
});

test("locate under collapsed connection groups resolves the path, expands the groups, then finds the flat node", () => {
  // Mirrors locateTabInSidebar for a target inside collapsed (nested)
  // connection groups: the node path ignores expansion, the visible flat tree
  // does not, so locate must reopen the collapsed groups through the layout op
  // and rebuild before matching, otherwise the locate silently fails (#7387).
  const conn = (id: string): ConnectionConfig => ({
    id,
    name: id,
    db_type: "postgres",
    host: "localhost",
    port: 5432,
    username: "user",
    password: "",
  });
  const layout: SidebarLayout = {
    groups: [
      { id: "group-outer", name: "Outer", collapsed: true },
      { id: "group-inner", name: "Inner", collapsed: true },
      { id: "group-open", name: "Open", collapsed: false },
    ],
    order: [
      {
        type: "group",
        id: "group-outer",
        children: [{ type: "group", id: "group-inner", children: [{ type: "connection", id: "conn-grouped" }] }],
      },
      { type: "group", id: "group-open", children: [{ type: "connection", id: "conn-open" }] },
    ],
  };
  const connections = [conn("conn-grouped"), conn("conn-open")];
  const target = { type: "connection", connectionId: "conn-grouped" } as const;

  const collapsedTree = buildTreeNodesFromLayout(layout, connections, new Set());
  const nodePath = findNodePathForTarget(target, collapsedTree);
  assert.deepEqual(nodePath?.map((node) => node.id), ["group-outer", "group-inner", "conn-grouped"]);
  assert.equal(findSidebarNodeForTarget(target, flattenTree(collapsedTree)), null);

  const collapsedGroupIds = nodePath!
    .filter((node) => node.type === "connection-group" && !node.isExpanded)
    .map((node) => node.id);
  assert.deepEqual(collapsedGroupIds, ["group-outer", "group-inner"]);

  const expandedLayout = expandGroups(layout, collapsedGroupIds);
  assert.deepEqual(
    expandedLayout.groups.map((group) => [group.id, group.collapsed]),
    [
      ["group-outer", false],
      ["group-inner", false],
      ["group-open", false],
    ],
  );

  const rebuiltTree = buildTreeNodesFromLayout(expandedLayout, connections, new Set());
  assert.equal(findSidebarNodeForTarget(target, flattenTree(rebuiltTree))?.id, "conn-grouped");
});

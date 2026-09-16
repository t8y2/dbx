import { strict as assert } from "node:assert";
import { test } from "vitest";
import { filterSidebarSearchRootsByConnectionState, filterSidebarTree, mergeSidebarRegexIndexScopes, nodeMatchesRegexScopeIdentity, resolveSidebarObjectSearchFilter, reuseLiveSidebarTreeNodes } from "../../apps/desktop/src/lib/sidebar/sidebarSearchTree.ts";
import type { TreeNode, TreeNodeType } from "../../apps/desktop/src/types/database.ts";

test("preserves loaded table children when the table itself matches search", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:db",
      label: "app",
      type: "database",
      connectionId: "conn",
      database: "app",
      isExpanded: true,
      children: [
        {
          id: "conn:db:orders",
          label: "orders",
          type: "table",
          connectionId: "conn",
          database: "app",
          isExpanded: true,
          children: [
            {
              id: "conn:db:orders:__columns",
              label: "tree.columns",
              type: "group-columns",
              connectionId: "conn",
              database: "app",
              tableName: "orders",
              isExpanded: true,
              children: [
                {
                  id: "conn:db:orders:__columns:id",
                  label: "id",
                  type: "column",
                  connectionId: "conn",
                  database: "app",
                  tableName: "orders",
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "orders", new Set());

  const table = filtered[0]?.children?.[0];
  assert.equal(table?.label, "orders");
  assert.equal(table?.children?.[0]?.label, "tree.columns");
  assert.equal(table?.children?.[0]?.children?.[0]?.label, "id");
});

test("preserves loaded schema children when the database itself matches search", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:hdi",
      label: "hdi",
      type: "database",
      connectionId: "conn",
      database: "hdi",
      isExpanded: true,
      children: [
        {
          id: "conn:hdi:public",
          label: "public",
          type: "schema",
          connectionId: "conn",
          database: "hdi",
          schema: "public",
          isExpanded: false,
          children: [],
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "hdi", new Set());

  assert.equal(filtered[0]?.label, "hdi");
  assert.equal(filtered[0]?.children?.[0]?.label, "public");
});

test("preserves loaded MongoDB collection children when the database itself matches search", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:analytics",
      label: "analytics",
      type: "mongo-db",
      connectionId: "conn",
      database: "analytics",
      isExpanded: true,
      children: [
        {
          id: "conn:analytics:__gridfs",
          label: "tree.gridfs",
          type: "mongo-gridfs",
          connectionId: "conn",
          database: "analytics",
          isExpanded: false,
        },
        {
          id: "conn:analytics:orders",
          label: "orders",
          type: "mongo-collection",
          connectionId: "conn",
          database: "analytics",
          isExpanded: false,
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "analytics", new Set());

  assert.equal(filtered[0]?.label, "analytics");
  assert.deepEqual(
    filtered[0]?.children?.map((child) => child.type),
    ["mongo-gridfs", "mongo-collection"],
  );
  assert.equal(filtered[0]?.children?.[1]?.label, "orders");
});

test("preserves loaded MongoDB collection groups when the collection itself matches search", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:analytics",
      label: "analytics",
      type: "mongo-db",
      connectionId: "conn",
      database: "analytics",
      isExpanded: true,
      children: [
        {
          id: "conn:analytics:orders",
          label: "orders",
          type: "mongo-collection",
          connectionId: "conn",
          database: "analytics",
          isExpanded: true,
          children: [
            {
              id: "conn:analytics:orders:__columns",
              label: "tree.columns",
              type: "group-columns",
              connectionId: "conn",
              database: "analytics",
              tableName: "orders",
              isExpanded: true,
              children: [
                {
                  id: "conn:analytics:orders:__columns:_id",
                  label: "_id",
                  type: "column",
                  connectionId: "conn",
                  database: "analytics",
                  tableName: "orders",
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "orders", new Set());

  const collection = filtered[0]?.children?.[0];
  assert.equal(collection?.label, "orders");
  assert.equal(collection?.children?.[0]?.label, "tree.columns");
  assert.equal(collection?.children?.[0]?.children?.[0]?.label, "_id");
});

test("preserves loaded children when the connection itself matches search", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:1",
      label: "192.168.0.200_3306",
      type: "connection",
      connectionId: "conn:1",
      isExpanded: true,
      children: [
        {
          id: "conn:1:inventory",
          label: "inventory",
          type: "database",
          connectionId: "conn:1",
          database: "inventory",
          isExpanded: true,
          children: [
            {
              id: "conn:1:inventory:products",
              label: "products",
              type: "table",
              connectionId: "conn:1",
              database: "inventory",
            },
          ],
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "192.168.0.200", new Set());

  assert.equal(filtered[0]?.label, "192.168.0.200_3306");
  assert.equal(filtered[0]?.children?.[0]?.label, "inventory");
  assert.equal(filtered[0]?.children?.[0]?.children?.[0]?.label, "products");
});

test("does not treat a matching connection name as an object-name filter", () => {
  const tablesGroup: TreeNode = {
    id: "conn:1:basic:__tables",
    label: "tree.tables",
    type: "group-tables",
    connectionId: "conn:1",
    database: "basic",
    isExpanded: true,
    children: [],
  };
  const nodes: TreeNode[] = [
    {
      id: "conn:1",
      label: "60307",
      type: "connection",
      connectionId: "conn:1",
      isExpanded: true,
      children: [
        {
          id: "conn:1:basic",
          label: "basic",
          type: "database",
          connectionId: "conn:1",
          database: "basic",
          isExpanded: true,
          children: [tablesGroup],
        },
      ],
    },
  ];

  assert.equal(resolveSidebarObjectSearchFilter(nodes, tablesGroup.id, "60307"), "");
  assert.equal(resolveSidebarObjectSearchFilter(nodes, tablesGroup.id, "orders"), "orders");
  assert.equal(resolveSidebarObjectSearchFilter(nodes, "conn:1:basic", "basic"), "");
});

test("only lets searchable ancestor types suppress the object-name filter", () => {
  const tablesGroup: TreeNode = {
    id: "conn:1:basic:__tables",
    label: "tree.tables",
    type: "group-tables",
    connectionId: "conn:1",
    database: "basic",
  };
  const nodes: TreeNode[] = [
    {
      id: "conn:1",
      label: "60307",
      type: "connection",
      connectionId: "conn:1",
      children: [
        {
          id: "conn:1:basic",
          label: "basic",
          type: "database",
          connectionId: "conn:1",
          database: "basic",
          children: [tablesGroup],
        },
      ],
    },
  ];

  assert.equal(resolveSidebarObjectSearchFilter(nodes, tablesGroup.id, "60307", new Set<TreeNodeType>(["table"])), "60307");
  assert.equal(resolveSidebarObjectSearchFilter(nodes, tablesGroup.id, "60307", new Set<TreeNodeType>(["connection", "table"])), "");
});

test("matches connections by host and username search aliases", () => {
  const connection: TreeNode = {
    id: "conn:1",
    label: "Production reporting",
    type: "connection",
    connectionId: "conn:1",
    searchAliases: ["192.168.0.27", "report_user"],
    isExpanded: false,
    children: [],
  };

  assert.equal(filterSidebarTree([connection], "192.168.0", new Set())[0]?.id, connection.id);
  assert.equal(filterSidebarTree([connection], "report_user", new Set())[0]?.id, connection.id);
  assert.deepEqual(filterSidebarTree([connection], "unrelated", new Set()), []);
});

test("omits synthetic connection management entries when the connection itself matches search", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:1",
      label: "1000-test",
      type: "connection",
      connectionId: "conn:1",
      isExpanded: false,
      children: [
        {
          id: "conn:1:inventory",
          label: "inventory",
          type: "database",
          connectionId: "conn:1",
          database: "inventory",
        },
        {
          id: "conn:1:__user_admin",
          label: "tree.userAdmin",
          type: "user-admin",
          connectionId: "conn:1",
          database: "",
        },
        {
          id: "conn:1:__dameng_jobs",
          label: "tree.damengJobAdmin",
          type: "dameng-job-admin",
          connectionId: "conn:1",
          database: "",
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "1000", new Set());

  assert.deepEqual(
    filtered[0]?.children?.map((child) => child.type),
    ["database"],
  );
  assert.equal(filtered[0]?.isExpanded, true);
});

test("keeps a disconnected connection search result collapsed when it only has synthetic management entries", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:1",
      label: "1000",
      type: "connection",
      connectionId: "conn:1",
      isExpanded: false,
      children: [
        {
          id: "conn:1:__user_admin",
          label: "tree.userAdmin",
          type: "user-admin",
          connectionId: "conn:1",
          database: "",
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "1000", new Set());

  assert.deepEqual(filtered[0]?.children, []);
  assert.equal(filtered[0]?.isExpanded, false);
});

test("does not return synthetic connection management entries as direct text matches", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:1:__user_admin",
      label: "tree.userAdmin",
      type: "user-admin",
      connectionId: "conn:1",
      database: "",
    },
  ];

  assert.deepEqual(filterSidebarTree(nodes, "userAdmin", new Set()), []);
});

test("merges manifest regex index scopes into existing grouped connections without mutating live nodes", () => {
  const live: TreeNode[] = [
    {
      id: "group-a",
      label: "A",
      type: "connection-group",
      children: [{ id: "conn-1", label: "Production", type: "connection", connectionId: "conn-1", children: [] }],
    },
  ];
  const snapshot = JSON.parse(JSON.stringify(live)) as TreeNode[];
  const merged = mergeSidebarRegexIndexScopes(live, [
    {
      parentNodeId: "conn-1:app:public:__tables",
      connectionId: "conn-1",
      database: "app",
      schema: "public",
      nodeType: "group-tables",
      path: [
        { id: "conn-1", label: "Production", type: "connection", connectionId: "conn-1" },
        { id: "conn-1:app", label: "app", type: "database", connectionId: "conn-1", database: "app" },
        { id: "conn-1:app:public", label: "public", type: "schema", connectionId: "conn-1", database: "app", schema: "public" },
        { id: "conn-1:app:public:__tables", label: "Tables", type: "group-tables", connectionId: "conn-1", database: "app", schema: "public" },
      ],
      entries: [
        { name: "Foo", table_type: "TABLE" },
        { name: "foo", table_type: "VIEW" },
      ],
    },
  ]);
  assert.deepEqual(live, snapshot);
  assert.equal(merged[0]?.type, "connection-group");
  assert.equal(merged[0]?.children?.[0]?.id, "conn-1");
  // group-a -> conn-1 -> app database -> public schema -> group-tables
  const group = merged[0]?.children?.[0]?.children?.[0]?.children?.[0]?.children?.[0];
  assert.deepEqual(
    group?.children?.map((node) => [node.label, node.type]),
    [
      ["Foo", "table"],
      ["foo", "view"],
    ],
  );
});

test("anchors a pathless legacy index scope into its live parent without synthesizing ancestors", () => {
  const liveTable: TreeNode = {
    id: "conn-1:app:public:__tables:existing",
    label: "existing",
    type: "table",
    connectionId: "conn-1",
    database: "app",
    schema: "public",
  };
  const live: TreeNode[] = [
    {
      id: "group-a",
      label: "A",
      type: "connection-group",
      children: [
        {
          id: "conn-1",
          label: "Production",
          type: "connection",
          connectionId: "conn-1",
          children: [
            {
              id: "conn-1:app",
              label: "app",
              type: "database",
              connectionId: "conn-1",
              database: "app",
              children: [
                {
                  id: "conn-1:app:public",
                  label: "public",
                  type: "schema",
                  connectionId: "conn-1",
                  database: "app",
                  schema: "public",
                  children: [
                    {
                      id: "conn-1:app:public:__tables",
                      label: "Tables",
                      type: "group-tables",
                      connectionId: "conn-1",
                      database: "app",
                      schema: "public",
                      isExpanded: true,
                      children: [liveTable],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];
  const snapshot = JSON.parse(JSON.stringify(live)) as TreeNode[];
  const merged = mergeSidebarRegexIndexScopes(live, [
    {
      parentNodeId: "conn-1:app:public:__tables",
      connectionId: "conn-1",
      database: "app",
      schema: "public",
      nodeType: "group-tables",
      entries: [{ name: "Foo", table_type: "TABLE" }],
    },
  ]);
  assert.deepEqual(live, snapshot);
  // The group keeps its live position under connection -> database -> schema;
  // nothing is inserted directly below the connection.
  const connection = merged[0]?.children?.[0];
  assert.deepEqual(
    connection?.children?.map((node) => node.id),
    ["conn-1:app"],
  );
  const group = connection?.children?.[0]?.children?.[0]?.children?.[0];
  assert.equal(group?.type, "group-tables");
  assert.deepEqual(
    group?.children?.map((node) => [node.label, node.type]),
    [
      ["existing", "table"],
      ["Foo", "table"],
    ],
  );
  // The live table node keeps its identity/state.
  assert.equal(group?.children?.[0], liveTable);
});

test("anchors same-id scopes to the node matching their database context", () => {
  const live: TreeNode[] = [
    {
      id: "conn-1",
      label: "c",
      type: "connection",
      connectionId: "conn-1",
      isExpanded: true,
      children: [
        {
          id: "conn-1:a:b",
          label: "a:b",
          type: "database",
          connectionId: "conn-1",
          database: "a:b",
          isExpanded: true,
          children: [],
        },
        {
          id: "conn-1:a",
          label: "a",
          type: "database",
          connectionId: "conn-1",
          database: "a",
          isExpanded: true,
          children: [
            {
              id: "conn-1:a:b",
              label: "b",
              type: "schema",
              connectionId: "conn-1",
              database: "a",
              schema: "b",
              isExpanded: true,
              children: [],
            },
          ],
        },
      ],
    },
  ];
  const snapshot = JSON.parse(JSON.stringify(live)) as TreeNode[];
  const merged = mergeSidebarRegexIndexScopes(live, [
    {
      parentNodeId: "conn-1:a:b",
      connectionId: "conn-1",
      database: "a",
      schema: "b",
      nodeType: "schema",
      entries: [{ name: "schema_b_table", table_type: "TABLE" }],
    },
    {
      parentNodeId: "conn-1:a:b",
      connectionId: "conn-1",
      database: "a:b",
      nodeType: "database",
      entries: [{ name: "db_a_b_table", table_type: "TABLE" }],
    },
  ]);
  assert.deepEqual(live, snapshot);
  const children = merged[0]?.children;
  // Database "a:b" node (id conn-1:a:b) gets the database-scoped entry...
  assert.equal(children?.[0]?.type, "database");
  assert.deepEqual(
    children?.[0]?.children?.map((node) => node.label),
    ["db_a_b_table"],
  );
  // ...while the schema "b" under database "a" (same id) gets its own entry.
  assert.equal(children?.[1]?.type, "database");
  const schema = children?.[1]?.children?.[0];
  assert.equal(schema?.type, "schema");
  assert.deepEqual(
    schema?.children?.map((node) => node.label),
    ["schema_b_table"],
  );
});

test("does not anchor a pathless scope to a same-id node with a different database context", () => {
  const live: TreeNode[] = [
    {
      id: "conn-1",
      label: "c",
      type: "connection",
      connectionId: "conn-1",
      isExpanded: true,
      children: [
        {
          id: "conn-1:a:b",
          label: "a:b",
          type: "database",
          connectionId: "conn-1",
          database: "a:b",
          isExpanded: true,
          children: [],
        },
      ],
    },
  ];
  const merged = mergeSidebarRegexIndexScopes(live, [
    {
      parentNodeId: "conn-1:a:b",
      connectionId: "conn-1",
      database: "a",
      schema: "b",
      nodeType: "schema",
      entries: [{ name: "must_not_land_here", table_type: "TABLE" }],
    },
  ]);
  // The schema scope does not exist in this tree; the same-id database node
  // must not receive the entry.
  assert.deepEqual(merged[0]?.children?.[0]?.children, []);
  assert.deepEqual(merged, live);
});

test("does not match a scope when a required identity field is missing from the node", () => {
  const node: TreeNode = {
    id: "conn-1:hive:sales",
    label: "sales",
    type: "database",
    connectionId: "conn-1",
    database: "sales",
  };

  assert.equal(nodeMatchesRegexScopeIdentity(node, node.id, { connectionId: "conn-1", database: "sales", catalog: "hive", nodeType: "database" }), false);
});

test("drops a pathless index scope when only its connection remains in the tree", () => {
  const live: TreeNode[] = [{ id: "conn-1", label: "Production", type: "connection", connectionId: "conn-1", children: [] }];
  const merged = mergeSidebarRegexIndexScopes(live, [
    {
      parentNodeId: "conn-1:app:__tables",
      connectionId: "conn-1",
      database: "app",
      nodeType: "group-tables",
      entries: [{ name: "Foo", table_type: "TABLE" }],
    },
  ]);
  assert.deepEqual(merged, live);
});

test("does not resurrect a removed connection from a manifest scope with a stale path", () => {
  const merged = mergeSidebarRegexIndexScopes(
    [],
    [
      {
        parentNodeId: "gone:db:__tables",
        connectionId: "gone",
        database: "db",
        nodeType: "group-tables",
        path: [
          { id: "gone", label: "Gone", type: "connection", connectionId: "gone" },
          { id: "gone:db", label: "db", type: "database", connectionId: "gone", database: "db" },
          { id: "gone:db:__tables", label: "Tables", type: "group-tables", connectionId: "gone", database: "db" },
        ],
        entries: [{ name: "orders", table_type: "TABLE" }],
      },
    ],
  );
  assert.deepEqual(merged, []);
});

test("merges a manifest scope whose parent is a schema directly under the connection", () => {
  const live: TreeNode[] = [
    {
      id: "conn-1",
      label: "oracle",
      type: "connection",
      connectionId: "conn-1",
      isExpanded: true,
      children: [{ id: "conn-1:SYSTEM", label: "SYSTEM", type: "schema", connectionId: "conn-1", database: "", schema: "SYSTEM", children: [] }],
    },
  ];
  const snapshot = JSON.parse(JSON.stringify(live)) as TreeNode[];
  const merged = mergeSidebarRegexIndexScopes(live, [
    {
      parentNodeId: "conn-1:SYSTEM",
      connectionId: "conn-1",
      database: "",
      schema: "SYSTEM",
      nodeType: "schema",
      path: [
        { id: "conn-1", label: "oracle", type: "connection", connectionId: "conn-1" },
        { id: "conn-1:SYSTEM", label: "SYSTEM", type: "schema", connectionId: "conn-1", database: "", schema: "SYSTEM" },
      ],
      entries: [{ name: "Foo", table_type: "TABLE" }],
    },
  ]);
  assert.deepEqual(live, snapshot);
  // No synthetic database level is guessed between connection and schema.
  assert.deepEqual(
    merged[0]?.children?.map((node) => node.type),
    ["schema"],
  );
  const schema = merged[0]?.children?.[0];
  assert.deepEqual(
    schema?.children?.map((node) => [node.label, node.type]),
    [["Foo", "table"]],
  );
});

test("synthesizes catalog ancestors from a Doris manifest scope", () => {
  const live: TreeNode[] = [{ id: "conn-1", label: "doris", type: "connection", connectionId: "conn-1", isExpanded: true, children: [] }];
  const merged = mergeSidebarRegexIndexScopes(live, [
    {
      parentNodeId: "conn-1:internal:analytics:public:__tables",
      connectionId: "conn-1",
      database: "analytics",
      schema: "public",
      catalog: "internal",
      nodeType: "group-tables",
      path: [
        { id: "conn-1", label: "doris", type: "connection", connectionId: "conn-1" },
        { id: "conn-1:internal", label: "internal", type: "doris-catalog", connectionId: "conn-1", catalog: "internal" },
        { id: "conn-1:internal:analytics", label: "analytics", type: "database", connectionId: "conn-1", database: "analytics", catalog: "internal" },
        { id: "conn-1:internal:analytics:public", label: "public", type: "schema", connectionId: "conn-1", database: "analytics", schema: "public", catalog: "internal" },
        { id: "conn-1:internal:analytics:public:__tables", label: "Tables", type: "group-tables", connectionId: "conn-1", database: "analytics", schema: "public", catalog: "internal" },
      ],
      entries: [{ name: "Foo", table_type: "TABLE" }],
    },
  ]);
  const catalog = merged[0]?.children?.[0];
  assert.equal(catalog?.type, "doris-catalog");
  assert.equal(catalog?.catalog, "internal");
  const database = catalog?.children?.[0];
  assert.equal(database?.type, "database");
  assert.equal(database?.catalog, "internal");
  const schema = database?.children?.[0];
  assert.equal(schema?.type, "schema");
  const group = schema?.children?.[0];
  assert.deepEqual(
    group?.children?.map((node) => [node.label, node.type]),
    [["Foo", "table"]],
  );
  assert.equal(group?.children?.[0]?.catalog, "internal");
});

test("synthesizes linked-server ancestors from a SQL Server manifest scope", () => {
  const live: TreeNode[] = [{ id: "conn-1", label: "mssql", type: "connection", connectionId: "conn-1", isExpanded: true, children: [] }];
  const merged = mergeSidebarRegexIndexScopes(live, [
    {
      parentNodeId: "conn-1:linked:catalog:schema:__tables",
      connectionId: "conn-1",
      database: "",
      schema: "schema",
      nodeType: "group-tables",
      path: [
        { id: "conn-1", label: "mssql", type: "connection", connectionId: "conn-1" },
        { id: "conn-1:linked", label: "linked", type: "linked-server", connectionId: "conn-1", linkedServer: "linked" },
        { id: "conn-1:linked:catalog", label: "catalog", type: "linked-server-catalog", connectionId: "conn-1", linkedServer: "linked", linkedCatalog: "catalog" },
        { id: "conn-1:linked:catalog:schema", label: "schema", type: "linked-server-schema", connectionId: "conn-1", database: "", schema: "schema", linkedServer: "linked", linkedCatalog: "catalog" },
        { id: "conn-1:linked:catalog:schema:__tables", label: "Tables", type: "group-tables", connectionId: "conn-1", database: "", schema: "schema", linkedServer: "linked", linkedCatalog: "catalog" },
      ],
      entries: [{ name: "Foo", table_type: "TABLE" }],
    },
  ]);
  const linkedServer = merged[0]?.children?.[0];
  assert.equal(linkedServer?.type, "linked-server");
  assert.equal(linkedServer?.linkedServer, "linked");
  const linkedCatalog = linkedServer?.children?.[0];
  assert.equal(linkedCatalog?.type, "linked-server-catalog");
  assert.equal(linkedCatalog?.linkedCatalog, "catalog");
  const linkedSchema = linkedCatalog?.children?.[0];
  assert.equal(linkedSchema?.type, "linked-server-schema");
  assert.equal(linkedSchema?.linkedServer, "linked");
  const group = linkedSchema?.children?.[0];
  assert.deepEqual(
    group?.children?.map((node) => [node.label, node.type]),
    [["Foo", "table"]],
  );
});

test("indexed entries keep partition parents, case-distinct names, normalized types, and name order", () => {
  const live: TreeNode[] = [{ id: "conn-1", label: "c", type: "connection", connectionId: "conn-1", isExpanded: true, children: [] }];
  const merged = mergeSidebarRegexIndexScopes(live, [
    {
      parentNodeId: "conn-1:app:public:__tables",
      connectionId: "conn-1",
      database: "app",
      schema: "public",
      nodeType: "group-tables",
      path: [
        { id: "conn-1", label: "c", type: "connection", connectionId: "conn-1" },
        { id: "conn-1:app", label: "app", type: "database", connectionId: "conn-1", database: "app" },
        { id: "conn-1:app:public", label: "public", type: "schema", connectionId: "conn-1", database: "app", schema: "public" },
        { id: "conn-1:app:public:__tables", label: "Tables", type: "group-tables", connectionId: "conn-1", database: "app", schema: "public" },
      ],
      entries: [
        { name: "orders_2024", table_type: "TABLE", parent_schema: "public", parent_name: "Orders" },
        { name: "Foo", table_type: "BASE TABLE" },
        { name: "foo", table_type: "TABLE" },
        { name: "Foo", table_type: "VIEW" },
        { name: "Orders", table_type: "TABLE" },
        { name: "t10", table_type: "TABLE" },
        { name: "t2", table_type: "TABLE" },
      ],
    },
  ]);
  const group = merged[0]?.children?.[0]?.children?.[0]?.children?.[0];
  // Sorted by name (numeric collator, case-insensitive ties keep input order);
  // same name with different case/type is not deduped.
  assert.deepEqual(
    group?.children?.map((node) => [node.label, node.type]),
    [
      ["Foo", "table"],
      ["foo", "table"],
      ["Foo", "view"],
      ["Orders", "table"],
      ["t2", "table"],
      ["t10", "table"],
    ],
  );
  const orders = group?.children?.[3];
  assert.deepEqual(
    orders?.children?.map((node) => node.type),
    ["group-partitions"],
  );
  assert.deepEqual(
    orders?.children?.[0]?.children?.map((node) => node.label),
    ["orders_2024"],
  );
});

test("does not resurrect a removed connection from an old index manifest", () => {
  const merged = mergeSidebarRegexIndexScopes([], [{ parentNodeId: "gone:db:__tables", connectionId: "gone", database: "db", nodeType: "group-tables", entries: [{ name: "orders", table_type: "TABLE" }] }]);
  assert.deepEqual(merged, []);
});

test("temporarily collapses an empty object group within a preserved search subtree", () => {
  const tablesGroup: TreeNode = {
    id: "conn:1:inventory:__tables",
    label: "tree.tables",
    type: "group-tables",
    connectionId: "conn:1",
    database: "inventory",
    isExpanded: true,
    children: [],
  };
  const nodes: TreeNode[] = [
    {
      id: "conn:1",
      label: "local-mysql",
      type: "connection",
      connectionId: "conn:1",
      isExpanded: true,
      children: [
        {
          id: "conn:1:inventory",
          label: "inventory",
          type: "database",
          connectionId: "conn:1",
          database: "inventory",
          isExpanded: true,
          children: [tablesGroup],
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "local", new Set([tablesGroup.id]));
  const filteredGroup = filtered[0]?.children?.[0]?.children?.[0];

  assert.equal(filteredGroup?.isExpanded, false);
  assert.equal(tablesGroup.isExpanded, true);
  assert.equal(filterSidebarTree(nodes, "local", new Set())[0]?.children?.[0]?.children?.[0]?.isExpanded, true);
});

test("matches table comments during sidebar search", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:db",
      label: "app",
      type: "database",
      connectionId: "conn",
      database: "app",
      isExpanded: true,
      children: [
        {
          id: "conn:db:inventory",
          label: "inventory",
          type: "table",
          connectionId: "conn",
          database: "app",
          comment: "purchase order history",
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "purchase", new Set());

  assert.equal(filtered[0]?.children?.[0]?.label, "inventory");
});

test("search scope excludes non-selected node self matches", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:1",
      label: "orders-conn",
      type: "connection",
      connectionId: "conn",
      isExpanded: true,
      children: [
        {
          id: "conn:1:db",
          label: "orders_db",
          type: "database",
          connectionId: "conn",
          database: "orders_db",
          isExpanded: true,
          children: [
            {
              id: "conn:1:db:table",
              label: "customers",
              type: "table",
              connectionId: "conn",
              database: "orders_db",
            },
          ],
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "orders", new Set(), new Set(["table"]));

  assert.equal(filtered.length, 0);
});

function scopedSearchNodes(): TreeNode[] {
  return [
    {
      id: "conn:1",
      label: "warehouse",
      type: "connection",
      connectionId: "conn:1",
      isExpanded: true,
      children: [
        {
          id: "conn:1:db",
          label: "inventory",
          type: "database",
          connectionId: "conn:1",
          database: "inventory",
          isExpanded: true,
          children: [
            {
              id: "conn:1:db:sales-order",
              label: "sales_order",
              type: "schema",
              connectionId: "conn:1",
              database: "inventory",
              schema: "sales_order",
              isExpanded: true,
              children: [
                {
                  id: "conn:1:db:sales-order:orders",
                  label: "orders",
                  type: "table",
                  connectionId: "conn:1",
                  database: "inventory",
                  schema: "sales_order",
                },
              ],
            },
            {
              id: "conn:1:db:audit",
              label: "audit",
              type: "schema",
              connectionId: "conn:1",
              database: "inventory",
              schema: "audit",
              isExpanded: true,
              children: [
                {
                  id: "conn:1:db:audit:order-log",
                  label: "order_log",
                  type: "table",
                  connectionId: "conn:1",
                  database: "inventory",
                  schema: "audit",
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

test("filters the sidebar by node type without a text query", () => {
  const filtered = filterSidebarTree(scopedSearchNodes(), "", new Set(), new Set(["schema"]));

  const schemas = filtered[0]?.children?.[0]?.children;
  assert.deepEqual(
    schemas?.map((node) => node.label),
    ["sales_order", "audit"],
  );
  assert.deepEqual(
    schemas?.map((node) => node.children),
    [[], []],
  );
});

test("preserves an expanded type-filtered table after the text query is cleared", () => {
  const table: TreeNode = {
    id: "conn:db:orders",
    label: "orders",
    type: "table",
    connectionId: "conn",
    database: "inventory",
    isExpanded: true,
    children: [
      {
        id: "conn:db:orders:__columns",
        label: "tree.columns",
        type: "group-columns",
        connectionId: "conn",
        database: "inventory",
        tableName: "orders",
        isExpanded: false,
        children: [],
      },
    ],
  };

  const [filteredTable] = filterSidebarTree([table], "", new Set(), new Set(["table"]));

  assert.equal(filteredTable, table);
  assert.equal(filteredTable?.isExpanded, true);
  assert.equal(filteredTable?.children?.[0]?.type, "group-columns");
});

test("indexed table search reuses loaded live node state before type filtering", () => {
  const liveTable: TreeNode = {
    id: "conn:db:orders",
    label: "orders",
    type: "table",
    connectionId: "conn",
    database: "inventory",
    isExpanded: true,
    isLoading: true,
    children: [
      {
        id: "conn:db:orders:__columns",
        label: "tree.columns",
        type: "group-columns",
        connectionId: "conn",
        database: "inventory",
        tableName: "orders",
        children: [],
      },
    ],
  };
  const indexedTable: TreeNode = { ...liveTable, isExpanded: false, isLoading: false, children: [] };
  const indexedOnly: TreeNode = {
    id: "conn:db:archive",
    label: "archive",
    type: "table",
    connectionId: "conn",
    database: "inventory",
    children: [],
  };

  const merged = reuseLiveSidebarTreeNodes([indexedTable, indexedOnly], [liveTable]);
  const filtered = filterSidebarTree(merged, "", new Set(), new Set(["table"]));

  assert.equal(filtered[0], liveTable);
  assert.equal(filtered[0]?.children?.[0]?.type, "group-columns");
  assert.equal(filtered[0]?.isExpanded, true);
  assert.equal(filtered[0]?.isLoading, true);
  assert.equal(filtered[1], indexedOnly);
});

test("combines text search with the selected node types", () => {
  const filtered = filterSidebarTree(scopedSearchNodes(), "order", new Set(), new Set(["schema"]));

  assert.deepEqual(
    filtered[0]?.children?.[0]?.children?.map((node) => node.label),
    ["sales_order"],
  );
});

test("clearing the type filter restores default text search", () => {
  const filtered = filterSidebarTree(scopedSearchNodes(), "order", new Set());

  assert.deepEqual(
    filtered[0]?.children?.[0]?.children?.map((node) => node.label),
    ["sales_order", "audit"],
  );
});

test("clearing all search criteria preserves the original tree", () => {
  const nodes = scopedSearchNodes();

  assert.equal(filterSidebarTree(nodes, "", new Set()), nodes);
});

test("connection search results stay visible before connecting", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:1",
      label: "Orders local",
      type: "connection",
      connectionId: "conn:1",
      isExpanded: false,
      children: [],
    },
    {
      id: "conn:1:db",
      label: "orders",
      type: "database",
      connectionId: "conn:1",
      database: "orders",
    },
  ];

  const filtered = filterSidebarSearchRootsByConnectionState(nodes, new Set());

  assert.deepEqual(
    filtered.map((node) => node.id),
    ["conn:1"],
  );
});

test("connection search copies preserve loading state", () => {
  const nodes: TreeNode[] = [
    {
      id: "conn:1",
      label: "Orders local",
      type: "connection",
      connectionId: "conn:1",
      isLoading: true,
      children: [
        {
          id: "conn:1:db",
          label: "orders",
          type: "database",
          connectionId: "conn:1",
          database: "orders",
        },
      ],
    },
  ];

  const filtered = filterSidebarTree(nodes, "orders", new Set());

  assert.equal(filtered[0]?.type, "connection");
  assert.equal(filtered[0]?.isLoading, true);
});

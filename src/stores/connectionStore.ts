import { defineStore } from "pinia";
import { ref } from "vue";
import type { ColumnInfo, ConnectionConfig, TreeNode } from "@/types/database";
import { orderPinnedFirst } from "@/lib/pinnedItems";
import type { SqlCompletionColumn, SqlCompletionTable } from "@/lib/sqlCompletion";
import * as api from "@/lib/tauri";

const PINNED_TREE_NODES_STORAGE_KEY = "dbx-pinned-tree-nodes";

export const useConnectionStore = defineStore("connection", () => {
  const connections = ref<ConnectionConfig[]>([]);
  const activeConnectionId = ref<string | null>(null);
  const treeNodes = ref<TreeNode[]>([]);
  const pinnedTreeNodeIds = ref<Set<string>>(loadPinnedTreeNodeIds());
  const connectedIds = ref<Set<string>>(new Set());
  const editingConnectionId = ref<string | null>(null);
  const completionTablesCache = ref<Record<string, SqlCompletionTable[]>>({});
  const completionColumnsCache = ref<Record<string, ColumnInfo[]>>({});

  function startEditing(id: string) {
    editingConnectionId.value = id;
  }

  function stopEditing() {
    editingConnectionId.value = null;
  }

  function getConfig(connectionId: string) {
    return connections.value.find((c) => c.id === connectionId);
  }

  function normalizeConnection(config: ConnectionConfig): ConnectionConfig {
    const labelMap: Record<string, string> = {
      mysql: "MySQL",
      postgres: "PostgreSQL",
      sqlite: "SQLite",
      redis: "Redis",
      duckdb: "DuckDB",
      clickhouse: "ClickHouse",
      sqlserver: "SQL Server",
      mongodb: "MongoDB",
      oracle: "Oracle",
      elasticsearch: "Elasticsearch",
    };
    return {
      ...config,
      driver_profile: config.driver_profile || config.db_type,
      driver_label: config.driver_label || labelMap[config.driver_profile || config.db_type] || config.db_type,
      url_params: config.url_params || "",
    };
  }

  function upsertConnectionNode(config: ConnectionConfig) {
    const node: TreeNode = {
      id: config.id,
      label: config.name,
      type: "connection",
      connectionId: config.id,
      isExpanded: false,
      children: [],
    };
    const existing = treeNodes.value.findIndex((n) => n.id === config.id);
    if (existing >= 0) {
      treeNodes.value[existing] = { ...treeNodes.value[existing], ...node };
    } else {
      treeNodes.value.push(node);
    }
  }

  function loadPinnedTreeNodeIds(): Set<string> {
    try {
      if (typeof localStorage === "undefined") return new Set();
      const saved = localStorage.getItem(PINNED_TREE_NODES_STORAGE_KEY);
      const ids = saved ? JSON.parse(saved) : [];
      return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
    } catch {
      return new Set();
    }
  }

  function persistPinnedTreeNodeIds() {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(PINNED_TREE_NODES_STORAGE_KEY, JSON.stringify([...pinnedTreeNodeIds.value]));
  }

  function isTreeNodePinned(id: string): boolean {
    return pinnedTreeNodeIds.value.has(id);
  }

  function pinTreeNode(node: TreeNode): TreeNode {
    node.pinned = isTreeNodePinned(node.id);
    return node;
  }

  function setChildren(parent: TreeNode, children: TreeNode[]) {
    parent.children = orderPinnedFirst(children.map(pinTreeNode), (node) => !!node.pinned);
  }

  function findParentNode(nodes: TreeNode[], id: string, parent: TreeNode | null = null): TreeNode | null {
    for (const node of nodes) {
      if (node.id === id) return parent;
      if (node.children) {
        const found = findParentNode(node.children, id, node);
        if (found) return found;
      }
    }
    return null;
  }

  function toggleTreeNodePin(id: string) {
    const next = new Set(pinnedTreeNodeIds.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    pinnedTreeNodeIds.value = next;
    persistPinnedTreeNodeIds();

    const node = findNode(treeNodes.value, id);
    if (node) node.pinned = next.has(id);

    const parent = findParentNode(treeNodes.value, id);
    if (parent?.children) {
      parent.children = orderPinnedFirst(parent.children, (child) => !!child.pinned);
    } else {
      treeNodes.value = orderPinnedFirst(treeNodes.value, (child) => !!child.pinned);
    }
  }

  function addConnection(config: ConnectionConfig) {
    const normalized = normalizeConnection(config);
    const existing = connections.value.findIndex((c) => c.id === normalized.id);
    if (existing >= 0) {
      connections.value[existing] = normalized;
    } else {
      connections.value.push(normalized);
    }
    upsertConnectionNode(normalized);
    persistConnections();
  }

  function invalidateCompletionCache(connectionId: string) {
    const cachePrefix = `${connectionId}:`;
    completionTablesCache.value = Object.fromEntries(
      Object.entries(completionTablesCache.value).filter(([key]) => !key.startsWith(cachePrefix)),
    );
    completionColumnsCache.value = Object.fromEntries(
      Object.entries(completionColumnsCache.value).filter(([key]) => !key.startsWith(cachePrefix)),
    );
  }

  function removeConnection(id: string) {
    connections.value = connections.value.filter((c) => c.id !== id);
    treeNodes.value = treeNodes.value.filter((n) => n.id !== id);
    if (activeConnectionId.value === id) {
      activeConnectionId.value = null;
    }
    invalidateCompletionCache(id);
    persistConnections();
  }

  function updateConnection(config: ConnectionConfig) {
    config = normalizeConnection(config);
    const idx = connections.value.findIndex((c) => c.id === config.id);
    if (idx >= 0) connections.value[idx] = config;
    const node = findNode(treeNodes.value, config.id);
    if (node) {
      node.label = config.name;
      node.isExpanded = false;
      node.children = [];
    }
    connectedIds.value.delete(config.id);
    invalidateCompletionCache(config.id);
    persistConnections();
  }

  async function connect(config: ConnectionConfig) {
    config = normalizeConnection(config);
    const pendingNode = findNode(treeNodes.value, config.id);
    if (pendingNode) pendingNode.isLoading = true;
    try {
      const id = await api.connectDb(config);
      activeConnectionId.value = id;
      connectedIds.value.add(id);

      const node: TreeNode = {
        id,
        label: config.name,
        type: "connection",
        connectionId: id,
        isExpanded: false,
        children: [],
      };
      const existing = treeNodes.value.findIndex((n) => n.id === id);
      if (existing >= 0) {
        treeNodes.value[existing] = node;
      } else {
        treeNodes.value.push(node);
      }
      return id;
    } finally {
      const node = findNode(treeNodes.value, config.id);
      if (node) node.isLoading = false;
    }
  }

  async function disconnect(connectionId: string) {
    await api.disconnectDb(connectionId);
    connectedIds.value.delete(connectionId);
    const node = treeNodes.value.find((n) => n.connectionId === connectionId);
    if (node) {
      node.isExpanded = false;
      node.children = [];
    }
    if (activeConnectionId.value === connectionId) {
      activeConnectionId.value = null;
    }
    invalidateCompletionCache(connectionId);
  }

  async function ensureConnected(connectionId: string) {
    if (connectedIds.value.has(connectionId)) return;
    const config = getConfig(connectionId);
    if (!config) throw new Error("Connection config not found");
    await api.connectDb(config);
    connectedIds.value.add(connectionId);
    activeConnectionId.value = connectionId;
  }

  async function loadDatabases(connectionId: string) {
    const node = findNode(treeNodes.value, connectionId);
    if (!node) return;

    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      const databases = await api.listDatabases(connectionId);
      setChildren(node, databases.map((db) => ({
        id: `${connectionId}:${db.name}`,
        label: db.name,
        type: "database" as const,
        connectionId,
        database: db.name,
        isExpanded: false,
        children: [],
      })));
      node.isExpanded = true;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadRedisDatabases(connectionId: string) {
    const node = findNode(treeNodes.value, connectionId);
    if (!node) return;

    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      const dbs = await api.redisListDatabases(connectionId);
      setChildren(node, dbs.map((db) => ({
        id: `${connectionId}:db${db}`,
        label: `db${db}`,
        type: "redis-db" as const,
        connectionId,
        database: String(db),
        isExpanded: false,
        children: [],
      })));
      node.isExpanded = true;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadMongoDatabases(connectionId: string) {
    const node = findNode(treeNodes.value, connectionId);
    if (!node) return;

    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      const dbs = await api.mongoListDatabases(connectionId);
      setChildren(node, dbs.map((db) => ({
        id: `${connectionId}:${db}`,
        label: db,
        type: "mongo-db" as const,
        connectionId,
        database: db,
        isExpanded: false,
        children: [],
      })));
      node.isExpanded = true;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadMongoCollections(connectionId: string, database: string) {
    const nodeId = `${connectionId}:${database}`;
    const node = findNode(treeNodes.value, nodeId);
    if (!node) return;

    node.isLoading = true;
    try {
      const collections = await api.mongoListCollections(connectionId, database);
      setChildren(node, collections.map((col) => ({
        id: `${nodeId}:${col}`,
        label: col,
        type: "mongo-collection" as const,
        connectionId,
        database,
        isExpanded: false,
      })));
      node.isExpanded = true;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadSchemas(connectionId: string, database: string) {
    const nodeId = `${connectionId}:${database}`;
    const node = findNode(treeNodes.value, nodeId);
    if (!node) return;

    node.isLoading = true;
    try {
      const schemas = await api.listSchemas(connectionId, database);
      setChildren(node, schemas.map((s) => ({
        id: `${connectionId}:${database}:${s}`,
        label: s,
        type: "schema" as const,
        connectionId,
        database,
        schema: s,
        isExpanded: false,
        children: [],
      })));
      node.isExpanded = true;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadTables(connectionId: string, database: string, schema?: string) {
    const nodeId = schema
      ? `${connectionId}:${database}:${schema}`
      : `${connectionId}:${database}`;
    const node = findNode(treeNodes.value, nodeId);
    if (!node) return;

    node.isLoading = true;
    try {
      const querySchema = schema || database;
      const tables = await api.listTables(connectionId, database, querySchema);
      setChildren(node, tables.map((t) => ({
        id: `${nodeId}:${t.name}`,
        label: t.name,
        type: (t.table_type === "VIEW" ? "view" : "table") as "view" | "table",
        connectionId,
        database,
        schema,
        isExpanded: false,
        children: [],
      })));
      node.isExpanded = true;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadTableGroups(connectionId: string, database: string, table: string, schema?: string) {
    const parentId = schema
      ? `${connectionId}:${database}:${schema}:${table}`
      : `${connectionId}:${database}:${table}`;
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    setChildren(node, [
      { id: `${parentId}:__columns`, label: "tree.columns", type: "group-columns", connectionId, database, schema, tableName: table, isExpanded: false, children: [] },
      { id: `${parentId}:__indexes`, label: "tree.indexes", type: "group-indexes", connectionId, database, schema, tableName: table, isExpanded: false, children: [] },
      { id: `${parentId}:__fkeys`, label: "tree.foreignKeys", type: "group-fkeys", connectionId, database, schema, tableName: table, isExpanded: false, children: [] },
      { id: `${parentId}:__triggers`, label: "tree.triggers", type: "group-triggers", connectionId, database, schema, tableName: table, isExpanded: false, children: [] },
    ]);
    node.isExpanded = true;
  }

  async function loadColumns(connectionId: string, database: string, table: string, schema?: string) {
    const parentId = schema
      ? `${connectionId}:${database}:${schema}:${table}:__columns`
      : `${connectionId}:${database}:${table}:__columns`;
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    node.isLoading = true;
    try {
      const querySchema = schema || database;
      const columns = await api.getColumns(connectionId, database, querySchema, table);
      setChildren(node, columns.map((col) => ({
        id: `${parentId}:${col.name}`,
        label: `${col.name} (${col.data_type})`,
        type: "column" as const,
        connectionId,
        database,
        schema,
        meta: col,
      })));
      node.isExpanded = true;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadIndexes(connectionId: string, database: string, table: string, schema?: string) {
    const parentId = schema
      ? `${connectionId}:${database}:${schema}:${table}:__indexes`
      : `${connectionId}:${database}:${table}:__indexes`;
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    node.isLoading = true;
    try {
      const querySchema = schema || database;
      const indexes = await api.listIndexes(connectionId, database, querySchema, table);
      setChildren(node, indexes.map((idx) => ({
        id: `${parentId}:${idx.name}`,
        label: `${idx.name} (${idx.columns.join(", ")})`,
        type: "index" as const,
        connectionId,
        database,
        schema,
        meta: idx,
      })));
      node.isExpanded = true;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadForeignKeys(connectionId: string, database: string, table: string, schema?: string) {
    const parentId = schema
      ? `${connectionId}:${database}:${schema}:${table}:__fkeys`
      : `${connectionId}:${database}:${table}:__fkeys`;
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    node.isLoading = true;
    try {
      const querySchema = schema || database;
      const fkeys = await api.listForeignKeys(connectionId, database, querySchema, table);
      setChildren(node, fkeys.map((fk) => ({
        id: `${parentId}:${fk.name}`,
        label: `${fk.column} → ${fk.ref_table}.${fk.ref_column}`,
        type: "fkey" as const,
        connectionId,
        database,
        schema,
        meta: fk,
      })));
      node.isExpanded = true;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadTriggers(connectionId: string, database: string, table: string, schema?: string) {
    const parentId = schema
      ? `${connectionId}:${database}:${schema}:${table}:__triggers`
      : `${connectionId}:${database}:${table}:__triggers`;
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    node.isLoading = true;
    try {
      const querySchema = schema || database;
      const triggers = await api.listTriggers(connectionId, database, querySchema, table);
      setChildren(node, triggers.map((tr) => ({
        id: `${parentId}:${tr.name}`,
        label: `${tr.name} (${tr.timing} ${tr.event})`,
        type: "trigger" as const,
        connectionId,
        database,
        schema,
        meta: tr,
      })));
      node.isExpanded = true;
    } finally {
      node.isLoading = false;
    }
  }

  function isSchemaAwareDatabase(connectionId: string): boolean {
    const dbType = getConfig(connectionId)?.db_type;
    return dbType === "postgres" || dbType === "sqlserver" || dbType === "oracle";
  }

  async function listCompletionTables(connectionId: string, database: string): Promise<SqlCompletionTable[]> {
    const cacheKey = `${connectionId}:${database}`;
    if (completionTablesCache.value[cacheKey]) {
      return completionTablesCache.value[cacheKey];
    }

    await ensureConnected(connectionId);

    if (isSchemaAwareDatabase(connectionId)) {
      const schemas = await api.listSchemas(connectionId, database);
      const tableGroups = await Promise.all(
        schemas.map(async (schema) => {
          const tables = await api.listTables(connectionId, database, schema);
          return tables.map((table) => ({
            name: table.name,
            schema,
            type: table.table_type === "VIEW" ? "view" as const : "table" as const,
          }));
        }),
      );
      completionTablesCache.value[cacheKey] = tableGroups.flat();
      return completionTablesCache.value[cacheKey];
    }

    const tables = await api.listTables(connectionId, database, database);
    completionTablesCache.value[cacheKey] = tables.map((table) => ({
      name: table.name,
      type: table.table_type === "VIEW" ? "view" as const : "table" as const,
    }));
    return completionTablesCache.value[cacheKey];
  }

  async function listCompletionColumns(
    connectionId: string,
    database: string,
    table: string,
    schema?: string,
  ): Promise<SqlCompletionColumn[]> {
    const cacheKey = `${connectionId}:${database}:${schema || ""}:${table}`;
    if (!completionColumnsCache.value[cacheKey]) {
      await ensureConnected(connectionId);
      const querySchema = schema || database;
      completionColumnsCache.value[cacheKey] = await api.getColumns(connectionId, database, querySchema, table);
    }

    return completionColumnsCache.value[cacheKey].map((column) => ({
      name: column.name,
      table,
      schema,
      dataType: column.data_type,
    }));
  }

  function findNode(nodes: TreeNode[], id: string): TreeNode | null {
    for (const node of nodes) {
      if (node.id === id) return node;
      if (node.children) {
        const found = findNode(node.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  function persistConnections() {
    api.saveConnections(connections.value).catch(() => {});
  }

  async function exportConnectionsToFile() {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await save({ filters: [{ name: "JSON", extensions: ["json"] }], defaultPath: "dbx-connections.json" });
    if (!path) return;
    const data = connections.value.map((c) => ({ ...c, password: "", ssh_password: "" }));
    await writeTextFile(path, JSON.stringify(data, null, 2));
  }

  async function importConnectionsFromFile() {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({ filters: [{ name: "JSON", extensions: ["json"] }], multiple: false });
    if (!path) return;
    const json = await readTextFile(path as string);
    const imported: ConnectionConfig[] = JSON.parse(json);
    for (const config of imported) {
      if (!connections.value.find((c) => c.id === config.id)) {
        config.id = crypto.randomUUID();
        const normalized = normalizeConnection(config);
        addConnection(normalized);
      }
    }
  }

  async function initFromDisk() {
    const saved = await api.loadConnections();
    connections.value = saved.map(normalizeConnection);
    treeNodes.value = saved.map((config) => ({
      id: config.id,
      label: config.name,
      type: "connection" as const,
      connectionId: config.id,
      isExpanded: false,
      children: [],
    }));
  }

  function addEphemeralConnection(config: ConnectionConfig) {
    const normalized = normalizeConnection(config);
    if (!connections.value.find((c) => c.id === normalized.id)) {
      connections.value.push(normalized);
    }
    connectedIds.value.add(normalized.id);
  }

  return {
    connections,
    activeConnectionId,
    treeNodes,
    connectedIds,
    getConfig,
    isTreeNodePinned,
    toggleTreeNodePin,
    addConnection,
    addEphemeralConnection,
    updateConnection,
    removeConnection,
    editingConnectionId,
    startEditing,
    stopEditing,
    connect,
    disconnect,
    ensureConnected,
    initFromDisk,
    loadDatabases,
    loadRedisDatabases,
    loadMongoDatabases,
    loadMongoCollections,
    loadSchemas,
    loadTables,
    loadTableGroups,
    loadColumns,
    loadIndexes,
    loadForeignKeys,
    loadTriggers,
    listCompletionTables,
    listCompletionColumns,
    exportConnectionsToFile,
    importConnectionsFromFile,
  };
});

import { defineStore } from "pinia";
import { ref } from "vue";
import type { ConnectionConfig, TreeNode } from "@/types/database";
import * as api from "@/lib/tauri";

export const useConnectionStore = defineStore("connection", () => {
  const connections = ref<ConnectionConfig[]>([]);
  const activeConnectionId = ref<string | null>(null);
  const treeNodes = ref<TreeNode[]>([]);
  const connectedIds = ref<Set<string>>(new Set());
  const editingConnectionId = ref<string | null>(null);

  function startEditing(id: string) {
    editingConnectionId.value = id;
  }

  function stopEditing() {
    editingConnectionId.value = null;
  }

  function getConfig(connectionId: string) {
    return connections.value.find((c) => c.id === connectionId);
  }

  function addConnection(config: ConnectionConfig) {
    connections.value.push(config);
    persistConnections();
  }

  function removeConnection(id: string) {
    connections.value = connections.value.filter((c) => c.id !== id);
    treeNodes.value = treeNodes.value.filter((n) => n.id !== id);
    if (activeConnectionId.value === id) {
      activeConnectionId.value = null;
    }
    persistConnections();
  }

  function updateConnection(config: ConnectionConfig) {
    const idx = connections.value.findIndex((c) => c.id === config.id);
    if (idx >= 0) connections.value[idx] = config;
    const node = findNode(treeNodes.value, config.id);
    if (node) {
      node.label = config.name;
      node.isExpanded = false;
      node.children = [];
    }
    connectedIds.value.delete(config.id);
    persistConnections();
  }

  async function connect(config: ConnectionConfig) {
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
      node.children = databases.map((db) => ({
        id: `${connectionId}:${db.name}`,
        label: db.name,
        type: "database" as const,
        connectionId,
        database: db.name,
        isExpanded: false,
        children: [],
      }));
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
      node.children = dbs.map((db) => ({
        id: `${connectionId}:db${db}`,
        label: `db${db}`,
        type: "redis-db" as const,
        connectionId,
        database: String(db),
        isExpanded: false,
        children: [],
      }));
      node.isExpanded = true;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadRedisKeys(connectionId: string, db: number, nodeId: string) {
    const node = findNode(treeNodes.value, nodeId);
    if (!node) return;

    node.isLoading = true;
    try {
      const result = await api.redisScanKeys(connectionId, db, 0, "*", 200);
      node.scanCursor = result.cursor;
      node.hasMore = result.cursor !== 0;
      node.children = result.keys.map((k) => ({
        id: `${nodeId}:${k.key}`,
        label: `${k.key} [${k.key_type}]${k.ttl > 0 ? ` TTL:${k.ttl}` : ""}`,
        type: "redis-key" as const,
        connectionId,
        database: String(db),
        isExpanded: false,
      }));
      node.isExpanded = true;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadMoreRedisKeys(connectionId: string, db: number, nodeId: string) {
    const node = findNode(treeNodes.value, nodeId);
    if (!node || node.isLoading || !node.hasMore) return;

    node.isLoading = true;
    try {
      const result = await api.redisScanKeys(connectionId, db, node.scanCursor ?? 0, "*", 200);
      const existingIds = new Set((node.children ?? []).map((child) => child.id));
      const moreChildren = result.keys
        .filter((k) => !existingIds.has(`${nodeId}:${k.key}`))
        .map((k) => ({
          id: `${nodeId}:${k.key}`,
          label: `${k.key} [${k.key_type}]${k.ttl > 0 ? ` TTL:${k.ttl}` : ""}`,
          type: "redis-key" as const,
          connectionId,
          database: String(db),
          isExpanded: false,
        }));

      node.scanCursor = result.cursor;
      node.hasMore = result.cursor !== 0;
      node.children = [...(node.children ?? []), ...moreChildren];
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
      node.children = dbs.map((db) => ({
        id: `${connectionId}:${db}`,
        label: db,
        type: "mongo-db" as const,
        connectionId,
        database: db,
        isExpanded: false,
        children: [],
      }));
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
      node.children = collections.map((col) => ({
        id: `${nodeId}:${col}`,
        label: col,
        type: "mongo-collection" as const,
        connectionId,
        database,
        isExpanded: false,
      }));
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
      node.children = schemas.map((s) => ({
        id: `${connectionId}:${database}:${s}`,
        label: s,
        type: "schema" as const,
        connectionId,
        database,
        schema: s,
        isExpanded: false,
        children: [],
      }));
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
      node.children = tables.map((t) => ({
        id: `${nodeId}:${t.name}`,
        label: t.name,
        type: (t.table_type === "VIEW" ? "view" : "table") as "view" | "table",
        connectionId,
        database,
        schema,
        isExpanded: false,
        children: [],
      }));
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

    node.children = [
      { id: `${parentId}:__columns`, label: "tree.columns", type: "group-columns", connectionId, database, schema, tableName: table, isExpanded: false, children: [] },
      { id: `${parentId}:__indexes`, label: "tree.indexes", type: "group-indexes", connectionId, database, schema, tableName: table, isExpanded: false, children: [] },
      { id: `${parentId}:__fkeys`, label: "tree.foreignKeys", type: "group-fkeys", connectionId, database, schema, tableName: table, isExpanded: false, children: [] },
      { id: `${parentId}:__triggers`, label: "tree.triggers", type: "group-triggers", connectionId, database, schema, tableName: table, isExpanded: false, children: [] },
    ];
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
      node.children = columns.map((col) => ({
        id: `${parentId}:${col.name}`,
        label: `${col.name} (${col.data_type})`,
        type: "column" as const,
        connectionId,
        database,
        schema,
        meta: col,
      }));
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
      node.children = indexes.map((idx) => ({
        id: `${parentId}:${idx.name}`,
        label: `${idx.name} (${idx.columns.join(", ")})`,
        type: "index" as const,
        connectionId,
        database,
        schema,
        meta: idx,
      }));
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
      node.children = fkeys.map((fk) => ({
        id: `${parentId}:${fk.name}`,
        label: `${fk.column} → ${fk.ref_table}.${fk.ref_column}`,
        type: "fkey" as const,
        connectionId,
        database,
        schema,
        meta: fk,
      }));
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
      node.children = triggers.map((tr) => ({
        id: `${parentId}:${tr.name}`,
        label: `${tr.name} (${tr.timing} ${tr.event})`,
        type: "trigger" as const,
        connectionId,
        database,
        schema,
        meta: tr,
      }));
      node.isExpanded = true;
    } finally {
      node.isLoading = false;
    }
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
    const data = connections.value.map((c) => ({ ...c, password: "" }));
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
        addConnection(config);
        treeNodes.value.push({
          id: config.id,
          label: config.name,
          type: "connection" as const,
          connectionId: config.id,
          isExpanded: false,
          children: [],
        });
      }
    }
  }

  async function initFromDisk() {
    const saved = await api.loadConnections();
    connections.value = saved;
    treeNodes.value = saved.map((config) => ({
      id: config.id,
      label: config.name,
      type: "connection" as const,
      connectionId: config.id,
      isExpanded: false,
      children: [],
    }));
  }

  return {
    connections,
    activeConnectionId,
    treeNodes,
    connectedIds,
    getConfig,
    addConnection,
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
    loadRedisKeys,
    loadMoreRedisKeys,
    loadMongoDatabases,
    loadMongoCollections,
    loadSchemas,
    loadTables,
    loadTableGroups,
    loadColumns,
    loadIndexes,
    loadForeignKeys,
    loadTriggers,
    exportConnectionsToFile,
    importConnectionsFromFile,
  };
});

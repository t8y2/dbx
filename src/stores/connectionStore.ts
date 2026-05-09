import { defineStore } from "pinia";
import { uuid } from "@/lib/utils";
import { ref, watch } from "vue";
import type { ColumnInfo, ConnectionConfig, SidebarLayout, TreeNode } from "@/types/database";
import { orderPinnedFirst } from "@/lib/pinnedItems";
import {
  reconcileLayout,
  buildTreeNodesFromLayout,
  emptyLayout,
  appendConnectionToLayout,
  removeConnectionFromSidebarLayout,
  createGroup as createGroupOp,
  renameGroup as renameGroupOp,
  deleteGroup as deleteGroupOp,
  toggleGroupCollapsed as toggleGroupCollapsedOp,
  moveConnectionToGroup as moveConnectionToGroupOp,
  reorderEntry as reorderEntryOp,
  type DropPosition,
} from "@/lib/sidebarLayout";
import type { SqlCompletionColumn, SqlCompletionTable } from "@/lib/sqlCompletion";
import * as api from "@/lib/api";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { isSchemaAware } from "@/lib/databaseCapabilities";
import { buildDatabaseTreeNodes } from "@/lib/databaseTree";

const PINNED_TREE_NODES_STORAGE_KEY = "dbx-pinned-tree-nodes";

export const useConnectionStore = defineStore("connection", () => {
  const connections = ref<ConnectionConfig[]>([]);
  const isDesktop = isTauriRuntime();
  const activeConnectionId = ref<string | null>(!isDesktop ? localStorage.getItem("dbx-active-connection") : null);

  watch(activeConnectionId, (id) => {
    if (isDesktop) return;
    if (id) localStorage.setItem("dbx-active-connection", id);
    else localStorage.removeItem("dbx-active-connection");
  });
  const treeNodes = ref<TreeNode[]>([]);
  const pinnedTreeNodeIds = ref<Set<string>>(loadPinnedTreeNodeIds());
  const connectedIds = ref<Set<string>>(new Set());
  const connectionErrors = ref<Record<string, string>>({});
  const editingConnectionId = ref<string | null>(null);
  const completionTablesCache = ref<Record<string, SqlCompletionTable[]>>({});
  const completionColumnsCache = ref<Record<string, ColumnInfo[]>>({});
  const transferSource = ref<{ connectionId: string; database: string } | null>(null);
  const schemaDiffSource = ref<{ connectionId: string; database: string } | null>(null);
  const sqlFileSource = ref<{ connectionId: string; database: string } | null>(null);
  const diagramSource = ref<{
    connectionId: string;
    database: string;
    schema?: string;
    tableName?: string;
  } | null>(null);
  const tableImportSource = ref<{
    connectionId: string;
    database: string;
    schema?: string;
    tableName: string;
  } | null>(null);
  const structureEditorSource = ref<{
    connectionId: string;
    database: string;
    schema?: string;
    tableName: string;
  } | null>(null);
  const fieldLineageSource = ref<{
    connectionId: string;
    database: string;
    schema?: string;
    tableName: string;
    columnName: string;
  } | null>(null);
  const databaseSearchSource = ref<{
    connectionId: string;
    database: string;
    schema?: string;
  } | null>(null);
  const sidebarLayout = ref<SidebarLayout>(emptyLayout());
  let layoutPersistTimer: ReturnType<typeof setTimeout> | null = null;

  function startEditing(id: string) {
    editingConnectionId.value = id;
  }

  function stopEditing() {
    editingConnectionId.value = null;
  }

  function getConfig(connectionId: string) {
    return connections.value.find((c) => c.id === connectionId);
  }

  function connectionErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  function setConnectionError(connectionId: string, message: string) {
    connectionErrors.value = {
      ...connectionErrors.value,
      [connectionId]: message,
    };
  }

  function clearConnectionError(connectionId: string) {
    if (!connectionErrors.value[connectionId]) return;
    const next = { ...connectionErrors.value };
    delete next[connectionId];
    connectionErrors.value = next;
  }

  function recordConnectionError(connectionId: string, error: unknown): string {
    const message = connectionErrorMessage(error);
    setConnectionError(connectionId, message);
    return message;
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
      doris: "Doris",
      starrocks: "StarRocks",
      redshift: "Redshift",
      dameng: "DM (Dameng)",
      gaussdb: "GaussDB",
    };

    const profile = config.driver_profile || config.db_type;
    let dbType = config.db_type;
    if ((profile === "gaussdb" || profile === "opengauss") && dbType === "postgres") {
      dbType = "gaussdb" as ConnectionConfig["db_type"];
    }

    return {
      ...config,
      db_type: dbType,
      driver_profile: profile,
      driver_label: config.driver_label || labelMap[profile] || config.db_type,
      url_params: config.url_params || "",
    };
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

    const isConnectionOrGroup =
      treeNodes.value.some((n) => n.id === id) ||
      treeNodes.value.some((n) => n.type === "connection-group" && n.children?.some((c) => c.id === id));
    if (isConnectionOrGroup) {
      rebuildTreeNodes();
    } else {
      const parent = findParentNode(treeNodes.value, id);
      if (parent?.children) {
        parent.children = orderPinnedFirst(parent.children, (child) => !!child.pinned);
      }
    }
  }

  async function addConnection(config: ConnectionConfig) {
    const normalized = normalizeConnection(config);
    const existing = connections.value.findIndex((c) => c.id === normalized.id);
    const nextConnections = [...connections.value];
    if (existing >= 0) {
      nextConnections[existing] = normalized;
    } else {
      nextConnections.push(normalized);
      sidebarLayout.value = appendConnectionToLayout(sidebarLayout.value, normalized.id);
    }
    await persistConnections(nextConnections);
    connections.value = nextConnections;
    rebuildTreeNodes();
    persistSidebarLayoutDebounced();
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

  async function removeConnection(id: string) {
    const nextConnections = connections.value.filter((c) => c.id !== id);
    await persistConnections(nextConnections);
    connections.value = nextConnections;
    clearConnectionError(id);
    sidebarLayout.value = removeConnectionFromSidebarLayout(sidebarLayout.value, id);
    rebuildTreeNodes();
    persistSidebarLayoutDebounced();
    if (activeConnectionId.value === id) {
      activeConnectionId.value = null;
    }
    invalidateCompletionCache(id);
  }

  async function updateConnection(config: ConnectionConfig) {
    config = normalizeConnection(config);
    const idx = connections.value.findIndex((c) => c.id === config.id);
    if (idx < 0) return;
    const nextConnections = [...connections.value];
    nextConnections[idx] = config;
    await persistConnections(nextConnections);
    connections.value = nextConnections;
    rebuildTreeNodes();
    connectedIds.value.delete(config.id);
    invalidateCompletionCache(config.id);
  }

  async function setDefaultDatabase(connectionId: string, database: string) {
    const config = getConfig(connectionId);
    if (!config || config.database === database) return;
    await updateConnection({
      ...config,
      database,
    });
  }

  async function clearDefaultDatabase(connectionId: string) {
    const config = getConfig(connectionId);
    if (!config || !config.database) return;
    await updateConnection({
      ...config,
      database: undefined,
    });
  }

  function isDefaultDatabase(connectionId: string, database: string): boolean {
    return getConfig(connectionId)?.database === database && database !== "";
  }

  async function connect(config: ConnectionConfig) {
    config = normalizeConnection(config);
    const pendingNode = findNode(treeNodes.value, config.id);
    if (pendingNode) pendingNode.isLoading = true;
    try {
      const id = await api.connectDb(config);
      activeConnectionId.value = id;
      connectedIds.value.add(id);
      clearConnectionError(config.id);
      if (id !== config.id) clearConnectionError(id);

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
    } catch (e) {
      recordConnectionError(config.id, e);
      throw e;
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
    if (!config) {
      const error = new Error("Connection config not found");
      recordConnectionError(connectionId, error);
      throw error;
    }
    try {
      await api.connectDb(config);
      connectedIds.value.add(connectionId);
      activeConnectionId.value = connectionId;
      clearConnectionError(connectionId);
    } catch (e) {
      recordConnectionError(connectionId, e);
      throw e;
    }
  }

  async function loadDatabases(connectionId: string) {
    const node = findNode(treeNodes.value, connectionId);
    if (!node) return;

    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      const databases = await api.listDatabases(connectionId);
      setChildren(node, buildDatabaseTreeNodes(connectionId, databases));
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
      setChildren(
        node,
        dbs.map((db) => ({
          id: `${connectionId}:db${db}`,
          label: `db${db}`,
          type: "redis-db" as const,
          connectionId,
          database: String(db),
          isExpanded: false,
          children: [],
        })),
      );
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
      setChildren(
        node,
        dbs.map((db) => ({
          id: `${connectionId}:${db}`,
          label: db,
          type: "mongo-db" as const,
          connectionId,
          database: db,
          isExpanded: false,
          children: [],
        })),
      );
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
      setChildren(
        node,
        collections.map((col) => ({
          id: `${nodeId}:${col}`,
          label: col,
          type: "mongo-collection" as const,
          connectionId,
          database,
          isExpanded: false,
        })),
      );
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
      setChildren(
        node,
        schemas.map((s) => ({
          id: `${connectionId}:${database}:${s}`,
          label: s,
          type: "schema" as const,
          connectionId,
          database,
          schema: s,
          isExpanded: false,
          children: [],
        })),
      );
      node.isExpanded = true;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadTables(connectionId: string, database: string, schema?: string) {
    const nodeId = schema ? `${connectionId}:${database}:${schema}` : `${connectionId}:${database}`;
    const node = findNode(treeNodes.value, nodeId);
    if (!node) return;

    node.isLoading = true;
    try {
      const querySchema = schema || database;
      const tables = await api.listTables(connectionId, database, querySchema);
      const config = getConfig(connectionId);
      const effectiveSchema = schema || (config?.db_type && isSchemaAware(config.db_type) ? database : undefined);
      setChildren(
        node,
        tables.map((t) => ({
          id: `${nodeId}:${t.name}`,
          label: t.name,
          type: (t.table_type === "VIEW" ? "view" : "table") as "view" | "table",
          connectionId,
          database,
          schema: effectiveSchema,
          isExpanded: false,
          children: [],
        })),
      );
      node.isExpanded = true;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadTableGroups(connectionId: string, database: string, table: string, schema?: string) {
    const parentId = schema ? `${connectionId}:${database}:${schema}:${table}` : `${connectionId}:${database}:${table}`;
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    setChildren(node, [
      {
        id: `${parentId}:__columns`,
        label: "tree.columns",
        type: "group-columns",
        connectionId,
        database,
        schema,
        tableName: table,
        isExpanded: false,
        children: [],
      },
      {
        id: `${parentId}:__indexes`,
        label: "tree.indexes",
        type: "group-indexes",
        connectionId,
        database,
        schema,
        tableName: table,
        isExpanded: false,
        children: [],
      },
      {
        id: `${parentId}:__fkeys`,
        label: "tree.foreignKeys",
        type: "group-fkeys",
        connectionId,
        database,
        schema,
        tableName: table,
        isExpanded: false,
        children: [],
      },
      {
        id: `${parentId}:__triggers`,
        label: "tree.triggers",
        type: "group-triggers",
        connectionId,
        database,
        schema,
        tableName: table,
        isExpanded: false,
        children: [],
      },
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
      setChildren(
        node,
        columns.map((col) => ({
          id: `${parentId}:${col.name}`,
          label: `${col.name} (${col.data_type})`,
          type: "column" as const,
          connectionId,
          database,
          schema,
          tableName: table,
          meta: col,
        })),
      );
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
      setChildren(
        node,
        indexes.map((idx) => ({
          id: `${parentId}:${idx.name}`,
          label: `${idx.name} (${idx.columns.join(", ")})`,
          type: "index" as const,
          connectionId,
          database,
          schema,
          meta: idx,
        })),
      );
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
      setChildren(
        node,
        fkeys.map((fk) => ({
          id: `${parentId}:${fk.name}`,
          label: `${fk.column} → ${fk.ref_table}.${fk.ref_column}`,
          type: "fkey" as const,
          connectionId,
          database,
          schema,
          meta: fk,
        })),
      );
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
      setChildren(
        node,
        triggers.map((tr) => ({
          id: `${parentId}:${tr.name}`,
          label: `${tr.name} (${tr.timing} ${tr.event})`,
          type: "trigger" as const,
          connectionId,
          database,
          schema,
          meta: tr,
        })),
      );
      node.isExpanded = true;
    } finally {
      node.isLoading = false;
    }
  }

  function isSchemaAwareDatabase(connectionId: string): boolean {
    return isSchemaAware(getConfig(connectionId)?.db_type);
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
          try {
            const tables = await api.listTables(connectionId, database, schema);
            return tables.map((table) => ({
              name: table.name,
              schema,
              type: table.table_type === "VIEW" ? ("view" as const) : ("table" as const),
            }));
          } catch {
            return [];
          }
        }),
      );
      completionTablesCache.value[cacheKey] = tableGroups.flat();
      return completionTablesCache.value[cacheKey];
    }

    const tables = await api.listTables(connectionId, database, database);
    completionTablesCache.value[cacheKey] = tables.map((table) => ({
      name: table.name,
      type: table.table_type === "VIEW" ? ("view" as const) : ("table" as const),
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

  async function persistConnections(nextConnections: ConnectionConfig[] = connections.value) {
    await api.saveConnections(nextConnections);
  }

  function persistSidebarLayoutDebounced() {
    if (layoutPersistTimer) clearTimeout(layoutPersistTimer);
    layoutPersistTimer = setTimeout(() => {
      api.saveSidebarLayout(sidebarLayout.value).catch(() => {});
      layoutPersistTimer = null;
    }, 300);
  }

  function rebuildTreeNodes() {
    const existingNodesMap = new Map<string, TreeNode>();
    const collectExisting = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        existingNodesMap.set(node.id, node);
        if (node.children) collectExisting(node.children);
      }
    };
    collectExisting(treeNodes.value);

    const freshNodes = buildTreeNodesFromLayout(sidebarLayout.value, connections.value, pinnedTreeNodeIds.value);
    const mergeState = (nodes: TreeNode[]): TreeNode[] =>
      nodes.map((node) => {
        const existing = existingNodesMap.get(node.id);
        if (node.type === "connection-group") {
          return { ...node, children: mergeState(node.children || []) };
        }
        if (existing && node.type === "connection") {
          return { ...existing, label: node.label, pinned: node.pinned };
        }
        return node;
      });
    treeNodes.value = mergeState(freshNodes);
  }

  function updateLayoutAndRebuild(nextLayout: SidebarLayout) {
    sidebarLayout.value = nextLayout;
    rebuildTreeNodes();
    persistSidebarLayoutDebounced();
  }

  function refreshAllTree() {
    const resetChildren = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type === "connection-group") {
          if (node.children) resetChildren(node.children);
          continue;
        }
        if (node.isExpanded) {
          node.isExpanded = false;
          node.children = [];
        }
      }
    };
    resetChildren(treeNodes.value);
  }

  async function exportConnectionsToFile(passphrase: string) {
    const { encryptConfig } = await import("@/lib/configCrypto");
    const exportData = { connections: connections.value, layout: sidebarLayout.value };
    const json = JSON.stringify(exportData);
    const payload = await encryptConfig(json, passphrase);
    const content = JSON.stringify(payload, null, 2);

    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        filters: [{ name: "JSON", extensions: ["json"] }],
        defaultPath: "dbx-connections.json",
      });
      if (!path) return;
      await writeTextFile(path, content);
    } else {
      const blob = new Blob([content], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "dbx-connections.json";
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  async function readImportFile(): Promise<{ content: string; encrypted: boolean } | null> {
    let content: string;

    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await open({
        filters: [{ name: "JSON", extensions: ["json"] }],
        multiple: false,
      });
      if (!path) return null;
      content = await readTextFile(path as string);
    } else {
      content = await new Promise<string>((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = () => {
          const file = input.files?.[0];
          if (!file) {
            reject(new Error("No file selected"));
            return;
          }
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsText(file);
        };
        input.click();
      });
    }

    const { isEncryptedConfig } = await import("@/lib/configCrypto");
    const parsed = JSON.parse(content);
    return { content, encrypted: isEncryptedConfig(parsed) };
  }

  async function importConnectionsFromFile(
    content: string,
    passphrase: string | null,
  ): Promise<{ count: number; layout?: SidebarLayout }> {
    let imported: ConnectionConfig[];
    let importedLayout: SidebarLayout | undefined;
    const parsed = JSON.parse(content);

    if (passphrase) {
      const { decryptConfig } = await import("@/lib/configCrypto");
      const json = await decryptConfig(parsed, passphrase);
      const decrypted = JSON.parse(json);
      if (Array.isArray(decrypted)) {
        imported = decrypted;
      } else if (decrypted.connections) {
        imported = decrypted.connections;
        if (decrypted.layout?.groups && decrypted.layout?.order) {
          importedLayout = decrypted.layout;
        }
      } else {
        imported = [];
      }
    } else if (Array.isArray(parsed)) {
      imported = parsed;
    } else if (parsed.format === "dbx-config" && Array.isArray(parsed.connections)) {
      imported = parsed.connections;
    } else if (parsed.connections && Array.isArray(parsed.connections)) {
      imported = parsed.connections;
      if (parsed.layout?.groups && parsed.layout?.order) {
        importedLayout = parsed.layout;
      }
    } else {
      imported = [];
    }

    let count = 0;
    for (const config of imported) {
      const duplicate = connections.value.find(
        (c) => c.name === config.name && c.host === config.host && c.port === config.port,
      );
      if (!duplicate) {
        config.id = uuid();
        const normalized = normalizeConnection(config);
        await addConnection(normalized);
        count++;
      }
    }
    return { count, layout: importedLayout };
  }

  function applySidebarLayout(layout: SidebarLayout) {
    const reconciledLayout = reconcileLayout(
      connections.value.map((c) => c.id),
      layout,
    );
    updateLayoutAndRebuild(reconciledLayout);
  }

  async function initFromDisk() {
    const saved = await api.loadConnections();
    connections.value = saved.map(normalizeConnection);
    const savedLayout = await api.loadSidebarLayout();
    sidebarLayout.value = reconcileLayout(
      connections.value.map((c) => c.id),
      savedLayout,
    );
    rebuildTreeNodes();
  }

  function addEphemeralConnection(config: ConnectionConfig) {
    const normalized = normalizeConnection(config);
    if (!connections.value.find((c) => c.id === normalized.id)) {
      connections.value.push(normalized);
    }
    connectedIds.value.add(normalized.id);
    clearConnectionError(normalized.id);
  }

  return {
    connections,
    activeConnectionId,
    treeNodes,
    refreshAllTree,
    connectedIds,
    connectionErrors,
    setConnectionError,
    clearConnectionError,
    recordConnectionError,
    sidebarLayout,
    getConfig,
    isTreeNodePinned,
    toggleTreeNodePin,
    addConnection,
    addEphemeralConnection,
    updateConnection,
    setDefaultDatabase,
    clearDefaultDatabase,
    isDefaultDatabase,
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
    readImportFile,
    importConnectionsFromFile,
    applySidebarLayout,
    transferSource,
    schemaDiffSource,
    sqlFileSource,
    diagramSource,
    tableImportSource,
    structureEditorSource,
    fieldLineageSource,
    databaseSearchSource,
    createConnectionGroup(name: string) {
      const result = createGroupOp(sidebarLayout.value, name);
      updateLayoutAndRebuild(result.layout);
      return result.groupId;
    },
    renameConnectionGroup(groupId: string, name: string) {
      updateLayoutAndRebuild(renameGroupOp(sidebarLayout.value, groupId, name));
    },
    deleteConnectionGroup(groupId: string) {
      updateLayoutAndRebuild(deleteGroupOp(sidebarLayout.value, groupId));
    },
    toggleConnectionGroupCollapsed(groupId: string) {
      updateLayoutAndRebuild(toggleGroupCollapsedOp(sidebarLayout.value, groupId));
    },
    moveConnectionToGroup(connectionId: string, groupId: string | null) {
      updateLayoutAndRebuild(moveConnectionToGroupOp(sidebarLayout.value, connectionId, groupId));
    },
    reorderSidebarEntry(draggedId: string, targetId: string, position: DropPosition) {
      updateLayoutAndRebuild(reorderEntryOp(sidebarLayout.value, draggedId, targetId, position));
    },
  };
});

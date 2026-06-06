import { defineStore } from "pinia";
import { uuid } from "@/lib/utils";
import { ref, computed, watch } from "vue";
import type { ColumnInfo, ConnectionConfig, ObjectInfo, SidebarLayout, TreeNode } from "@/types/database";
import { applyPinnedTreeNodeState, orderPinnedFirst } from "@/lib/pinnedItems";
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
import type { SqlCompletionColumn, SqlCompletionObject, SqlCompletionTable } from "@/lib/sqlCompletion";
import * as api from "@/lib/api";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { isSchemaAware, usesTreeSchemaMode } from "@/lib/databaseCapabilities";
import {
  connectionObjectTreeNodeSchema,
  connectionObjectTreeQuerySchema,
  connectionUsesDatabaseObjectTreeMode,
} from "@/lib/jdbcDialect";
import {
  buildDatabaseTreeNodes,
  buildDuckDbConnectionTreeNodes,
  sortSidebarNames,
  shouldIncludeDefaultDatabaseNode,
} from "@/lib/databaseTree";
import { buildSqlServerDatabaseTreeNodes, SQLSERVER_DEFAULT_SCHEMA } from "@/lib/sqlServerTree";
import { findDatabaseTreeNode } from "@/lib/treeRefreshTarget";
import { shouldMarkDisconnected } from "@/lib/connectionHealth";
import { connectionAttemptTimeoutMessage, connectionAttemptTimeoutMs } from "@/lib/connectionAttemptTimeout";
import {
  filterDatabaseNamesForConnection,
  filterVisibleDatabaseNames,
  normalizeVisibleDatabaseSelection,
} from "@/lib/visibleDatabases";
import {
  buildGroupedObjectTreeNodes,
  buildTableTreeNodes,
  expandCachedObjectBrowserNodes,
  mergeTableInfosIntoObjects,
  objectGroupRefreshParentId,
  tablePartitionGroups,
} from "@/lib/tableTree";
import {
  hasTreeNodeDatabaseContext,
  normalizeCataloglessDatabaseNodes,
  treeNodeSchemaCachePrefix,
} from "@/lib/treeNodeContext";
import { decodeSchemaTreeCache, encodeSchemaTreeCache } from "@/lib/schemaTreeCache";
import { sortSidebarTreeChildrenForParent } from "@/lib/sidebarNodeOrdering";
import { prunePinnedTreeNodeIdsForConnection } from "@/lib/pinnedTreeNodeIds";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { useSettingsStore } from "@/stores/settingsStore";

const PINNED_TREE_NODES_STORAGE_KEY = "dbx-pinned-tree-nodes";
const ACTIVE_CONNECTION_STORAGE_KEY = "dbx-active-connection";
type ImportSource = "dbx" | "navicat" | "dbeaver";

interface TreeClipboardTableStructure {
  kind: "table-structure";
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
}

interface LoadTreeOptions {
  force?: boolean;
}

interface PersistedTreeChildrenLoadResult {
  hit: boolean;
  isStale: boolean;
}

type BeforeConnectHandler = (config: ConnectionConfig) => Promise<void>;

function redisDbLabel(db: number, loadedKeyCount?: number, totalKeyCount?: number): string {
  if (totalKeyCount == null) return `db${db}`;
  return `db${db} (${loadedKeyCount ?? 0}/${totalKeyCount})`;
}

export const useConnectionStore = defineStore("connection", () => {
  const settingsStore = useSettingsStore();
  const connections = ref<ConnectionConfig[]>([]);
  const isDesktop = isTauriRuntime();
  const activeConnectionId = ref<string | null>(localStorage.getItem(ACTIVE_CONNECTION_STORAGE_KEY));
  const selectedTreeNodeId = ref<string | null>(null);
  const selectedTreeNodeIds = ref<string[]>([]);
  const treeSelectionAnchorId = ref<string | null>(null);
  const treeClipboard = ref<TreeClipboardTableStructure | null>(null);

  watch(activeConnectionId, (id) => {
    if (id) localStorage.setItem(ACTIVE_CONNECTION_STORAGE_KEY, id);
    else localStorage.removeItem(ACTIVE_CONNECTION_STORAGE_KEY);
  });
  const treeNodes = ref<TreeNode[]>([]);
  const pinnedTreeNodeIds = ref<Set<string>>(new Set());
  const connectedIds = ref<Set<string>>(new Set());
  const loadedTreeNodeChildrenIds = ref<Set<string>>(new Set());
  const connectionErrors = ref<Record<string, string>>({});
  const editingConnectionId = ref<string | null>(null);
  const newConnectionGroupId = ref<string | null>(null);
  const completionTablesCache = ref<Record<string, SqlCompletionTable[]>>({});
  const completionObjectsCache = ref<Record<string, SqlCompletionObject[]>>({});
  const completionColumnsCache = ref<Record<string, ColumnInfo[]>>({});
  const elasticsearchCompletionIndicesCache = ref<Record<string, string[]>>({});
  const schemaListCache = ref<Record<string, string[]>>({});
  const transferSource = ref<{ connectionId: string; database: string } | null>(null);
  const schemaDiffSource = ref<{ connectionId: string; database: string; schema?: string } | null>(null);
  const dataCompareSource = ref<{
    connectionId: string;
    database: string;
    schema?: string;
    tableName?: string;
  } | null>(null);
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
  const databaseExportSource = ref<{
    connectionId: string;
    database: string;
    schema?: string;
    tableName?: string;
    tableNames?: string[];
  } | null>(null);
  const sidebarLayout = ref<SidebarLayout>(emptyLayout());
  let layoutPersistTimer: ReturnType<typeof setTimeout> | null = null;
  const staleTreeRefreshIds = new Set<string>();
  let beforeConnectHandler: BeforeConnectHandler | null = null;
  let initFromDiskPromise: Promise<void> | null = null;

  function startEditing(id: string) {
    editingConnectionId.value = id;
  }

  function stopEditing() {
    editingConnectionId.value = null;
  }

  function startCreatingConnectionInGroup(groupId: string) {
    stopEditing();
    newConnectionGroupId.value = groupId;
  }

  function stopCreatingConnectionInGroup() {
    newConnectionGroupId.value = null;
  }

  const configById = computed(() => new Map(connections.value.map((c) => [c.id, c])));

  function getConfig(connectionId: string) {
    return configById.value.get(connectionId);
  }

  function connectionErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  function setConnectionError(connectionId: string, message: string) {
    connectionErrors.value[connectionId] = message;
  }

  function clearConnectionError(connectionId: string) {
    if (!connectionErrors.value[connectionId]) return;
    delete connectionErrors.value[connectionId];
  }

  function recordConnectionError(connectionId: string, error: unknown): string {
    const message = connectionErrorMessage(error);
    setConnectionError(connectionId, message);
    return message;
  }

  function recordMetadataLoadError(connectionId: string, error: unknown) {
    if (shouldMarkDisconnected(error)) {
      connectedIds.value.delete(connectionId);
      if (activeConnectionId.value === connectionId) activeConnectionId.value = null;
    }
    recordConnectionError(connectionId, error);
  }

  async function withConnectionAttemptTimeout<T>(promise: Promise<T>, config: ConnectionConfig): Promise<T> {
    const timeoutMs = connectionAttemptTimeoutMs(config);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(connectionAttemptTimeoutMessage(timeoutMs))), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
      kwdb: "KWDB",
      kingbase: "KingBase",
      highgo: "瀚高 HighGo",
      yashandb: "崖山 YashanDB",
      vastbase: "Vastbase",
      goldendb: "GoldenDB",
      access: "Microsoft Access",
      h2: "H2",
      snowflake: "Snowflake",
      trino: "Trino",
      hive: "Hive",
      db2: "DB2",
      informix: "Informix",
      neo4j: "Neo4j",
      cassandra: "Cassandra",
      bigquery: "BigQuery",
      kylin: "Kylin",
      sundb: "SunDB",
    };

    const profile = config.driver_profile || config.db_type;
    let dbType = config.db_type;
    if ((profile === "gaussdb" || profile === "opengauss") && dbType === "postgres") {
      dbType = "gaussdb" as ConnectionConfig["db_type"];
    } else if (profile === "kwdb" && dbType === "postgres") {
      dbType = "kwdb" as ConnectionConfig["db_type"];
    } else if (profile === "redshift" && dbType === "postgres") {
      dbType = "redshift" as ConnectionConfig["db_type"];
    } else if (profile === "kingbase" && dbType === "postgres") {
      dbType = "kingbase" as ConnectionConfig["db_type"];
    } else if (profile === "highgo" && dbType === "postgres") {
      dbType = "highgo" as ConnectionConfig["db_type"];
    } else if (profile === "vastbase" && dbType === "postgres") {
      dbType = "vastbase" as ConnectionConfig["db_type"];
    } else if (profile === "goldendb" && dbType === "mysql") {
      dbType = "goldendb" as ConnectionConfig["db_type"];
    }

    return {
      ...config,
      db_type: dbType,
      driver_profile: profile,
      driver_label: config.driver_label || labelMap[profile] || config.db_type,
      url_params: config.url_params || "",
      attached_databases: Array.isArray(config.attached_databases)
        ? config.attached_databases.filter((database) => database.name?.trim() && database.path?.trim())
        : [],
      transport_layers: Array.isArray(config.transport_layers) ? config.transport_layers : [],
      connect_timeout_secs: config.connect_timeout_secs || 5,
      query_timeout_secs: config.query_timeout_secs ?? 30,
    };
  }

  function loadPinnedTreeNodeIdsFromLocalStorage(): Set<string> {
    try {
      if (typeof localStorage === "undefined") return new Set();
      const saved = localStorage.getItem(PINNED_TREE_NODES_STORAGE_KEY);
      const ids = saved ? JSON.parse(saved) : [];
      return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
    } catch {
      return new Set();
    }
  }

  async function loadPinnedTreeNodeIds(): Promise<Set<string>> {
    if (!isDesktop) return loadPinnedTreeNodeIdsFromLocalStorage();
    const ids = await api.loadPinnedTreeNodeIds().catch(() => []);
    const valid = ids.filter((id) => typeof id === "string");
    if (valid.length > 0) return new Set(valid);

    // Migrate legacy localStorage values for existing desktop users.
    const legacy = loadPinnedTreeNodeIdsFromLocalStorage();
    if (legacy.size > 0) {
      await api.savePinnedTreeNodeIds([...legacy]).catch(() => undefined);
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(PINNED_TREE_NODES_STORAGE_KEY);
      }
    }
    return legacy;
  }

  function persistPinnedTreeNodeIds() {
    if (isDesktop) {
      void api.savePinnedTreeNodeIds([...pinnedTreeNodeIds.value]).catch(() => undefined);
      return;
    }
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(PINNED_TREE_NODES_STORAGE_KEY, JSON.stringify([...pinnedTreeNodeIds.value]));
  }

  function isTreeNodePinned(id: string): boolean {
    return pinnedTreeNodeIds.value.has(id);
  }

  function setChildren(parent: TreeNode, children: TreeNode[]) {
    if (parent.children && parent.children.length > 0) {
      const oldMap = new Map(parent.children.map((c) => [c.id, c] as const));
      children = children.map((child) => {
        const old = oldMap.get(child.id);
        if (old && old.isExpanded && old.children && old.children.length > 0) {
          return { ...child, isExpanded: true, children: old.children };
        }
        return child;
      });
    }
    parent.children = applyPinnedTreeNodeState(children, pinnedTreeNodeIds.value);
    loadedTreeNodeChildrenIds.value.add(parent.id);
  }

  function removeTreeNode(nodeId: string) {
    const parent = findParentNode(treeNodes.value, nodeId);
    if (parent?.children) {
      parent.children = parent.children.filter((c) => c.id !== nodeId);
    }
    if (selectedTreeNodeId.value === nodeId) selectedTreeNodeId.value = null;
    selectedTreeNodeIds.value = selectedTreeNodeIds.value.filter((id) => id !== nodeId);
    if (treeSelectionAnchorId.value === nodeId) treeSelectionAnchorId.value = null;
  }

  function buildSavedSqlRootNode(connectionId: string, existingRoot?: TreeNode): TreeNode | undefined {
    const savedSqlStore = useSavedSqlStore();
    const folders = savedSqlStore.listFolders(connectionId);
    const files = savedSqlStore.listFiles(connectionId);

    if (folders.length === 0 && files.length === 0) return undefined;

    const existingById = new Map<string, TreeNode>();
    const collectExisting = (node?: TreeNode) => {
      if (!node) return;
      existingById.set(node.id, node);
      node.children?.forEach(collectExisting);
    };
    collectExisting(existingRoot);

    const fileNode = (file: ReturnType<typeof savedSqlStore.listFiles>[number]): TreeNode => ({
      id: `${connectionId}:__saved_sql:file:${file.id}`,
      label: file.name,
      type: "saved-sql-file",
      connectionId,
      database: file.database,
      schema: file.schema,
      savedSqlId: file.id,
    });

    const folderNodes = folders.map((folder) => {
      const id = `${connectionId}:__saved_sql:folder:${folder.id}`;
      const existing = existingById.get(id);
      return {
        id,
        label: folder.name,
        type: "saved-sql-folder" as const,
        connectionId,
        savedSqlFolderId: folder.id,
        isExpanded: existing?.isExpanded ?? true,
        children: savedSqlStore.listFiles(connectionId, folder.id).map(fileNode),
      };
    });

    const rootId = `${connectionId}:__saved_sql`;
    return {
      id: rootId,
      label: "tree.savedSql",
      type: "saved-sql-root",
      connectionId,
      isExpanded: existingRoot?.isExpanded ?? true,
      children: [...folderNodes, ...files.map(fileNode)],
    };
  }

  function withSavedSqlRoot(connectionId: string, children: TreeNode[], existingConnectionNode?: TreeNode): TreeNode[] {
    const existingRoot = existingConnectionNode?.children?.find((child) => child.type === "saved-sql-root");
    const nonSavedChildren = children.filter((child) => child.type !== "saved-sql-root");
    const savedSqlRoot = buildSavedSqlRootNode(connectionId, existingRoot);
    return savedSqlRoot ? [savedSqlRoot, ...nonSavedChildren] : nonSavedChildren;
  }

  function refreshSavedSqlTree(connectionId?: string) {
    const refresh = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type === "connection" && node.connectionId && (!connectionId || node.connectionId === connectionId)) {
          node.children = withSavedSqlRoot(
            node.connectionId,
            (node.children || []).filter((child) => child.type !== "saved-sql-root"),
            node,
          );
        }
        if (node.children) refresh(node.children);
      }
    };
    refresh(treeNodes.value);
  }

  function schemaCacheKey(...parts: string[]): string {
    return parts.map((part) => encodeURIComponent(part)).join(":");
  }

  function refreshStaleTreeNode(node: TreeNode) {
    if (staleTreeRefreshIds.has(node.id)) return;
    staleTreeRefreshIds.add(node.id);
    const expandedIds = collectExpandedNodeIds([node]);
    clearLoadedChildrenCache(node.id);
    void loadTreeNodeChildren(node, { force: true })
      .then(() => restoreExpandedChildren(node, expandedIds, { force: true }))
      .finally(() => staleTreeRefreshIds.delete(node.id));
  }

  async function loadPersistedTreeChildren(node: TreeNode, cacheKey: string): Promise<PersistedTreeChildrenLoadResult> {
    const payload = await api.loadSchemaCache<unknown>(cacheKey).catch(() => null);
    const decoded = decodeSchemaTreeCache<TreeNode[]>(payload);
    if (!decoded) return { hit: false, isStale: false };
    const normalizedChildren = sortSidebarTreeChildrenForParent(
      node,
      normalizeCataloglessDatabaseNodes(expandCachedObjectBrowserNodes(decoded.children)),
      node.connectionId ? getConfig(node.connectionId)?.db_type : undefined,
    );
    setChildren(
      node,
      node.type === "connection" && node.connectionId
        ? withSavedSqlRoot(node.connectionId, normalizedChildren, node)
        : normalizedChildren,
    );
    node.isExpanded = true;
    return { hit: true, isStale: decoded.isStale };
  }

  async function savePersistedTreeChildren(cacheKey: string, children: TreeNode[]) {
    await api.saveSchemaCache(cacheKey, encodeSchemaTreeCache(children)).catch(() => undefined);
  }

  function useCachedChildren(node: TreeNode, options?: LoadTreeOptions): boolean {
    if (options?.force || !loadedTreeNodeChildrenIds.value.has(node.id)) return false;
    node.isExpanded = true;
    return true;
  }

  function isTreeNodeChildrenLoaded(nodeId: string): boolean {
    return loadedTreeNodeChildrenIds.value.has(nodeId);
  }

  function clearLoadedChildrenCache(prefix: string) {
    for (const id of loadedTreeNodeChildrenIds.value) {
      if (id === prefix || id.startsWith(`${prefix}:`)) {
        loadedTreeNodeChildrenIds.value.delete(id);
      }
    }
    const rawPrefix = `${prefix}:`;
    const encodedPrefix = `${schemaCacheKey(prefix)}:`;
    if (rawPrefix === encodedPrefix) {
      api.deleteSchemaCachePrefix(rawPrefix).catch(() => undefined);
    } else {
      Promise.all([api.deleteSchemaCachePrefix(rawPrefix), api.deleteSchemaCachePrefix(encodedPrefix)]).catch(
        () => undefined,
      );
    }
  }

  function schemaCachePrefixForNode(node: TreeNode): string | null {
    return treeNodeSchemaCachePrefix(node);
  }

  async function clearPersistedTreeCacheForNode(node: TreeNode) {
    const prefix = schemaCachePrefixForNode(node);
    if (!prefix) return;
    await api.deleteSchemaCachePrefix(prefix).catch(() => undefined);
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
        const sqlRootIdx = parent.children.findIndex((c) => c.type === "saved-sql-root");
        if (sqlRootIdx > 0) {
          parent.children.unshift(...parent.children.splice(sqlRootIdx, 1));
        }
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
      sidebarLayout.value = appendConnectionToLayout(sidebarLayout.value, normalized.id, newConnectionGroupId.value);
    }
    await persistConnections(nextConnections);
    connections.value = nextConnections;
    rebuildTreeNodes();
    persistSidebarLayoutDebounced();
    stopCreatingConnectionInGroup();
  }

  function invalidateCompletionCache(connectionId: string, database?: string) {
    const cachePrefix = database == null ? `${connectionId}:` : `${connectionId}:${database}:`;
    const exactCacheKey = database == null ? null : `${connectionId}:${database}`;
    for (const key of Object.keys(completionTablesCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete completionTablesCache.value[key];
    }
    for (const key of Object.keys(completionObjectsCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete completionObjectsCache.value[key];
    }
    for (const key of Object.keys(completionColumnsCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete completionColumnsCache.value[key];
    }
    for (const key of Object.keys(schemaListCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete schemaListCache.value[key];
    }
    for (const key of Object.keys(elasticsearchCompletionIndicesCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete elasticsearchCompletionIndicesCache.value[key];
    }
  }

  async function removeConnection(id: string) {
    const nextConnections = connections.value.filter((c) => c.id !== id);
    await persistConnections(nextConnections);
    connections.value = nextConnections;
    pinnedTreeNodeIds.value = prunePinnedTreeNodeIdsForConnection(pinnedTreeNodeIds.value, id);
    persistPinnedTreeNodeIds();
    clearConnectionError(id);
    sidebarLayout.value = removeConnectionFromSidebarLayout(sidebarLayout.value, id);
    rebuildTreeNodes();
    persistSidebarLayoutDebounced();
    if (activeConnectionId.value === id) {
      activeConnectionId.value = null;
    }
    invalidateCompletionCache(id);
    clearLoadedChildrenCache(id);
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
    clearLoadedChildrenCache(config.id);
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

  async function setVisibleDatabases(connectionId: string, databaseNames: string[]) {
    const config = getConfig(connectionId);
    if (!config) return;
    await updateVisibleDatabasesConfig(connectionId, normalizeVisibleDatabaseSelection(databaseNames, databaseNames));
    await reloadConnectionDatabaseChildren(connectionId);
  }

  async function clearVisibleDatabases(connectionId: string) {
    const config = getConfig(connectionId);
    if (!config || !Array.isArray(config.visible_databases)) return;
    await updateVisibleDatabasesConfig(connectionId, undefined);
    await reloadConnectionDatabaseChildren(connectionId);
  }

  async function updateVisibleDatabasesConfig(connectionId: string, visibleDatabases: string[] | undefined) {
    const idx = connections.value.findIndex((connection) => connection.id === connectionId);
    if (idx < 0) return;
    const nextConnections = [...connections.value];
    nextConnections[idx] = {
      ...nextConnections[idx],
      visible_databases: visibleDatabases,
    };
    await persistConnections(nextConnections);
    connections.value = nextConnections;
    rebuildTreeNodes();
  }

  async function reloadConnectionDatabaseChildren(connectionId: string) {
    const config = getConfig(connectionId);
    if (!config) return;
    clearLoadedChildrenCache(connectionId);
    if (config.db_type === "redis") {
      await loadRedisDatabases(connectionId);
    } else if (config.db_type === "mongodb") {
      await loadMongoDatabases(connectionId);
    } else {
      await loadDatabases(connectionId, { force: true });
    }
  }

  async function connect(config: ConnectionConfig) {
    config = normalizeConnection(config);
    const pendingNode = findNode(treeNodes.value, config.id);
    if (pendingNode) pendingNode.isLoading = true;
    try {
      await beforeConnectHandler?.(config);
      const id = await withConnectionAttemptTimeout(api.connectDb(config), config);
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
    const shouldRemoveOneTimeConnection = getConfig(connectionId)?.one_time === true;
    await api.disconnectDb(connectionId);
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    switch (settingsStore.editorSettings.disconnectTabHandlingMode) {
      case "close-tabs":
        queryStore.closeConnectionTabs(connectionId);
        break;
      case "keep-tabs-clear-results":
        queryStore.releaseConnectionTabs(connectionId);
        break;
      case "keep-tabs-keep-results":
        break;
    }
    connectedIds.value.delete(connectionId);
    const node = findNode(treeNodes.value, connectionId);
    if (node) {
      node.isExpanded = false;
      node.children = [];
    }
    clearLoadedChildrenCache(connectionId);
    if (activeConnectionId.value === connectionId) {
      activeConnectionId.value = null;
    }
    invalidateCompletionCache(connectionId);
    if (shouldRemoveOneTimeConnection) {
      await removeConnection(connectionId);
    }
  }

  async function closeDatabaseConnection(connectionId: string, database: string) {
    await api.closeDatabaseConnection(connectionId, database);
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    switch (settingsStore.editorSettings.disconnectTabHandlingMode) {
      case "close-tabs":
        queryStore.closeDatabaseTabs(connectionId, database);
        break;
      case "keep-tabs-clear-results":
        queryStore.releaseDatabaseTabs(connectionId, database);
        break;
      case "keep-tabs-keep-results":
        break;
    }
    const node = findDatabaseTreeNode(treeNodes.value, connectionId, database);
    if (node) {
      node.isExpanded = false;
      node.children = [];
      clearLoadedChildrenCache(node.id);
    }
    invalidateCompletionCache(connectionId, database);
  }

  async function ensureConnected(connectionId: string) {
    if (connectedIds.value.has(connectionId)) return;
    let config = getConfig(connectionId);
    if (!config) {
      await initFromDisk();
      config = getConfig(connectionId);
    }
    if (!config) {
      const error = new Error("Connection config not found");
      recordConnectionError(connectionId, error);
      throw error;
    }
    try {
      await beforeConnectHandler?.(config);
      await withConnectionAttemptTimeout(api.connectDb(config), config);
      connectedIds.value.add(connectionId);
      activeConnectionId.value = connectionId;
      clearConnectionError(connectionId);
    } catch (e) {
      recordConnectionError(connectionId, e);
      throw e;
    }
  }

  function setBeforeConnectHandler(handler: BeforeConnectHandler | null) {
    beforeConnectHandler = handler;
  }

  async function loadDatabases(connectionId: string, options?: LoadTreeOptions) {
    const node = findNode(treeNodes.value, connectionId);
    if (!node) return;
    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      if (useCachedChildren(node, options)) return;

      const config = getConfig(connectionId);
      if (config?.db_type === "duckdb") {
        const cacheKey = schemaCacheKey(connectionId, "duckdb-root");
        if (!options?.force) {
          const cached = await loadPersistedTreeChildren(node, cacheKey);
          if (cached.hit) {
            if (cached.isStale) refreshStaleTreeNode(node);
            return;
          }
        }
        const [databases, schemas] = await Promise.all([
          api.listDatabases(connectionId),
          api.listSchemas(connectionId, "main"),
        ]);
        const children = withSavedSqlRoot(
          connectionId,
          buildDuckDbConnectionTreeNodes(connectionId, databases, schemas),
          node,
        );
        setChildren(node, children);
        await savePersistedTreeChildren(cacheKey, children);
      } else if (config?.db_type === "dameng" || config?.db_type === "oracle") {
        const effectiveDb = config.database || "";
        const cacheKey = schemaCacheKey(connectionId, effectiveDb, "schemas");
        if (!options?.force) {
          const cached = await loadPersistedTreeChildren(node, cacheKey);
          if (cached.hit) {
            if (cached.isStale) refreshStaleTreeNode(node);
            return;
          }
        }
        const schemas = await api.listSchemas(connectionId, effectiveDb);
        const visibleSchemas = filterDatabaseNamesForConnection(schemas, config);
        const schemaNodes: TreeNode[] = sortSidebarNames(visibleSchemas).map((s) => ({
          id: `${connectionId}:${s}:${s}`,
          label: s,
          type: "schema" as const,
          connectionId,
          database: s,
          schema: s,
          isExpanded: false,
          children: [],
        }));
        setChildren(node, withSavedSqlRoot(connectionId, schemaNodes, node));
        await savePersistedTreeChildren(cacheKey, schemaNodes);
      } else {
        const cacheKey = schemaCacheKey(connectionId, "databases");
        if (!options?.force) {
          const cached = await loadPersistedTreeChildren(node, cacheKey);
          if (cached.hit) {
            if (cached.isStale) refreshStaleTreeNode(node);
            return;
          }
        }
        const databases = await api.listDatabases(connectionId);
        const visibleNames = filterDatabaseNamesForConnection(
          databases.map((database) => database.name),
          config,
        );
        const visibleNameSet = new Set(visibleNames);
        const visibleDatabases = databases.filter((database) => visibleNameSet.has(database.name));
        const children = withSavedSqlRoot(
          connectionId,
          buildDatabaseTreeNodes(connectionId, visibleDatabases, {
            includeDefaultWhenEmpty:
              usesTreeSchemaMode(config?.db_type) || shouldIncludeDefaultDatabaseNode(config, visibleDatabases),
          }),
          node,
        );
        setChildren(node, children);
        await savePersistedTreeChildren(cacheKey, children);
      }
      node.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e);
      throw e;
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
      const config = getConfig(connectionId);
      const visibleNames = filterVisibleDatabaseNames(
        dbs.map((db) => String(db.db)),
        config?.visible_databases,
      );
      const visibleNameSet = new Set(visibleNames);
      setChildren(
        node,
        withSavedSqlRoot(
          connectionId,
          dbs
            .filter((db) => visibleNameSet.has(String(db.db)))
            .map((db) => ({
              id: `${connectionId}:db${db.db}`,
              label: redisDbLabel(db.db, 0, db.keys),
              type: "redis-db" as const,
              connectionId,
              database: String(db.db),
              loadedKeyCount: 0,
              totalKeyCount: db.keys,
              isExpanded: false,
              children: [],
            })),
          node,
        ),
      );
      node.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e);
      throw e;
    } finally {
      node.isLoading = false;
    }
  }

  function updateRedisDbKeyStats(
    connectionId: string,
    db: number,
    stats: { loaded?: number; total?: number; totalDelta?: number },
  ) {
    const node = findNode(treeNodes.value, `${connectionId}:db${db}`);
    if (!node || node.type !== "redis-db") return;
    if (stats.loaded != null) node.loadedKeyCount = stats.loaded;
    if (stats.total != null) node.totalKeyCount = stats.total;
    if (stats.totalDelta != null && node.totalKeyCount != null) {
      node.totalKeyCount = Math.max(0, node.totalKeyCount + stats.totalDelta);
    }
    node.label = redisDbLabel(db, node.loadedKeyCount, node.totalKeyCount);
  }

  async function loadMongoDatabases(connectionId: string) {
    const node = findNode(treeNodes.value, connectionId);
    if (!node) return;

    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      const dbs = await api.mongoListDatabases(connectionId);
      const config = getConfig(connectionId);
      const visibleDbs = filterDatabaseNamesForConnection(dbs, config);
      setChildren(
        node,
        withSavedSqlRoot(
          connectionId,
          sortSidebarNames(visibleDbs).map((db) => ({
            id: `${connectionId}:${db}`,
            label: db,
            type: "mongo-db" as const,
            connectionId,
            database: db,
            isExpanded: false,
            children: [],
          })),
          node,
        ),
      );
      node.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e);
      throw e;
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
        sortSidebarNames(collections).map((col) => ({
          id: `${nodeId}:${col}`,
          label: col,
          type: "mongo-collection" as const,
          connectionId,
          database,
          isExpanded: false,
        })),
      );
      node.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e);
      throw e;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadSchemas(connectionId: string, database: string, options?: LoadTreeOptions) {
    const nodeId = `${connectionId}:${database}`;
    const node = findNode(treeNodes.value, nodeId);
    if (!node) return;
    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      if (useCachedChildren(node, options)) return;
      const cacheKey = schemaCacheKey(connectionId, database, "schemas");
      if (!options?.force) {
        const cached = await loadPersistedTreeChildren(node, cacheKey);
        if (cached.hit) {
          if (cached.isStale) refreshStaleTreeNode(node);
          return;
        }
      }

      const schemas = sortSidebarNames(await api.listSchemas(connectionId, database));
      const children = schemas.map((s) => ({
        id: `${connectionId}:${database}:${s}`,
        label: s,
        type: "schema" as const,
        connectionId,
        database,
        schema: s,
        isExpanded: false,
        children: [],
      }));
      setChildren(node, children);
      await savePersistedTreeChildren(cacheKey, children);
      node.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e);
      throw e;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadSqlServerDatabaseObjects(connectionId: string, database: string, options?: LoadTreeOptions) {
    const nodeId = `${connectionId}:${database}`;
    const node = findNode(treeNodes.value, nodeId);
    if (!node) return;
    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      if (useCachedChildren(node, options)) return;
      const cacheKey = schemaCacheKey(connectionId, database, "sqlserver-objects");
      if (!options?.force) {
        const cached = await loadPersistedTreeChildren(node, cacheKey);
        if (cached.hit) {
          if (cached.isStale) refreshStaleTreeNode(node);
          return;
        }
      }

      const [schemas, defaultSchemaObjects] = await Promise.all([
        api.listSchemas(connectionId, database),
        api.listObjects(connectionId, database, SQLSERVER_DEFAULT_SCHEMA),
      ]);
      const children = buildSqlServerDatabaseTreeNodes(connectionId, database, schemas, defaultSchemaObjects, {
        simpleObjectDisplay: useSettingsStore().editorSettings.sidebarObjectDisplay === "simple",
      });
      setChildren(node, children);
      await savePersistedTreeChildren(cacheKey, children);
      node.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e);
      throw e;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadTables(connectionId: string, database: string, schema?: string, options?: LoadTreeOptions) {
    const nodeId = schema ? `${connectionId}:${database}:${schema}` : `${connectionId}:${database}`;
    const node = findNode(treeNodes.value, nodeId);
    if (!node) return;
    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      if (useCachedChildren(node, options)) return;
      const cacheKey = schemaCacheKey(connectionId, database, schema || "", "objects");
      if (!options?.force) {
        const cached = await loadPersistedTreeChildren(node, cacheKey);
        if (cached.hit) {
          if (cached.isStale) refreshStaleTreeNode(node);
          return;
        }
      }

      const config = getConfig(connectionId);
      const querySchema = connectionObjectTreeQuerySchema(config, database, schema);
      const effectiveSchema = connectionObjectTreeNodeSchema(config, database, schema);
      const simpleObjectDisplay = useSettingsStore().editorSettings.sidebarObjectDisplay === "simple";
      let children: TreeNode[];
      if (simpleObjectDisplay) {
        const tables = await api.listTables(connectionId, database, querySchema);
        children = buildTableTreeNodes({ nodeId, connectionId, database, schema: effectiveSchema, tables });
      } else {
        try {
          const [objects, tables] = await Promise.all([
            api.listObjects(connectionId, database, querySchema),
            api.listTables(connectionId, database, querySchema),
          ]);
          children = buildGroupedObjectTreeNodes({
            nodeId,
            connectionId,
            database,
            schema: effectiveSchema,
            objects: mergeTableInfosIntoObjects(objects, tables, effectiveSchema),
          });
        } catch {
          const tables = await api.listTables(connectionId, database, querySchema);
          children = buildTableTreeNodes({ nodeId, connectionId, database, schema: effectiveSchema, tables });
        }
      }
      setChildren(node, children);
      await savePersistedTreeChildren(cacheKey, children);
      node.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e);
      throw e;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadTableGroups(
    connectionId: string,
    database: string,
    table: string,
    schema?: string,
    nodeId?: string,
  ) {
    const parentId =
      nodeId ?? (schema ? `${connectionId}:${database}:${schema}:${table}` : `${connectionId}:${database}:${table}`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    const children: TreeNode[] = [
      ...tablePartitionGroups(node),
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
    ];

    if (node.type === "table") {
      children.push(
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
      );
    }

    setChildren(node, children);
    node.isExpanded = true;
  }

  async function loadColumns(connectionId: string, database: string, table: string, schema?: string, nodeId?: string) {
    const parentId =
      nodeId ??
      (schema
        ? `${connectionId}:${database}:${schema}:${table}:__columns`
        : `${connectionId}:${database}:${table}:__columns`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    node.isLoading = true;
    try {
      const querySchema = metadataQuerySchema(connectionId, database, schema);
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
    } catch (e) {
      recordMetadataLoadError(connectionId, e);
      throw e;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadIndexes(connectionId: string, database: string, table: string, schema?: string, nodeId?: string) {
    const parentId =
      nodeId ??
      (schema
        ? `${connectionId}:${database}:${schema}:${table}:__indexes`
        : `${connectionId}:${database}:${table}:__indexes`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    node.isLoading = true;
    try {
      const querySchema = metadataQuerySchema(connectionId, database, schema);
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
          tableName: table,
          meta: idx,
        })),
      );
      node.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e);
      throw e;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadForeignKeys(
    connectionId: string,
    database: string,
    table: string,
    schema?: string,
    nodeId?: string,
  ) {
    const parentId =
      nodeId ??
      (schema
        ? `${connectionId}:${database}:${schema}:${table}:__fkeys`
        : `${connectionId}:${database}:${table}:__fkeys`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    node.isLoading = true;
    try {
      const querySchema = metadataQuerySchema(connectionId, database, schema);
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
          tableName: table,
          meta: fk,
        })),
      );
      node.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e);
      throw e;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadTriggers(connectionId: string, database: string, table: string, schema?: string, nodeId?: string) {
    const parentId =
      nodeId ??
      (schema
        ? `${connectionId}:${database}:${schema}:${table}:__triggers`
        : `${connectionId}:${database}:${table}:__triggers`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    node.isLoading = true;
    try {
      const querySchema = metadataQuerySchema(connectionId, database, schema);
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
          tableName: table,
          meta: tr,
        })),
      );
      node.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e);
      throw e;
    } finally {
      node.isLoading = false;
    }
  }

  function collectExpandedNodeIds(nodes: TreeNode[], ids = new Set<string>()): Set<string> {
    for (const node of nodes) {
      if (node.isExpanded) ids.add(node.id);
      if (node.children) collectExpandedNodeIds(node.children, ids);
    }
    return ids;
  }

  async function loadTreeNodeChildren(node: TreeNode, options?: LoadTreeOptions) {
    if (node.type === "connection" && node.connectionId) {
      const config = getConfig(node.connectionId);
      if (config?.db_type === "redis") {
        await loadRedisDatabases(node.connectionId);
      } else if (config?.db_type === "mongodb" || config?.db_type === "elasticsearch") {
        await loadMongoDatabases(node.connectionId);
      } else {
        await loadDatabases(node.connectionId, options);
      }
    } else if (node.type === "mongo-db" && node.connectionId && node.database) {
      await loadMongoCollections(node.connectionId, node.database);
    } else if (node.type === "database" && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      const config = getConfig(node.connectionId);
      if (config?.db_type === "sqlserver") {
        await loadSqlServerDatabaseObjects(node.connectionId, node.database, options);
      } else if (usesTreeSchemaMode(config?.db_type) && !connectionUsesDatabaseObjectTreeMode(config)) {
        await loadSchemas(node.connectionId, node.database, options);
      } else {
        await loadTables(node.connectionId, node.database, undefined, options);
      }
    } else if (node.type === "schema" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.schema) {
      await loadTables(node.connectionId, node.database, node.schema, options);
    } else if (
      (node.type === "table" || node.type === "view") &&
      node.connectionId &&
      hasTreeNodeDatabaseContext(node)
    ) {
      await loadTableGroups(node.connectionId, node.database, node.label, node.schema, node.id);
    } else if (
      node.type === "group-columns" &&
      node.connectionId &&
      hasTreeNodeDatabaseContext(node) &&
      node.tableName
    ) {
      await loadColumns(node.connectionId, node.database, node.tableName, node.schema, node.id);
    } else if (
      node.type === "group-indexes" &&
      node.connectionId &&
      hasTreeNodeDatabaseContext(node) &&
      node.tableName
    ) {
      await loadIndexes(node.connectionId, node.database, node.tableName, node.schema, node.id);
    } else if (node.type === "group-fkeys" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadForeignKeys(node.connectionId, node.database, node.tableName, node.schema, node.id);
    } else if (
      node.type === "group-triggers" &&
      node.connectionId &&
      hasTreeNodeDatabaseContext(node) &&
      node.tableName
    ) {
      await loadTriggers(node.connectionId, node.database, node.tableName, node.schema, node.id);
    } else if (
      node.type === "group-tables" ||
      node.type === "group-views" ||
      node.type === "group-procedures" ||
      node.type === "group-functions" ||
      node.type === "group-packages" ||
      node.type === "group-partitions"
    ) {
      node.isExpanded = true;
    }
  }

  async function restoreExpandedChildren(node: TreeNode, expandedIds: Set<string>, options?: LoadTreeOptions) {
    if (!node.children) return;
    for (const child of node.children) {
      if (!expandedIds.has(child.id)) continue;
      await loadTreeNodeChildren(child, options);
      await restoreExpandedChildren(child, expandedIds, options);
    }
  }

  async function refreshTreeNode(node: TreeNode) {
    const parentId = objectGroupRefreshParentId(node);
    const parentNode = parentId ? findNode(treeNodes.value, parentId) : null;
    if (parentNode) {
      await refreshTreeNode(parentNode);
      return;
    }

    if (node.connectionId && !connectedIds.value.has(node.connectionId)) return;
    const expandedIds = collectExpandedNodeIds([node]);
    expandedIds.add(node.id);
    await clearPersistedTreeCacheForNode(node);
    clearLoadedChildrenCache(node.id);
    if (node.type !== "connection-group") {
      node.children = [];
    }
    await loadTreeNodeChildren(node, { force: true });
    await restoreExpandedChildren(node, expandedIds, { force: true });
  }

  async function refreshDatabaseTreeNode(connectionId: string, database: string) {
    const node = findDatabaseTreeNode(treeNodes.value, connectionId, database);
    if (node) {
      await refreshTreeNode(node);
      return;
    }
    await loadDatabases(connectionId, { force: true });
  }

  async function refreshObjectListTreeNode(connectionId: string, database: string, schema?: string) {
    const config = getConfig(connectionId);
    const shouldRefreshSchemaNode = schema && !(config?.db_type === "sqlserver" && schema.toLowerCase() === "dbo");
    const node = shouldRefreshSchemaNode ? findNode(treeNodes.value, `${connectionId}:${database}:${schema}`) : null;
    if (node) {
      await refreshTreeNode(node);
      return;
    }
    await refreshDatabaseTreeNode(connectionId, database);
  }

  function isSchemaAwareDatabase(connectionId: string): boolean {
    return isSchemaAware(getConfig(connectionId)?.db_type);
  }

  function metadataQuerySchema(connectionId: string, database: string, schema?: string): string {
    return connectionObjectTreeQuerySchema(getConfig(connectionId), database, schema);
  }

  const COMPLETION_CACHE_MAX = 50;

  function evictOldestCacheEntries(cache: Record<string, unknown>, max: number) {
    const keys = Object.keys(cache);
    if (keys.length <= max) return;
    const toRemove = keys.slice(0, keys.length - max);
    for (const key of toRemove) {
      delete cache[key];
    }
  }

  async function listCompletionSchemas(connectionId: string, database: string): Promise<string[]> {
    const cacheKey = `${connectionId}:${database}`;
    if (schemaListCache.value[cacheKey]) {
      return schemaListCache.value[cacheKey];
    }
    const schemas = await api.listSchemas(connectionId, database);
    schemaListCache.value[cacheKey] = schemas;
    return schemas;
  }

  async function listElasticsearchCompletionIndices(connectionId: string, database: string): Promise<string[]> {
    const cacheKey = `${connectionId}:${database}`;
    if (elasticsearchCompletionIndicesCache.value[cacheKey]) {
      return elasticsearchCompletionIndicesCache.value[cacheKey];
    }
    await ensureConnected(connectionId);
    const indices = await api.mongoListCollections(connectionId, database);
    elasticsearchCompletionIndicesCache.value[cacheKey] = indices;
    evictOldestCacheEntries(elasticsearchCompletionIndicesCache.value, COMPLETION_CACHE_MAX);
    return elasticsearchCompletionIndicesCache.value[cacheKey];
  }

  async function listCompletionTables(
    connectionId: string,
    database: string,
    filter = "",
    limit?: number,
    schema?: string,
  ): Promise<SqlCompletionTable[]> {
    const normalizedFilter = filter.trim().toLowerCase();
    const relaxedFilter = relaxedCompletionTableFilter(normalizedFilter);
    const cacheKey = `${connectionId}:${database}:${normalizedFilter}:${limit ?? ""}:${schema ?? ""}`;
    if (completionTablesCache.value[cacheKey]) {
      return completionTablesCache.value[cacheKey];
    }

    await ensureConnected(connectionId);

    if (isSchemaAwareDatabase(connectionId)) {
      const schemas = schema ? [schema] : await listCompletionSchemas(connectionId, database);
      if (normalizedFilter || limit) {
        const batchSize = 5;
        const results: SqlCompletionTable[] = [];
        for (let i = 0; i < schemas.length && results.length < (limit ?? Infinity); i += batchSize) {
          const batch = schemas.slice(i, i + batchSize);
          const batchResults = await Promise.all(
            batch.map(async (s) => {
              try {
                const tables = await api.listTables(connectionId, database, s, normalizedFilter, limit);
                return tables.map((table) => ({
                  name: table.name,
                  schema: s,
                  type: table.table_type === "VIEW" ? ("view" as const) : ("table" as const),
                })) as SqlCompletionTable[];
              } catch {
                return [] as SqlCompletionTable[];
              }
            }),
          );
          for (const group of batchResults) {
            results.push(...group);
          }
        }
        if (results.length === 0 && relaxedFilter) {
          for (let i = 0; i < schemas.length && results.length < (limit ?? Infinity); i += batchSize) {
            const batch = schemas.slice(i, i + batchSize);
            const batchResults = await Promise.all(
              batch.map(async (s) => {
                try {
                  const tables = await api.listTables(
                    connectionId,
                    database,
                    s,
                    relaxedFilter,
                    expandedCompletionLimit(limit),
                  );
                  return tables.map((table) => ({
                    name: table.name,
                    schema: s,
                    type: table.table_type === "VIEW" ? ("view" as const) : ("table" as const),
                  })) as SqlCompletionTable[];
                } catch {
                  return [] as SqlCompletionTable[];
                }
              }),
            );
            for (const group of batchResults) {
              results.push(...group);
            }
          }
        }
        const limitedTables = limit
          ? dedupeCompletionTables(results).slice(0, expandedCompletionLimit(limit))
          : results;
        completionTablesCache.value[cacheKey] = limitedTables;
        evictOldestCacheEntries(completionTablesCache.value, COMPLETION_CACHE_MAX);
        return completionTablesCache.value[cacheKey];
      }

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
      evictOldestCacheEntries(completionTablesCache.value, COMPLETION_CACHE_MAX);
      return completionTablesCache.value[cacheKey];
    }

    let tables = await api.listTables(connectionId, database, database, normalizedFilter, limit);
    if (tables.length === 0 && relaxedFilter) {
      tables = await api.listTables(connectionId, database, database, relaxedFilter, expandedCompletionLimit(limit));
    }
    completionTablesCache.value[cacheKey] = tables.map((table) => ({
      name: table.name,
      type: table.table_type === "VIEW" ? ("view" as const) : ("table" as const),
    }));
    evictOldestCacheEntries(completionTablesCache.value, COMPLETION_CACHE_MAX);
    return completionTablesCache.value[cacheKey];
  }

  function relaxedCompletionTableFilter(filter: string): string | undefined {
    if (filter.length < 3) return undefined;
    return filter.slice(0, 2);
  }

  function expandedCompletionLimit(limit?: number): number | undefined {
    if (!limit) return limit;
    return Math.min(Math.max(limit * 3, limit), 1000);
  }

  function dedupeCompletionTables(tables: SqlCompletionTable[]): SqlCompletionTable[] {
    const seen = new Set<string>();
    const deduped: SqlCompletionTable[] = [];
    for (const table of tables) {
      const key = `${table.schema ?? ""}.${table.name}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(table);
    }
    return deduped;
  }

  async function listCompletionObjects(
    connectionId: string,
    database: string,
    filter = "",
    limit?: number,
    schema?: string,
  ): Promise<SqlCompletionObject[]> {
    const normalizedFilter = filter.trim().toLowerCase();
    const cacheKey = `${connectionId}:${database}:${schema ?? ""}`;
    if (!completionObjectsCache.value[cacheKey]) {
      await ensureConnected(connectionId);
      const objects = isSchemaAwareDatabase(connectionId)
        ? await listSchemaAwareCompletionObjects(connectionId, database, schema)
        : await api.listCompletionObjects(connectionId, database, schema || database);
      completionObjectsCache.value[cacheKey] = dedupeCompletionObjects(
        objects.map(toSqlCompletionObject).filter((object): object is SqlCompletionObject => object != null),
      );
      evictOldestCacheEntries(completionObjectsCache.value, COMPLETION_CACHE_MAX);
    }

    const objects = completionObjectsCache.value[cacheKey];
    const filtered = normalizedFilter
      ? objects.filter((object) => fuzzyCompletionObjectMatch(object, normalizedFilter))
      : objects;
    return typeof limit === "number" ? filtered.slice(0, expandedCompletionLimit(limit)) : filtered;
  }

  async function listSchemaAwareCompletionObjects(
    connectionId: string,
    database: string,
    schema?: string,
  ): Promise<ObjectInfo[]> {
    const schemas = schema ? [schema] : await listCompletionSchemas(connectionId, database);
    const batchSize = 5;
    const results: ObjectInfo[] = [];
    for (let i = 0; i < schemas.length; i += batchSize) {
      const batch = schemas.slice(i, i + batchSize);
      const groups = await Promise.all(
        batch.map(async (s) => {
          try {
            return await api.listCompletionObjects(connectionId, database, s);
          } catch {
            return [] as ObjectInfo[];
          }
        }),
      );
      for (const group of groups) results.push(...group);
    }
    return results;
  }

  function toSqlCompletionObject(object: ObjectInfo): SqlCompletionObject | null {
    const objectType = object.object_type.toUpperCase();
    const type = objectType.includes("PROCEDURE")
      ? "procedure"
      : objectType.includes("FUNCTION")
        ? "function"
        : objectType.includes("TRIGGER")
          ? "trigger"
          : null;
    if (!type) return null;
    return {
      name: object.name,
      schema: object.schema ?? undefined,
      type,
      parentSchema: object.parent_schema ?? undefined,
      parentName: object.parent_name ?? undefined,
    };
  }

  function fuzzyCompletionObjectMatch(object: SqlCompletionObject, filter: string): boolean {
    return fuzzyTextMatch(object.name, filter) || (!!object.schema && fuzzyTextMatch(object.schema, filter));
  }

  function fuzzyTextMatch(value: string, filter: string): boolean {
    if (!filter) return true;
    const text = value.toLowerCase();
    if (text.includes(filter)) return true;
    let index = 0;
    for (const ch of filter) {
      index = text.indexOf(ch, index);
      if (index < 0) return false;
      index++;
    }
    return true;
  }

  function dedupeCompletionObjects(objects: SqlCompletionObject[]): SqlCompletionObject[] {
    const seen = new Set<string>();
    const deduped: SqlCompletionObject[] = [];
    for (const object of objects) {
      const key = `${object.type}:${object.schema ?? ""}:${object.name}:${object.parentName ?? ""}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(object);
    }
    return deduped;
  }

  async function listCompletionColumns(
    connectionId: string,
    database: string,
    table: string,
    schema?: string,
  ): Promise<SqlCompletionColumn[]> {
    if (
      isSchemaAwareDatabase(connectionId) &&
      !connectionUsesDatabaseObjectTreeMode(getConfig(connectionId)) &&
      !schema
    ) {
      return [];
    }
    const cacheKey = `${connectionId}:${database}:${schema || ""}:${table}`;
    if (!completionColumnsCache.value[cacheKey]) {
      await ensureConnected(connectionId);
      const querySchema = metadataQuerySchema(connectionId, database, schema);
      completionColumnsCache.value[cacheKey] = await api.getColumns(connectionId, database, querySchema, table);
      evictOldestCacheEntries(completionColumnsCache.value, COMPLETION_CACHE_MAX);
    }

    return completionColumnsCache.value[cacheKey].map((column) => ({
      name: column.name,
      table,
      schema,
      dataType: column.data_type,
      isNullable: column.is_nullable,
      comment: column.comment,
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
          return {
            ...existing,
            label: node.label,
            pinned: node.pinned,
            children: withSavedSqlRoot(node.connectionId!, existing.children || [], existing),
          };
        }
        if (node.type === "connection" && node.connectionId) {
          return { ...node, children: withSavedSqlRoot(node.connectionId, node.children || []) };
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

  async function refreshAllTree() {
    const expandedIds = collectExpandedNodeIds(treeNodes.value);
    const refreshExpandedNodes = async (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type === "connection-group") {
          if (node.children) await refreshExpandedNodes(node.children);
          continue;
        }
        if (!expandedIds.has(node.id)) continue;
        if (node.connectionId && !connectedIds.value.has(node.connectionId)) continue;
        clearLoadedChildrenCache(node.id);
        node.children = [];
        await loadTreeNodeChildren(node, { force: true });
        await restoreExpandedChildren(node, expandedIds, { force: true });
      }
    };
    await refreshExpandedNodes(treeNodes.value);
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

  function bytesToBase64(bytes: Uint8Array) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function siblingCredentialsPath(path: string) {
    const fileName = path.split(/[\\/]/).pop() || "";
    const credentialsFile = fileName.startsWith("data-sources-")
      ? fileName.replace(/^data-sources/, "credentials-config")
      : "credentials-config.json";
    return path.replace(/[^\\/]+$/, credentialsFile);
  }

  async function readDbeaverImportFile(): Promise<{ content: string; encrypted: boolean } | null> {
    let dataSources: string;
    let credentialsBase64 = "";

    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile, readFile } = await import("@tauri-apps/plugin-fs");
      const path = await open({
        filters: [{ name: "DBeaver Data Sources", extensions: ["json"] }],
        multiple: false,
      });
      if (!path) return null;
      const dataSourcesPath = path as string;
      dataSources = await readTextFile(dataSourcesPath);
      try {
        credentialsBase64 = bytesToBase64(await readFile(siblingCredentialsPath(dataSourcesPath)));
      } catch {
        credentialsBase64 = "";
      }
    } else {
      const files = await new Promise<FileList>((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.multiple = true;
        input.onchange = () => {
          if (!input.files?.length) {
            reject(new Error("No file selected"));
            return;
          }
          resolve(input.files);
        };
        input.click();
      });
      const fileList = Array.from(files);
      const dataSourcesFile =
        fileList.find((file) => /^data-sources.*\.json$/i.test(file.name)) ||
        fileList.find((file) => !/^credentials-config.*\.json$/i.test(file.name));
      const credentialsFile = fileList.find((file) => /^credentials-config.*\.json$/i.test(file.name));
      if (!dataSourcesFile) throw new Error("Select DBeaver data-sources.json");
      dataSources = await dataSourcesFile.text();
      if (credentialsFile) {
        credentialsBase64 = bytesToBase64(new Uint8Array(await credentialsFile.arrayBuffer()));
      }
    }

    return {
      content: JSON.stringify({ format: "dbeaver-import", dataSources, credentialsBase64 }),
      encrypted: false,
    };
  }

  async function readImportFile(source: ImportSource = "dbx"): Promise<{ content: string; encrypted: boolean } | null> {
    if (source === "dbeaver") return readDbeaverImportFile();

    let content: string;

    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await open({
        filters:
          source === "navicat"
            ? [{ name: "Navicat Connection Export", extensions: ["ncx", "xml"] }]
            : [{ name: "DBX JSON", extensions: ["json"] }],
        multiple: false,
      });
      if (!path) return null;
      content = await readTextFile(path as string);
    } else {
      content = await new Promise<string>((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = source === "navicat" ? ".ncx,.xml" : ".json";
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

    if (content.trimStart().startsWith("<")) {
      return { content, encrypted: false };
    }

    const { isEncryptedConfig } = await import("@/lib/configCrypto");
    const parsed = JSON.parse(content);
    return { content, encrypted: isEncryptedConfig(parsed) };
  }

  async function importConnectionsFromFile(
    content: string,
    passphrase: string | null,
  ): Promise<{ count: number; layout?: SidebarLayout }> {
    let imported: ConnectionConfig[] = [];
    let importedLayout: SidebarLayout | undefined;

    if (!passphrase && content.trimStart().startsWith("<")) {
      const { parseNavicatConnections } = await import("@/lib/navicatImport");
      imported = await parseNavicatConnections(content);
    } else if (!passphrase) {
      const { isDbeaverImportPayload, parseDbeaverConnections } = await import("@/lib/dbeaverImport");
      if (isDbeaverImportPayload(content)) {
        imported = await parseDbeaverConnections(content);
      } else {
        const parsed = JSON.parse(content);

        if (Array.isArray(parsed)) {
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
      }
    } else {
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
      }
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
    if (!initFromDiskPromise) {
      initFromDiskPromise = (async () => {
        pinnedTreeNodeIds.value = await loadPinnedTreeNodeIds();
        const saved = await api.loadConnections();
        connections.value = saved.map(normalizeConnection);
        const savedLayout = await api.loadSidebarLayout();
        sidebarLayout.value = reconcileLayout(
          connections.value.map((c) => c.id),
          savedLayout,
        );
        rebuildTreeNodes();
      })().finally(() => {
        initFromDiskPromise = null;
      });
    }
    await initFromDiskPromise;
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
    selectedTreeNodeId,
    selectedTreeNodeIds,
    treeSelectionAnchorId,
    treeClipboard,
    treeNodes,
    removeTreeNode,
    refreshAllTree,
    refreshSavedSqlTree,
    refreshTreeNode,
    refreshDatabaseTreeNode,
    refreshObjectListTreeNode,
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
    setVisibleDatabases,
    clearVisibleDatabases,
    removeConnection,
    editingConnectionId,
    newConnectionGroupId,
    startEditing,
    stopEditing,
    startCreatingConnectionInGroup,
    stopCreatingConnectionInGroup,
    connect,
    disconnect,
    closeDatabaseConnection,
    ensureConnected,
    isTreeNodeChildrenLoaded,
    setBeforeConnectHandler,
    initFromDisk,
    loadDatabases,
    loadRedisDatabases,
    updateRedisDbKeyStats,
    loadMongoDatabases,
    loadMongoCollections,
    loadSchemas,
    loadSqlServerDatabaseObjects,
    loadTables,
    loadTableGroups,
    loadColumns,
    loadIndexes,
    loadForeignKeys,
    loadTriggers,
    listCompletionTables,
    listCompletionObjects,
    listCompletionColumns,
    listCompletionSchemas,
    listElasticsearchCompletionIndices,
    exportConnectionsToFile,
    readImportFile,
    importConnectionsFromFile,
    applySidebarLayout,
    transferSource,
    schemaDiffSource,
    dataCompareSource,
    sqlFileSource,
    diagramSource,
    tableImportSource,
    fieldLineageSource,
    databaseSearchSource,
    databaseExportSource,
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

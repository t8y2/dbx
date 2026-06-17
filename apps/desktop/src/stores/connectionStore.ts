import { defineStore } from "pinia";
import { uuid } from "@/lib/utils";
import { ref, computed, watch } from "vue";
import type { ColumnInfo, ConnectionConfig, ForeignKeyInfo, ObjectInfo, SidebarLayout, TreeNode } from "@/types/database";
import { applyPinnedTreeNodeState, updatePinnedTreeNodeInPlace } from "@/lib/pinnedItems";
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
  remapSidebarLayoutConnectionIds,
  reorderEntry as reorderEntryOp,
  type DropPosition,
} from "@/lib/sidebarLayout";
import type { SqlCompletionColumn, SqlCompletionForeignKey, SqlCompletionObject, SqlCompletionTable } from "@/lib/sqlCompletion";
import * as api from "@/lib/api";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { isSchemaAware, normalizeSidebarObjectKind, sidebarObjectKindsForDatabase, usesTreeSchemaMode } from "@/lib/databaseCapabilities";
import { connectionObjectTreeNodeSchema, connectionObjectTreeQuerySchema, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection } from "@/lib/jdbcDialect";
import { buildDatabaseTreeNodes, buildDuckDbConnectionTreeNodes, sortSidebarNames, shouldIncludeDefaultDatabaseNode } from "@/lib/databaseTree";
import { buildSqlServerDatabaseTreeNodes, SQLSERVER_DEFAULT_SCHEMA } from "@/lib/sqlServerTree";
import { findDatabaseTreeNode } from "@/lib/treeRefreshTarget";
import { shouldMarkDisconnected } from "@/lib/connectionHealth";
import { connectionAttemptTimeoutMessage, connectionAttemptTimeoutMs } from "@/lib/connectionAttemptTimeout";
import { filterDatabaseNamesForConnection, filterVisibleDatabaseNames, normalizeVisibleDatabaseSelection } from "@/lib/visibleDatabases";
import {
  buildObjectGroupPlaceholderNodes,
  buildGroupedObjectTreeNodes,
  buildSimpleObjectTreeNodes,
  buildTableTreeNodes,
  expandCachedObjectBrowserNodes,
  mergeTableInfosIntoObjects,
  objectGroupRefreshParentId,
  objectTypesForGroupNode,
  tablePartitionGroups,
  type DatabaseObjectTreeKind,
} from "@/lib/tableTree";
import { hasTreeNodeDatabaseContext, normalizeCataloglessDatabaseNodes, treeNodeSchemaCachePrefix } from "@/lib/treeNodeContext";
import { decodeSchemaTreeCache, encodeSchemaTreeCache } from "@/lib/schemaTreeCache";
import { sortSidebarTreeChildrenForParent } from "@/lib/sidebarNodeOrdering";
import { prunePinnedTreeNodeIdsForConnection } from "@/lib/pinnedTreeNodeIds";
import { supportsDatabaseUserAdmin } from "@/lib/databaseUserAdmin";
import { getTableMetadataCapabilities } from "@/lib/tableMetadataCapabilities";
import { useSettingsStore } from "@/stores/settingsStore";

const PINNED_TREE_NODES_STORAGE_KEY = "dbx-pinned-tree-nodes";
const ACTIVE_CONNECTION_STORAGE_KEY = "dbx-active-connection";
function sidebarObjectGroupPageSize(): number {
  const settingsStore = useSettingsStore();
  const size = settingsStore.desktopSettings.sidebar_table_page_size;
  return typeof size === "number" && size > 0 ? size : 500;
}
type ImportSource = "dbx" | "navicat" | "dbeaver" | "datagrip";

// Temporary storage for DataGrip import payload (used to read Keychain passwords after import)
let pendingDataGripPayload: { format: "datagrip-import"; dataSources: string; dataSourcesLocal?: string } | null = null;

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

function redisDbLabel(db: number, _loadedKeyCount?: number, totalKeyCount?: number): string {
  if (totalKeyCount == null) return `db${db}`;
  return `db${db} (${totalKeyCount})`;
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
  const completionForeignKeysCache = ref<Record<string, ForeignKeyInfo[]>>({});
  const completionDatabasesCache = ref<Record<string, string[]>>({});
  const elasticsearchCompletionIndicesCache = ref<Record<string, string[]>>({});
  const redisCompletionKeysCache = ref<Record<string, string[]>>({});
  const schemaListCache = ref<Record<string, string[]>>({});
  const sidebarSearchQuery = ref("");
  const completionTableIndex = new Map<string, { touched: number; tables: SqlCompletionTable[] }>();
  const completionObjectIndex = new Map<string, { touched: number; objects: SqlCompletionObject[] }>();
  const completionColumnIndex = new Map<string, { touched: number; columns: SqlCompletionColumn[] }>();
  const completionForeignKeyIndex = new Map<string, { touched: number; foreignKeys: SqlCompletionForeignKey[] }>();
  const completionInFlight = new Map<string, Promise<unknown>>();
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
  const tableDataGenerateSource = ref<{
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
      etcd: "etcd",
      duckdb: "DuckDB",
      clickhouse: "ClickHouse",
      sqlserver: "SQL Server",
      mongodb: "MongoDB",
      oracle: "Oracle",
      elasticsearch: "Elasticsearch",
      doris: "Doris",
      starrocks: "StarRocks",
      manticoresearch: "Manticore Search",
      redshift: "Redshift",
      dameng: "DM (Dameng)",
      gaussdb: "GaussDB",
      questdb: "QuestDB",
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
      influxdb: "InfluxDB",
    };

    const profile = config.driver_profile || config.db_type;
    let dbType = config.db_type;
    if ((profile === "gaussdb" || profile === "opengauss") && dbType === "postgres") {
      dbType = "gaussdb" as ConnectionConfig["db_type"];
    } else if (profile === "kwdb" && dbType === "postgres") {
      dbType = "kwdb" as ConnectionConfig["db_type"];
    } else if (profile === "questdb" && dbType === "postgres") {
      dbType = "questdb" as ConnectionConfig["db_type"];
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
      attached_databases: Array.isArray(config.attached_databases) ? config.attached_databases.filter((database) => database.name?.trim() && database.path?.trim()) : [],
      transport_layers: Array.isArray(config.transport_layers) ? config.transport_layers : [],
      connect_timeout_secs: config.connect_timeout_secs || 5,
      query_timeout_secs: config.query_timeout_secs ?? 30,
      idle_timeout_secs: config.idle_timeout_secs ?? 60,
      keepalive_interval_secs: config.keepalive_interval_secs ?? 0,
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

  function buildUserAdminNode(connectionId: string, existingConnectionNode?: TreeNode): TreeNode | undefined {
    const config = getConfig(connectionId);
    if (!supportsDatabaseUserAdmin(effectiveDatabaseTypeForConnection(config))) return undefined;
    const existing = existingConnectionNode?.children?.find((child) => child.type === "user-admin");
    return {
      id: `${connectionId}:__user_admin`,
      label: "tree.userAdmin",
      type: "user-admin",
      connectionId,
      database: "",
      isExpanded: existing?.isExpanded ?? false,
    };
  }

  function withConnectionUtilityNodes(connectionId: string, children: TreeNode[], existingConnectionNode?: TreeNode): TreeNode[] {
    const nonUtilityChildren = children.filter((child) => child.type !== "user-admin");
    const userAdminNode = buildUserAdminNode(connectionId, existingConnectionNode);
    return [...nonUtilityChildren, userAdminNode].filter(Boolean) as TreeNode[];
  }

  function withSavedSqlRoot(connectionId: string, children: TreeNode[], existingConnectionNode?: TreeNode): TreeNode[] {
    return withConnectionUtilityNodes(connectionId, children, existingConnectionNode);
  }

  function schemaCacheKey(...parts: string[]): string {
    return parts.map((part) => encodeURIComponent(part)).join(":");
  }

  function supportedSidebarObjectTypes(config?: ConnectionConfig): DatabaseObjectTreeKind[] {
    const dbType = effectiveDatabaseTypeForConnection(config);
    return sidebarObjectKindsForDatabase(dbType);
  }

  function objectGroupCacheKey(node: TreeNode): string {
    return schemaCacheKey(node.connectionId || "", node.database || "", node.schema || "", node.type, "objects-v2");
  }

  function buildLoadMoreNode(parent: TreeNode, offset: number, pageSize: number): TreeNode {
    return {
      id: `${parent.id}:__load_more:${offset}`,
      label: "tree.loadMore",
      type: "load-more",
      connectionId: parent.connectionId,
      database: parent.database,
      schema: parent.schema,
      isLoading: false,
      loadMore: {
        parentId: parent.id,
        offset,
        pageSize,
      },
    };
  }

  function withoutLoadMoreNodes(children: TreeNode[] | undefined): TreeNode[] {
    return (children || []).filter((child) => child.type !== "load-more");
  }

  function objectGroupChildrenFromObjects(options: { node: TreeNode; parentNodeId: string; effectiveSchema?: string; objectTypes: DatabaseObjectTreeKind[]; objects: ObjectInfo[] }): TreeNode[] {
    const grouped = buildGroupedObjectTreeNodes({
      nodeId: options.parentNodeId,
      connectionId: options.node.connectionId || "",
      database: options.node.database || "",
      schema: options.effectiveSchema,
      objects: options.objects.filter((object) => options.objectTypes.includes(normalizedObjectTreeKind(object.object_type))),
    });
    const refreshedGroup = grouped.find((group) => group.type === options.node.type);
    return refreshedGroup?.children ?? [];
  }

  async function loadPagedTableGroupChildren(options: {
    node: TreeNode;
    parentNodeId: string;
    querySchema: string;
    effectiveSchema?: string;
    objectTypes: DatabaseObjectTreeKind[];
    offset: number;
    pageSize: number;
  }): Promise<{ children: TreeNode[]; objectCount: number; hasMore: boolean; nextOffset: number }> {
    if (!options.node.connectionId || !options.node.database) {
      return { children: [], objectCount: 0, hasMore: false, nextOffset: options.offset };
    }
    const searchFilter = sidebarSearchQuery.value || undefined;
    // When searching, fetch all matching tables (no pagination) — backend filter
    // already narrows the result set, so client-side filtering is not needed.
    const fetchLimit = searchFilter ? undefined : options.pageSize + 1;
    const tables = await api.listTables(options.node.connectionId, options.node.database, options.querySchema, searchFilter, fetchLimit, searchFilter ? undefined : options.offset, options.objectTypes);
    const hasMore = searchFilter ? false : tables.length > options.pageSize;
    const pageTables = hasMore ? tables.slice(0, options.pageSize) : tables;
    const objects = mergeTableInfosIntoObjects([], pageTables, options.effectiveSchema);
    const visibleObjectCount = objects.filter((object) => options.objectTypes.includes(normalizedObjectTreeKind(object.object_type))).length;
    return {
      children: objectGroupChildrenFromObjects({
        node: options.node,
        parentNodeId: options.parentNodeId,
        effectiveSchema: options.effectiveSchema,
        objectTypes: options.objectTypes,
        objects,
      }),
      objectCount: visibleObjectCount,
      hasMore,
      nextOffset: options.offset + pageTables.length,
    };
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
    const normalizedChildren = sortSidebarTreeChildrenForParent(node, normalizeCataloglessDatabaseNodes(expandCachedObjectBrowserNodes(decoded.children)), node.connectionId ? getConfig(node.connectionId)?.db_type : undefined);
    setChildren(node, node.type === "connection" && node.connectionId ? withSavedSqlRoot(node.connectionId, normalizedChildren, node) : normalizedChildren);
    node.isExpanded = true;
    return { hit: true, isStale: decoded.isStale };
  }

  async function savePersistedTreeChildren(cacheKey: string, children: TreeNode[]) {
    await api.saveSchemaCache(cacheKey, encodeSchemaTreeCache(children)).catch(() => undefined);
  }

  function useCachedChildren(node: TreeNode, options?: LoadTreeOptions): boolean {
    if (options?.force || !loadedTreeNodeChildrenIds.value.has(node.id)) return false;
    if (node.type === "connection" && node.connectionId) {
      const normalizedChildren = sortSidebarTreeChildrenForParent(node, withSavedSqlRoot(node.connectionId, node.children || [], node), getConfig(node.connectionId)?.db_type);
      setChildren(node, normalizedChildren);
    }
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
      Promise.all([api.deleteSchemaCachePrefix(rawPrefix), api.deleteSchemaCachePrefix(encodedPrefix)]).catch(() => undefined);
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

    const scope = updatePinnedTreeNodeInPlace(treeNodes.value, id, next.has(id));
    if (scope === "root") rebuildTreeNodes();
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
    for (const key of Object.keys(completionForeignKeysCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete completionForeignKeysCache.value[key];
    }
    for (const key of Object.keys(schemaListCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete schemaListCache.value[key];
    }
    for (const key of Object.keys(elasticsearchCompletionIndicesCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete elasticsearchCompletionIndicesCache.value[key];
    }
    for (const key of Object.keys(redisCompletionKeysCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete redisCompletionKeysCache.value[key];
    }
    for (const key of completionTableIndex.keys()) {
      if (key.startsWith(cachePrefix)) completionTableIndex.delete(key);
    }
    for (const key of completionObjectIndex.keys()) {
      if (key.startsWith(cachePrefix)) completionObjectIndex.delete(key);
    }
    for (const key of completionColumnIndex.keys()) {
      if (key.startsWith(cachePrefix)) completionColumnIndex.delete(key);
    }
    for (const key of completionForeignKeyIndex.keys()) {
      if (key.startsWith(cachePrefix)) completionForeignKeyIndex.delete(key);
    }
    for (const key of completionInFlight.keys()) {
      if (key.startsWith(cachePrefix)) completionInFlight.delete(key);
    }
  }

  async function removeConnections(ids: Iterable<string>) {
    const connectionIds = [...new Set(ids)].filter((id) => connections.value.some((c) => c.id === id));
    if (!connectionIds.length) return;

    const removedIds = new Set(connectionIds);
    const nextConnections = connections.value.filter((c) => !removedIds.has(c.id));
    await persistConnections(nextConnections);
    connections.value = nextConnections;
    for (const id of removedIds) {
      pinnedTreeNodeIds.value = prunePinnedTreeNodeIdsForConnection(pinnedTreeNodeIds.value, id);
    }
    persistPinnedTreeNodeIds();
    for (const id of removedIds) {
      clearConnectionError(id);
      connectedIds.value.delete(id);
      sidebarLayout.value = removeConnectionFromSidebarLayout(sidebarLayout.value, id);
    }
    rebuildTreeNodes();
    persistSidebarLayoutDebounced();
    if (activeConnectionId.value && removedIds.has(activeConnectionId.value)) {
      activeConnectionId.value = null;
    }
    selectedTreeNodeIds.value = selectedTreeNodeIds.value.filter((id) => !removedIds.has(id));
    if (selectedTreeNodeId.value && removedIds.has(selectedTreeNodeId.value)) selectedTreeNodeId.value = null;
    if (treeSelectionAnchorId.value && removedIds.has(treeSelectionAnchorId.value)) treeSelectionAnchorId.value = null;
    for (const id of removedIds) {
      invalidateCompletionCache(id);
      clearLoadedChildrenCache(id);
    }
  }

  async function removeConnection(id: string) {
    await removeConnections([id]);
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
    invalidateCompletionCache(connectionId);
    rebuildTreeNodes();
  }

  async function reloadConnectionDatabaseChildren(connectionId: string) {
    const config = getConfig(connectionId);
    if (!config) return;
    clearLoadedChildrenCache(connectionId);
    if (config.db_type === "redis") {
      await loadRedisDatabases(connectionId);
    } else if (config.db_type === "etcd") {
      await loadEtcdRoot(connectionId);
    } else if (config.db_type === "mongodb") {
      await loadMongoDatabases(connectionId);
    } else if (config.db_type === "elasticsearch") {
      await loadElasticsearchIndices(connectionId);
    } else if (config.db_type === "mq") {
      await loadMqTenants(connectionId, { force: true });
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

      const existing = findNode(treeNodes.value, id);
      if (existing) {
        existing.label = config.name;
        existing.type = "connection";
        existing.connectionId = id;
        existing.children = existing.children || [];
      } else {
        treeNodes.value.push({
          id,
          label: config.name,
          type: "connection",
          connectionId: id,
          isExpanded: false,
          children: [],
        });
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
    clearConnectionError(connectionId);
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
        const [databases, schemas] = await Promise.all([api.listDatabases(connectionId), api.listSchemas(connectionId, "main")]);
        const children = withSavedSqlRoot(connectionId, buildDuckDbConnectionTreeNodes(connectionId, databases, schemas), node);
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
        const effectiveDbType = effectiveDatabaseTypeForConnection(config);
        const children = withSavedSqlRoot(
          connectionId,
          buildDatabaseTreeNodes(connectionId, visibleDatabases, {
            includeDefaultWhenEmpty: usesTreeSchemaMode(effectiveDbType) || shouldIncludeDefaultDatabaseNode(config, visibleDatabases),
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

  async function loadEtcdRoot(connectionId: string) {
    const node = findNode(treeNodes.value, connectionId);
    if (!node) return;

    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      setChildren(
        node,
        withSavedSqlRoot(
          connectionId,
          [
            {
              id: `${connectionId}:etcd`,
              label: "Keys",
              type: "etcd-root" as const,
              connectionId,
              database: "",
              isExpanded: false,
              children: [],
            },
          ],
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

  async function loadMqTenants(connectionId: string, options?: LoadTreeOptions) {
    const node = findNode(treeNodes.value, connectionId);
    if (!node) return;

    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      if (useCachedChildren(node, options)) return;

      const tenants = await api.mqListTenants(connectionId);
      const tenantNames = sortSidebarNames(tenants.map((tenant) => tenant.name).filter((name) => !!name.trim()));
      setChildren(
        node,
        tenantNames.map((tenant) => ({
          id: schemaCacheKey(connectionId, "mq-tenant", tenant),
          label: tenant,
          type: "mq-tenant" as const,
          connectionId,
          mqTenant: tenant,
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

  function updateRedisDbKeyStats(connectionId: string, db: number, stats: { loaded?: number; total?: number; totalDelta?: number }) {
    const node = findNode(treeNodes.value, `${connectionId}:db${db}`);
    if (!node || node.type !== "redis-db") return;
    if (stats.loaded != null) node.loadedKeyCount = stats.loaded;
    if (stats.total != null) node.totalKeyCount = stats.total;
    if (stats.totalDelta != null && node.totalKeyCount != null) {
      node.totalKeyCount = Math.max(0, node.totalKeyCount + stats.totalDelta);
    }
    node.label = redisDbLabel(db, node.loadedKeyCount, node.totalKeyCount);
  }

  // Re-fetch the authoritative per-db key counts (INFO keyspace, lightweight) and update
  // the sidebar db nodes' counts in place — WITHOUT rebuilding the tree, so already-loaded
  // key trees under expanded db nodes are preserved. Used after a Redis write command so the
  // `dbN (count)` labels reflect the new reality without a manual refresh.
  async function refreshRedisDbKeyCounts(connectionId: string) {
    const connNode = findNode(treeNodes.value, connectionId);
    if (!connNode) return;
    try {
      await ensureConnected(connectionId);
      const dbs = await api.redisListDatabases(connectionId);
      for (const db of dbs) {
        updateRedisDbKeyStats(connectionId, db.db, { total: db.keys });
      }
    } catch {
      // Best-effort: a failed count refresh must not disrupt the result view.
    }
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

  async function loadElasticsearchIndices(connectionId: string) {
    const node = findNode(treeNodes.value, connectionId);
    if (!node) return;

    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      const indices = await api.elasticsearchListIndices(connectionId);
      setChildren(
        node,
        withSavedSqlRoot(
          connectionId,
          sortSidebarNames(indices).map((index) => ({
            id: `${connectionId}:__es_index:${index}`,
            label: index,
            type: "elasticsearch-index" as const,
            connectionId,
            database: "default",
            isExpanded: false,
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
      const simpleObjectDisplay = useSettingsStore().editorSettings.sidebarObjectDisplay === "simple";
      const cacheKey = schemaCacheKey(connectionId, database, simpleObjectDisplay ? "sqlserver-objects-simple-v2" : "sqlserver-objects-grouped-v2");
      if (!options?.force) {
        const cached = await loadPersistedTreeChildren(node, cacheKey);
        if (cached.hit) {
          if (cached.isStale) refreshStaleTreeNode(node);
          return;
        }
      }

      const config = getConfig(connectionId);
      const schemas = await api.listSchemas(connectionId, database);
      const defaultSchemaObjects = simpleObjectDisplay ? await api.listObjects(connectionId, database, SQLSERVER_DEFAULT_SCHEMA) : [];
      const children = buildSqlServerDatabaseTreeNodes(connectionId, database, schemas, defaultSchemaObjects, {
        lazyObjectTypes: simpleObjectDisplay ? undefined : supportedSidebarObjectTypes(config),
        simpleObjectDisplay,
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
      const simpleObjectDisplay = useSettingsStore().editorSettings.sidebarObjectDisplay === "simple";
      const cacheKey = schemaCacheKey(connectionId, database, schema || "", simpleObjectDisplay ? "objects-simple-v2" : "objects-grouped-v2");
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
      let children: TreeNode[];
      if (simpleObjectDisplay) {
        try {
          const [objects, tables] = await Promise.all([api.listObjects(connectionId, database, querySchema), api.listTables(connectionId, database, querySchema)]);
          children = buildSimpleObjectTreeNodes({
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
      } else {
        children = buildObjectGroupPlaceholderNodes({
          nodeId,
          connectionId,
          database,
          schema: effectiveSchema,
          objectTypes: supportedSidebarObjectTypes(config),
        });
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

  async function loadObjectGroupChildren(node: TreeNode, options?: LoadTreeOptions) {
    if (!node.connectionId || !hasTreeNodeDatabaseContext(node)) return;
    node.isLoading = true;
    try {
      await ensureConnected(node.connectionId);
      if (useCachedChildren(node, options)) return;
      const objectTypes = objectTypesForGroupNode(node.type);
      const parentNodeId = objectGroupRefreshParentId(node);
      if (!objectTypes || !parentNodeId) return;

      const config = getConfig(node.connectionId);
      const querySchema = connectionObjectTreeQuerySchema(config, node.database, node.schema);
      const effectiveSchema = connectionObjectTreeNodeSchema(config, node.database, node.schema);
      const cacheKey = objectGroupCacheKey(node);
      if (!options?.force && !sidebarSearchQuery.value) {
        const cached = await loadPersistedTreeChildren(node, cacheKey);
        if (cached.hit) {
          if (cached.isStale) refreshStaleTreeNode(node);
          return;
        }
      }

      const wantsOnlyTablesOrViews = objectTypes.every((objectType) => objectType === "TABLE" || objectType === "VIEW" || objectType === "MATERIALIZED_VIEW");
      let children: TreeNode[];
      if (wantsOnlyTablesOrViews) {
        const page = await loadPagedTableGroupChildren({
          node,
          parentNodeId,
          querySchema,
          effectiveSchema,
          objectTypes,
          offset: 0,
          pageSize: sidebarObjectGroupPageSize(),
        });
        children = page.hasMore && !sidebarSearchQuery.value ? [...page.children, buildLoadMoreNode(node, page.nextOffset, sidebarObjectGroupPageSize())] : page.children;
        node.objectCount = page.objectCount;
      } else {
        const objects = await api.listObjects(node.connectionId, node.database, querySchema, objectTypes);
        children = objectGroupChildrenFromObjects({
          node,
          parentNodeId,
          effectiveSchema,
          objectTypes,
          objects,
        });
        node.objectCount = children.length;
      }
      setChildren(node, children);
      if (!sidebarSearchQuery.value) {
        await savePersistedTreeChildren(cacheKey, children);
      }
      node.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(node.connectionId, e);
      throw e;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadMoreObjectGroupChildren(node: TreeNode) {
    if (node.type !== "load-more" || !node.loadMore) return;
    const parent = findNode(treeNodes.value, node.loadMore.parentId);
    if (!parent?.connectionId || !hasTreeNodeDatabaseContext(parent)) return;
    node.isLoading = true;
    try {
      await ensureConnected(parent.connectionId);
      const objectTypes = objectTypesForGroupNode(parent.type);
      const parentNodeId = objectGroupRefreshParentId(parent);
      if (!objectTypes || !parentNodeId) return;
      if (!objectTypes.every((objectType) => objectType === "TABLE" || objectType === "VIEW" || objectType === "MATERIALIZED_VIEW")) return;

      const config = getConfig(parent.connectionId);
      const querySchema = connectionObjectTreeQuerySchema(config, parent.database, parent.schema);
      const effectiveSchema = connectionObjectTreeNodeSchema(config, parent.database, parent.schema);
      const page = await loadPagedTableGroupChildren({
        node: parent,
        parentNodeId,
        querySchema,
        effectiveSchema,
        objectTypes,
        offset: node.loadMore.offset,
        pageSize: node.loadMore.pageSize,
      });
      const currentChildren = withoutLoadMoreNodes(parent.children);
      const nextChildren = page.hasMore ? [...currentChildren, ...page.children, buildLoadMoreNode(parent, page.nextOffset, node.loadMore.pageSize)] : [...currentChildren, ...page.children];
      parent.objectCount = (parent.objectCount ?? currentChildren.length) + page.objectCount;
      setChildren(parent, nextChildren);
      await savePersistedTreeChildren(objectGroupCacheKey(parent), nextChildren);
      parent.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(parent.connectionId, e);
      throw e;
    } finally {
      node.isLoading = false;
    }
  }

  function normalizedObjectTreeKind(type: string): DatabaseObjectTreeKind {
    return normalizeSidebarObjectKind(type);
  }

  async function loadTableGroups(connectionId: string, database: string, table: string, schema?: string, nodeId?: string) {
    const parentId = nodeId ?? (schema ? `${connectionId}:${database}:${schema}:${table}` : `${connectionId}:${database}:${table}`);
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

    const config = getConfig(connectionId);
    const metadataCapabilities = getTableMetadataCapabilities(effectiveDatabaseTypeForConnection(config));
    if (node.type === "table") {
      if (metadataCapabilities.indexes) {
        children.push({
          id: `${parentId}:__indexes`,
          label: "tree.indexes",
          type: "group-indexes",
          connectionId,
          database,
          schema,
          tableName: table,
          isExpanded: false,
          children: [],
        });
      }
      if (metadataCapabilities.foreignKeys) {
        children.push({
          id: `${parentId}:__fkeys`,
          label: "tree.foreignKeys",
          type: "group-fkeys",
          connectionId,
          database,
          schema,
          tableName: table,
          isExpanded: false,
          children: [],
        });
      }
      if (metadataCapabilities.triggers) {
        children.push({
          id: `${parentId}:__triggers`,
          label: "tree.triggers",
          type: "group-triggers",
          connectionId,
          database,
          schema,
          tableName: table,
          isExpanded: false,
          children: [],
        });
      }
    }

    setChildren(node, children);
    node.isExpanded = true;
  }

  async function loadColumns(connectionId: string, database: string, table: string, schema?: string, nodeId?: string) {
    const parentId = nodeId ?? (schema ? `${connectionId}:${database}:${schema}:${table}:__columns` : `${connectionId}:${database}:${table}:__columns`);
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
    const parentId = nodeId ?? (schema ? `${connectionId}:${database}:${schema}:${table}:__indexes` : `${connectionId}:${database}:${table}:__indexes`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    node.isLoading = true;
    try {
      const metadataCapabilities = getTableMetadataCapabilities(effectiveDatabaseTypeForConnection(getConfig(connectionId)));
      if (!metadataCapabilities.indexes) {
        setChildren(node, []);
        node.isExpanded = true;
        return;
      }
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

  async function loadForeignKeys(connectionId: string, database: string, table: string, schema?: string, nodeId?: string) {
    const parentId = nodeId ?? (schema ? `${connectionId}:${database}:${schema}:${table}:__fkeys` : `${connectionId}:${database}:${table}:__fkeys`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    node.isLoading = true;
    try {
      const metadataCapabilities = getTableMetadataCapabilities(effectiveDatabaseTypeForConnection(getConfig(connectionId)));
      if (!metadataCapabilities.foreignKeys) {
        setChildren(node, []);
        node.isExpanded = true;
        return;
      }
      const querySchema = metadataQuerySchema(connectionId, database, schema);
      const fkeys = await api.listForeignKeys(connectionId, database, querySchema, table);
      const cacheKey = `${connectionId}:${database}:${schema || ""}:${table}`;
      completionForeignKeysCache.value[cacheKey] = fkeys;
      evictOldestCacheEntries(completionForeignKeysCache.value, COMPLETION_CACHE_MAX);
      indexCompletionForeignKeys(connectionId, database, table, schema, sqlCompletionForeignKeys(fkeys));
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
    const parentId = nodeId ?? (schema ? `${connectionId}:${database}:${schema}:${table}:__triggers` : `${connectionId}:${database}:${table}:__triggers`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    node.isLoading = true;
    try {
      const metadataCapabilities = getTableMetadataCapabilities(effectiveDatabaseTypeForConnection(getConfig(connectionId)));
      if (!metadataCapabilities.triggers) {
        setChildren(node, []);
        node.isExpanded = true;
        return;
      }
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
      } else if (config?.db_type === "etcd") {
        await loadEtcdRoot(node.connectionId);
      } else if (config?.db_type === "mongodb") {
        await loadMongoDatabases(node.connectionId);
      } else if (config?.db_type === "elasticsearch") {
        await loadElasticsearchIndices(node.connectionId);
      } else if (config?.db_type === "mq") {
        await loadMqTenants(node.connectionId, options);
      } else {
        await loadDatabases(node.connectionId, options);
      }
    } else if (node.type === "mongo-db" && node.connectionId && node.database) {
      await loadMongoCollections(node.connectionId, node.database);
    } else if (node.type === "database" && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      const config = getConfig(node.connectionId);
      const effectiveDbType = effectiveDatabaseTypeForConnection(config);
      if (config?.db_type === "sqlserver") {
        await loadSqlServerDatabaseObjects(node.connectionId, node.database, options);
      } else if (usesTreeSchemaMode(effectiveDbType) && !connectionUsesDatabaseObjectTreeMode(config)) {
        await loadSchemas(node.connectionId, node.database, options);
      } else {
        await loadTables(node.connectionId, node.database, undefined, options);
      }
    } else if (node.type === "schema" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.schema) {
      await loadTables(node.connectionId, node.database, node.schema, options);
    } else if ((node.type === "table" || node.type === "view" || node.type === "materialized_view") && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      await loadTableGroups(node.connectionId, node.database, node.label, node.schema, node.id);
    } else if (node.type === "group-columns" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadColumns(node.connectionId, node.database, node.tableName, node.schema, node.id);
    } else if (node.type === "group-indexes" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadIndexes(node.connectionId, node.database, node.tableName, node.schema, node.id);
    } else if (node.type === "group-fkeys" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadForeignKeys(node.connectionId, node.database, node.tableName, node.schema, node.id);
    } else if (node.type === "group-triggers" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadTriggers(node.connectionId, node.database, node.tableName, node.schema, node.id);
    } else if (node.type === "group-tables" || node.type === "group-views" || node.type === "group-materialized-views" || node.type === "group-procedures" || node.type === "group-functions" || node.type === "group-sequences" || node.type === "group-packages") {
      await loadObjectGroupChildren(node, options);
    } else if (node.type === "group-partitions") {
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
    if (objectTypesForGroupNode(node.type)) {
      clearLoadedChildrenCache(node.id);
      await loadObjectGroupChildren(node, { force: true });
      return;
    }

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

  function completionScopeKey(connectionId: string, database: string, schema?: string): string {
    return `${connectionId}:${database}:${schema ?? ""}`;
  }

  function completionColumnsKey(connectionId: string, database: string, table: string, schema?: string): string {
    return `${completionScopeKey(connectionId, database, schema)}:${table.toLowerCase()}`;
  }

  function completionForeignKeysKey(connectionId: string, database: string, table: string, schema?: string): string {
    return `${completionScopeKey(connectionId, database, schema)}:${table.toLowerCase()}:fkeys`;
  }

  function touchCompletionIndex<T>(index: Map<string, { touched: number } & T>, key: string, value: T, max = COMPLETION_CACHE_MAX) {
    index.set(key, { ...value, touched: Date.now() });
    if (index.size <= max) return;
    const oldest = [...index.entries()].sort(([, a], [, b]) => a.touched - b.touched).slice(0, index.size - max);
    for (const [oldKey] of oldest) index.delete(oldKey);
  }

  function withCompletionInFlight<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = completionInFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = load().finally(() => {
      if (completionInFlight.get(key) === promise) completionInFlight.delete(key);
    });
    completionInFlight.set(key, promise);
    return promise;
  }

  function completionNameSegments(name: string): string[] {
    return name
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[\s_.:-]+/)
      .map((segment) => segment.trim().toLowerCase())
      .filter(Boolean);
  }

  function completionNameAcronym(name: string): string {
    return completionNameSegments(name)
      .map((segment) => segment[0])
      .join("");
  }

  function orderedSubsequenceScore(text: string, filter: string): number {
    let index = 0;
    let gaps = 0;
    for (const ch of filter) {
      const found = text.indexOf(ch, index);
      if (found < 0) return -1;
      gaps += found - index;
      index = found + 1;
    }
    return 1_000 - gaps - text.length;
  }

  function tableMatchScore(table: SqlCompletionTable, filter: string, preferredSchema?: string): number {
    const text = table.name.toLowerCase();
    const schema = table.schema?.toLowerCase();
    const normalized = filter.trim().toLowerCase();
    let score = schema && preferredSchema && schema === preferredSchema.toLowerCase() ? 10_000 : 0;
    if (!normalized) return score;
    if (text === normalized) return score + 9_000 - text.length;
    if (text.startsWith(normalized)) return score + 7_500 - text.length;
    const segments = completionNameSegments(table.name);
    if (segments.some((segment) => segment.startsWith(normalized))) return score + 7_200 - text.length;
    const acronym = completionNameAcronym(table.name);
    if (acronym === normalized) return score + 7_100 - text.length;
    if (acronym.startsWith(normalized)) return score + 6_900 - text.length;
    if (normalized.length <= segments.length && segments.every((segment, index) => segment.startsWith(normalized[index] ?? ""))) return score + 6_700 - text.length;
    if (text.includes(normalized)) return score + 4_000 - text.length;
    const subsequenceScore = orderedSubsequenceScore(text, normalized);
    return subsequenceScore < 0 ? -1 : score + subsequenceScore;
  }

  function objectMatchScore(object: SqlCompletionObject, filter: string, preferredSchema?: string): number {
    const tableLike: SqlCompletionTable = { name: object.name, schema: object.schema };
    return tableMatchScore(tableLike, filter, preferredSchema);
  }

  function indexCompletionTables(connectionId: string, database: string, schema: string | undefined, tables: SqlCompletionTable[]) {
    const groups = new Map<string, SqlCompletionTable[]>();
    for (const table of tables) {
      const tableSchema = table.schema ?? schema;
      const key = completionScopeKey(connectionId, database, tableSchema);
      const list = groups.get(key) ?? [];
      list.push({ ...table, schema: tableSchema });
      groups.set(key, list);
    }
    for (const [key, group] of groups) {
      const previous = completionTableIndex.get(key)?.tables ?? [];
      touchCompletionIndex(completionTableIndex, key, {
        tables: dedupeCompletionTables([...previous, ...group]),
      });
    }
  }

  function indexCompletionObjects(connectionId: string, database: string, schema: string | undefined, objects: SqlCompletionObject[]) {
    const groups = new Map<string, SqlCompletionObject[]>();
    for (const object of objects) {
      const objectSchema = object.schema ?? schema;
      const key = completionScopeKey(connectionId, database, objectSchema);
      const list = groups.get(key) ?? [];
      list.push({ ...object, schema: objectSchema });
      groups.set(key, list);
    }
    for (const [key, group] of groups) {
      const previous = completionObjectIndex.get(key)?.objects ?? [];
      touchCompletionIndex(completionObjectIndex, key, {
        objects: dedupeCompletionObjects([...previous, ...group]),
      });
    }
  }

  function indexCompletionColumns(connectionId: string, database: string, table: string, schema: string | undefined, columns: SqlCompletionColumn[]) {
    touchCompletionIndex(completionColumnIndex, completionColumnsKey(connectionId, database, table, schema), {
      columns,
    });
  }

  function sqlCompletionForeignKeys(foreignKeys: ForeignKeyInfo[]): SqlCompletionForeignKey[] {
    return foreignKeys.map((foreignKey) => ({
      name: foreignKey.name,
      column: foreignKey.column,
      ref_schema: foreignKey.ref_schema,
      ref_table: foreignKey.ref_table,
      ref_column: foreignKey.ref_column,
    }));
  }

  function indexCompletionForeignKeys(connectionId: string, database: string, table: string, schema: string | undefined, foreignKeys: SqlCompletionForeignKey[]) {
    touchCompletionIndex(completionForeignKeyIndex, completionForeignKeysKey(connectionId, database, table, schema), {
      foreignKeys,
    });
  }

  function lookupLocalCompletionTables(connectionId: string, database: string, filter = "", limit?: number, schema?: string): SqlCompletionTable[] {
    const allScopes = [...completionTableIndex.entries()].filter(([key]) => key.startsWith(`${connectionId}:${database}:`)).map(([, entry]) => entry);
    const preferred = schema ? completionTableIndex.get(completionScopeKey(connectionId, database, schema)) : undefined;
    const scopes = preferred ? [preferred, ...allScopes.filter((entry) => entry !== preferred)] : allScopes;
    const ranked = scopes
      .flatMap((entry) => entry?.tables ?? [])
      .map((table) => ({ table, score: tableMatchScore(table, filter, schema) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.table.name.localeCompare(b.table.name));
    return dedupeCompletionTables(ranked.map((entry) => entry.table)).slice(0, limit ?? 200);
  }

  function lookupLocalCompletionObjects(connectionId: string, database: string, filter = "", limit?: number, schema?: string): SqlCompletionObject[] {
    const allScopes = [...completionObjectIndex.entries()].filter(([key]) => key.startsWith(`${connectionId}:${database}:`)).map(([, entry]) => entry);
    const preferred = schema ? completionObjectIndex.get(completionScopeKey(connectionId, database, schema)) : undefined;
    const scopes = preferred ? [preferred, ...allScopes.filter((entry) => entry !== preferred)] : allScopes;
    const ranked = scopes
      .flatMap((entry) => entry?.objects ?? [])
      .map((object) => ({ object, score: objectMatchScore(object, filter, schema) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.object.name.localeCompare(b.object.name));
    return dedupeCompletionObjects(ranked.map((entry) => entry.object)).slice(0, limit ?? 200);
  }

  function lookupLocalCompletionSchemas(connectionId: string, database: string, filter = "", limit = 50): string[] {
    const schemas = schemaListCache.value[`${connectionId}:${database}`] ?? [];
    const normalized = filter.trim().toLowerCase();
    return schemas
      .filter((schema) => fuzzyTextMatch(schema, normalized))
      .sort((a, b) => tableMatchScore({ name: b }, normalized) - tableMatchScore({ name: a }, normalized))
      .slice(0, limit);
  }

  function lookupLocalCompletionDatabases(connectionId: string, filter = "", limit = 50): string[] {
    const databases = completionDatabasesCache.value[connectionId] ?? databaseNamesFromTree(connectionId);
    const normalized = filter.trim().toLowerCase();
    return databases
      .filter((database) => fuzzyTextMatch(database, normalized))
      .sort((a, b) => tableMatchScore({ name: b }, normalized) - tableMatchScore({ name: a }, normalized))
      .slice(0, limit);
  }

  function lookupLocalCompletionColumns(connectionId: string, database: string, table: string, schema?: string): SqlCompletionColumn[] {
    return completionColumnIndex.get(completionColumnsKey(connectionId, database, table, schema))?.columns ?? [];
  }

  function lookupLocalCompletionForeignKeys(connectionId: string, database: string, table: string, schema?: string): SqlCompletionForeignKey[] {
    return completionForeignKeyIndex.get(completionForeignKeysKey(connectionId, database, table, schema))?.foreignKeys ?? [];
  }

  function databaseNamesFromTree(connectionId: string): string[] {
    const node = findNode(treeNodes.value, connectionId);
    if (!node?.children) return [];
    const seen = new Set<string>();
    const names: string[] = [];
    for (const child of node.children) {
      if (child.type !== "database" || !child.database) continue;
      const key = child.database.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(child.database);
    }
    return names;
  }

  async function listCompletionDatabases(connectionId: string): Promise<string[]> {
    if (completionDatabasesCache.value[connectionId]) {
      return completionDatabasesCache.value[connectionId];
    }
    return withCompletionInFlight(`${connectionId}:completion-databases`, async () => {
      await ensureConnected(connectionId);
      const config = getConfig(connectionId);
      const databases = await api.listDatabases(connectionId);
      completionDatabasesCache.value[connectionId] = filterDatabaseNamesForConnection(
        databases.map((database) => database.name),
        config,
      );
      return completionDatabasesCache.value[connectionId];
    });
  }

  async function listCompletionSchemas(connectionId: string, database: string): Promise<string[]> {
    const cacheKey = `${connectionId}:${database}`;
    if (schemaListCache.value[cacheKey]) {
      return schemaListCache.value[cacheKey];
    }
    return withCompletionInFlight(`${cacheKey}:schemas`, async () => {
      const schemas = await api.listSchemas(connectionId, database);
      schemaListCache.value[cacheKey] = schemas;
      return schemas;
    });
  }

  async function listElasticsearchCompletionIndices(connectionId: string, database: string): Promise<string[]> {
    const cacheKey = `${connectionId}:${database}`;
    if (elasticsearchCompletionIndicesCache.value[cacheKey]) {
      return elasticsearchCompletionIndicesCache.value[cacheKey];
    }
    await ensureConnected(connectionId);
    const indices = await api.elasticsearchListIndices(connectionId);
    elasticsearchCompletionIndicesCache.value[cacheKey] = indices;
    evictOldestCacheEntries(elasticsearchCompletionIndicesCache.value, COMPLETION_CACHE_MAX);
    return elasticsearchCompletionIndicesCache.value[cacheKey];
  }

  // Upper bound on cached key names per db, to keep completion memory bounded
  // (Redis can hold far more keys than we ever want resident for autocomplete).
  const REDIS_COMPLETION_KEYS_MAX = 1000;

  async function listRedisCompletionKeys(connectionId: string, database: string): Promise<string[]> {
    if (!database) return [];
    const cacheKey = `${connectionId}:${database}`;
    const cached = redisCompletionKeysCache.value[cacheKey];
    if (cached) return cached;
    return withCompletionInFlight(`${cacheKey}:redis-keys`, async () => {
      await ensureConnected(connectionId);
      const pageSize = settingsStore.editorSettings.redisScanPageSize;
      // Bounded multi-round SCAN: trade coverage for latency/memory safety.
      const result = await api.redisScanKeysBatch(connectionId, Number(database), 0, "*", pageSize, 6);
      const keys = result.keys.map((key) => key.key_display).slice(0, REDIS_COMPLETION_KEYS_MAX);
      redisCompletionKeysCache.value[cacheKey] = keys;
      evictOldestCacheEntries(redisCompletionKeysCache.value, COMPLETION_CACHE_MAX);
      return keys;
    });
  }

  async function listCompletionTables(connectionId: string, database: string, filter = "", limit?: number, schema?: string): Promise<SqlCompletionTable[]> {
    const normalizedFilter = filter.trim().toLowerCase();
    const relaxedFilter = relaxedCompletionTableFilter(normalizedFilter);
    const cacheKey = `${connectionId}:${database}:${normalizedFilter}:${limit ?? ""}:${schema ?? ""}`;
    if (completionTablesCache.value[cacheKey]) {
      return completionTablesCache.value[cacheKey];
    }

    return withCompletionInFlight(`${cacheKey}:tables`, async () => {
      await ensureConnected(connectionId);

      if (isSchemaAwareDatabase(connectionId)) {
        const schemas = schema ? [schema] : await listCompletionSchemas(connectionId, database);
        if (normalizedFilter || limit) {
          const batchSize = 5;
          const results: SqlCompletionTable[] = [];
          const maxResults = limit ?? Infinity;
          for (let i = 0; i < schemas.length && results.length < maxResults; i += batchSize) {
            const batch = schemas.slice(i, i + batchSize);
            const batchResults = await Promise.all(
              batch.map(async (s) => {
                try {
                  const tables = await api.listTables(connectionId, database, s, normalizedFilter, limit);
                  return tables.map((table) => ({
                    name: table.name,
                    schema: s,
                    type: table.table_type === "VIEW" || table.table_type === "MATERIALIZED VIEW" ? ("view" as const) : ("table" as const),
                  })) as SqlCompletionTable[];
                } catch {
                  return [] as SqlCompletionTable[];
                }
              }),
            );
            for (const group of batchResults) {
              results.push(...group);
              indexCompletionTables(connectionId, database, undefined, group);
            }
          }
          if (results.length === 0 && relaxedFilter) {
            for (let i = 0; i < schemas.length && results.length < maxResults; i += batchSize) {
              const batch = schemas.slice(i, i + batchSize);
              const batchResults = await Promise.all(
                batch.map(async (s) => {
                  try {
                    const tables = await api.listTables(connectionId, database, s, relaxedFilter, expandedCompletionLimit(limit));
                    return tables.map((table) => ({
                      name: table.name,
                      schema: s,
                      type: table.table_type === "VIEW" || table.table_type === "MATERIALIZED VIEW" ? ("view" as const) : ("table" as const),
                    })) as SqlCompletionTable[];
                  } catch {
                    return [] as SqlCompletionTable[];
                  }
                }),
              );
              for (const group of batchResults) {
                results.push(...group);
                indexCompletionTables(connectionId, database, undefined, group);
              }
            }
          }
          const limitedTables = limit ? dedupeCompletionTables(results).slice(0, limit) : results;
          completionTablesCache.value[cacheKey] = limitedTables;
          indexCompletionTables(connectionId, database, schema, limitedTables);
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
                type: table.table_type === "VIEW" || table.table_type === "MATERIALIZED VIEW" ? ("view" as const) : ("table" as const),
              }));
            } catch {
              return [];
            }
          }),
        );
        completionTablesCache.value[cacheKey] = tableGroups.flat();
        indexCompletionTables(connectionId, database, schema, completionTablesCache.value[cacheKey]);
        evictOldestCacheEntries(completionTablesCache.value, COMPLETION_CACHE_MAX);
        return completionTablesCache.value[cacheKey];
      }

      let tables = await api.listTables(connectionId, database, database, normalizedFilter, limit);
      if (tables.length === 0 && relaxedFilter) {
        tables = await api.listTables(connectionId, database, database, relaxedFilter, expandedCompletionLimit(limit));
      }
      completionTablesCache.value[cacheKey] = tables.map((table) => ({
        name: table.name,
        type: table.table_type === "VIEW" || table.table_type === "MATERIALIZED VIEW" ? ("view" as const) : ("table" as const),
      }));
      completionTablesCache.value[cacheKey] = limit ? completionTablesCache.value[cacheKey].slice(0, limit) : completionTablesCache.value[cacheKey];
      indexCompletionTables(connectionId, database, schema, completionTablesCache.value[cacheKey]);
      evictOldestCacheEntries(completionTablesCache.value, COMPLETION_CACHE_MAX);
      return completionTablesCache.value[cacheKey];
    });
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

  async function listCompletionObjects(connectionId: string, database: string, filter = "", limit?: number, schema?: string): Promise<SqlCompletionObject[]> {
    const normalizedFilter = filter.trim().toLowerCase();
    const cacheKey = `${connectionId}:${database}:${schema ?? ""}`;
    if (!completionObjectsCache.value[cacheKey]) {
      await withCompletionInFlight(`${cacheKey}:objects`, async () => {
        await ensureConnected(connectionId);
        const objects = isSchemaAwareDatabase(connectionId) ? await listSchemaAwareCompletionObjects(connectionId, database, schema) : await api.listCompletionObjects(connectionId, database, schema || database);
        completionObjectsCache.value[cacheKey] = dedupeCompletionObjects(objects.map(toSqlCompletionObject).filter((object): object is SqlCompletionObject => object != null));
        indexCompletionObjects(connectionId, database, schema, completionObjectsCache.value[cacheKey]);
        evictOldestCacheEntries(completionObjectsCache.value, COMPLETION_CACHE_MAX);
      });
    }

    const objects = completionObjectsCache.value[cacheKey];
    const filtered = normalizedFilter ? objects.filter((object) => fuzzyCompletionObjectMatch(object, normalizedFilter)) : objects;
    return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
  }

  async function listSchemaAwareCompletionObjects(connectionId: string, database: string, schema?: string): Promise<ObjectInfo[]> {
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
    const type = objectType.includes("PROCEDURE") ? "procedure" : objectType.includes("FUNCTION") ? "function" : objectType.includes("TRIGGER") ? "trigger" : objectType.includes("PACKAGE") ? "package" : null;
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
    return fuzzyTextMatch(object.name, filter) || (!!object.schema && fuzzyTextMatch(object.schema, filter)) || (!!object.parentName && fuzzyTextMatch(object.parentName, filter)) || (!!object.parentSchema && fuzzyTextMatch(`${object.parentSchema}.${object.parentName ?? ""}`, filter));
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

  async function listCompletionColumns(connectionId: string, database: string, table: string, schema?: string): Promise<SqlCompletionColumn[]> {
    if (isSchemaAwareDatabase(connectionId) && !connectionUsesDatabaseObjectTreeMode(getConfig(connectionId)) && !schema) {
      return [];
    }
    const cacheKey = `${connectionId}:${database}:${schema || ""}:${table}`;
    if (!completionColumnsCache.value[cacheKey]) {
      await withCompletionInFlight(`${cacheKey}:columns`, async () => {
        await ensureConnected(connectionId);
        const querySchema = metadataQuerySchema(connectionId, database, schema);
        completionColumnsCache.value[cacheKey] = await api.getColumns(connectionId, database, querySchema, table);
        evictOldestCacheEntries(completionColumnsCache.value, COMPLETION_CACHE_MAX);
      });
    }

    const columns = completionColumnsCache.value[cacheKey].map((column) => ({
      name: column.name,
      table,
      schema,
      dataType: column.data_type,
      isNullable: column.is_nullable,
      comment: column.comment,
    }));
    indexCompletionColumns(connectionId, database, table, schema, columns);
    return columns;
  }

  async function listCompletionForeignKeys(connectionId: string, database: string, table: string, schema?: string): Promise<SqlCompletionForeignKey[]> {
    if (isSchemaAwareDatabase(connectionId) && !connectionUsesDatabaseObjectTreeMode(getConfig(connectionId)) && !schema) {
      return [];
    }
    const metadataCapabilities = getTableMetadataCapabilities(effectiveDatabaseTypeForConnection(getConfig(connectionId)));
    if (!metadataCapabilities.foreignKeys) return [];

    const cacheKey = `${connectionId}:${database}:${schema || ""}:${table}`;
    if (!completionForeignKeysCache.value[cacheKey]) {
      await withCompletionInFlight(`${cacheKey}:fkeys`, async () => {
        await ensureConnected(connectionId);
        const querySchema = metadataQuerySchema(connectionId, database, schema);
        completionForeignKeysCache.value[cacheKey] = await api.listForeignKeys(connectionId, database, querySchema, table);
        evictOldestCacheEntries(completionForeignKeysCache.value, COMPLETION_CACHE_MAX);
      });
    }

    const foreignKeys = sqlCompletionForeignKeys(completionForeignKeysCache.value[cacheKey]);
    indexCompletionForeignKeys(connectionId, database, table, schema, foreignKeys);
    return foreignKeys;
  }

  function refreshCompletionTables(connectionId: string, database: string, filter = "", limit?: number, schema?: string): Promise<SqlCompletionTable[]> {
    return listCompletionTables(connectionId, database, filter, limit, schema);
  }

  function refreshCompletionObjects(connectionId: string, database: string, filter = "", limit?: number, schema?: string): Promise<SqlCompletionObject[]> {
    return listCompletionObjects(connectionId, database, filter, limit, schema);
  }

  function refreshCompletionSchemas(connectionId: string, database: string): Promise<string[]> {
    return listCompletionSchemas(connectionId, database);
  }

  function refreshCompletionDatabases(connectionId: string): Promise<string[]> {
    return listCompletionDatabases(connectionId);
  }

  function refreshCompletionColumns(connectionId: string, database: string, table: string, schema?: string): Promise<SqlCompletionColumn[]> {
    return listCompletionColumns(connectionId, database, table, schema);
  }

  function refreshCompletionForeignKeys(connectionId: string, database: string, table: string, schema?: string): Promise<SqlCompletionForeignKey[]> {
    return listCompletionForeignKeys(connectionId, database, table, schema);
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
    const credentialsFile = fileName.startsWith("data-sources-") ? fileName.replace(/^data-sources/, "credentials-config") : "credentials-config.json";
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
      const dataSourcesFile = fileList.find((file) => /^data-sources.*\.json$/i.test(file.name)) || fileList.find((file) => !/^credentials-config.*\.json$/i.test(file.name));
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

  async function readDataGripImportFile(): Promise<{ content: string; encrypted: boolean } | null> {
    let dataSources: string;
    let dataSourcesLocal = "";

    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await open({
        filters: [{ name: "DataGrip dataSources.xml", extensions: ["xml"] }],
        multiple: false,
      });
      if (!path) return null;
      dataSources = await readTextFile(path as string);
      // Auto-load dataSources.local.xml from the same directory
      const dir = (path as string).replace(/[^/\\]*$/, "");
      try {
        dataSourcesLocal = await readTextFile(dir + "dataSources.local.xml");
      } catch {
        dataSourcesLocal = "";
      }
    } else {
      const files = await new Promise<FileList>((resolve, reject) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".xml";
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
      const dsFile = fileList.find((f) => /^dataSources\.xml$/i.test(f.name)) || fileList[0];
      const localFile = fileList.find((f) => /^dataSources\.local\.xml$/i.test(f.name));
      if (!dsFile) throw new Error("Select dataSources.xml");
      dataSources = await dsFile.text();
      if (localFile) {
        dataSourcesLocal = await localFile.text();
      }
    }

    return {
      content: JSON.stringify({ format: "datagrip-import", dataSources, dataSourcesLocal }),
      encrypted: false,
    };
  }

  async function readImportFile(source: ImportSource = "dbx"): Promise<{ content: string; encrypted: boolean } | null> {
    if (source === "dbeaver") return readDbeaverImportFile();
    if (source === "datagrip") return readDataGripImportFile();

    let content: string;

    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await open({
        filters: source === "navicat" ? [{ name: "Navicat Connection Export", extensions: ["ncx", "xml"] }] : [{ name: "DBX JSON", extensions: ["json"] }],
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

  async function importConnectionsFromFile(content: string, passphrase: string | null): Promise<{ count: number; layout?: SidebarLayout }> {
    let imported: ConnectionConfig[] = [];
    let importedLayout: SidebarLayout | undefined;

    if (!passphrase && content.trimStart().startsWith("<")) {
      const { parseNavicatConnections } = await import("@/lib/navicatImport");
      imported = await parseNavicatConnections(content);
    } else if (!passphrase) {
      const { isDbeaverImportPayload, parseDbeaverConnections } = await import("@/lib/dbeaverImport");
      const { isDataGripImportPayload, parseDataGripConnections } = await import("@/lib/datagripImport");
      if (isDataGripImportPayload(content)) {
        const payload = JSON.parse(content) as {
          format: "datagrip-import";
          dataSources: string;
          dataSourcesLocal?: string;
        };
        pendingDataGripPayload = payload;
        imported = parseDataGripConnections(payload);
      } else if (isDbeaverImportPayload(content)) {
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
    const importedConnectionIdMap = new Map<string, string>();
    for (const config of imported) {
      const duplicate = connections.value.find((c) => c.name === config.name && c.host === config.host && c.port === config.port);
      if (!duplicate) {
        const importedId = config.id;
        config.id = uuid();
        if (typeof importedId === "string") importedConnectionIdMap.set(importedId, config.id);
        const normalized = normalizeConnection(config);
        await addConnection(normalized);
        count++;
      } else if (typeof config.id === "string") {
        importedConnectionIdMap.set(config.id, duplicate.id);
      }
    }
    if (importedLayout) {
      importedLayout = remapSidebarLayoutConnectionIds(importedLayout, importedConnectionIdMap);
    }
    return { count, layout: importedLayout };
  }

  /** Read macOS Keychain passwords for DataGrip connections and update them. */
  async function applyDataGripKeychainPasswords(): Promise<number> {
    const payload = pendingDataGripPayload;
    pendingDataGripPayload = null;
    if (!payload) return 0;

    try {
      const { getDataGripUuidMap, datagripKeychainService } = await import("@/lib/datagripImport");
      // dedupKey → DataGrip UUID
      const uuidMap = getDataGripUuidMap(payload);
      if (uuidMap.size === 0) return 0;

      // Build service names for batch Keychain read
      const dedupKeyToService = new Map<string, string>();
      const services: string[] = [];
      for (const [dedupKey, dgUuid] of uuidMap) {
        const service = datagripKeychainService(dgUuid);
        dedupKeyToService.set(dedupKey, service);
        services.push(service);
      }

      // Call Tauri command to read Keychain
      const results: [string, string][] = await api.readKeychainPasswords(services);

      // Build service → password map
      const passwordByService = new Map<string, string>();
      for (const [service, password] of results) {
        if (password) passwordByService.set(service, password);
      }

      // Update connections that have passwords (match by name/host/port)
      let filled = 0;
      const updated = connections.value.map((conn) => {
        const dedupKey = [conn.name, conn.host, conn.port, conn.database || ""].join("\u0000");
        const service = dedupKeyToService.get(dedupKey);
        if (!service) return conn;
        const password = passwordByService.get(service);
        if (password) {
          filled++;
          return { ...conn, password };
        }
        return conn;
      });

      if (filled > 0) {
        connections.value = updated;
        await persistConnections();
      }
      return filled;
    } catch (e) {
      console.warn("[DataGrip Import] Keychain read failed:", e);
      return 0;
    }
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
    removeConnections,
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
    refreshRedisDbKeyCounts,
    loadEtcdRoot,
    loadMqTenants,
    updateRedisDbKeyStats,
    loadMongoDatabases,
    loadElasticsearchIndices,
    loadMongoCollections,
    loadSchemas,
    loadSqlServerDatabaseObjects,
    loadTables,
    loadObjectGroupChildren,
    loadMoreObjectGroupChildren,
    loadTableGroups,
    loadColumns,
    loadIndexes,
    loadForeignKeys,
    loadTriggers,
    listCompletionTables,
    listCompletionObjects,
    listCompletionColumns,
    listCompletionForeignKeys,
    listCompletionSchemas,
    listCompletionDatabases,
    lookupLocalCompletionTables,
    lookupLocalCompletionObjects,
    lookupLocalCompletionColumns,
    lookupLocalCompletionForeignKeys,
    lookupLocalCompletionSchemas,
    lookupLocalCompletionDatabases,
    refreshCompletionTables,
    refreshCompletionObjects,
    refreshCompletionColumns,
    refreshCompletionForeignKeys,
    refreshCompletionSchemas,
    refreshCompletionDatabases,
    listElasticsearchCompletionIndices,
    listRedisCompletionKeys,
    invalidateCompletionCache,
    exportConnectionsToFile,
    readImportFile,
    importConnectionsFromFile,
    applyDataGripKeychainPasswords,
    applySidebarLayout,
    transferSource,
    schemaDiffSource,
    dataCompareSource,
    sqlFileSource,
    diagramSource,
    tableImportSource,
    tableDataGenerateSource,
    fieldLineageSource,
    databaseSearchSource,
    databaseExportSource,
    sidebarSearchQuery,
    createConnectionGroup(name: string, parentGroupId?: string | null) {
      const result = createGroupOp(sidebarLayout.value, name, parentGroupId);
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
    reorderSidebarEntries(draggedIds: string[], targetId: string, position: DropPosition) {
      // Apply each dragged entry in turn so a multi-selection moves together,
      // not just the single grabbed row (issue #681).
      let layout = sidebarLayout.value;
      let changed = false;
      for (const id of draggedIds) {
        if (id === targetId) continue;
        layout = reorderEntryOp(layout, id, targetId, position);
        changed = true;
      }
      if (changed) updateLayoutAndRebuild(layout);
    },
  };
});

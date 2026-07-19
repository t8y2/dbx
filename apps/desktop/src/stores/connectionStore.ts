import { defineStore } from "pinia";
import { uuid } from "@/lib/common/utils";
import { ref, computed, watch, markRaw } from "vue";
import type {
  ColumnInfo,
  CompletionAssistantCandidate,
  CompletionAssistantObjectKind,
  CompletionAssistantRequest,
  ConnectionConfig,
  DatabaseConnectionInfo,
  CatalogInfo,
  ForeignKeyInfo,
  ObjectInfo,
  SchemaInfo,
  SidebarLayout,
  TableInfo,
  TreeNode,
  TunnelProfile,
  VectorCollectionMeta,
} from "@/types/database";
import { inheritNaturalTreeNodeOrder, migrateLegacyPinnedTreeNodeIds, syncPinnedTreeNodeStateInPlace, treeNodePinKey } from "@/lib/app/pinnedItems";
import {
  reconcileLayout,
  buildTreeNodesFromLayout,
  emptyLayout,
  appendConnectionToLayout,
  removeConnectionFromSidebarLayout,
  findConnectionLocation,
  createGroup as createGroupOp,
  renameGroup as renameGroupOp,
  deleteGroup as deleteGroupOp,
  toggleGroupCollapsed as toggleGroupCollapsedOp,
  collapseAllGroups as collapseAllGroupsOp,
  moveConnectionToGroup as moveConnectionToGroupOp,
  remapSidebarLayoutConnectionIds,
  reorderEntry as reorderEntryOp,
  buildConnectionGroupPathMap,
  type DropPosition,
} from "@/lib/sidebar/sidebarLayout";
import type { SqlCompletionColumn, SqlCompletionForeignKey, SqlCompletionObject, SqlCompletionTable } from "@/lib/sql/sqlCompletion";
import { mergeSqlObjectNavigationType, sqlObjectNavigationTypeFromTableType } from "@/lib/sql/sqlNavigation";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useTunnelProfileStore } from "@/stores/tunnelProfileStore";
import { connectionIsDorisFamilyCatalogCapable, isInternalDorisCatalog, isSchemaAware, normalizeSidebarObjectKind, sidebarObjectKindsForDatabase, usesTreeSchemaMode } from "@/lib/database/databaseCapabilities";
import { connectionObjectTreeNodeSchema, connectionObjectTreeQuerySchema, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { buildDatabaseTreeNodes, buildDuckDbConnectionTreeNodes, sortSidebarDatabases, sortSidebarNames, shouldIncludeDefaultDatabaseNode } from "@/lib/database/databaseTree";
import { buildSqlServerDatabaseTreeNodes } from "@/lib/database/sqlServerTree";
import { collapseExpandedTreeNodes } from "@/lib/sidebar/sidebarTreeCollapse";
import { findDatabaseTreeNode } from "@/lib/sidebar/treeRefreshTarget";
import { shouldMarkDisconnected } from "@/lib/connection/connectionHealth";
import { connectionAttemptOriginalErrorMessage, connectionAttemptTimeoutMessage, connectionAttemptTimeoutMs } from "@/lib/connection/connectionAttemptTimeout";
import { requiresSqlServerLegacyCompatibilityComponent, SQLSERVER_LEGACY_COMPATIBILITY_DRIVER_KEY } from "@/lib/connection/sqlServerLegacyCompatibility";
import { deleteTabResultSnapshotsForOwner } from "@/lib/tabs/tabResultCache";
import { connectionUsesVisibleSchemaFilter, filterDatabaseNamesForConnection, filterSchemaNamesForConnection, filterVisibleDatabaseNames, normalizeVisibleDatabaseSelection } from "@/lib/database/visibleDatabases";
import {
  buildObjectGroupPlaceholderNodes,
  buildGroupedObjectTreeNodes,
  buildSimpleObjectTreeNodes,
  buildTableTreeNodes,
  appendTableTreeLoadMoreNode,
  expandCachedObjectBrowserNodes,
  filterSimpleSidebarSupplementalObjects,
  mergeTableInfosIntoObjects,
  mergeTableTreePageChildren,
  objectGroupRefreshParentId,
  objectTypesForGroupNode,
  sortDatabaseObjectsByName,
  tablePartitionGroups,
  withoutTableTreeLoadMoreNodes,
  type TableTreeLoadMoreParent,
  type DatabaseObjectTreeKind,
} from "@/lib/table/tableTree";
import { hasTreeNodeDatabaseContext, normalizeCataloglessDatabaseNodes, treeNodeSchemaCachePrefix } from "@/lib/sidebar/treeNodeContext";
import { decodeSchemaTreeCache, encodeSchemaTreeCache } from "@/lib/metadata/schemaTreeCache";
import { sortSidebarTreeChildrenForParent } from "@/lib/sidebar/sidebarNodeOrdering";
import { prunePinnedTreeNodeIdsForConnection } from "@/lib/app/pinnedTreeNodeIds";
import { connectionSupportsDatabaseUserAdmin } from "@/lib/database/databaseUserAdmin";
import { getTableMetadataCapabilities } from "@/lib/table/tableMetadataCapabilities";
import { useSettingsStore } from "@/stores/settingsStore";
import { encodeSqlServerLinkedSchema, parseSqlServerLinkedSchema } from "@/lib/database/sqlServerLinkedServers";
import { inferMongoCompletionFields, type MongoCompletionField } from "@/lib/mongo/mongoCompletion";
import { completionSchemasFromTree, completionTablesFromTree } from "@/lib/metadata/completionTreeIndex";
import { kvRootNodeLabel } from "@/lib/kv/kvRootPresentation";
import { REDIS_SCAN_PAGE_SIZE_DEFAULT } from "@/lib/redis/redisKeyPattern";
import { appendAgentDriverUpdateHint, hasAgentDriverUpdate, type AgentDriverInstallState } from "@/lib/connection/agentDriverInstallHint";
import { appendConnectionErrorHints } from "@/lib/connection/connectionErrorHints";
import { appendVisibleDatabaseSelection } from "@/lib/connection/connectionVisibleDatabases";
import { configuredDatabaseProductName, connectionConfigFingerprint, normalizeDatabaseConnectionInfo } from "@/lib/connection/connectionDatabaseInfo";
import { createMetadataLoadTrace, logMetadataLoadTrace, MetadataLoadCoordinator, type MetadataLoadTraceLogger } from "@/lib/metadata/metadataLoadCoordinator";
import type { MetadataScopeInput } from "@/lib/metadata/metadataLoadScope";
import { MetadataResultCache, type MetadataCacheInvalidation } from "@/lib/metadata/metadataResultCache";
import { invalidateTableMetadataCache } from "@/lib/metadata/tableMetadataCache";
import { MetadataTaskLimiter } from "@/lib/metadata/metadataTaskLimiter";
import i18n from "@/i18n";
import type { MqAdminConfig } from "@/types/mq";

const PINNED_TREE_NODES_STORAGE_KEY = "dbx-pinned-tree-nodes";
const ACTIVE_CONNECTION_STORAGE_KEY = "dbx-active-connection";
const CONNECTION_HEALTH_CHECK_TTL_MS = 2000;
const CONNECTION_HEALTH_CHECK_TIMEOUT_MS = 5000;
const METADATA_LOAD_MIN_TIMEOUT_MS = 15_000;
const METADATA_LOAD_DISABLED_QUERY_TIMEOUT_MS = 60_000;
const DISCONNECT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_KEEPALIVE_INTERVAL_SECS = 30;
const METADATA_LIST_PAGE_CACHE_TTL_MS = 30_000;
const METADATA_LIST_PAGE_CACHE_MAX_ENTRIES = 160;
export const COMPLETION_METADATA_CONCURRENCY = 2;
const MONGO_LEGACY_DRIVER_PROFILE = "mongodb-legacy";
const MONGO_LEGACY_DRIVER_LABEL = "MongoDB (Legacy)";
const SUPERSEDED_CONNECTION_ATTEMPT_MESSAGE = "Connection attempt was superseded by a newer attempt";
function sidebarObjectGroupPageSize(): number {
  const settingsStore = useSettingsStore();
  const size = settingsStore.desktopSettings.sidebar_table_page_size;
  return typeof size === "number" && size > 0 ? size : 500;
}

function isKafkaMqConnection(config: ConnectionConfig | undefined): boolean {
  if (!config || config.db_type !== "mq") return false;
  if (config.driver_profile === "kafka") return true;
  return (config.external_config as Partial<MqAdminConfig> | undefined)?.systemKind === "kafka";
}

type ImportSource = "dbx" | "navicat" | "dbeaver" | "datagrip";

interface LocateTableTarget {
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
}

function nodeIdPart(value: string): string {
  return encodeURIComponent(value);
}

function sqlServerLinkedRootId(connectionId: string): string {
  return `${connectionId}:__linked_servers`;
}

function sqlServerLinkedServerId(connectionId: string, server: string): string {
  return `${sqlServerLinkedRootId(connectionId)}:${nodeIdPart(server)}`;
}

function sqlServerLinkedCatalogId(connectionId: string, server: string, catalog: string): string {
  return `${sqlServerLinkedServerId(connectionId, server)}:${nodeIdPart(catalog)}`;
}

function dorisCatalogId(connectionId: string, catalog: string): string {
  return `${connectionId}:doris-catalog:${nodeIdPart(catalog)}`;
}

function dorisCatalogDatabaseId(connectionId: string, catalog: string, database: string): string {
  return `${dorisCatalogId(connectionId, catalog)}:${nodeIdPart(database)}`;
}

function sqlServerLinkedRuntimeDatabase(config?: ConnectionConfig): string {
  return config?.database?.trim() || "master";
}

function sqlServerLinkedRootNode(connectionId: string, database: string): TreeNode {
  return {
    id: sqlServerLinkedRootId(connectionId),
    label: "tree.linkedServers",
    type: "linked-server-root",
    connectionId,
    database,
    isExpanded: false,
    children: [],
  };
}

function ensureSqlServerLinkedRootNode(connectionId: string, children: TreeNode[], config?: ConnectionConfig): TreeNode[] {
  if (config?.db_type !== "sqlserver") return children;
  if (children.some((child) => child.type === "linked-server-root" || child.id === sqlServerLinkedRootId(connectionId))) {
    return children;
  }
  return [...children, sqlServerLinkedRootNode(connectionId, sqlServerLinkedRuntimeDatabase(config))];
}

// Temporary storage for DataGrip import payload (used to read Keychain passwords after import)
let pendingDataGripPayload: { format: "datagrip-import"; dataSources: string; dataSourcesLocal?: string } | null = null;

interface TreeClipboardTableEntry {
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
}

interface TreeClipboardConnectionEntry {
  config: ConnectionConfig;
  sourceGroupId: string | null;
}

export type TreeClipboard =
  | {
      kind: "table-copy";
      tables: TreeClipboardTableEntry[];
    }
  | {
      kind: "connection-copy";
      connections: TreeClipboardConnectionEntry[];
    };

interface LoadTreeOptions {
  force?: boolean;
  connectedOnly?: boolean;
  expectedSidebarSearchQuery?: string;
  searchFilter?: string;
  sidebarTableSearchParentId?: string;
  expectedSidebarTableSearchQuery?: string;
}

interface PersistedTreeChildrenLoadResult {
  hit: boolean;
  isStale: boolean;
}

type MetadataListPageResult = TableInfo[] | ObjectInfo[];

type BeforeConnectHandler = (config: ConnectionConfig) => Promise<void>;

export const CONNECTION_ATTEMPT_CANCELLED_MESSAGE = "Connection attempt was cancelled";

function redisDbLabel(db: number, _loadedKeyCount?: number, totalKeyCount?: number): string {
  if (totalKeyCount == null) return `db${db}`;
  return `db${db} (${totalKeyCount})`;
}

function metadataDriverProfile(config?: ConnectionConfig): string | undefined {
  return config?.driver_profile || config?.db_type;
}

export const useConnectionStore = defineStore("connection", () => {
  const settingsStore = useSettingsStore();
  const connections = ref<ConnectionConfig[]>([]);
  const isDesktop = isTauriRuntime();
  const activeConnectionId = ref<string | null>(localStorage.getItem(ACTIVE_CONNECTION_STORAGE_KEY));
  const selectedTreeNodeId = ref<string | null>(null);
  const selectedTreeNodeIds = ref<string[]>([]);
  // O(1) membership set — rebuilds only when selectedTreeNodeIds changes.
  // Avoids O(N) Array.includes() in every visible TreeItem's isMultiSelected
  // computed during scrolling and selection changes.
  const selectedTreeNodeIdsSet = computed(() => new Set(selectedTreeNodeIds.value));
  const treeSelectionAnchorId = ref<string | null>(null);
  const connectionMultiSelectActive = ref(false);
  const treeClipboard = ref<TreeClipboard | null>(null);

  watch(activeConnectionId, (id) => {
    if (id) localStorage.setItem(ACTIVE_CONNECTION_STORAGE_KEY, id);
    else localStorage.removeItem(ACTIVE_CONNECTION_STORAGE_KEY);
  });
  const treeNodes = ref<TreeNode[]>([]);
  const pinnedTreeNodeIds = ref<Set<string>>(new Set());
  const connectedIds = ref<Set<string>>(new Set());
  const identifierQuotes = ref<Record<string, string>>({});
  const lastConnectionHealthCheckAt = ref<Record<string, number>>({});
  const agentDrivers = ref<AgentDriverInstallState[]>([]);
  let agentDriversRefreshPromise: Promise<void> | null = null;
  const loadedTreeNodeChildrenIds = ref<Set<string>>(new Set());
  const connectionErrors = ref<Record<string, string>>({});
  const connectingIds = ref<Set<string>>(new Set());
  const editingConnectionId = ref<string | null>(null);
  const newConnectionGroupId = ref<string | null>(null);
  const completionTablesCache = ref<Record<string, SqlCompletionTable[]>>({});
  const completionObjectsCache = ref<Record<string, SqlCompletionObject[]>>({});
  const completionColumnsCache = ref<Record<string, ColumnInfo[]>>({});
  const completionForeignKeysCache = ref<Record<string, ForeignKeyInfo[]>>({});
  const completionDatabasesCache = ref<Record<string, string[]>>({});
  const elasticsearchCompletionIndicesCache = ref<Record<string, string[]>>({});
  const redisCompletionKeysCache = ref<Record<string, string[]>>({});
  const mongoCompletionCollectionsCache = ref<Record<string, string[]>>({});
  const mongoCompletionFieldsCache = ref<Record<string, MongoCompletionField[]>>({});
  const schemaListCache = ref<Record<string, string[]>>({});
  const sidebarSearchQuery = ref("");
  const sidebarTableSearchQueries = ref<Record<string, string>>({});
  const completionTableIndex = new Map<string, { touched: number; tables: SqlCompletionTable[] }>();
  const completionObjectIndex = new Map<string, { touched: number; objects: SqlCompletionObject[] }>();
  const completionColumnIndex = new Map<string, { touched: number; columns: SqlCompletionColumn[] }>();
  const completionForeignKeyIndex = new Map<string, { touched: number; foreignKeys: SqlCompletionForeignKey[] }>();
  const completionInFlight = new Map<string, Promise<unknown>>();
  const completionMetadataLimiter = new MetadataTaskLimiter(COMPLETION_METADATA_CONCURRENCY, (event) => {
    console.debug("[DBX][completion-metadata:limit]", event);
  });
  const transferSource = ref<{ connectionId: string; database: string } | null>(null);
  const schemaDiffSource = ref<{ connectionId: string; database: string; schema?: string } | null>(null);
  const dataCompareSource = ref<{
    connectionId: string;
    database: string;
    schema?: string;
    tableName?: string;
  } | null>(null);
  const sqlFileSource = ref<{ connectionId: string; database: string; filePath?: string } | null>(null);
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
    tableName?: string;
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
    allDatabases?: boolean;
  } | null>(null);
  const sidebarLayout = ref<SidebarLayout>(emptyLayout());
  const connectionGroupPaths = computed(() => buildConnectionGroupPathMap(sidebarLayout.value));
  let layoutPersistTimer: ReturnType<typeof setTimeout> | null = null;
  const staleTreeRefreshIds = new Set<string>();
  const metadataLoadCoordinator = new MetadataLoadCoordinator((event) => {
    console.debug("[DBX][metadata-load:coordinator]", event);
  });
  const metadataListPageCache = new MetadataResultCache<MetadataListPageResult>({
    ttlMs: METADATA_LIST_PAGE_CACHE_TTL_MS,
    maxEntries: METADATA_LIST_PAGE_CACHE_MAX_ENTRIES,
  });
  const metadataTraceLogger: MetadataLoadTraceLogger = (event) => {
    console.debug("[DBX][metadata-load:trace]", event);
  };
  const connectInFlight = new Map<string, Promise<void>>();
  const disconnectInFlight = new Map<string, Promise<void>>();
  const disconnectInFlightScoped = new Map<string, boolean>();
  const cancelDisconnectInFlight = new Map<string, Promise<void>>();
  const activeLocalConnectionAttempts = new Map<string, number>();
  const cancelledLocalConnectionAttempts = new Map<string, Set<number>>();
  const successfulLocalConnectionAttempts = new Map<string, number>();
  const connectionStateRevisions = new Map<string, number>();
  const connectionErrorRevisions = new Map<string, number>();
  let nextLocalConnectionAttempt = 0;
  let beforeConnectHandler: BeforeConnectHandler | null = null;
  let initFromDiskPromise: Promise<void> | null = null;

  function runTreeMetadataLoad<T>(scope: MetadataScopeInput, task: () => Promise<T>, options?: LoadTreeOptions): Promise<T> {
    return metadataLoadCoordinator.run(scope, task, { force: options?.force, kind: scope.kind });
  }

  async function loadCachedMetadataListPage<T extends MetadataListPageResult>(scope: MetadataScopeInput, load: () => Promise<T>, options?: { force?: boolean }): Promise<T> {
    const trace = createMetadataLoadTrace(scope);
    if (!options?.force) {
      const cached = metadataListPageCache.get(scope);
      if (cached) {
        logMetadataLoadTrace(metadataTraceLogger, trace, "cache-hit", {
          cacheStatus: cached.stale ? "stale" : "hit",
          resultCount: cached.value.length,
          stale: cached.stale,
        });
        return cached.value as T;
      }
    }

    logMetadataLoadTrace(metadataTraceLogger, trace, "cache-miss", { cacheStatus: options?.force ? "refresh" : "miss", force: options?.force === true });
    const errorRevision = connectionErrorRevision(scope.connectionId);
    const result = await load();
    clearConnectionErrorIfUnchanged(scope.connectionId, errorRevision);
    metadataListPageCache.set(scope, result);
    logMetadataLoadTrace(metadataTraceLogger, trace, "done", {
      cacheStatus: options?.force ? "refresh" : "miss",
      resultCount: result.length,
      force: options?.force === true,
    });
    return result;
  }

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

  function connectionIdentifierQuote(connectionId?: string): string | undefined {
    if (!connectionId) return undefined;
    return identifierQuotes.value[connectionId];
  }

  function clearConnectionIdentifierQuote(connectionId: string) {
    if (!(connectionId in identifierQuotes.value)) return;
    const next = { ...identifierQuotes.value };
    delete next[connectionId];
    identifierQuotes.value = next;
  }

  async function refreshConnectionIdentifierQuote(connectionId: string, config: ConnectionConfig) {
    clearConnectionIdentifierQuote(connectionId);
    if (config.db_type !== "kingbase") return;
    const quote = await api.connectionIdentifierQuote(connectionId).catch(() => undefined);
    if (quote != null) identifierQuotes.value = { ...identifierQuotes.value, [connectionId]: quote };
  }

  function connectionErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  function isSupersededConnectionAttempt(error: unknown): boolean {
    return connectionErrorMessage(error).includes(SUPERSEDED_CONNECTION_ATTEMPT_MESSAGE);
  }

  function isCancelledConnectionAttempt(error: unknown): boolean {
    return connectionErrorMessage(error).includes(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
  }

  function beginLocalConnectionAttempt(connectionId: string): number {
    const attempt = ++nextLocalConnectionAttempt;
    bumpConnectionStateRevision(connectionId);
    activeLocalConnectionAttempts.set(connectionId, attempt);
    connectingIds.value.add(connectionId);
    const node = findConnectionNode(connectionId);
    if (node) node.isLoading = true;
    return attempt;
  }

  function markSuccessfulLocalConnectionAttempt(connectionId: string, attempt: number) {
    successfulLocalConnectionAttempts.set(connectionId, attempt);
  }

  function forgetSuccessfulLocalConnectionAttempt(connectionId: string) {
    successfulLocalConnectionAttempts.delete(connectionId);
  }

  function bumpConnectionStateRevision(connectionId: string): number {
    const revision = (connectionStateRevisions.get(connectionId) ?? 0) + 1;
    connectionStateRevisions.set(connectionId, revision);
    return revision;
  }

  function isCurrentConnectionStateRevision(connectionId: string, revision: number): boolean {
    return connectionStateRevisions.get(connectionId) === revision;
  }

  function isCurrentLocalConnectionAttempt(connectionId: string, attempt: number): boolean {
    return activeLocalConnectionAttempts.get(connectionId) === attempt;
  }

  function isCancelledLocalConnectionAttempt(connectionId: string, attempt: number): boolean {
    return cancelledLocalConnectionAttempts.get(connectionId)?.has(attempt) === true;
  }

  function getLocalConnectionAttempt(connectionId: string): number | undefined {
    return activeLocalConnectionAttempts.get(connectionId);
  }

  function finishLocalConnectionAttempt(connectionId: string, attempt: number) {
    if (isCancelledLocalConnectionAttempt(connectionId, attempt)) {
      const attempts = cancelledLocalConnectionAttempts.get(connectionId);
      attempts?.delete(attempt);
      if (attempts?.size === 0) {
        cancelledLocalConnectionAttempts.delete(connectionId);
      }
    }
    if (!isCurrentLocalConnectionAttempt(connectionId, attempt)) return;
    activeLocalConnectionAttempts.delete(connectionId);
    connectingIds.value.delete(connectionId);
    clearConnectionNodeLoading(connectionId);
  }

  function cancelLocalConnectionAttempt(connectionId: string): boolean {
    const attempt = activeLocalConnectionAttempts.get(connectionId);
    if (attempt == null) return false;
    const attempts = cancelledLocalConnectionAttempts.get(connectionId) ?? new Set<number>();
    attempts.add(attempt);
    cancelledLocalConnectionAttempts.set(connectionId, attempts);
    activeLocalConnectionAttempts.delete(connectionId);
    connectingIds.value.delete(connectionId);
    clearConnectionNodeLoading(connectionId);
    clearConnectionRootMetadataLoad(connectionId);
    connectInFlight.delete(connectionId);
    return true;
  }

  function clearConnectionRootMetadataLoad(connectionId: string) {
    metadataLoadCoordinator.clear({
      kind: "connection-databases",
      connectionId,
      driverProfile: metadataDriverProfile(getConfig(connectionId)),
    });
  }

  function getBlockingDisconnectInFlight(connectionId: string): Promise<void> | undefined {
    return disconnectInFlightScoped.get(connectionId) ? undefined : disconnectInFlight.get(connectionId);
  }

  async function waitForBlockingDisconnectInFlight(connectionId: string): Promise<void> {
    const pending = getBlockingDisconnectInFlight(connectionId);
    if (pending) await pending;
  }

  function trackDisconnectRequest(connectionId: string, request: Promise<void>, scoped: boolean): Promise<void> {
    const bounded = withDisconnectRequestTimeout(connectionId, request);
    const tracked = bounded
      .catch((error) => {
        console.warn("[DBX][connection:disconnect-error]", { connectionId, error });
      })
      .finally(() => {
        if (disconnectInFlight.get(connectionId) === tracked) {
          disconnectInFlight.delete(connectionId);
          disconnectInFlightScoped.delete(connectionId);
        }
      });
    disconnectInFlight.set(connectionId, tracked);
    disconnectInFlightScoped.set(connectionId, scoped);
    return bounded;
  }

  function startDisconnectRequest(connectionId: string): Promise<void> {
    const clientAttempt = activeLocalConnectionAttempts.get(connectionId) ?? successfulLocalConnectionAttempts.get(connectionId);
    let request: Promise<void>;
    try {
      request = api.disconnectDb(connectionId, clientAttempt);
    } catch (error) {
      request = Promise.reject(error);
    }
    return trackDisconnectRequest(connectionId, request, clientAttempt != null);
  }

  function cancelDisconnectKey(connectionId: string, attempt: number): string {
    return `${connectionId}:${attempt}`;
  }

  function startCancelDisconnectRequest(connectionId: string, attempt: number): Promise<void> {
    const key = cancelDisconnectKey(connectionId, attempt);
    const existing = cancelDisconnectInFlight.get(key);
    if (existing) return existing;
    let request: Promise<void>;
    try {
      request = api.disconnectDb(connectionId, attempt);
    } catch (error) {
      request = Promise.reject(error);
    }
    const tracked = withDisconnectRequestTimeout(connectionId, request)
      .catch((error) => {
        console.warn("[DBX][connection:cancel-disconnect-error]", { connectionId, attempt, error });
        throw error;
      })
      .finally(() => {
        if (cancelDisconnectInFlight.get(key) === tracked) {
          cancelDisconnectInFlight.delete(key);
        }
      });
    cancelDisconnectInFlight.set(key, tracked);
    return tracked;
  }

  async function cleanupResolvedCancelledConnectionAttempt(connectionId: string, attempt: number) {
    try {
      // A cancel request can reach the backend before connect_db registers the
      // attempt, so clean again if that cancelled connect later returns a pool.
      await withDisconnectRequestTimeout(connectionId, api.disconnectDb(connectionId, attempt));
    } catch (error) {
      console.warn("[DBX][connection:cancel-result-cleanup-error]", { connectionId, attempt, error });
    }
  }

  async function ensureLocalConnectionAttemptActiveAfterConnectResult(connectionId: string, attempt: number, cleanupConnectionId: string) {
    if (isCancelledLocalConnectionAttempt(connectionId, attempt)) {
      await cleanupResolvedCancelledConnectionAttempt(cleanupConnectionId, attempt);
      throw new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
    }
    ensureLocalConnectionAttemptActive(connectionId, attempt);
  }

  function ensureLocalConnectionAttemptActive(connectionId: string, attempt: number) {
    if (isCancelledLocalConnectionAttempt(connectionId, attempt)) {
      throw new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
    }
    if (!isCurrentLocalConnectionAttempt(connectionId, attempt)) {
      throw new Error(SUPERSEDED_CONNECTION_ATTEMPT_MESSAGE);
    }
  }

  function setConnectionError(connectionId: string, message: string) {
    connectionErrors.value[connectionId] = message;
    connectionErrorRevisions.set(connectionId, connectionErrorRevision(connectionId) + 1);
  }

  function updateConnectionErrorPresentation(connectionId: string, expectedMessage: string, message: string) {
    // Hints decorate the current error event and must not invalidate a retry's recovery revision.
    if (connectionErrors.value[connectionId] !== expectedMessage) return;
    connectionErrors.value[connectionId] = message;
  }

  function connectionErrorRevision(connectionId?: string | null): number {
    return connectionId ? (connectionErrorRevisions.get(connectionId) ?? 0) : 0;
  }

  function clearConnectionErrorIfUnchanged(connectionId: string | null | undefined, revision: number) {
    if (!connectionId || connectionErrorRevision(connectionId) !== revision) return;
    clearConnectionError(connectionId);
  }

  function agentDriverUpdateHint(): string {
    return i18n.global.t("connection.agentDriverUpdateConnectionHint");
  }

  function connectionErrorWithDriverUpdateHint(config: ConnectionConfig | undefined, message: string): string {
    if (!config) return message;
    message = appendConnectionErrorHints(config, message, i18n.global.t);
    if (!hasAgentDriverUpdate(config.db_type, agentDrivers.value, config.driver_profile)) return message;
    return appendAgentDriverUpdateHint(message, agentDriverUpdateHint());
  }

  function refreshAgentDriversForErrorHint(): Promise<void> {
    if (agentDriversRefreshPromise) return agentDriversRefreshPromise;
    agentDriversRefreshPromise = api
      .listInstalledAgents()
      .then((drivers) => {
        agentDrivers.value = drivers;
      })
      .catch(() => undefined)
      .finally(() => {
        agentDriversRefreshPromise = null;
      });
    return agentDriversRefreshPromise;
  }

  function maybeAppendAgentDriverUpdateHint(connectionId: string, baseMessage: string) {
    const config = getConfig(connectionId);
    const message = connectionErrorWithDriverUpdateHint(config, baseMessage);
    if (message !== baseMessage) {
      updateConnectionErrorPresentation(connectionId, baseMessage, message);
      return;
    }
    void refreshAgentDriversForErrorHint().then(() => {
      if (connectionErrors.value[connectionId] !== baseMessage) return;
      const refreshedMessage = connectionErrorWithDriverUpdateHint(config, baseMessage);
      if (refreshedMessage !== baseMessage) updateConnectionErrorPresentation(connectionId, baseMessage, refreshedMessage);
    });
  }

  function clearConnectionError(connectionId: string) {
    if (!connectionErrors.value[connectionId]) return;
    delete connectionErrors.value[connectionId];
    connectionErrorRevisions.set(connectionId, connectionErrorRevision(connectionId) + 1);
  }

  function markConnectionHealthChecked(connectionId: string) {
    lastConnectionHealthCheckAt.value[connectionId] = Date.now();
  }

  function clearConnectionHealthCheck(connectionId: string) {
    if (!lastConnectionHealthCheckAt.value[connectionId]) return;
    delete lastConnectionHealthCheckAt.value[connectionId];
  }

  function hasRecentConnectionHealthCheck(connectionId: string) {
    const checkedAt = lastConnectionHealthCheckAt.value[connectionId];
    return typeof checkedAt === "number" && Date.now() - checkedAt < CONNECTION_HEALTH_CHECK_TTL_MS;
  }

  function clearConnectionNodeLoading(connectionId: string) {
    const node = findConnectionNode(connectionId);
    if (node) node.isLoading = false;
  }

  function metadataLoadTimeoutMs(config?: ConnectionConfig): number {
    const queryTimeoutSecs = Number(config?.query_timeout_secs);
    if (queryTimeoutSecs === 0) return METADATA_LOAD_DISABLED_QUERY_TIMEOUT_MS;
    const boundedTimeoutSecs = Number.isFinite(queryTimeoutSecs) && queryTimeoutSecs > 0 ? queryTimeoutSecs + 5 : 35;
    return Math.max(METADATA_LOAD_MIN_TIMEOUT_MS, boundedTimeoutSecs * 1000);
  }

  async function withConnectionHealthTimeout(connectionId: string, promise: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Connection health check timed out after ${Math.ceil(CONNECTION_HEALTH_CHECK_TIMEOUT_MS / 1000)}s.`));
          }, CONNECTION_HEALTH_CHECK_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      clearConnectionNodeLoading(connectionId);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function withMetadataLoadTimeout<T>(connectionId: string, promise: Promise<T>, label: string): Promise<T> {
    const timeoutMs = metadataLoadTimeoutMs(getConfig(connectionId));
    const errorRevision = connectionErrorRevision(connectionId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Connection timed out while loading ${label} after ${Math.ceil(timeoutMs / 1000)}s. Please check the network or VPN and try again.`));
          }, timeoutMs);
        }),
      ]);
      clearConnectionErrorIfUnchanged(connectionId, errorRevision);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function withDisconnectRequestTimeout(connectionId: string, promise: Promise<void>): Promise<void> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void promise.catch((error) => {
      if (timedOut) console.warn("[DBX][connection:disconnect-late-error]", { connectionId, error });
    });
    try {
      await Promise.race([
        promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            console.warn("[DBX][connection:disconnect-timeout]", { connectionId, timeoutMs: DISCONNECT_REQUEST_TIMEOUT_MS });
            resolve();
          }, DISCONNECT_REQUEST_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function recordConnectionError(connectionId: string, error: unknown): string {
    const message = connectionErrorMessage(error);
    if (isCancelledConnectionAttempt(message)) {
      clearConnectionError(connectionId);
      return "";
    }
    setConnectionError(connectionId, message);
    maybeAppendAgentDriverUpdateHint(connectionId, message);
    return message;
  }

  function markConnectionLost(connectionId: string, error: unknown) {
    connectedIds.value.delete(connectionId);
    clearConnectionIdentifierQuote(connectionId);
    clearConnectionNodeLoading(connectionId);
    clearConnectionHealthCheck(connectionId);
    if (activeConnectionId.value === connectionId) activeConnectionId.value = null;
    recordConnectionError(connectionId, error);
  }

  function recordConnectionLostError(connectionId: string, error: unknown): boolean {
    if (shouldMarkDisconnected(error)) {
      markConnectionLost(connectionId, error);
      return true;
    }
    return false;
  }

  // Metadata loaders keep this internal: match connection-loss errors before recording generic errors.
  function recordMetadataLoadError(connectionId: string, error: unknown) {
    if (recordConnectionLostError(connectionId, error)) return;
    recordConnectionError(connectionId, error);
  }

  async function withConnectionAttemptTimeout<T>(promise: Promise<T>, config: ConnectionConfig): Promise<T> {
    const timeoutMs = connectionAttemptTimeoutMs(config);
    const timeoutMessage = connectionAttemptTimeoutMessage(timeoutMs);
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void promise.then(
      (connectionId) => {
        if (!timedOut) return;
        const cleanupConnectionId = typeof connectionId === "string" && connectionId ? connectionId : config.id;
        if (connectedIds.value.has(cleanupConnectionId)) return;
        void api.disconnectDb(cleanupConnectionId).catch((error) => {
          console.warn("[DBX][connection:timeout-cleanup-failed]", { connectionId: cleanupConnectionId, error });
        });
      },
      (error) => {
        if (!timedOut) return;
        const current = connectionErrors.value[config.id];
        if (current !== timeoutMessage) return;
        setConnectionError(config.id, connectionAttemptOriginalErrorMessage(timeoutMessage, connectionErrorMessage(error)));
      },
    );
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(timeoutMessage));
          }, timeoutMs);
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
      zookeeper: "Apache ZooKeeper",
      duckdb: "DuckDB",
      clickhouse: "ClickHouse",
      sqlserver: "SQL Server",
      mongodb: "MongoDB",
      oracle: "Oracle",
      "mongodb-legacy": MONGO_LEGACY_DRIVER_LABEL,
      elasticsearch: "Elasticsearch",
      qdrant: "Qdrant",
      milvus: "Milvus",
      weaviate: "Weaviate",
      chromadb: "ChromaDB",
      doris: "Doris",
      starrocks: "StarRocks",
      manticoresearch: "Manticore Search",
      redshift: "Redshift",
      dameng: "达梦 Dameng",
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
      prestosql: "PrestoSQL",
      hive: "Hive",
      spark: "Apache Spark",
      db2: "DB2",
      informix: "Informix",
      neo4j: "Neo4j",
      cassandra: "Cassandra",
      bigquery: "BigQuery",
      kylin: "Kylin",
      sundb: "SunDB",
      oscar: "神通 OSCAR",
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
      agent_java_options: Array.isArray(config.agent_java_options) ? config.agent_java_options : [],
      attached_databases: Array.isArray(config.attached_databases) ? config.attached_databases.filter((database) => database.name?.trim() && database.path?.trim()) : [],
      init_script: config.init_script?.trim() ? config.init_script : undefined,
      transport_layers: Array.isArray(config.transport_layers) ? config.transport_layers : [],
      connect_timeout_secs: config.connect_timeout_secs || 10,
      query_timeout_secs: config.query_timeout_secs ?? 30,
      idle_timeout_secs: config.idle_timeout_secs ?? 60,
      keepalive_interval_secs: config.keepalive_interval_secs ?? DEFAULT_KEEPALIVE_INTERVAL_SECS,
      database_info: normalizeDatabaseConnectionInfo(config.database_info),
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

  function isTreeNodePinned(node: TreeNode | string): boolean {
    if (typeof node === "string") return pinnedTreeNodeIds.value.has(node);
    return pinnedTreeNodeIds.value.has(treeNodePinKey(node)) || pinnedTreeNodeIds.value.has(node.id);
  }

  function isConnectionUtilityNode(node: TreeNode): boolean {
    return node.type === "user-admin" || node.type === "dameng-job-admin";
  }

  function connectionMetadataChildren(children: TreeNode[] | undefined): TreeNode[] {
    return (children || []).filter((child) => !isConnectionUtilityNode(child));
  }

  function hasConnectionMetadataChildren(children: TreeNode[] | undefined): boolean {
    return connectionMetadataChildren(children).length > 0;
  }

  function preserveExistingConnectionMetadataChildren(parent: TreeNode, children: TreeNode[]): TreeNode[] {
    if (parent.type !== "connection" || hasConnectionMetadataChildren(children)) return children;

    const existingMetadataChildren = connectionMetadataChildren(parent.children);
    const nextUtilityChildren = children.filter(isConnectionUtilityNode);
    if (existingMetadataChildren.length === 0 || nextUtilityChildren.length === 0) return children;

    return [...existingMetadataChildren, ...nextUtilityChildren];
  }

  // Leaf tree nodes (table columns / indexes / foreign keys / triggers) are
  // immutable data payloads: they never expand, never load children, and their
  // fields are never mutated after creation. A large schema can produce tens of
  // thousands of them, and Vue's deep reactivity wraps every node AND its nested
  // `meta` object in a Proxy — the dominant memory cost of the schema tree.
  // Marking each leaf raw keeps Vue from wrapping it (and, since Vue does not
  // recurse into raw objects, its `meta` too), mirroring the markRaw() treatment
  // queryStore already applies to result rows. Containers stay reactive so their
  // children / isExpanded / isLoading mutations still drive the UI.
  const LEAF_TREE_NODE_TYPES = new Set<TreeNode["type"]>(["column", "index", "fkey", "trigger"]);

  function markRawLeafTreeNodes(nodes: TreeNode[]): TreeNode[] {
    for (const node of nodes) {
      if (LEAF_TREE_NODE_TYPES.has(node.type)) {
        markRaw(node);
      } else if (node.children && node.children.length > 0) {
        markRawLeafTreeNodes(node.children);
      }
    }
    return nodes;
  }

  function setChildren(parent: TreeNode, children: TreeNode[]) {
    children = preserveExistingConnectionMetadataChildren(parent, children);
    if (parent.children && parent.children.length > 0) {
      const oldMap = new Map(parent.children.map((c) => [c.id, c] as const));
      children = children.map((child) => {
        const old = oldMap.get(child.id);
        if (old?.isLoading) {
          const isExpanded = old.isExpanded;
          const isLoading = old.isLoading;
          const oldChildren = old.children;
          Object.assign(old, child);
          old.isExpanded = isExpanded;
          old.isLoading = isLoading;
          old.children = oldChildren;
          return old;
        }
        if (old?.isExpanded) {
          return { ...child, isExpanded: true, children: old.children };
        }
        return child;
      });
    }
    const migratedPins = migrateLegacyPinnedTreeNodeIds(children, pinnedTreeNodeIds.value);
    if (migratedPins.changed) {
      pinnedTreeNodeIds.value = migratedPins.ids;
      persistPinnedTreeNodeIds();
    }
    syncPinnedTreeNodeStateInPlace(children, migratedPins.ids);
    parent.children = markRawLeafTreeNodes(children);
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
    if (!connectionSupportsDatabaseUserAdmin(config)) return undefined;
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

  function buildDamengJobAdminNode(connectionId: string, existingConnectionNode?: TreeNode): TreeNode | undefined {
    const config = getConfig(connectionId);
    if (effectiveDatabaseTypeForConnection(config) !== "dameng") return undefined;
    const existing = existingConnectionNode?.children?.find((child) => child.type === "dameng-job-admin");
    return {
      id: `${connectionId}:__dameng_jobs`,
      label: "tree.damengJobAdmin",
      type: "dameng-job-admin",
      connectionId,
      database: "",
      isExpanded: existing?.isExpanded ?? false,
    };
  }

  function withConnectionUtilityNodes(connectionId: string, children: TreeNode[], existingConnectionNode?: TreeNode): TreeNode[] {
    const nonUtilityChildren = connectionMetadataChildren(children);
    const userAdminNode = buildUserAdminNode(connectionId, existingConnectionNode);
    const damengJobAdminNode = buildDamengJobAdminNode(connectionId, existingConnectionNode);
    return [...nonUtilityChildren, userAdminNode, damengJobAdminNode].filter(Boolean) as TreeNode[];
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

  function sortSidebarSchemaInfos(schemas: readonly SchemaInfo[]): SchemaInfo[] {
    const byName = new Map<string, SchemaInfo>();
    for (const schema of schemas) {
      const name = schema.name.trim();
      if (!name) continue;
      byName.set(name, { name, comment: schema.comment ?? null });
    }
    return sortSidebarNames([...byName.keys()]).map((name) => byName.get(name)!);
  }

  function objectGroupCacheKey(node: TreeNode): string {
    return schemaCacheKey(node.connectionId || "", node.database || "", node.schema || "", node.type, "objects-v5");
  }

  function metadataListDriverProfile(connectionId?: string): string | undefined {
    return connectionId ? metadataDriverProfile(getConfig(connectionId)) : undefined;
  }

  function metadataListCacheScope(options: {
    kind: string;
    connectionId?: string | null;
    database?: string | null;
    schema?: string | null;
    nodeKind?: string | null;
    objectTypes?: readonly string[] | null;
    searchFilter?: string | null;
    limit?: number | null;
    offset?: number | null;
    sidebarDisplayMode?: string | null;
    extra?: MetadataScopeInput["extra"];
  }): MetadataScopeInput {
    return {
      kind: options.kind,
      connectionId: options.connectionId,
      database: options.database,
      schema: options.schema,
      nodeKind: options.nodeKind,
      objectTypes: options.objectTypes,
      searchFilter: options.searchFilter,
      limit: options.limit,
      offset: options.offset,
      sidebarDisplayMode: options.sidebarDisplayMode,
      driverProfile: metadataListDriverProfile(options.connectionId || undefined),
      extra: options.extra,
    };
  }

  function invalidateMetadataCaches(match: MetadataCacheInvalidation): number {
    return metadataListPageCache.invalidate(match) + invalidateTableMetadataCache(match);
  }

  function invalidateMetadataCachesByTreePrefix(prefix: string) {
    const [connectionId, database, schema, tableName] = prefix.split(":").map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
    if (!connectionId) return;
    invalidateMetadataCaches({
      connectionId,
      database: database || undefined,
      schema: schema || undefined,
      tableName: tableName && !tableName.startsWith("__") ? tableName : undefined,
    });
  }

  function invalidateMetadataCachesForNode(node: TreeNode) {
    if (!node.connectionId) return;
    const tableName = node.tableName || (node.type === "table" || node.type === "view" || node.type === "materialized_view" || node.type === "mongo-collection" ? node.label : undefined);
    invalidateMetadataCaches({
      connectionId: node.connectionId,
      database: node.database || undefined,
      schema: node.schema || undefined,
      tableName,
    });
  }

  function invalidateMetadataCache(connectionId: string, database?: string, schema?: string, tableName?: string) {
    invalidateMetadataCaches({ connectionId, database, schema, tableName });
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

  function tableInfosToCompletionTables(tables: readonly TableInfo[], schema?: string): SqlCompletionTable[] {
    return tables.map((table) => ({
      name: table.name,
      schema,
      type: sqlObjectNavigationTypeFromTableType(table.table_type),
    }));
  }

  function sameSidebarObjectName(left: string | undefined, right: string | undefined): boolean {
    return (left || "").toLowerCase() === (right || "").toLowerCase();
  }

  function treeNodeObjectIdentity(node: TreeNode): string {
    return `${node.type}\0${(node.schema || "").toLowerCase()}\0${node.label.toLowerCase()}`;
  }

  function mergeLocatedTreeChildren(parent: TreeNode, currentChildren: TreeNode[], pageChildren: TreeNode[], connectionId: string, database: string): TreeNode[] {
    const tableChildren = pageChildren.filter((child) => child.type === "table");
    const nonTableChildren = pageChildren.filter((child) => child.type !== "table");
    let merged = tableChildren.length ? mergeTableTreePageChildren(currentChildren, tableChildren, connectionId, database) : [...currentChildren];
    const existing = new Set(merged.map(treeNodeObjectIdentity));
    for (const child of nonTableChildren) {
      const key = treeNodeObjectIdentity(child);
      if (existing.has(key)) continue;
      merged.push(child);
      existing.add(key);
    }
    const config = parent.connectionId ? getConfig(parent.connectionId) : undefined;
    return sortSidebarTreeChildrenForParent(
      parent,
      sortDatabaseObjectsByName(merged, (node) => node.label),
      config?.db_type,
    );
  }

  function findTreeNodes(nodes: TreeNode[], predicate: (node: TreeNode) => boolean): TreeNode[] {
    const matches: TreeNode[] = [];
    for (const node of nodes) {
      if (predicate(node)) matches.push(node);
      if (node.children) matches.push(...findTreeNodes(node.children, predicate));
      const hiddenOnlyChildren = node.hiddenChildren?.filter((child) => !(node.children || []).includes(child));
      if (hiddenOnlyChildren?.length) matches.push(...findTreeNodes(hiddenOnlyChildren, predicate));
    }
    return matches;
  }

  async function loadPagedTableGroupChildren(options: {
    node: TreeNode;
    parentNodeId: string;
    querySchema: string;
    effectiveSchema?: string;
    objectTypes: DatabaseObjectTreeKind[];
    offset: number;
    pageSize: number;
    searchFilter?: string;
    force?: boolean;
  }): Promise<{ children: TreeNode[]; objectCount: number; hasMore: boolean; nextOffset: number; loadMoreParent?: TableTreeLoadMoreParent }> {
    if (!options.node.connectionId || !options.node.database) {
      return { children: [], objectCount: 0, hasMore: false, nextOffset: options.offset };
    }
    const searchFilter = (options.searchFilter ?? sidebarSearchQuery.value) || undefined;
    const fetchLimit = searchFilter ? options.pageSize : options.pageSize + 1;
    const fetchOffset = searchFilter ? undefined : options.offset;
    const tables = await loadCachedMetadataListPage<TableInfo[]>(
      metadataListCacheScope({
        kind: "table-list-page",
        connectionId: options.node.connectionId,
        database: options.node.database,
        schema: options.querySchema,
        nodeKind: options.node.type,
        objectTypes: options.objectTypes,
        searchFilter,
        limit: fetchLimit,
        offset: fetchOffset,
        sidebarDisplayMode: "grouped",
      }),
      () => api.listTables(options.node.connectionId!, options.node.database!, options.querySchema, searchFilter, fetchLimit, fetchOffset, options.objectTypes),
      { force: options.force },
    );
    const hasMore = searchFilter ? false : tables.length > options.pageSize;
    const pageTables = hasMore ? tables.slice(0, options.pageSize) : tables;
    indexCompletionTables(options.node.connectionId, options.node.database, options.effectiveSchema, tableInfosToCompletionTables(pageTables, options.effectiveSchema));
    const objects = mergeTableInfosIntoObjects([], pageTables, options.effectiveSchema);
    const children = objectGroupChildrenFromObjects({
      node: options.node,
      parentNodeId: options.parentNodeId,
      effectiveSchema: options.effectiveSchema,
      objectTypes: options.objectTypes,
      objects,
    });
    const lastTable = pageTables[pageTables.length - 1];
    return {
      children,
      objectCount: children.length,
      hasMore,
      nextOffset: options.offset + pageTables.length,
      loadMoreParent: lastTable?.parent_name ? { schema: lastTable.parent_schema, name: lastTable.parent_name } : undefined,
    };
  }

  async function loadPagedObjectGroupChildren(options: {
    node: TreeNode;
    parentNodeId: string;
    querySchema: string;
    effectiveSchema?: string;
    objectTypes: DatabaseObjectTreeKind[];
    offset: number;
    pageSize: number;
    searchFilter?: string;
    force?: boolean;
  }): Promise<{ children: TreeNode[]; objectCount: number; hasMore: boolean; nextOffset: number }> {
    if (!options.node.connectionId || !options.node.database) {
      return { children: [], objectCount: 0, hasMore: false, nextOffset: options.offset };
    }
    const searchFilter = options.searchFilter || undefined;
    const fetchLimit = searchFilter ? undefined : options.pageSize + 1;
    const fetchOffset = searchFilter ? undefined : options.offset;
    const objects = await loadCachedMetadataListPage<ObjectInfo[]>(
      metadataListCacheScope({
        kind: "object-list-page",
        connectionId: options.node.connectionId,
        database: options.node.database,
        schema: options.querySchema,
        nodeKind: options.node.type,
        objectTypes: options.objectTypes,
        searchFilter,
        limit: fetchLimit,
        offset: fetchOffset,
        sidebarDisplayMode: useSettingsStore().editorSettings.sidebarObjectDisplay,
      }),
      () => api.listObjects(options.node.connectionId!, options.node.database!, options.querySchema, options.objectTypes, searchFilter, fetchLimit, fetchOffset),
      { force: options.force },
    );
    const hasMore = searchFilter ? false : objects.length > options.pageSize;
    const pageObjects = hasMore ? objects.slice(0, options.pageSize) : objects;
    const children = objectGroupChildrenFromObjects({
      node: options.node,
      parentNodeId: options.parentNodeId,
      effectiveSchema: options.effectiveSchema,
      objectTypes: options.objectTypes,
      objects: pageObjects,
    });
    return {
      children,
      objectCount: children.length,
      hasMore,
      nextOffset: options.offset + pageObjects.length,
    };
  }

  async function loadPagedSimpleTableChildren(options: {
    nodeId: string;
    connectionId: string;
    database: string;
    querySchema: string;
    effectiveSchema?: string;
    nonTableObjectTypes: DatabaseObjectTreeKind[];
    offset: number;
    pageSize: number;
    searchFilter?: string;
    force?: boolean;
  }): Promise<{ children: TreeNode[]; objectCount: number; hasMore: boolean; nextOffset: number; loadMoreParent?: TableTreeLoadMoreParent }> {
    const searchFilter = (options.searchFilter ?? sidebarSearchQuery.value) || undefined;
    const fetchLimit = searchFilter ? options.pageSize : options.pageSize + 1;
    const fetchOffset = searchFilter ? undefined : options.offset;
    const tables = await loadCachedMetadataListPage<TableInfo[]>(
      metadataListCacheScope({
        kind: "table-list-page",
        connectionId: options.connectionId,
        database: options.database,
        schema: options.querySchema,
        nodeKind: "simple-tables",
        searchFilter,
        limit: fetchLimit,
        offset: fetchOffset,
        sidebarDisplayMode: "simple",
      }),
      () => api.listTables(options.connectionId, options.database, options.querySchema, searchFilter, fetchLimit, fetchOffset),
      { force: options.force },
    );
    const hasMore = searchFilter ? false : tables.length > options.pageSize;
    const pageTables = hasMore ? tables.slice(0, options.pageSize) : tables;
    indexCompletionTables(options.connectionId, options.database, options.effectiveSchema, tableInfosToCompletionTables(pageTables, options.effectiveSchema));

    const children = buildTableTreeNodes({
      nodeId: options.nodeId,
      connectionId: options.connectionId,
      database: options.database,
      schema: options.effectiveSchema,
      tables: pageTables,
    });
    const lastTable = pageTables[pageTables.length - 1];
    return {
      children,
      objectCount: children.length,
      hasMore,
      nextOffset: options.offset + pageTables.length,
      loadMoreParent: lastTable?.parent_name ? { schema: lastTable.parent_schema, name: lastTable.parent_name } : undefined,
    };
  }

  async function loadSimpleSupplementalObjectChildren(options: { node: TreeNode; nodeId: string; connectionId: string; database: string; querySchema: string; effectiveSchema?: string; objectTypes: DatabaseObjectTreeKind[]; cacheKey: string; loadOptions?: LoadTreeOptions }) {
    if (options.objectTypes.length === 0) return;
    const searchFilter = activeTreeLoadSearchFilter(options.loadOptions);
    if (searchFilter) return;

    try {
      const objects = await loadCachedMetadataListPage<ObjectInfo[]>(
        metadataListCacheScope({
          kind: "object-list-page",
          connectionId: options.connectionId,
          database: options.database,
          schema: options.querySchema,
          nodeKind: "simple-supplemental",
          objectTypes: options.objectTypes,
          sidebarDisplayMode: "simple",
        }),
        () => api.listObjects(options.connectionId, options.database, options.querySchema, options.objectTypes),
        { force: options.loadOptions?.force },
      );
      const supplementalObjects = filterSimpleSidebarSupplementalObjects(objects);
      if (supplementalObjects.length === 0) return;
      const supplementalChildren = buildSimpleObjectTreeNodes({
        nodeId: options.nodeId,
        connectionId: options.connectionId,
        database: options.database,
        schema: options.effectiveSchema,
        objects: supplementalObjects,
      });
      if (supplementalChildren.length === 0) return;
      if (isTreeLoadSearchChanged(searchFilter, options.loadOptions)) return;
      if (!canApplyTreeMetadataResult(options.node)) return;

      const loadMoreNodes = (options.node.children || []).filter((child) => child.type === "load-more");
      const currentChildren = withoutLoadMoreNodes(options.node.children);
      const mergedChildren = mergeLocatedTreeChildren(options.node, currentChildren, supplementalChildren, options.connectionId, options.database);
      const nextChildren = [...mergedChildren, ...loadMoreNodes];
      setChildren(options.node, nextChildren);
      await savePersistedTreeChildren(options.cacheKey, nextChildren);
    } catch (error) {
      // Some drivers only expose table metadata; keep the already-rendered table tree usable.
      console.debug("[DBX][metadata:simple-supplemental:error]", {
        connectionId: options.connectionId,
        database: options.database,
        schema: options.effectiveSchema,
        error,
      });
    }
  }

  function refreshStaleTreeNode(node: TreeNode) {
    const searchFilter = sidebarSearchQuery.value || "";
    if (searchFilter) return;
    if (staleTreeRefreshIds.has(node.id)) return;
    staleTreeRefreshIds.add(node.id);
    const expandedIds = collectExpandedNodeIds([node]);
    clearLoadedChildrenCache(node.id);
    const refreshOptions = { force: true, expectedSidebarSearchQuery: searchFilter };
    void loadTreeNodeChildren(node, refreshOptions)
      .then(() => {
        if ((sidebarSearchQuery.value || "") !== searchFilter) return;
        return restoreExpandedChildren(node, expandedIds, refreshOptions);
      })
      .finally(() => staleTreeRefreshIds.delete(node.id));
  }

  async function loadPersistedTreeChildren(node: TreeNode, cacheKey: string): Promise<PersistedTreeChildrenLoadResult> {
    const trace = createMetadataLoadTrace({
      kind: "persisted-tree-cache",
      connectionId: node.connectionId,
      database: node.database,
      schema: node.schema,
      nodeKind: node.type,
      extra: { cacheKey },
    });
    const payload = await api.loadSchemaCache<unknown>(cacheKey).catch(() => null);
    const decoded = decodeSchemaTreeCache<TreeNode[]>(payload);
    if (!decoded) {
      logMetadataLoadTrace(metadataTraceLogger, trace, "cache-miss", { cacheStatus: "miss" });
      return { hit: false, isStale: false };
    }
    const config = node.connectionId ? getConfig(node.connectionId) : undefined;
    const cachedChildren = normalizeCataloglessDatabaseNodes(expandCachedObjectBrowserNodes(decoded.children));
    const childrenWithLinkedServers = node.type === "connection" && node.connectionId ? ensureSqlServerLinkedRootNode(node.connectionId, cachedChildren, config) : cachedChildren;
    if (node.type === "connection" && !hasConnectionMetadataChildren(childrenWithLinkedServers)) {
      logMetadataLoadTrace(metadataTraceLogger, trace, "cache-miss", { cacheStatus: "miss", resultCount: 0 });
      return { hit: false, isStale: false };
    }
    const normalizedChildren = sortSidebarTreeChildrenForParent(node, childrenWithLinkedServers, config?.db_type);
    setChildren(node, node.type === "connection" && node.connectionId ? withSavedSqlRoot(node.connectionId, normalizedChildren, node) : normalizedChildren);
    node.isExpanded = true;
    logMetadataLoadTrace(metadataTraceLogger, trace, "cache-hit", {
      cacheStatus: decoded.isStale ? "stale" : "hit",
      resultCount: normalizedChildren.length,
      stale: decoded.isStale,
    });
    return { hit: true, isStale: decoded.isStale };
  }

  async function savePersistedTreeChildren(cacheKey: string, children: TreeNode[]) {
    await api.saveSchemaCache(cacheKey, encodeSchemaTreeCache(children)).catch(() => undefined);
  }

  async function savePersistedConnectionTreeChildren(cacheKey: string, children: TreeNode[]) {
    const metadataChildren = connectionMetadataChildren(children);
    if (metadataChildren.length === 0) return;
    await savePersistedTreeChildren(cacheKey, metadataChildren);
  }

  function useCachedChildren(node: TreeNode, options?: LoadTreeOptions): boolean {
    if (options?.force || !loadedTreeNodeChildrenIds.value.has(node.id)) return false;
    if (node.type === "connection" && node.connectionId) {
      if (!hasConnectionMetadataChildren(node.children)) {
        clearLoadedChildrenCache(node.id);
        return false;
      }
      const normalizedChildren = sortSidebarTreeChildrenForParent(node, withSavedSqlRoot(node.connectionId, node.children || [], node), getConfig(node.connectionId)?.db_type);
      setChildren(node, normalizedChildren);
    }
    node.isExpanded = true;
    return true;
  }

  function isSidebarSearchQueryChanged(options?: LoadTreeOptions) {
    return options?.expectedSidebarSearchQuery !== undefined && (sidebarSearchQuery.value || "") !== options.expectedSidebarSearchQuery;
  }

  function isSidebarTableSearchQueryChanged(options?: LoadTreeOptions) {
    if (!options?.sidebarTableSearchParentId || options.expectedSidebarTableSearchQuery === undefined) return false;
    return (sidebarTableSearchQueries.value[options.sidebarTableSearchParentId]?.trim() || "") !== options.expectedSidebarTableSearchQuery;
  }

  function activeTreeLoadSearchFilter(options?: LoadTreeOptions): string {
    return (options?.searchFilter ?? sidebarSearchQuery.value) || "";
  }

  function isTreeLoadSearchChanged(searchFilter: string, options?: LoadTreeOptions): boolean {
    if (options?.sidebarTableSearchParentId) return isSidebarTableSearchQueryChanged(options);
    return (sidebarSearchQuery.value || "") !== searchFilter || isSidebarSearchQueryChanged(options);
  }

  function isTreeNodeChildrenLoaded(nodeId: string): boolean {
    return loadedTreeNodeChildrenIds.value.has(nodeId);
  }

  // Collapsing a node only hides it — its loaded children stay in memory, so a
  // long browsing session accumulates every schema the user ever expanded and
  // the webview creeps upward. When a *large* subtree is collapsed we drop its
  // children so the memory is reclaimed; re-expanding reloads them (fast, from
  // the schema cache). Small subtrees are kept so routine expand/collapse stays
  // instant and never triggers a reload.
  const RELEASE_COLLAPSED_SUBTREE_MIN_DESCENDANTS = 400;

  function countTreeNodeDescendants(node: TreeNode, cap: number): number {
    let count = 0;
    const stack: TreeNode[] = [...(node.children ?? [])];
    while (stack.length) {
      const current = stack.pop()!;
      count += 1;
      if (count >= cap) return count;
      if (current.children?.length) stack.push(...current.children);
    }
    return count;
  }

  function forgetLoadedChildrenIdsForSubtree(node: TreeNode) {
    loadedTreeNodeChildrenIds.value.delete(node.id);
    for (const child of node.children ?? []) {
      forgetLoadedChildrenIdsForSubtree(child);
    }
  }

  // Returns true when the collapsed node's children were released. Caller should
  // have already set node.isExpanded = false. Re-expanding reloads on demand
  // because the node id is removed from loadedTreeNodeChildrenIds.
  function releaseCollapsedTreeNodeChildren(nodeId: string): boolean {
    const node = findNode(treeNodes.value, nodeId);
    if (!node?.children?.length) return false;
    if (countTreeNodeDescendants(node, RELEASE_COLLAPSED_SUBTREE_MIN_DESCENDANTS) < RELEASE_COLLAPSED_SUBTREE_MIN_DESCENDANTS) {
      return false;
    }
    forgetLoadedChildrenIdsForSubtree(node);
    node.children = [];
    return true;
  }

  function canApplyTreeMetadataResult(node: TreeNode): boolean {
    if (findNode(treeNodes.value, node.id) !== node) return false;
    if (node.connectionId && !connectedIds.value.has(node.connectionId)) return false;
    return true;
  }

  function clearLoadedChildrenCache(prefix: string) {
    for (const id of loadedTreeNodeChildrenIds.value) {
      if (id === prefix || id.startsWith(`${prefix}:`)) {
        loadedTreeNodeChildrenIds.value.delete(id);
      }
    }
    invalidateMetadataCachesByTreePrefix(prefix);
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

  function toggleTreeNodePin(node: TreeNode) {
    const pinKey = treeNodePinKey(node);
    const next = new Set(pinnedTreeNodeIds.value);
    const wasPinned = next.has(pinKey) || next.has(node.id);
    // Remove the legacy bare id as part of every toggle so old ambiguous pins
    // cannot continue matching objects in a different database.
    next.delete(node.id);
    if (wasPinned) next.delete(pinKey);
    else next.add(pinKey);
    pinnedTreeNodeIds.value = next;
    persistPinnedTreeNodeIds();

    // Pinning is infrequent; synchronizing the loaded tree here also clears any
    // stale flags created by legacy unscoped ids without rebuilding metadata.
    syncPinnedTreeNodeStateInPlace(treeNodes.value, next);
  }

  async function addConnection(config: ConnectionConfig, targetGroupId?: string | null) {
    const normalized = normalizeConnection(config);
    const existing = connections.value.findIndex((c) => c.id === normalized.id);
    const nextConnections = [...connections.value];
    if (existing >= 0) {
      nextConnections[existing] = normalized;
    } else {
      nextConnections.push(normalized);
      const groupId = targetGroupId !== undefined ? targetGroupId : newConnectionGroupId.value;
      sidebarLayout.value = appendConnectionToLayout(sidebarLayout.value, normalized.id, groupId);
    }
    await persistConnections(nextConnections);
    connections.value = nextConnections;
    rebuildTreeNodes();
    persistSidebarLayoutDebounced();
    stopCreatingConnectionInGroup();
  }

  function copyConnectionsToTreeClipboard(connectionIds: Iterable<string>): number {
    const seen = new Set<string>();
    const entries: TreeClipboardConnectionEntry[] = [];
    for (const connectionId of connectionIds) {
      if (seen.has(connectionId)) continue;
      seen.add(connectionId);
      const config = getConfig(connectionId);
      if (!config) continue;
      entries.push({
        config: { ...config },
        sourceGroupId: findConnectionLocation(sidebarLayout.value, connectionId)?.groupId ?? null,
      });
    }
    if (!entries.length) return 0;
    treeClipboard.value = { kind: "connection-copy", connections: entries };
    return entries.length;
  }

  async function pasteConnectionClipboard(targetGroupId?: string | null): Promise<number> {
    const clipboard = treeClipboard.value;
    if (clipboard?.kind !== "connection-copy" || clipboard.connections.length === 0) return 0;

    let pastedCount = 0;
    for (const entry of clipboard.connections) {
      await addConnection(
        {
          ...entry.config,
          id: uuid(),
          name: `${entry.config.name} (Copy)`,
        },
        targetGroupId === undefined ? entry.sourceGroupId : targetGroupId,
      );
      pastedCount += 1;
    }
    return pastedCount;
  }

  function invalidateCompletionCache(connectionId: string, database?: string) {
    invalidateMetadataCaches({ connectionId, database });
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
    for (const key of Object.keys(mongoCompletionCollectionsCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete mongoCompletionCollectionsCache.value[key];
    }
    for (const key of Object.keys(mongoCompletionFieldsCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete mongoCompletionFieldsCache.value[key];
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
      connectionErrorRevisions.delete(id);
      connectedIds.value.delete(id);
      clearConnectionIdentifierQuote(id);
      clearConnectionHealthCheck(id);
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
      void deleteTabResultSnapshotsForOwner(id);
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
    clearConnectionIdentifierQuote(config.id);
    clearConnectionHealthCheck(config.id);
    invalidateCompletionCache(config.id);
    clearLoadedChildrenCache(config.id);
    const node = findConnectionNode(config.id);
    if (node?.isExpanded) {
      await reloadConnectionDatabaseChildren(config.id);
    }
  }

  async function updateConnectionDatabaseInfo(connectionId: string, databaseInfo: DatabaseConnectionInfo, expectedConfigFingerprint?: string): Promise<void> {
    const normalized = normalizeDatabaseConnectionInfo(databaseInfo);
    if (!normalized) return;
    const current = connections.value.find((connection) => connection.id === connectionId);
    if (!current) return;
    if (expectedConfigFingerprint && connectionConfigFingerprint(current) !== expectedConfigFingerprint) return;
    if (JSON.stringify(current.database_info) === JSON.stringify(normalized)) return;

    await api.saveConnectionDatabaseInfo(connectionId, normalized);
    const index = connections.value.findIndex((connection) => connection.id === connectionId);
    if (index < 0) return;
    if (expectedConfigFingerprint && connectionConfigFingerprint(connections.value[index]) !== expectedConfigFingerprint) return;
    const nextConnections = [...connections.value];
    nextConnections[index] = { ...nextConnections[index], database_info: normalized };
    connections.value = nextConnections;
    // Database info is reactive connection metadata, not tree structure. Keep
    // navigator node identities stable so an in-flight first expansion can
    // still apply its loaded children after this background refresh completes.
  }

  async function refreshConnectedDatabaseInfo(connectionId: string, config: ConnectionConfig): Promise<void> {
    const expectedConfigFingerprint = connectionConfigFingerprint(config);
    try {
      const detected = await api.connectionDatabaseInfo(connectionId);
      const normalized = normalizeDatabaseConnectionInfo(detected, configuredDatabaseProductName(config), config.database);
      if (normalized) await updateConnectionDatabaseInfo(connectionId, normalized, expectedConfigFingerprint);
    } catch {
      // Database metadata is optional and must not turn a successful connection into a failure.
    }
  }

  async function syncMongoLegacyDriverFallback(connectionId: string, previousConfig: ConnectionConfig) {
    if (!isDesktop || previousConfig.db_type !== "mongodb" || previousConfig.driver_profile === MONGO_LEGACY_DRIVER_PROFILE) {
      return;
    }

    const savedConnections = await api.loadConnections().catch(() => null);
    const savedConfig = savedConnections?.map((connection) => normalizeConnection(connection)).find((connection) => connection.id === connectionId && connection.driver_profile === MONGO_LEGACY_DRIVER_PROFILE);
    if (!savedConfig) return;

    const idx = connections.value.findIndex((connection) => connection.id === connectionId);
    if (idx < 0) return;
    const nextConnections = [...connections.value];
    nextConnections[idx] = {
      ...savedConfig,
      driver_label: savedConfig.driver_label || MONGO_LEGACY_DRIVER_LABEL,
    };
    connections.value = nextConnections;
    rebuildTreeNodes();
  }

  async function ensureSqlServerLegacyCompatibilityComponentInstalled(config: ConnectionConfig) {
    if (!requiresSqlServerLegacyCompatibilityComponent(config)) return;
    if (await api.isAgentInstalled(SQLSERVER_LEGACY_COMPATIBILITY_DRIVER_KEY)) return;
    await api.installAgent(SQLSERVER_LEGACY_COMPATIBILITY_DRIVER_KEY);
  }

  async function setDefaultDatabase(connectionId: string, database: string) {
    const config = getConfig(connectionId);
    if (config?.db_type === "cloudflare-d1") return;
    if (!config || config.database === database) return;
    await updateConnection({
      ...config,
      database,
    });
  }

  async function clearDefaultDatabase(connectionId: string) {
    const config = getConfig(connectionId);
    if (config?.db_type === "cloudflare-d1") return;
    if (!config || !config.database) return;
    await updateConnection({
      ...config,
      database: undefined,
    });
  }

  function isDefaultDatabase(connectionId: string, database: string): boolean {
    const config = getConfig(connectionId);
    if (config?.db_type === "cloudflare-d1") return database === "main";
    return config?.database === database && database !== "";
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

  async function ensureVisibleDatabase(connectionId: string, databaseName: string) {
    const config = getConfig(connectionId);
    if (!config) return;
    const visibleDatabases = appendVisibleDatabaseSelection(config.visible_databases, databaseName);
    if (visibleDatabases === config.visible_databases) return;
    await updateVisibleDatabasesConfig(connectionId, visibleDatabases);
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

  async function setVisibleSchemas(connectionId: string, database: string, schemaNames: string[]) {
    const config = getConfig(connectionId);
    if (!config) return;
    const key = database || "";
    await updateVisibleSchemasConfig(connectionId, key, schemaNames);
    await reloadSchemaChildren(connectionId, database);
  }

  async function clearVisibleSchemas(connectionId: string, database: string) {
    const config = getConfig(connectionId);
    if (!config || !config.visible_schemas) return;
    const key = database || "";
    await updateVisibleSchemasConfig(connectionId, key, undefined);
    await reloadSchemaChildren(connectionId, database);
  }

  async function updateVisibleSchemasConfig(connectionId: string, database: string, schemaNames: string[] | undefined) {
    const idx = connections.value.findIndex((connection) => connection.id === connectionId);
    if (idx < 0) return;
    const existing = connections.value[idx].visible_schemas;
    let nextSchemas: Record<string, string[]> | undefined;
    if (schemaNames) {
      nextSchemas = { ...existing, [database]: schemaNames };
    } else if (existing) {
      nextSchemas = { ...existing };
      delete nextSchemas[database];
      if (Object.keys(nextSchemas).length === 0) nextSchemas = undefined;
    }
    const nextConnections = [...connections.value];
    nextConnections[idx] = {
      ...nextConnections[idx],
      visible_schemas: nextSchemas,
    };
    await persistConnections(nextConnections);
    connections.value = nextConnections;
    rebuildTreeNodes();
  }

  async function reloadSchemaChildren(connectionId: string, database?: string) {
    const config = getConfig(connectionId);
    if (!config) return;
    const db = database || config.database || "";
    clearLoadedChildrenCache(connectionId);
    clearLoadedChildrenCache(`${connectionId}:${db}`);
    await loadDatabases(connectionId, { force: true });
    // After saving schema filter, force-refresh database node's schema children
    // to avoid stale children from previously expanded nodes
    if (db) {
      const dbNode = findNode(treeNodes.value, `${connectionId}:${db}`);
      if (dbNode) {
        await loadTreeNodeChildren(dbNode, { force: true });
      }
    }
  }

  async function reloadConnectionDatabaseChildren(connectionId: string) {
    const config = getConfig(connectionId);
    if (!config) return;
    clearLoadedChildrenCache(connectionId);
    if (config.db_type === "redis") {
      await loadRedisDatabases(connectionId);
    } else if (config.db_type === "etcd") {
      await loadEtcdRoot(connectionId);
    } else if (config.db_type === "zookeeper") {
      await loadZooKeeperRoot(connectionId);
    } else if (config.db_type === "mongodb") {
      await loadMongoDatabases(connectionId);
    } else if (config.db_type === "elasticsearch") {
      await loadElasticsearchIndices(connectionId);
    } else if (config.db_type === "milvus") {
      await loadMilvusDatabases(connectionId);
    } else if (config.db_type === "qdrant" || config.db_type === "weaviate" || config.db_type === "chromadb") {
      await loadVectorCollections(connectionId);
    } else if (config.db_type === "mq") {
      await loadMqTenants(connectionId, { force: true });
    } else if (config.db_type === "nacos") {
      await loadNacosNamespaces(connectionId, { force: true });
    } else {
      await loadDatabases(connectionId, { force: true });
    }
  }

  async function connect(config: ConnectionConfig) {
    config = normalizeConnection(config);
    if (getBlockingDisconnectInFlight(config.id)) await waitForBlockingDisconnectInFlight(config.id);
    const localAttempt = beginLocalConnectionAttempt(config.id);
    try {
      await beforeConnectHandler?.(config);
      await ensureSqlServerLegacyCompatibilityComponentInstalled(config);
      ensureLocalConnectionAttemptActive(config.id, localAttempt);
      const id = await withConnectionAttemptTimeout(api.connectDb(config, localAttempt), config);
      await ensureLocalConnectionAttemptActiveAfterConnectResult(config.id, localAttempt, id);
      await syncMongoLegacyDriverFallback(id, config);
      await ensureLocalConnectionAttemptActiveAfterConnectResult(config.id, localAttempt, id);
      activeConnectionId.value = id;
      connectedIds.value.add(id);
      void refreshConnectedDatabaseInfo(id, { ...config, id });
      await refreshConnectionIdentifierQuote(id, { ...config, id });
      if (id !== config.id) markSuccessfulLocalConnectionAttempt(config.id, localAttempt);
      markSuccessfulLocalConnectionAttempt(id, localAttempt);
      markConnectionHealthChecked(id);
      clearConnectionError(config.id);
      if (id !== config.id) clearConnectionError(id);

      const existing = findConnectionNode(id);
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
      if (isCancelledLocalConnectionAttempt(config.id, localAttempt)) {
        clearConnectionError(config.id);
        throw new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
      }
      if (isCancelledConnectionAttempt(e) || isSupersededConnectionAttempt(e)) {
        clearConnectionError(config.id);
      } else {
        recordConnectionError(config.id, e);
      }
      throw e;
    } finally {
      finishLocalConnectionAttempt(config.id, localAttempt);
    }
  }

  async function cancelConnecting(connectionId: string): Promise<boolean> {
    const localAttempt = getLocalConnectionAttempt(connectionId);
    if (localAttempt == null) return false;
    const disconnectRequest = startCancelDisconnectRequest(connectionId, localAttempt);
    const cancelled = cancelLocalConnectionAttempt(connectionId);
    if (!cancelled) return false;
    clearConnectionError(connectionId);
    connectedIds.value.delete(connectionId);
    clearConnectionIdentifierQuote(connectionId);
    clearConnectionHealthCheck(connectionId);
    if (activeConnectionId.value === connectionId) activeConnectionId.value = null;
    invalidateCompletionCache(connectionId);
    await disconnectRequest;
    return true;
  }

  async function disconnect(connectionId: string) {
    const stateRevision = bumpConnectionStateRevision(connectionId);
    const disconnectRequest = startDisconnectRequest(connectionId);
    cancelLocalConnectionAttempt(connectionId);
    const shouldRemoveOneTimeConnection = getConfig(connectionId)?.one_time === true;

    connectedIds.value.delete(connectionId);
    clearConnectionIdentifierQuote(connectionId);
    forgetSuccessfulLocalConnectionAttempt(connectionId);
    clearConnectionHealthCheck(connectionId);
    const node = findConnectionNode(connectionId);
    if (node) {
      node.isLoading = false;
      node.isExpanded = false;
      node.children = [];
    }
    clearConnectionRootMetadataLoad(connectionId);
    clearLoadedChildrenCache(connectionId);
    if (activeConnectionId.value === connectionId) {
      activeConnectionId.value = null;
    }
    invalidateCompletionCache(connectionId);
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
        queryStore.rollbackConnectionTransactions(connectionId);
        break;
    }
    await disconnectRequest;
    if (isCurrentConnectionStateRevision(connectionId, stateRevision)) {
      clearConnectionError(connectionId);
    }
    if (shouldRemoveOneTimeConnection && isCurrentConnectionStateRevision(connectionId, stateRevision)) {
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
        queryStore.rollbackDatabaseTransactions(connectionId, database);
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
    if (connectedIds.value.has(connectionId)) {
      if (hasRecentConnectionHealthCheck(connectionId)) return;
      // Optimistic: verify backend pool is actually healthy
      try {
        await withConnectionHealthTimeout(connectionId, api.checkConnectionHealth(connectionId));
        markConnectionHealthChecked(connectionId);
        return;
      } catch {
        // Backend pool is dead — remove from connectedIds and reconnect
        connectedIds.value.delete(connectionId);
        clearConnectionHealthCheck(connectionId);
        if (activeConnectionId.value === connectionId) activeConnectionId.value = null;
      }
    }
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
    if (getBlockingDisconnectInFlight(connectionId)) await waitForBlockingDisconnectInFlight(connectionId);
    const existingConnect = connectInFlight.get(connectionId);
    if (existingConnect) {
      await existingConnect;
      return;
    }
    const localAttempt = beginLocalConnectionAttempt(connectionId);
    const connectPromise = (async () => {
      await beforeConnectHandler?.(config);
      ensureLocalConnectionAttemptActive(connectionId, localAttempt);
      const id = await withConnectionAttemptTimeout(api.connectDb(config, localAttempt), config);
      await ensureLocalConnectionAttemptActiveAfterConnectResult(connectionId, localAttempt, id);
      await syncMongoLegacyDriverFallback(connectionId, config);
      await ensureLocalConnectionAttemptActiveAfterConnectResult(connectionId, localAttempt, id);
      connectedIds.value.add(connectionId);
      void refreshConnectedDatabaseInfo(connectionId, config);
      await refreshConnectionIdentifierQuote(connectionId, config);
      markSuccessfulLocalConnectionAttempt(connectionId, localAttempt);
      markConnectionHealthChecked(connectionId);
      activeConnectionId.value = connectionId;
      clearConnectionError(connectionId);
    })();
    connectInFlight.set(connectionId, connectPromise);
    try {
      await connectPromise;
    } catch (e) {
      if (isCancelledLocalConnectionAttempt(connectionId, localAttempt)) {
        clearConnectionError(connectionId);
        throw new Error(CONNECTION_ATTEMPT_CANCELLED_MESSAGE);
      }
      if (isCancelledConnectionAttempt(e)) {
        clearConnectionError(connectionId);
        throw e;
      }
      if (isSupersededConnectionAttempt(e) && connectedIds.value.has(connectionId)) {
        clearConnectionError(connectionId);
        return;
      }
      recordConnectionError(connectionId, e);
      clearConnectionNodeLoading(connectionId);
      throw e;
    } finally {
      if (connectInFlight.get(connectionId) === connectPromise) {
        connectInFlight.delete(connectionId);
      }
      finishLocalConnectionAttempt(connectionId, localAttempt);
    }
  }

  function setBeforeConnectHandler(handler: BeforeConnectHandler | null) {
    beforeConnectHandler = handler;
  }

  async function loadDatabases(connectionId: string, options?: LoadTreeOptions) {
    const configForScope = getConfig(connectionId);
    return runTreeMetadataLoad(
      {
        kind: "connection-databases",
        connectionId,
        driverProfile: metadataDriverProfile(configForScope),
      },
      async () => {
        const node = findConnectionNode(connectionId);
        if (!node) return;
        node.isLoading = true;
        try {
          if (options?.connectedOnly) {
            if (!connectedIds.value.has(connectionId)) return;
          } else {
            await ensureConnected(connectionId);
          }
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
            const [databases, schemas] = await Promise.all([withMetadataLoadTimeout(connectionId, api.listDatabases(connectionId), "databases"), withMetadataLoadTimeout(connectionId, api.listSchemas(connectionId, "main"), "schemas")]);
            const children = withSavedSqlRoot(connectionId, buildDuckDbConnectionTreeNodes(connectionId, databases, schemas), node);
            if (isSidebarSearchQueryChanged(options)) return;
            if (!canApplyTreeMetadataResult(node)) return;
            setChildren(node, children);
            await savePersistedConnectionTreeChildren(cacheKey, node.children || children);
          } else if (config && connectionUsesVisibleSchemaFilter(config)) {
            const schemaFilterConfig = config;
            const effectiveDb = schemaFilterConfig.database || "";
            const cacheKey = schemaCacheKey(connectionId, effectiveDb, "schemas");
            if (!options?.force) {
              const cached = await loadPersistedTreeChildren(node, cacheKey);
              if (cached.hit) {
                if (cached.isStale) refreshStaleTreeNode(node);
                return;
              }
            }
            const schemas = await withMetadataLoadTimeout(connectionId, api.listSchemas(connectionId, effectiveDb, true), "schemas");
            const visibleSchemas = filterSchemaNamesForConnection(schemas, schemaFilterConfig, effectiveDb || "");
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
            if (isSidebarSearchQueryChanged(options)) return;
            if (!canApplyTreeMetadataResult(node)) return;
            setChildren(node, withSavedSqlRoot(connectionId, schemaNodes, node));
            await savePersistedConnectionTreeChildren(cacheKey, node.children || schemaNodes);
          } else {
            // Doris / StarRocks multi-catalog: when external catalogs exist,
            // render a catalog grouping layer (catalog → database → tables).
            // When only `internal` is present, fall through to the flat database
            // list (no regression for single-catalog deployments).
            let dorisCatalogs: CatalogInfo[] | null = null;
            if (connectionIsDorisFamilyCatalogCapable(config)) {
              dorisCatalogs = await withMetadataLoadTimeout(connectionId, api.listDorisCatalogs(connectionId), "catalogs").catch((error: unknown) => {
                recordMetadataLoadError(connectionId, error);
                return null;
              });
            }
            if (dorisCatalogs && dorisCatalogs.length > 1) {
              const cacheKey = schemaCacheKey(connectionId, "doris-catalogs");
              if (!options?.force) {
                const cached = await loadPersistedTreeChildren(node, cacheKey);
                if (cached.hit) {
                  if (cached.isStale) refreshStaleTreeNode(node);
                  return;
                }
              }
              const catalogNodes: TreeNode[] = dorisCatalogs.map((catalog) => ({
                id: dorisCatalogId(connectionId, catalog.name),
                label: catalog.name,
                type: "doris-catalog" as const,
                connectionId,
                catalog: catalog.name,
                catalogType: catalog.catalog_type,
                comment: catalog.comment ?? null,
                isExpanded: false,
                children: [],
              }));
              const children = withSavedSqlRoot(connectionId, catalogNodes, node);
              if (isSidebarSearchQueryChanged(options)) return;
              if (!canApplyTreeMetadataResult(node)) return;
              setChildren(node, children);
              await savePersistedConnectionTreeChildren(cacheKey, node.children || children);
            } else {
              const cacheKey = schemaCacheKey(connectionId, "databases-v2");
              if (!options?.force) {
                const cached = await loadPersistedTreeChildren(node, cacheKey);
                if (cached.hit) {
                  if (cached.isStale) refreshStaleTreeNode(node);
                  return;
                }
              }
              const databases = await withMetadataLoadTimeout(connectionId, api.listDatabases(connectionId), "databases");
              const visibleNames = filterDatabaseNamesForConnection(
                databases.map((database) => database.name),
                config,
              );
              const visibleNameSet = new Set(visibleNames);
              const visibleDatabases = databases.filter((database) => visibleNameSet.has(database.name));
              const effectiveDbType = effectiveDatabaseTypeForConnection(config);
              const databaseNodes = buildDatabaseTreeNodes(connectionId, visibleDatabases, {
                includeDefaultWhenEmpty: usesTreeSchemaMode(effectiveDbType) || shouldIncludeDefaultDatabaseNode(config, visibleDatabases),
              });
              if (config?.db_type === "sqlserver") {
                const linkedServers = await withMetadataLoadTimeout(connectionId, api.listSqlServerLinkedServers(connectionId), "linked servers").catch(() => []);
                const linkedDatabase = sqlServerLinkedRuntimeDatabase(config);
                databaseNodes.push({
                  ...sqlServerLinkedRootNode(connectionId, linkedDatabase),
                  children: linkedServers.map((server) => ({
                    id: sqlServerLinkedServerId(connectionId, server.name),
                    label: server.name,
                    type: "linked-server",
                    connectionId,
                    database: linkedDatabase,
                    linkedServer: server.name,
                    comment: [server.product, server.provider, server.data_source].filter(Boolean).join(" / ") || null,
                    isExpanded: false,
                    children: [],
                  })),
                });
                if (linkedServers.length > 0) loadedTreeNodeChildrenIds.value.add(sqlServerLinkedRootId(connectionId));
              }
              const children = withSavedSqlRoot(connectionId, databaseNodes, node);
              if (isSidebarSearchQueryChanged(options)) return;
              if (!canApplyTreeMetadataResult(node)) return;
              setChildren(node, children);
              await savePersistedConnectionTreeChildren(cacheKey, node.children || children);
            }
          }
          node.isExpanded = true;
        } catch (e) {
          recordMetadataLoadError(connectionId, e);
          throw e;
        } finally {
          node.isLoading = false;
        }
      },
      options,
    );
  }

  async function loadConnectedConnectionRootForSidebarSearch(connectionId: string) {
    if (!connectedIds.value.has(connectionId)) return;
    const config = getConfig(connectionId);
    if (!config || ["redis", "etcd", "zookeeper", "mongodb", "elasticsearch", "milvus", "qdrant", "weaviate", "chromadb", "mq", "nacos"].includes(config.db_type)) return;
    const node = findConnectionNode(connectionId);
    if (!node || node.type !== "connection" || node.isLoading || hasConnectionMetadataChildren(node.children)) return;
    const scope = { kind: "connection-databases" as const, connectionId, driverProfile: metadataDriverProfile(config) };
    if (metadataLoadCoordinator.has(scope)) return;

    const wasExpanded = !!node.isExpanded;
    node.isLoading = true;
    try {
      await loadDatabases(connectionId, { connectedOnly: true });
    } finally {
      node.isExpanded = wasExpanded;
      node.isLoading = false;
    }
  }

  async function loadRedisDatabases(connectionId: string) {
    const node = findConnectionNode(connectionId);
    if (!node) return;

    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      const dbs = await withMetadataLoadTimeout(connectionId, api.redisListDatabases(connectionId), "Redis databases");
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
    const node = findConnectionNode(connectionId);
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
              label: kvRootNodeLabel("etcd"),
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

  async function loadZooKeeperRoot(connectionId: string) {
    const node = findConnectionNode(connectionId);
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
              id: `${connectionId}:zookeeper`,
              label: kvRootNodeLabel("zookeeper"),
              type: "zookeeper-root" as const,
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
    const node = findConnectionNode(connectionId);
    if (!node) return;

    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      if (useCachedChildren(node, options)) return;

      const config = getConfig(connectionId);
      if (isKafkaMqConnection(config)) {
        // Kafka has no tenant/namespace concept. Create a synthetic child
        // that opens the MQ admin console directly when clicked.
        setChildren(node, [
          {
            id: schemaCacheKey(connectionId, "mq-tenant", "_kafka"),
            label: "Topics",
            type: "mq-tenant" as const,
            connectionId,
            mqTenant: "_kafka",
            mqInitialTab: "topics",
          },
        ]);
      } else {
        const tenants = await withMetadataLoadTimeout(connectionId, api.mqListTenants(connectionId), "message queue tenants");
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
      }
      node.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e);
      throw e;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadNacosNamespaces(connectionId: string, options?: LoadTreeOptions) {
    const node = findConnectionNode(connectionId);
    if (!node) return;

    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      if (useCachedChildren(node, options)) return;

      const namespaces = await api.nacosListNamespaces(connectionId);
      const sorted = [...namespaces].sort((left, right) => {
        const leftLabel = left.namespaceShowName || left.namespace || "public";
        const rightLabel = right.namespaceShowName || right.namespace || "public";
        return leftLabel.localeCompare(rightLabel);
      });
      setChildren(
        node,
        sorted.map((namespace) => {
          const value = namespace.namespace || "";
          const label = namespace.namespaceShowName || value || "public";
          return {
            id: schemaCacheKey(connectionId, "nacos-namespace", value || "public"),
            label,
            type: "nacos-namespace" as const,
            connectionId,
            nacosNamespace: value,
            nacosNamespaceName: label,
            comment: namespace.namespaceDesc || null,
            objectCount: namespace.configCount,
          };
        }),
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
    const connNode = findConnectionNode(connectionId);
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
    const node = findConnectionNode(connectionId);
    if (!node) return;

    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      const dbs = await withMetadataLoadTimeout(connectionId, api.mongoListDatabases(connectionId), "MongoDB databases");
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
    const node = findConnectionNode(connectionId);
    if (!node) return;

    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      const indices = await withMetadataLoadTimeout(connectionId, api.elasticsearchListIndices(connectionId), "Elasticsearch indices");
      setChildren(
        node,
        withSavedSqlRoot(
          connectionId,
          sortSidebarNames(indices).map((index) => ({
            id: `${connectionId}:__collection:${index}`,
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

  async function loadMilvusDatabases(connectionId: string) {
    const node = findConnectionNode(connectionId);
    if (!node) return;

    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      const dbs = await withMetadataLoadTimeout(connectionId, api.documentListDatabases(connectionId), "Milvus databases");
      setChildren(
        node,
        withSavedSqlRoot(
          connectionId,
          sortSidebarNames(dbs).map((db) => ({
            id: `${connectionId}:${db}`,
            label: db,
            type: "vector-database" as const,
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

  async function loadVectorCollections(connectionId: string, database?: string) {
    const config = getConfig(connectionId);
    const isMilvus = config?.db_type === "milvus";
    const effectiveDb = database || config?.database || "default";
    // Milvus groups collections under a per-database node; other vector stores stay flat under the connection.
    const node = isMilvus && database ? findNode(treeNodes.value, `${connectionId}:${database}`) : findConnectionNode(connectionId);
    if (!node) return;

    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      const collections = await withMetadataLoadTimeout(connectionId, api.vectorListCollections(connectionId, effectiveDb), "vector collections");
      const sorted = [...collections].sort((a, b) => a.name.localeCompare(b.name));
      const collectionChildren = sorted.map((info) => ({
        // Include the database for Milvus so same-named collections across databases don't collide.
        id: `${connectionId}:__vector_collection:${isMilvus ? `${effectiveDb}:${info.id}` : info.id}`,
        label: info.name,
        type: "vector-collection" as const,
        connectionId,
        database: effectiveDb,
        isExpanded: false,
        meta: { dimension: info.dimension, collectionId: info.id } as VectorCollectionMeta,
      }));
      setChildren(node, isMilvus && database ? collectionChildren : withSavedSqlRoot(connectionId, collectionChildren, node));
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
      const bucketNames = new Set(collections.filter((c) => c.kind === "bucket" && c.bucketName).map((c) => c.bucketName as string));
      const hiddenCollectionNames = new Set([...bucketNames].flatMap((bucketName) => [`${bucketName}.files`, `${bucketName}.chunks`]));
      const collectionNames = collections
        .filter((c) => c.kind !== "bucket")
        .map((c) => c.name)
        .filter((name) => !hiddenCollectionNames.has(name));
      const collectionChildren = sortSidebarNames(collectionNames).map((col) => ({
        id: `${nodeId}:${col}`,
        label: col,
        type: "mongo-collection" as const,
        connectionId,
        database,
        isExpanded: false,
      }));
      const children = [
        {
          id: `${nodeId}:__gridfs`,
          label: i18n.global.t("tree.gridfs"),
          type: "mongo-gridfs" as const,
          connectionId,
          database,
          isExpanded: false,
        },
        ...collectionChildren,
      ];
      setChildren(node, children);
      node.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e);
      throw e;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadSchemas(connectionId: string, database: string, options?: LoadTreeOptions) {
    const configForScope = getConfig(connectionId);
    return runTreeMetadataLoad(
      {
        kind: "database-schemas",
        connectionId,
        database,
        driverProfile: metadataDriverProfile(configForScope),
      },
      async () => {
        const nodeId = `${connectionId}:${database}`;
        const node = findNode(treeNodes.value, nodeId);
        if (!node) return;
        node.isLoading = true;
        try {
          await ensureConnected(connectionId);
          if (useCachedChildren(node, options)) return;
          const cacheKey = schemaCacheKey(connectionId, database, "schemas-v2");
          if (!options?.force) {
            const cached = await loadPersistedTreeChildren(node, cacheKey);
            if (cached.hit) {
              if (cached.isStale) refreshStaleTreeNode(node);
              return;
            }
          }

          const schemas = sortSidebarSchemaInfos(await withMetadataLoadTimeout(connectionId, api.listSchemaInfos(connectionId, database), "schemas"));
          const visibleSchemaNames = new Set(
            filterSchemaNamesForConnection(
              schemas.map((schema) => schema.name),
              getConfig(connectionId),
              database,
            ),
          );
          const children = schemas
            .filter((schema) => visibleSchemaNames.has(schema.name))
            .map((schema) => {
              const s = schema.name;
              return {
                id: `${connectionId}:${database}:${s}`,
                label: s,
                type: "schema" as const,
                connectionId,
                database,
                schema: s,
                comment: schema.comment,
                isExpanded: false,
                children: [],
              };
            });
          if (isSidebarSearchQueryChanged(options)) return;
          if (!canApplyTreeMetadataResult(node)) return;
          setChildren(node, children);
          await savePersistedTreeChildren(cacheKey, children);
          node.isExpanded = true;
        } catch (e) {
          recordMetadataLoadError(connectionId, e);
          throw e;
        } finally {
          node.isLoading = false;
        }
      },
      options,
    );
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
      const cacheKey = schemaCacheKey(connectionId, database, simpleObjectDisplay ? "sqlserver-schemas-simple-v4" : "sqlserver-schemas-grouped-v4");
      if (!options?.force) {
        const cached = await loadPersistedTreeChildren(node, cacheKey);
        if (cached.hit) {
          if (cached.isStale) refreshStaleTreeNode(node);
          return;
        }
      }

      const config = getConfig(connectionId);
      const schemas = filterSchemaNamesForConnection(await api.listSchemas(connectionId, database), config, database);
      const children = buildSqlServerDatabaseTreeNodes(connectionId, database, schemas);
      if (isSidebarSearchQueryChanged(options)) return;
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

  async function loadSqlServerLinkedServers(connectionId: string, options?: LoadTreeOptions) {
    const node = findNode(treeNodes.value, sqlServerLinkedRootId(connectionId));
    if (!node) return;
    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      if (useCachedChildren(node, options)) return;
      const config = getConfig(connectionId);
      const database = sqlServerLinkedRuntimeDatabase(config);
      const linkedServers = await api.listSqlServerLinkedServers(connectionId);
      setChildren(
        node,
        linkedServers.map((server) => ({
          id: sqlServerLinkedServerId(connectionId, server.name),
          label: server.name,
          type: "linked-server" as const,
          connectionId,
          database,
          linkedServer: server.name,
          comment: [server.product, server.provider, server.data_source].filter(Boolean).join(" / ") || null,
          isExpanded: false,
          children: [],
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

  async function loadSqlServerLinkedServerCatalogs(node: TreeNode, options?: LoadTreeOptions) {
    if (!node.connectionId || !node.linkedServer) return;
    const connectionId = node.connectionId;
    const server = node.linkedServer;
    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      if (useCachedChildren(node, options)) return;
      const catalogs = await api.listSqlServerLinkedServerCatalogs(connectionId, server);
      const database = node.database || sqlServerLinkedRuntimeDatabase(getConfig(connectionId));
      setChildren(
        node,
        catalogs
          .filter((catalog) => catalog.name.trim())
          .map((catalog) => ({
            id: sqlServerLinkedCatalogId(connectionId, server, catalog.name),
            label: catalog.name,
            type: "linked-server-catalog" as const,
            connectionId,
            database,
            linkedServer: server,
            linkedCatalog: catalog.name,
            isExpanded: false,
            children: [],
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

  async function loadSqlServerLinkedServerSchemas(node: TreeNode, options?: LoadTreeOptions) {
    if (!node.connectionId || !node.linkedServer || !node.linkedCatalog) return;
    node.isLoading = true;
    try {
      await ensureConnected(node.connectionId);
      if (useCachedChildren(node, options)) return;
      const schemas = await api.listSqlServerLinkedServerSchemas(node.connectionId, node.linkedServer, node.linkedCatalog);
      const database = node.database || sqlServerLinkedRuntimeDatabase(getConfig(node.connectionId));
      setChildren(
        node,
        sortSidebarNames(schemas)
          .filter((schema) => schema.trim())
          .map((schema) => {
            const encodedSchema = encodeSqlServerLinkedSchema({
              server: node.linkedServer!,
              catalog: node.linkedCatalog!,
              schema,
            });
            return {
              id: `${node.connectionId}:${database}:${encodedSchema}`,
              label: schema,
              type: "linked-server-schema" as const,
              connectionId: node.connectionId,
              database,
              schema: encodedSchema,
              linkedServer: node.linkedServer,
              linkedCatalog: node.linkedCatalog,
              linkedSchema: schema,
              isExpanded: false,
              children: [],
            };
          }),
      );
      node.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(node.connectionId, e);
      throw e;
    } finally {
      node.isLoading = false;
    }
  }

  // Doris / StarRocks multi-catalog: load the databases under a catalog node.
  async function loadDorisCatalogDatabases(node: TreeNode, options?: LoadTreeOptions) {
    if (!node.connectionId || !node.catalog) return;
    const connectionId = node.connectionId;
    const catalog = node.catalog;
    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      if (useCachedChildren(node, options)) return;
      const config = getConfig(connectionId);
      const databases = await withMetadataLoadTimeout(connectionId, api.listDorisCatalogDatabases(connectionId, catalog), "databases");
      let databaseNodes: TreeNode[];
      if (isInternalDorisCatalog(node.catalogType, catalog)) {
        // The internal catalog's databases are rendered as standard database
        // nodes so they reuse the existing table-loading / table-open paths.
        // Detection is type-based (catalogType=`internal`), so StarRocks
        // `default_catalog` routes here too — its tables carry no catalog.
        const visibleNames = filterDatabaseNamesForConnection(
          databases.map((database) => database.name),
          config,
        );
        const visibleNameSet = new Set(visibleNames);
        const visibleDatabases = databases.filter((database) => visibleNameSet.has(database.name));
        databaseNodes = buildDatabaseTreeNodes(connectionId, visibleDatabases, { includeDefaultWhenEmpty: false });
      } else {
        databaseNodes = sortSidebarDatabases(databases).flatMap((database) => {
          const name = database.name.trim();
          if (!name) return [];
          return [
            {
              id: dorisCatalogDatabaseId(connectionId, catalog, name),
              label: name,
              type: "database" as const,
              connectionId,
              database: name,
              catalog,
              isExpanded: false,
              children: [],
            },
          ];
        });
      }
      if (isSidebarSearchQueryChanged(options)) return;
      if (!canApplyTreeMetadataResult(node)) return;
      setChildren(node, databaseNodes);
      node.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e);
      throw e;
    } finally {
      node.isLoading = false;
    }
  }

  // Doris / StarRocks multi-catalog: load tables under an external-catalog
  // database node. External catalogs only expose tables/views, so a flat list
  // (no routines/sequences/triggers) is rendered.
  async function loadDorisCatalogTables(node: TreeNode, options?: LoadTreeOptions) {
    if (!node.connectionId || !node.database || !node.catalog) return;
    const connectionId = node.connectionId;
    const { database, catalog } = node;
    const configForScope = getConfig(connectionId);
    const simpleObjectDisplayForScope = useSettingsStore().editorSettings.sidebarObjectDisplay === "simple";
    const objectTypesForScope = simpleObjectDisplayForScope ? supportedSidebarObjectTypes(configForScope) : undefined;
    return runTreeMetadataLoad(
      {
        kind: "schema-tables",
        connectionId,
        database,
        schema: undefined,
        nodeKind: "database",
        objectTypes: objectTypesForScope,
        searchFilter: activeTreeLoadSearchFilter(options),
        limit: simpleObjectDisplayForScope ? sidebarObjectGroupPageSize() + 1 : undefined,
        offset: 0,
        sidebarDisplayMode: simpleObjectDisplayForScope ? "simple" : "grouped",
        driverProfile: metadataDriverProfile(configForScope),
        extra: options?.sidebarTableSearchParentId ? { sidebarTableSearchParentId: options.sidebarTableSearchParentId } : undefined,
      },
      async () => {
        node.isLoading = true;
        try {
          await ensureConnected(connectionId);
          if (useCachedChildren(node, options)) return;
          const searchFilter = activeTreeLoadSearchFilter(options);
          const cacheKey = schemaCacheKey(connectionId, `doris-catalog:${catalog}`, database, "objects-simple-v4");
          if (!options?.force && !searchFilter) {
            const cached = await loadPersistedTreeChildren(node, cacheKey);
            if (cached.hit) {
              if (cached.isStale) refreshStaleTreeNode(node);
              return;
            }
          }
          const pageSize = sidebarObjectGroupPageSize();
          const fetchLimit = searchFilter ? pageSize : pageSize + 1;
          const fetchOffset = searchFilter ? undefined : 0;
          const tables = await withMetadataLoadTimeout(connectionId, api.listTables(connectionId, database, "", searchFilter, fetchLimit, fetchOffset, objectTypesForScope, catalog), "tables");
          const hasMore = searchFilter ? false : tables.length > pageSize;
          const pageTables = hasMore ? tables.slice(0, pageSize) : tables;
          indexCompletionTables(connectionId, database, undefined, tableInfosToCompletionTables(pageTables, undefined));
          let children = buildTableTreeNodes({
            nodeId: node.id,
            connectionId,
            database,
            schema: undefined,
            tables: pageTables,
            catalog,
          });
          if (hasMore && !searchFilter) {
            children = [...children, buildLoadMoreNode(node, pageSize, pageSize)];
          }
          if (isTreeLoadSearchChanged(searchFilter, options)) return;
          if (!canApplyTreeMetadataResult(node)) return;
          node.objectCount = children.filter((child) => child.type !== "load-more").length;
          setChildren(node, children);
          if (!searchFilter && !options?.sidebarTableSearchParentId) {
            await savePersistedTreeChildren(cacheKey, children);
          }
          node.isExpanded = true;
        } catch (e) {
          recordMetadataLoadError(connectionId, e);
          throw e;
        } finally {
          node.isLoading = false;
        }
      },
      options,
    );
  }

  async function loadTables(connectionId: string, database: string, schema?: string, options?: LoadTreeOptions) {
    const configForScope = getConfig(connectionId);
    const simpleObjectDisplayForScope = useSettingsStore().editorSettings.sidebarObjectDisplay === "simple";
    const objectTypesForScope = simpleObjectDisplayForScope ? supportedSidebarObjectTypes(configForScope) : undefined;
    return runTreeMetadataLoad(
      {
        kind: "schema-tables",
        connectionId,
        database,
        schema,
        nodeKind: schema ? "schema" : "database",
        objectTypes: objectTypesForScope,
        searchFilter: activeTreeLoadSearchFilter(options),
        limit: simpleObjectDisplayForScope ? sidebarObjectGroupPageSize() + 1 : undefined,
        offset: 0,
        sidebarDisplayMode: simpleObjectDisplayForScope ? "simple" : "grouped",
        driverProfile: metadataDriverProfile(configForScope),
        extra: options?.sidebarTableSearchParentId ? { sidebarTableSearchParentId: options.sidebarTableSearchParentId } : undefined,
      },
      async () => {
        const nodeId = schema ? `${connectionId}:${database}:${schema}` : `${connectionId}:${database}`;
        const node = findNode(treeNodes.value, nodeId);
        if (!node) return;
        node.isLoading = true;
        try {
          await ensureConnected(connectionId);
          if (useCachedChildren(node, options)) return;
          const simpleObjectDisplay = useSettingsStore().editorSettings.sidebarObjectDisplay === "simple";
          const cacheKey = schemaCacheKey(connectionId, database, schema || "", simpleObjectDisplay ? "objects-simple-v5" : "objects-grouped-v5");
          const searchFilter = activeTreeLoadSearchFilter(options);
          const isSidebarTableSearch = !!options?.sidebarTableSearchParentId;
          if (!options?.force && !searchFilter) {
            const cached = await loadPersistedTreeChildren(node, cacheKey);
            if (cached.hit) {
              if (cached.isStale) refreshStaleTreeNode(node);
              return;
            }
          }

          const config = getConfig(connectionId);
          const querySchema = connectionObjectTreeQuerySchema(config, database, schema);
          const effectiveSchema = connectionObjectTreeNodeSchema(config, database, schema);
          const nonTableObjectTypes = simpleObjectDisplay ? supportedSidebarObjectTypes(config).filter((objectType) => objectType !== "TABLE") : [];
          let children: TreeNode[];
          let nextObjectCount: number | undefined;
          if (simpleObjectDisplay) {
            const pageSize = sidebarObjectGroupPageSize();
            const page = await loadPagedSimpleTableChildren({
              nodeId,
              connectionId,
              database,
              querySchema,
              effectiveSchema,
              nonTableObjectTypes,
              offset: 0,
              pageSize,
              searchFilter: searchFilter || undefined,
              force: options?.force,
            });
            children = page.hasMore && !searchFilter ? appendTableTreeLoadMoreNode(page.children, buildLoadMoreNode(node, page.nextOffset, pageSize), page.loadMoreParent) : page.children;
            nextObjectCount = page.objectCount;
          } else {
            children = buildObjectGroupPlaceholderNodes({
              nodeId,
              connectionId,
              database,
              schema: effectiveSchema,
              objectTypes: supportedSidebarObjectTypes(config),
            });
            if (isPostgresLikeForExtensions(config?.db_type)) {
              children.push({
                id: `${nodeId}:__extensions`,
                label: "tree.extensions",
                type: "group-extensions",
                connectionId,
                database,
                schema: effectiveSchema,
                isExpanded: false,
                children: [],
              });
            }
          }
          if (isTreeLoadSearchChanged(searchFilter, options)) return;
          if (!canApplyTreeMetadataResult(node)) return;
          if (nextObjectCount !== undefined) node.objectCount = nextObjectCount;
          setChildren(node, children);
          if (!searchFilter && !isSidebarTableSearch) {
            await savePersistedTreeChildren(cacheKey, children);
          }
          node.isExpanded = true;
          if (simpleObjectDisplay && !searchFilter && !isSidebarTableSearch && nonTableObjectTypes.length > 0) {
            void loadSimpleSupplementalObjectChildren({
              node,
              nodeId,
              connectionId,
              database,
              querySchema,
              effectiveSchema,
              objectTypes: nonTableObjectTypes,
              cacheKey,
              loadOptions: options,
            });
          }
        } catch (e) {
          recordMetadataLoadError(connectionId, e);
          throw e;
        } finally {
          node.isLoading = false;
        }
      },
      options,
    );
  }

  async function loadObjectGroupChildren(node: TreeNode, options?: LoadTreeOptions) {
    const configForScope = node.connectionId ? getConfig(node.connectionId) : undefined;
    const objectTypesForScope = objectTypesForGroupNode(node.type);
    const pageSizeForScope = sidebarObjectGroupPageSize();
    return runTreeMetadataLoad(
      {
        kind: "object-group",
        connectionId: node.connectionId,
        database: node.database,
        schema: node.schema,
        nodeKind: node.type,
        objectTypes: objectTypesForScope,
        searchFilter: activeTreeLoadSearchFilter(options),
        limit: pageSizeForScope + 1,
        offset: 0,
        sidebarDisplayMode: useSettingsStore().editorSettings.sidebarObjectDisplay,
        driverProfile: metadataDriverProfile(configForScope),
        extra: options?.sidebarTableSearchParentId ? { sidebarTableSearchParentId: options.sidebarTableSearchParentId } : undefined,
      },
      async () => {
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
          const searchFilter = activeTreeLoadSearchFilter(options);
          const isSidebarTableSearch = !!options?.sidebarTableSearchParentId;
          if (!options?.force && !searchFilter) {
            const cached = await loadPersistedTreeChildren(node, cacheKey);
            if (cached.hit) {
              if (cached.isStale) refreshStaleTreeNode(node);
              return;
            }
          }

          const wantsOnlyTablesOrViews = objectTypes.every((objectType) => objectType === "TABLE" || objectType === "VIEW" || objectType === "MATERIALIZED_VIEW");
          let children: TreeNode[];
          let nextObjectCount: number;
          if (wantsOnlyTablesOrViews) {
            const page = await loadPagedTableGroupChildren({
              node,
              parentNodeId,
              querySchema,
              effectiveSchema,
              objectTypes,
              offset: 0,
              pageSize: sidebarObjectGroupPageSize(),
              searchFilter: searchFilter || undefined,
              force: options?.force,
            });
            children = page.hasMore && !searchFilter ? appendTableTreeLoadMoreNode(page.children, buildLoadMoreNode(node, page.nextOffset, sidebarObjectGroupPageSize()), page.loadMoreParent) : page.children;
            nextObjectCount = page.objectCount;
          } else {
            const pageSize = sidebarObjectGroupPageSize();
            const page = await loadPagedObjectGroupChildren({
              node,
              parentNodeId,
              querySchema,
              effectiveSchema,
              objectTypes,
              offset: 0,
              pageSize,
              searchFilter: searchFilter || undefined,
              force: options?.force,
            });
            children = page.hasMore && !searchFilter ? [...page.children, buildLoadMoreNode(node, page.nextOffset, pageSize)] : page.children;
            nextObjectCount = page.objectCount;
          }
          if (isTreeLoadSearchChanged(searchFilter, options)) return;
          if (!canApplyTreeMetadataResult(node)) return;
          node.objectCount = nextObjectCount;
          setChildren(node, children);
          if (!searchFilter && !isSidebarTableSearch) {
            await savePersistedTreeChildren(cacheKey, children);
          }
          node.isExpanded = true;
        } catch (e) {
          recordMetadataLoadError(node.connectionId, e);
          throw e;
        } finally {
          node.isLoading = false;
        }
      },
      options,
    );
  }

  async function loadExtensions(connectionId: string, database: string, schema: string) {
    const node = findNode(treeNodes.value, `${connectionId}:${database}:${schema}:__extensions`);
    if (!node) return;
    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      if (useCachedChildren(node)) return;
      const extensions = await withMetadataLoadTimeout(connectionId, api.listExtensions(connectionId, database, schema), "extensions");
      const children: TreeNode[] = extensions.map((ext) => ({
        id: `${node.id}:${ext.name}`,
        label: ext.name,
        type: "extension" as const,
        connectionId,
        database,
        schema,
        comment: ext.comment ?? null,
        meta: ext,
        isExpanded: false,
      }));
      setChildren(node, children);
      node.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e);
      throw e;
    } finally {
      node.isLoading = false;
    }
  }

  async function loadMoreObjectGroupChildren(node: TreeNode) {
    if (node.type !== "load-more" || !node.loadMore) return;
    const loadMore = node.loadMore;
    const parent = findNode(treeNodes.value, node.loadMore.parentId);
    if (!parent?.connectionId || !hasTreeNodeDatabaseContext(parent)) return;
    const parentConnectionId = parent.connectionId;
    const configForScope = getConfig(parentConnectionId);
    const objectTypesForScope = objectTypesForGroupNode(parent.type);
    return runTreeMetadataLoad(
      {
        kind: "object-group-page",
        connectionId: parentConnectionId,
        database: parent.database,
        schema: parent.schema,
        nodeKind: parent.type,
        objectTypes: objectTypesForScope,
        limit: loadMore.pageSize + 1,
        offset: loadMore.offset,
        sidebarDisplayMode: useSettingsStore().editorSettings.sidebarObjectDisplay,
        driverProfile: metadataDriverProfile(configForScope),
      },
      async () => {
        node.isLoading = true;
        try {
          await ensureConnected(parentConnectionId);
          if (parent.type === "database" || parent.type === "schema" || parent.type === "linked-server-schema") {
            const parentDatabase = parent.database;
            if (!parentDatabase) return;
            const config = getConfig(parentConnectionId);
            const querySchema = connectionObjectTreeQuerySchema(config, parentDatabase, parent.schema);
            const effectiveSchema = connectionObjectTreeNodeSchema(config, parentDatabase, parent.schema);
            const page = await loadPagedSimpleTableChildren({
              nodeId: parent.schema ? `${parentConnectionId}:${parentDatabase}:${parent.schema}` : `${parentConnectionId}:${parentDatabase}`,
              connectionId: parentConnectionId,
              database: parentDatabase,
              querySchema,
              effectiveSchema,
              nonTableObjectTypes: [],
              offset: loadMore.offset,
              pageSize: loadMore.pageSize,
              force: false,
            });
            const currentChildren = withoutTableTreeLoadMoreNodes(parent.children);
            const mergedChildren = mergeTableTreePageChildren(currentChildren, page.children, parentConnectionId, parentDatabase);
            const nextChildren = page.hasMore ? appendTableTreeLoadMoreNode(mergedChildren, buildLoadMoreNode(parent, page.nextOffset, loadMore.pageSize), page.loadMoreParent) : mergedChildren;
            if (!canApplyTreeMetadataResult(parent)) return;
            parent.objectCount = mergedChildren.length;
            setChildren(parent, nextChildren);
            await savePersistedTreeChildren(schemaCacheKey(parentConnectionId, parentDatabase, parent.schema || "", "objects-simple-v5"), nextChildren);
            parent.isExpanded = true;
            return;
          }
          const objectTypes = objectTypesForGroupNode(parent.type);
          const parentNodeId = objectGroupRefreshParentId(parent);
          if (!objectTypes || !parentNodeId) return;

          const config = getConfig(parentConnectionId);
          const parentDatabase = parent.database;
          if (!parentDatabase) return;
          const querySchema = connectionObjectTreeQuerySchema(config, parentDatabase, parent.schema);
          const effectiveSchema = connectionObjectTreeNodeSchema(config, parentDatabase, parent.schema);
          const wantsOnlyTablesOrViews = objectTypes.every((objectType) => objectType === "TABLE" || objectType === "VIEW" || objectType === "MATERIALIZED_VIEW");
          let mergedChildren: TreeNode[];
          let nextChildren: TreeNode[];
          if (wantsOnlyTablesOrViews) {
            const page = await loadPagedTableGroupChildren({
              node: parent,
              parentNodeId,
              querySchema,
              effectiveSchema,
              objectTypes,
              offset: loadMore.offset,
              pageSize: loadMore.pageSize,
              force: false,
            });
            const currentChildren = withoutTableTreeLoadMoreNodes(parent.children);
            mergedChildren = mergeTableTreePageChildren(currentChildren, page.children, parentConnectionId, parentDatabase);
            nextChildren = page.hasMore ? appendTableTreeLoadMoreNode(mergedChildren, buildLoadMoreNode(parent, page.nextOffset, loadMore.pageSize), page.loadMoreParent) : mergedChildren;
          } else {
            const page = await loadPagedObjectGroupChildren({
              node: parent,
              parentNodeId,
              querySchema,
              effectiveSchema,
              objectTypes,
              offset: loadMore.offset,
              pageSize: loadMore.pageSize,
              force: false,
            });
            const currentChildren = withoutLoadMoreNodes(parent.children);
            mergedChildren = mergeLocatedTreeChildren(parent, currentChildren, page.children, parentConnectionId, parentDatabase);
            nextChildren = page.hasMore ? [...mergedChildren, buildLoadMoreNode(parent, page.nextOffset, loadMore.pageSize)] : mergedChildren;
          }
          if (!canApplyTreeMetadataResult(parent)) return;
          parent.objectCount = mergedChildren.length;
          setChildren(parent, nextChildren);
          await savePersistedTreeChildren(objectGroupCacheKey(parent), nextChildren);
          parent.isExpanded = true;
        } catch (e) {
          recordMetadataLoadError(parentConnectionId, e);
          throw e;
        } finally {
          node.isLoading = false;
        }
      },
    );
  }

  async function loadTableForLocate(target: LocateTableTarget): Promise<boolean> {
    const config = getConfig(target.connectionId);
    if (!config) return false;
    return runTreeMetadataLoad(
      {
        kind: "locate-target",
        connectionId: target.connectionId,
        database: target.database,
        schema: target.schema,
        tableName: target.tableName,
        searchFilter: target.tableName,
        limit: sidebarObjectGroupPageSize() + 1,
        offset: 0,
        sidebarDisplayMode: useSettingsStore().editorSettings.sidebarObjectDisplay,
        driverProfile: metadataDriverProfile(config),
      },
      async () => {
        await ensureConnected(target.connectionId);

        const querySchema = connectionObjectTreeQuerySchema(config, target.database, target.schema);
        const effectiveSchema = connectionObjectTreeNodeSchema(config, target.database, target.schema);
        const pageSize = sidebarObjectGroupPageSize();
        const simpleObjectDisplay = useSettingsStore().editorSettings.sidebarObjectDisplay === "simple";
        let loaded = false;

        if (simpleObjectDisplay) {
          const parentId = target.schema ? `${target.connectionId}:${target.database}:${target.schema}` : `${target.connectionId}:${target.database}`;
          const parent = findNode(treeNodes.value, parentId);
          if (!parent) return false;
          const page = await loadPagedSimpleTableChildren({
            nodeId: parentId,
            connectionId: target.connectionId,
            database: target.database,
            querySchema,
            effectiveSchema,
            nonTableObjectTypes: [],
            offset: 0,
            pageSize,
            searchFilter: target.tableName,
            force: false,
          });
          if (!page.children.length) return false;
          const currentChildren = withoutLoadMoreNodes(parent.children);
          const loadMoreNodes = (parent.children || []).filter((child) => child.type === "load-more");
          const mergedChildren = mergeLocatedTreeChildren(parent, currentChildren, page.children, target.connectionId, target.database);
          if (!canApplyTreeMetadataResult(parent)) return false;
          setChildren(parent, [...mergedChildren, ...loadMoreNodes]);
          parent.objectCount = Math.max(parent.objectCount ?? currentChildren.length, mergedChildren.length);
          parent.isExpanded = true;
          return true;
        }

        const matchingGroups = findTreeNodes(treeNodes.value, (node) => {
          return (node.type === "group-tables" || node.type === "group-views" || node.type === "group-materialized-views") && node.connectionId === target.connectionId && sameSidebarObjectName(node.database, target.database) && (!target.schema || sameSidebarObjectName(node.schema, target.schema));
        });

        for (const group of matchingGroups) {
          const objectTypes = objectTypesForGroupNode(group.type);
          const parentNodeId = objectGroupRefreshParentId(group);
          if (!objectTypes || !parentNodeId) continue;

          const page = await loadPagedTableGroupChildren({
            node: group,
            parentNodeId,
            querySchema,
            effectiveSchema,
            objectTypes,
            offset: 0,
            pageSize,
            searchFilter: target.tableName,
            force: false,
          });
          if (!page.children.length) continue;

          const currentChildren = withoutLoadMoreNodes(group.children);
          const loadMoreNodes = (group.children || []).filter((child) => child.type === "load-more");
          const mergedChildren = mergeLocatedTreeChildren(group, currentChildren, page.children, target.connectionId, target.database);
          if (!canApplyTreeMetadataResult(group)) continue;
          setChildren(group, [...mergedChildren, ...loadMoreNodes]);
          group.objectCount = Math.max(group.objectCount ?? currentChildren.length, mergedChildren.length);
          group.isExpanded = true;
          loaded = true;
        }

        return loaded;
      },
    );
  }

  async function loadAllObjectGroupChildren(parent: TreeNode) {
    if (!parent.connectionId || !hasTreeNodeDatabaseContext(parent)) return;
    if (!objectTypesForGroupNode(parent.type)) return;
    parent.isLoading = true;
    try {
      await ensureConnected(parent.connectionId);
      if (!isTreeNodeChildrenLoaded(parent.id)) {
        await loadObjectGroupChildren(parent);
      }

      let loadMoreNode = findTreeNodes(parent.children ?? [], (child) => child.type === "load-more")[0];
      while (loadMoreNode?.loadMore) {
        loadMoreNode.isLoading = true;
        await loadMoreObjectGroupChildren(loadMoreNode);
        loadMoreNode = findTreeNodes(parent.children ?? [], (child) => child.type === "load-more")[0];
      }
      parent.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(parent.connectionId, e);
      throw e;
    } finally {
      parent.isLoading = false;
    }
  }

  function setSidebarTableSearchQuery(parentNodeId: string, query: string) {
    const normalized = query.trim();
    const next = { ...sidebarTableSearchQueries.value };
    if (normalized) {
      next[parentNodeId] = query;
    } else {
      delete next[parentNodeId];
    }
    sidebarTableSearchQueries.value = next;
  }

  async function refreshSidebarTableSearch(parentNodeId: string) {
    const parent = findNode(treeNodes.value, parentNodeId);
    if (!parent?.connectionId || !hasTreeNodeDatabaseContext(parent)) return;

    const searchFilter = sidebarTableSearchQueries.value[parentNodeId]?.trim() || "";
    const options: LoadTreeOptions = {
      force: true,
      searchFilter: searchFilter || undefined,
      sidebarTableSearchParentId: parentNodeId,
      expectedSidebarTableSearchQuery: searchFilter,
    };

    if (parent.type === "group-tables") {
      await loadObjectGroupChildren(parent, options);
      return;
    }

    if (parent.type === "database" || parent.type === "schema" || parent.type === "linked-server-schema") {
      await loadTables(parent.connectionId, parent.database, parent.schema, options);
    }
  }

  function normalizedObjectTreeKind(type: string): DatabaseObjectTreeKind {
    return normalizeSidebarObjectKind(type);
  }

  async function loadTableGroups(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
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
        catalog,
        tableName: table,
        isExpanded: false,
        children: [],
      },
    ];

    const config = getConfig(connectionId);
    const metadataCapabilities = getTableMetadataCapabilities(effectiveDatabaseTypeForConnection(config));
    if ((node.type === "table" || node.type === "mongo-collection") && !parseSqlServerLinkedSchema(schema)) {
      if (metadataCapabilities.indexes) {
        children.push({
          id: `${parentId}:__indexes`,
          label: "tree.indexes",
          type: "group-indexes",
          connectionId,
          database,
          schema,
          catalog,
          tableName: table,
          isExpanded: false,
          children: [],
        });
      }
    }
    if (node.type === "table" && !parseSqlServerLinkedSchema(schema)) {
      if (metadataCapabilities.foreignKeys) {
        children.push({
          id: `${parentId}:__fkeys`,
          label: "tree.foreignKeys",
          type: "group-fkeys",
          connectionId,
          database,
          schema,
          catalog,
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
          catalog,
          tableName: table,
          isExpanded: false,
          children: [],
        });
      }
    }

    setChildren(node, children);
    node.isExpanded = true;
  }

  async function loadColumns(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
    const parentId = nodeId ?? (schema ? `${connectionId}:${database}:${schema}:${table}:__columns` : `${connectionId}:${database}:${table}:__columns`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    node.isLoading = true;
    try {
      if (effectiveDatabaseTypeForConnection(getConfig(connectionId)) === "mongodb") {
        const fields = await listMongoCompletionFields(connectionId, database, table);
        setChildren(
          node,
          fields.map((field) => {
            const column = {
              name: field.name,
              data_type: field.type || "unknown",
              is_nullable: true,
              column_default: null,
              is_primary_key: field.name === "_id",
              extra: "sampled",
            };
            return {
              id: `${parentId}:${field.name}`,
              label: `${field.name} (${column.data_type})`,
              type: "column" as const,
              connectionId,
              database,
              tableName: table,
              meta: column,
            };
          }),
        );
        node.isExpanded = true;
        return;
      }
      const querySchema = metadataQuerySchema(connectionId, database, schema);
      const columns = await api.getColumns(connectionId, database, querySchema, table, catalog);
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

  async function loadIndexes(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
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
      const indexes = await api.listIndexes(connectionId, database, querySchema, table, catalog);
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

  async function loadForeignKeys(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
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
      const fkeys = await api.listForeignKeys(connectionId, database, querySchema, table, catalog);
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

  async function loadTriggers(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
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
      const triggers = await api.listTriggers(connectionId, database, querySchema, table, catalog);
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
      } else if (config?.db_type === "zookeeper") {
        await loadZooKeeperRoot(node.connectionId);
      } else if (config?.db_type === "mongodb") {
        await loadMongoDatabases(node.connectionId);
      } else if (config?.db_type === "elasticsearch") {
        await loadElasticsearchIndices(node.connectionId);
      } else if (config?.db_type === "milvus") {
        await loadMilvusDatabases(node.connectionId);
      } else if (config?.db_type === "qdrant" || config?.db_type === "weaviate" || config?.db_type === "chromadb") {
        await loadVectorCollections(node.connectionId);
      } else if (config?.db_type === "mq") {
        await loadMqTenants(node.connectionId, options);
      } else if (config?.db_type === "nacos") {
        await loadNacosNamespaces(node.connectionId, options);
      } else {
        await loadDatabases(node.connectionId, options);
      }
    } else if (node.type === "mongo-db" && node.connectionId && node.database) {
      await loadMongoCollections(node.connectionId, node.database);
    } else if (node.type === "vector-database" && node.connectionId && node.database) {
      await loadVectorCollections(node.connectionId, node.database);
    } else if (node.type === "mongo-collection" && node.connectionId && node.database) {
      await loadTableGroups(node.connectionId, node.database, node.label, node.schema, node.id);
    } else if (node.type === "mongo-gridfs") {
      node.isExpanded = true;
    } else if (node.type === "doris-catalog" && node.connectionId) {
      await loadDorisCatalogDatabases(node, options);
    } else if (node.type === "database" && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      if (node.catalog && node.catalog !== "internal") {
        await loadDorisCatalogTables(node, options);
      } else {
        const config = getConfig(node.connectionId);
        const effectiveDbType = effectiveDatabaseTypeForConnection(config);
        if (config?.db_type === "sqlserver") {
          await loadSqlServerDatabaseObjects(node.connectionId, node.database, options);
        } else if (usesTreeSchemaMode(effectiveDbType) && !connectionUsesDatabaseObjectTreeMode(config)) {
          await loadSchemas(node.connectionId, node.database, options);
        } else {
          await loadTables(node.connectionId, node.database, undefined, options);
        }
      }
    } else if (node.type === "schema" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.schema) {
      await loadTables(node.connectionId, node.database, node.schema, options);
    } else if (node.type === "linked-server-root" && node.connectionId) {
      await loadSqlServerLinkedServers(node.connectionId, options);
    } else if (node.type === "linked-server" && node.connectionId) {
      await loadSqlServerLinkedServerCatalogs(node, options);
    } else if (node.type === "linked-server-catalog" && node.connectionId) {
      await loadSqlServerLinkedServerSchemas(node, options);
    } else if (node.type === "linked-server-schema" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.schema) {
      await loadTables(node.connectionId, node.database, node.schema, options);
    } else if ((node.type === "table" || node.type === "view" || node.type === "materialized_view") && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      await loadTableGroups(node.connectionId, node.database, node.label, node.schema, node.id, node.catalog);
    } else if (node.type === "group-columns" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadColumns(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (node.type === "group-indexes" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadIndexes(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (node.type === "group-fkeys" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadForeignKeys(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (node.type === "group-triggers" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadTriggers(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (objectTypesForGroupNode(node.type)) {
      await loadObjectGroupChildren(node, options);
    } else if (node.type === "group-partitions") {
      node.isExpanded = true;
    } else if (node.type === "group-extensions" && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      await loadExtensions(node.connectionId, node.database || "", node.schema || "");
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
    invalidateMetadataCachesForNode(node);
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
    invalidateMetadataCaches({ connectionId, database, schema });
    const shouldRefreshSchemaNode = !!schema;
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

  function isPostgresLikeForExtensions(dbType?: string): boolean {
    return dbType === "postgres" || dbType === "gaussdb" || dbType === "kwdb" || dbType === "opengauss" || dbType === "highgo" || dbType === "vastbase" || dbType === "kingbase";
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
    return `${connectionId}:${database}:${schema?.toLowerCase() ?? ""}`;
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

  function completionLimiterScope(connectionId: string, database = ""): string {
    return `${connectionId}:${database}`;
  }

  function withCompletionInFlight<T>(key: string, load: () => Promise<T>, limit?: { scope: string; kind: string }): Promise<T> {
    const existing = completionInFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = (limit ? completionMetadataLimiter.run(limit.scope, limit.kind, load) : load()).finally(() => {
      if (completionInFlight.get(key) === promise) completionInFlight.delete(key);
    });
    completionInFlight.set(key, promise);
    return promise;
  }

  function completionAssistantRequestKey(request: CompletionAssistantRequest): string {
    return JSON.stringify({
      connection_id: request.connection_id,
      database: request.database,
      schema: request.schema ?? "",
      object_kinds: [...(request.object_kinds ?? [])].sort(),
      mask: request.mask ?? "",
      case_sensitive: !!request.case_sensitive,
      global_search: !!request.global_search,
      max_results: request.max_results ?? null,
      search_in_comments: !!request.search_in_comments,
      search_in_definitions: !!request.search_in_definitions,
      parent_schema: request.parent_schema ?? "",
      parent_name: request.parent_name ?? "",
      match_mode: request.match_mode ?? "prefix",
    });
  }

  async function completionAssistantSearch(request: CompletionAssistantRequest) {
    return withCompletionInFlight(`assistant:${completionAssistantRequestKey(request)}`, async () => {
      await ensureConnected(request.connection_id);
      return api.completionAssistantSearch(request);
    });
  }

  const ORACLE_SYSTEM_COMPLETION_SCHEMAS = new Set(["SYS", "SYSTEM", "SYSMAN", "DBSNMP", "OUTLN", "XDB", "MDSYS", "CTXSYS", "WMSYS"]);

  function completionPreferredSchema(connectionId: string, preferredSchema?: string): string | undefined {
    return preferredSchema?.trim() || getConfig(connectionId)?.username?.trim() || undefined;
  }

  function completionCandidateSchemaBoost(schema: string | null | undefined, preferredSchema?: string): number {
    if (schema && preferredSchema && schema.toLowerCase() === preferredSchema.toLowerCase()) return 2400;
    if (schema?.toUpperCase() === "PUBLIC") return 1200;
    if (schema && ORACLE_SYSTEM_COMPLETION_SCHEMAS.has(schema.toUpperCase())) return -1200;
    return 0;
  }

  function completionCandidateApplyName(name: string, schema: string | null | undefined, preferredSchema?: string): string {
    if (!schema || schema.toUpperCase() === "PUBLIC" || (preferredSchema && schema.toLowerCase() === preferredSchema.toLowerCase())) return name;
    return `${schema}.${name}`;
  }

  function completionAssistantTables(candidates: CompletionAssistantCandidate[], preferredSchema?: string, withOracleMetadata = false): SqlCompletionTable[] {
    return candidates
      .filter((candidate) => candidate.kind === "table" || candidate.kind === "view")
      .map((candidate) => {
        const table: SqlCompletionTable = {
          name: candidate.name,
          schema: candidate.schema ?? undefined,
          type: sqlObjectNavigationTypeFromTableType(candidate.data_type || candidate.kind),
        };
        if (!withOracleMetadata) return table;
        return {
          ...table,
          detail: candidate.schema ? `${candidate.schema} · ${(candidate.data_type || candidate.kind).toLowerCase()}` : candidate.kind,
          applyName: completionCandidateApplyName(candidate.name, candidate.schema, preferredSchema),
          boost: completionCandidateSchemaBoost(candidate.schema, preferredSchema),
        };
      });
  }

  function completionAssistantObjects(candidates: CompletionAssistantCandidate[], preferredSchema?: string): SqlCompletionObject[] {
    return candidates
      .map((candidate): SqlCompletionObject | null => {
        const candidateType = candidate.data_type?.toUpperCase();
        const type = candidate.kind === "procedure" ? "procedure" : candidate.kind === "function" ? "function" : candidate.kind === "object" && candidateType === "PACKAGE" ? "package" : null;
        if (!type) return null;
        return {
          name: candidate.name,
          schema: candidate.schema ?? undefined,
          type,
          parentSchema: candidate.parent_schema ?? undefined,
          parentName: candidate.parent_name ?? undefined,
          applyName: completionCandidateApplyName(candidate.name, candidate.schema, preferredSchema),
          boost: completionCandidateSchemaBoost(candidate.schema, preferredSchema),
        };
      })
      .filter((object): object is SqlCompletionObject => object != null);
  }

  function completionAssistantColumns(candidates: CompletionAssistantCandidate[], table: string, schema?: string): SqlCompletionColumn[] {
    return candidates
      .filter((candidate) => candidate.kind === "column")
      .map((candidate) => ({
        name: candidate.name,
        table: candidate.parent_name ?? table,
        schema: candidate.parent_schema ?? candidate.schema ?? schema,
        dataType: candidate.data_type ?? undefined,
        comment: candidate.comment ?? null,
      }));
  }

  async function listCompletionAssistantTables(connectionId: string, database: string, filter: string, limit?: number, schema?: string, globalSearch = false, currentSchema?: string): Promise<SqlCompletionTable[]> {
    const oracleAssistant = getConfig(connectionId)?.db_type === "oracle";
    const preferredSchema = oracleAssistant ? completionPreferredSchema(connectionId, globalSearch ? currentSchema : (schema ?? currentSchema)) : schema?.trim() || undefined;
    const objectKinds: CompletionAssistantObjectKind[] = ["table", "view"];
    const response = await completionAssistantSearch({
      connection_id: connectionId,
      database,
      schema: preferredSchema ?? null,
      object_kinds: objectKinds,
      mask: filter.trim(),
      max_results: limit ?? 200,
      global_search: globalSearch,
      parent_schema: globalSearch ? null : (schema ?? null),
      match_mode: "prefix",
    });
    const tables = completionAssistantTables(response.candidates, preferredSchema, oracleAssistant);
    indexCompletionTables(connectionId, database, schema, tables);
    return tables;
  }

  async function listCompletionAssistantObjects(connectionId: string, database: string, filter: string, limit: number | undefined, schema: string | undefined, parentName: string | undefined, globalSearch: boolean, currentSchema?: string): Promise<SqlCompletionObject[]> {
    const preferredSchema = completionPreferredSchema(connectionId, currentSchema);
    const response = await completionAssistantSearch({
      connection_id: connectionId,
      database,
      schema: preferredSchema ?? null,
      object_kinds: ["routine"],
      mask: filter.trim(),
      max_results: limit ?? 200,
      global_search: globalSearch,
      parent_schema: globalSearch ? null : (schema ?? null),
      parent_name: parentName ?? null,
      match_mode: "prefix",
    });
    const objects = completionAssistantObjects(response.candidates, preferredSchema);
    indexCompletionObjects(connectionId, database, schema, objects);
    return objects;
  }

  async function listCompletionAssistantColumns(connectionId: string, database: string, table: string, schema?: string): Promise<SqlCompletionColumn[]> {
    const response = await completionAssistantSearch({
      connection_id: connectionId,
      database,
      schema: schema ?? null,
      object_kinds: ["column"],
      mask: "",
      max_results: 500,
      parent_schema: schema ?? null,
      parent_name: table,
      match_mode: "prefix",
    });
    const columns = completionAssistantColumns(response.candidates, table, schema);
    if (columns.length > 0) indexCompletionColumns(connectionId, database, table, schema, columns);
    return columns;
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
    const scopes = schema ? (preferred ? [preferred] : []) : allScopes;
    const treeTables = completionTablesFromTree(treeNodes.value, connectionId, database, schema);
    const ranked = scopes
      .flatMap((entry) => entry?.tables ?? [])
      .concat(treeTables)
      .map((table) => ({ table, score: tableMatchScore(table, filter, schema) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.table.name.localeCompare(b.table.name));
    return dedupeCompletionTables(ranked.map((entry) => entry.table)).slice(0, limit ?? 200);
  }

  function lookupLocalCompletionObjects(connectionId: string, database: string, filter = "", limit?: number, schema?: string): SqlCompletionObject[] {
    const allScopes = [...completionObjectIndex.entries()].filter(([key]) => key.startsWith(`${connectionId}:${database}:`)).map(([, entry]) => entry);
    const preferred = schema ? completionObjectIndex.get(completionScopeKey(connectionId, database, schema)) : undefined;
    const scopes = schema ? (preferred ? [preferred] : []) : allScopes;
    const ranked = scopes
      .flatMap((entry) => entry?.objects ?? [])
      .map((object) => ({ object, score: objectMatchScore(object, filter, schema) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || a.object.name.localeCompare(b.object.name));
    return dedupeCompletionObjects(ranked.map((entry) => entry.object)).slice(0, limit ?? 200);
  }

  function lookupLocalCompletionSchemas(connectionId: string, database: string, filter = "", limit = 50): string[] {
    const schemas = dedupeCompletionQualifierNames([...(schemaListCache.value[`${connectionId}:${database}`] ?? []), ...completionSchemasFromTree(treeNodes.value, connectionId, database)]);
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

  function dedupeCompletionQualifierNames(names: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const name of names) {
      const normalized = name.trim();
      if (!normalized) continue;
      const key = normalized.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
    }
    return result;
  }

  function lookupLocalCompletionColumns(connectionId: string, database: string, table: string, schema?: string): SqlCompletionColumn[] {
    return completionColumnIndex.get(completionColumnsKey(connectionId, database, table, schema))?.columns ?? [];
  }

  function lookupLocalCompletionForeignKeys(connectionId: string, database: string, table: string, schema?: string): SqlCompletionForeignKey[] {
    return completionForeignKeyIndex.get(completionForeignKeysKey(connectionId, database, table, schema))?.foreignKeys ?? [];
  }

  function databaseNamesFromTree(connectionId: string): string[] {
    const node = findConnectionNode(connectionId);
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
    return withCompletionInFlight(
      `${connectionId}:completion-databases`,
      async () => {
        await ensureConnected(connectionId);
        const config = getConfig(connectionId);
        const databases = await api.listDatabases(connectionId);
        completionDatabasesCache.value[connectionId] = filterDatabaseNamesForConnection(
          databases.map((database) => database.name),
          config,
        );
        evictOldestCacheEntries(completionDatabasesCache.value, COMPLETION_CACHE_MAX);
        return completionDatabasesCache.value[connectionId];
      },
      { scope: completionLimiterScope(connectionId), kind: "databases" },
    );
  }

  async function listCompletionSchemas(connectionId: string, database: string): Promise<string[]> {
    const cacheKey = `${connectionId}:${database}`;
    if (schemaListCache.value[cacheKey]) {
      return schemaListCache.value[cacheKey];
    }
    return withCompletionInFlight(`${cacheKey}:schemas`, async () => {
      const schemas = await api.listSchemas(connectionId, database);
      schemaListCache.value[cacheKey] = schemas;
      evictOldestCacheEntries(schemaListCache.value, COMPLETION_CACHE_MAX);
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
      const pageSize = getConfig(connectionId)?.redis_scan_page_size ?? REDIS_SCAN_PAGE_SIZE_DEFAULT;
      // Bounded multi-round SCAN: trade coverage for latency/memory safety.
      const result = await api.redisScanKeysBatch(connectionId, Number(database), 0, "*", pageSize, 6, false);
      const keys = result.keys.map((key) => key.key_display).slice(0, REDIS_COMPLETION_KEYS_MAX);
      redisCompletionKeysCache.value[cacheKey] = keys;
      evictOldestCacheEntries(redisCompletionKeysCache.value, COMPLETION_CACHE_MAX);
      return keys;
    });
  }

  async function listMongoCompletionCollections(connectionId: string, database: string): Promise<string[]> {
    if (!database) return [];
    const cacheKey = `${connectionId}:${database}`;
    const cached = mongoCompletionCollectionsCache.value[cacheKey];
    if (cached) return cached;
    return withCompletionInFlight(`${cacheKey}:mongo-collections`, async () => {
      await ensureConnected(connectionId);
      const collections = sortSidebarNames((await api.mongoListCollections(connectionId, database)).map((c) => c.name));
      mongoCompletionCollectionsCache.value[cacheKey] = collections;
      evictOldestCacheEntries(mongoCompletionCollectionsCache.value, COMPLETION_CACHE_MAX);
      return collections;
    });
  }

  async function listMongoCompletionFields(connectionId: string, database: string, collection: string): Promise<MongoCompletionField[]> {
    if (!database || !collection) return [];
    const cacheKey = `${connectionId}:${database}:${collection}`;
    const cached = mongoCompletionFieldsCache.value[cacheKey];
    if (cached) return cached;
    return withCompletionInFlight(`${cacheKey}:mongo-fields`, async () => {
      await ensureConnected(connectionId);
      const result = await api.mongoFindDocuments(connectionId, database, collection, 0, 20, "{}");
      const fields = inferMongoCompletionFields(result.documents ?? []);
      mongoCompletionFieldsCache.value[cacheKey] = fields;
      evictOldestCacheEntries(mongoCompletionFieldsCache.value, COMPLETION_CACHE_MAX);
      return fields;
    });
  }

  async function listCompletionTables(connectionId: string, database: string, filter = "", limit?: number, schema?: string, globalSearch = false, currentSchema?: string): Promise<SqlCompletionTable[]> {
    const trimmedFilter = filter.trim();
    const normalizedFilter = trimmedFilter.toLowerCase();
    // Remote queries (Dameng/Oracle) are case-sensitive, so the cache key must
    // preserve original casing — otherwise "TEST" and "test" collide and the
    // second lookup returns the first's stale results. Local lookups below stay
    // case-insensitive because tableMatchScore normalizes internally.
    const relaxedFilter = relaxedCompletionTableFilter(trimmedFilter);
    const cacheKey = `${connectionId}:${database}:${trimmedFilter}:${limit ?? ""}:${schema ?? ""}:${globalSearch ? "global" : "scoped"}:${currentSchema ?? ""}`;
    if (completionTablesCache.value[cacheKey]) {
      return completionTablesCache.value[cacheKey];
    }

    return withCompletionInFlight(
      `${cacheKey}:tables`,
      async () => {
        await ensureConnected(connectionId);

        if (isSchemaAwareDatabase(connectionId)) {
          if (normalizedFilter || limit) {
            let results: SqlCompletionTable[] = [];
            try {
              results = await listCompletionAssistantTables(connectionId, database, trimmedFilter, limit, schema, globalSearch, currentSchema);
            } catch {
              if (schema) {
                const tables = await api.listTables(connectionId, database, schema, trimmedFilter, limit);
                results = tables.map((table) => ({
                  name: table.name,
                  schema,
                  type: sqlObjectNavigationTypeFromTableType(table.table_type),
                }));
              } else {
                results = lookupLocalCompletionTables(connectionId, database, normalizedFilter, limit);
              }
            }
            if (results.length === 0 && relaxedFilter) {
              if (globalSearch) {
                try {
                  results = await listCompletionAssistantTables(connectionId, database, relaxedFilter, expandedCompletionLimit(limit), schema, true, currentSchema);
                } catch {
                  results = [];
                }
              } else if (schema) {
                try {
                  const tables = await api.listTables(connectionId, database, schema, relaxedFilter, expandedCompletionLimit(limit));
                  results = tables.map((table) => ({
                    name: table.name,
                    schema,
                    type: sqlObjectNavigationTypeFromTableType(table.table_type),
                  }));
                } catch {
                  results = [];
                }
              } else {
                results = lookupLocalCompletionTables(connectionId, database, relaxedFilter, expandedCompletionLimit(limit));
              }
            }
            const limitedTables = limit ? dedupeCompletionTables(results).slice(0, limit) : results;
            completionTablesCache.value[cacheKey] = limitedTables;
            indexCompletionTables(connectionId, database, undefined, limitedTables);
            evictOldestCacheEntries(completionTablesCache.value, COMPLETION_CACHE_MAX);
            return completionTablesCache.value[cacheKey];
          }

          if (schema) {
            const tables = await api.listTables(connectionId, database, schema);
            completionTablesCache.value[cacheKey] = tables.map((table) => ({
              name: table.name,
              schema,
              type: sqlObjectNavigationTypeFromTableType(table.table_type),
            }));
          } else {
            completionTablesCache.value[cacheKey] = lookupLocalCompletionTables(connectionId, database, normalizedFilter, limit);
          }
          indexCompletionTables(connectionId, database, undefined, completionTablesCache.value[cacheKey]);
          evictOldestCacheEntries(completionTablesCache.value, COMPLETION_CACHE_MAX);
          return completionTablesCache.value[cacheKey];
        }

        let tables = await api.listTables(connectionId, database, database, trimmedFilter, limit);
        if (tables.length === 0 && relaxedFilter) {
          tables = await api.listTables(connectionId, database, database, relaxedFilter, expandedCompletionLimit(limit));
        }
        completionTablesCache.value[cacheKey] = tables.map((table) => ({
          name: table.name,
          type: sqlObjectNavigationTypeFromTableType(table.table_type),
        }));
        completionTablesCache.value[cacheKey] = limit ? completionTablesCache.value[cacheKey].slice(0, limit) : completionTablesCache.value[cacheKey];
        indexCompletionTables(connectionId, database, schema, completionTablesCache.value[cacheKey]);
        evictOldestCacheEntries(completionTablesCache.value, COMPLETION_CACHE_MAX);
        return completionTablesCache.value[cacheKey];
      },
      { scope: completionLimiterScope(connectionId, database), kind: "tables" },
    );
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
    const indexByKey = new Map<string, number>();
    const deduped: SqlCompletionTable[] = [];
    for (const table of tables) {
      const key = `${table.schema ?? ""}.${table.name}`.toLowerCase();
      const existingIndex = indexByKey.get(key);
      if (existingIndex != null) {
        const existing = deduped[existingIndex];
        // Loaded tree metadata can distinguish materialized views even when an older completion endpoint only reports VIEW.
        deduped[existingIndex] = { ...table, ...existing, type: mergeSqlObjectNavigationType(existing.type, table.type) };
        continue;
      }
      indexByKey.set(key, deduped.length);
      deduped.push(table);
    }
    return deduped;
  }

  async function listCompletionObjects(connectionId: string, database: string, filter = "", limit?: number, schema?: string, parentName?: string, globalSearch = false, currentSchema?: string): Promise<SqlCompletionObject[]> {
    const normalizedFilter = filter.trim().toLowerCase();
    const oracleAssistant = getConfig(connectionId)?.db_type === "oracle" && (!!normalizedFilter || typeof limit === "number" || !!parentName || globalSearch);
    const cacheKey = oracleAssistant ? `${connectionId}:${database}:${schema ?? ""}:${parentName ?? ""}:${normalizedFilter}:${limit ?? ""}:${globalSearch ? "global" : "scoped"}:${currentSchema ?? ""}` : `${connectionId}:${database}:${schema ?? ""}`;
    if (!completionObjectsCache.value[cacheKey]) {
      await withCompletionInFlight(
        `${cacheKey}:objects`,
        async () => {
          await ensureConnected(connectionId);
          if (oracleAssistant) {
            completionObjectsCache.value[cacheKey] = dedupeCompletionObjects(await listCompletionAssistantObjects(connectionId, database, filter, limit, schema, parentName, globalSearch, currentSchema));
          } else {
            const objects = isSchemaAwareDatabase(connectionId) ? await listSchemaAwareCompletionObjects(connectionId, database, schema) : await api.listCompletionObjects(connectionId, database, schema || database);
            completionObjectsCache.value[cacheKey] = dedupeCompletionObjects(objects.map(toSqlCompletionObject).filter((object): object is SqlCompletionObject => object != null));
          }
          indexCompletionObjects(connectionId, database, schema, completionObjectsCache.value[cacheKey]);
          evictOldestCacheEntries(completionObjectsCache.value, COMPLETION_CACHE_MAX);
        },
        { scope: completionLimiterScope(connectionId, database), kind: "objects" },
      );
    }

    const objects = completionObjectsCache.value[cacheKey];
    const filtered = normalizedFilter ? objects.filter((object) => fuzzyCompletionObjectMatch(object, normalizedFilter)) : objects;
    return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
  }

  async function listSchemaAwareCompletionObjects(connectionId: string, database: string, schema?: string): Promise<ObjectInfo[]> {
    const schemas = schema ? [schema] : await listCompletionSchemas(connectionId, database);
    const batchSize = COMPLETION_METADATA_CONCURRENCY;
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
      await withCompletionInFlight(
        `${cacheKey}:columns`,
        async () => {
          await ensureConnected(connectionId);
          try {
            const assistantColumns = await listCompletionAssistantColumns(connectionId, database, table, schema);
            if (assistantColumns.length > 0) {
              completionColumnsCache.value[cacheKey] = assistantColumns.map((column) => ({
                name: column.name,
                data_type: column.dataType ?? "",
                is_nullable: column.isNullable ?? true,
                column_default: null,
                is_primary_key: false,
                extra: null,
                comment: column.comment ?? null,
                numeric_precision: null,
                numeric_scale: null,
                character_maximum_length: null,
              }));
              evictOldestCacheEntries(completionColumnsCache.value, COMPLETION_CACHE_MAX);
              return;
            }
          } catch {
            // Fall back to the existing metadata path below.
          }
          const querySchema = metadataQuerySchema(connectionId, database, schema);
          completionColumnsCache.value[cacheKey] = await api.getColumns(connectionId, database, querySchema, table);
          evictOldestCacheEntries(completionColumnsCache.value, COMPLETION_CACHE_MAX);
        },
        { scope: completionLimiterScope(connectionId, database), kind: "columns" },
      );
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
      await withCompletionInFlight(
        `${cacheKey}:fkeys`,
        async () => {
          await ensureConnected(connectionId);
          const querySchema = metadataQuerySchema(connectionId, database, schema);
          completionForeignKeysCache.value[cacheKey] = await api.listForeignKeys(connectionId, database, querySchema, table);
          evictOldestCacheEntries(completionForeignKeysCache.value, COMPLETION_CACHE_MAX);
        },
        { scope: completionLimiterScope(connectionId, database), kind: "foreignKeys" },
      );
    }

    const foreignKeys = sqlCompletionForeignKeys(completionForeignKeysCache.value[cacheKey]);
    indexCompletionForeignKeys(connectionId, database, table, schema, foreignKeys);
    return foreignKeys;
  }

  function refreshCompletionTables(connectionId: string, database: string, filter = "", limit?: number, schema?: string, globalSearch = false, currentSchema?: string): Promise<SqlCompletionTable[]> {
    return listCompletionTables(connectionId, database, filter, limit, schema, globalSearch, currentSchema);
  }

  function refreshCompletionObjects(connectionId: string, database: string, filter = "", limit?: number, schema?: string, parentName?: string, globalSearch = false, currentSchema?: string): Promise<SqlCompletionObject[]> {
    return listCompletionObjects(connectionId, database, filter, limit, schema, parentName, globalSearch, currentSchema);
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

  /** 查连接根节点：沿 connection-group 层级下钻但不穿透连接的整棵子树
   * （原通用 DFS 找第 N 个连接前要完整遍历前 N-1 个连接的数千个表/列节点）。
   * 不能用"同层优先"版 findNode 代替通用 DFS——节点 id 并非全树唯一
   * （如数据库 "a:b" 与数据库 "a" 下 schema "b" 同为 connectionId:a:b，
   * 见 pinnedItems 对 colliding node IDs 的处理），改变遍历顺序会让深层
   * 调用选中错误节点；连接根节点的 id 就是 connectionId，且只出现在
   * 顶层或连接组内，无歧义。 */
  function findConnectionNode(connectionId: string, nodes: TreeNode[] = treeNodes.value): TreeNode | null {
    for (const node of nodes) {
      if (node.id === connectionId && node.type !== "connection-group") return node;
      if (node.type === "connection-group" && node.children) {
        const found = findConnectionNode(connectionId, node.children);
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
          return inheritNaturalTreeNodeOrder(node, { ...node, children: mergeState(node.children || []) });
        }
        if (existing && node.type === "connection") {
          return inheritNaturalTreeNodeOrder(node, {
            ...existing,
            label: node.label,
            pinned: node.pinned,
            children: withSavedSqlRoot(node.connectionId!, existing.children || [], existing),
          });
        }
        if (node.type === "connection" && node.connectionId) {
          return inheritNaturalTreeNodeOrder(node, { ...node, children: withSavedSqlRoot(node.connectionId, node.children || []) });
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

  function collapseAllTreeNodes() {
    updateLayoutAndRebuild(collapseAllGroupsOp(sidebarLayout.value));
    collapseExpandedTreeNodes(treeNodes.value);
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

  async function refreshSidebarObjectPagination() {
    const simpleObjectDisplay = useSettingsStore().editorSettings.sidebarObjectDisplay === "simple";
    const isDirectObjectParent = (node: TreeNode) => {
      if (!node.children || node.children.length === 0) return false;
      return node.children.some(
        (child) => child.type === "table" || child.type === "view" || child.type === "materialized_view" || child.type === "procedure" || child.type === "function" || child.type === "sequence" || child.type === "package" || child.type === "package-body" || child.type === "load-more",
      );
    };
    const refreshNodes = async (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.type === "connection-group") {
          if (node.children) await refreshNodes(node.children);
          continue;
        }
        if (objectTypesForGroupNode(node.type)) {
          if (node.connectionId && connectedIds.value.has(node.connectionId)) {
            clearLoadedChildrenCache(node.id);
            if (node.isExpanded) {
              await loadObjectGroupChildren(node, { force: true });
            } else if (node.children) {
              node.children = [];
            }
          }
          continue;
        }
        if (simpleObjectDisplay && (node.type === "database" || node.type === "schema" || node.type === "linked-server-schema")) {
          if (isDirectObjectParent(node)) {
            if (node.connectionId && connectedIds.value.has(node.connectionId)) {
              clearLoadedChildrenCache(node.id);
              if (node.isExpanded) {
                await refreshTreeNode(node);
              } else {
                node.children = [];
              }
            }
            continue;
          }
          if (node.children) await refreshNodes(node.children);
          continue;
        }
        if (node.children) await refreshNodes(node.children);
      }
    };
    await refreshNodes(treeNodes.value);
  }

  async function exportConnectionsToFile(passphrase: string) {
    const { encryptConfig } = await import("@/lib/backend/configCrypto");
    const tunnelProfileStore = useTunnelProfileStore();
    await tunnelProfileStore.init();
    const exportData = { connections: connections.value, layout: sidebarLayout.value, tunnelProfiles: tunnelProfileStore.profiles };
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

    const { isEncryptedConfig } = await import("@/lib/backend/configCrypto");
    const parsed = JSON.parse(content);
    return { content, encrypted: isEncryptedConfig(parsed) };
  }

  async function importConnectionsFromFile(content: string, passphrase: string | null): Promise<{ count: number; layout?: SidebarLayout }> {
    let imported: ConnectionConfig[] = [];
    let importedLayout: SidebarLayout | undefined;
    let importedTunnelProfiles: TunnelProfile[] = [];

    if (!passphrase && content.trimStart().startsWith("<")) {
      const { parseNavicatConnections } = await import("@/lib/imports/navicatImport");
      imported = await parseNavicatConnections(content);
    } else if (!passphrase) {
      const { isDbeaverImportPayload, parseDbeaverConnections } = await import("@/lib/imports/dbeaverImport");
      const { isDataGripImportPayload, parseDataGripConnections } = await import("@/lib/imports/datagripImport");
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
          if (Array.isArray(parsed.tunnelProfiles)) {
            importedTunnelProfiles = parsed.tunnelProfiles;
          }
        } else {
          imported = [];
        }
      }
    } else {
      const parsed = JSON.parse(content);

      if (passphrase) {
        const { decryptConfig } = await import("@/lib/backend/configCrypto");
        const json = await decryptConfig(parsed, passphrase);
        const decrypted = JSON.parse(json);
        if (Array.isArray(decrypted)) {
          imported = decrypted;
        } else if (decrypted.connections) {
          imported = decrypted.connections;
          if (decrypted.layout?.groups && decrypted.layout?.order) {
            importedLayout = decrypted.layout;
          }
          if (Array.isArray(decrypted.tunnelProfiles)) {
            importedTunnelProfiles = decrypted.tunnelProfiles;
          }
        } else {
          imported = [];
        }
      }
    }

    // Profiles keep their original ids: imported connections reference them
    // via transport_layers[].profile_id, so regenerating ids would break the
    // links. Same-id profiles are overwritten with the imported copy.
    if (importedTunnelProfiles.length) {
      const tunnelProfileStore = useTunnelProfileStore();
      await tunnelProfileStore.init();
      const merged = [...tunnelProfileStore.profiles];
      for (const profile of importedTunnelProfiles) {
        if (!profile || typeof profile.id !== "string" || !profile.id) continue;
        const index = merged.findIndex((existing) => existing.id === profile.id);
        if (index >= 0) merged[index] = profile;
        else merged.push(profile);
      }
      await tunnelProfileStore.saveProfiles(merged);
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
      const { getDataGripUuidMap, datagripKeychainService } = await import("@/lib/imports/datagripImport");
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
        const currentLayout = sidebarLayout.value.groups.length || sidebarLayout.value.order.length ? sidebarLayout.value : null;
        sidebarLayout.value = reconcileLayout(
          connections.value.map((c) => c.id),
          savedLayout ?? currentLayout,
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
    markConnectionHealthChecked(normalized.id);
    clearConnectionError(normalized.id);
  }

  return {
    connections,
    activeConnectionId,
    selectedTreeNodeId,
    selectedTreeNodeIds,
    selectedTreeNodeIdsSet,
    treeSelectionAnchorId,
    connectionMultiSelectActive,
    treeClipboard,
    treeNodes,
    removeTreeNode,
    refreshAllTree,
    collapseAllTreeNodes,
    refreshSidebarObjectPagination,
    refreshTreeNode,
    refreshDatabaseTreeNode,
    refreshObjectListTreeNode,
    connectedIds,
    connectingIds,
    connectionErrors,
    setConnectionError,
    clearConnectionError,
    recordConnectionError,
    markConnectionLost,
    recordConnectionLostError,
    sidebarLayout,
    connectionGroupPaths,
    getConfig,
    connectionIdentifierQuote,
    isTreeNodePinned,
    toggleTreeNodePin,
    addConnection,
    copyConnectionsToTreeClipboard,
    pasteConnectionClipboard,
    addEphemeralConnection,
    updateConnection,
    updateConnectionDatabaseInfo,
    setDefaultDatabase,
    clearDefaultDatabase,
    isDefaultDatabase,
    setVisibleDatabases,
    clearVisibleDatabases,
    ensureVisibleDatabase,
    setVisibleSchemas,
    clearVisibleSchemas,
    removeConnection,
    removeConnections,
    editingConnectionId,
    newConnectionGroupId,
    startEditing,
    stopEditing,
    startCreatingConnectionInGroup,
    stopCreatingConnectionInGroup,
    connect,
    cancelConnecting,
    disconnect,
    closeDatabaseConnection,
    ensureConnected,
    loadConnectedConnectionRootForSidebarSearch,
    isTreeNodeChildrenLoaded,
    releaseCollapsedTreeNodeChildren,
    setBeforeConnectHandler,
    initFromDisk,
    loadDatabases,
    loadRedisDatabases,
    refreshRedisDbKeyCounts,
    loadEtcdRoot,
    loadZooKeeperRoot,
    loadMqTenants,
    loadNacosNamespaces,
    updateRedisDbKeyStats,
    loadMongoDatabases,
    loadMilvusDatabases,
    loadElasticsearchIndices,
    loadVectorCollections,
    loadMongoCollections,
    loadSchemas,
    loadSqlServerDatabaseObjects,
    loadSqlServerLinkedServers,
    loadSqlServerLinkedServerCatalogs,
    loadSqlServerLinkedServerSchemas,
    loadDorisCatalogDatabases,
    loadDorisCatalogTables,
    loadTables,
    loadTableForLocate,
    loadObjectGroupChildren,
    loadMoreObjectGroupChildren,
    loadAllObjectGroupChildren,
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
    listMongoCompletionCollections,
    listMongoCompletionFields,
    invalidateCompletionCache,
    invalidateMetadataCache,
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
    sidebarTableSearchQueries,
    setSidebarTableSearchQuery,
    refreshSidebarTableSearch,
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
    groupIdForConnection(connectionId: string): string | null {
      return findConnectionLocation(sidebarLayout.value, connectionId)?.groupId ?? null;
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

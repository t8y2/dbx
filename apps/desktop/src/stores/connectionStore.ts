import { defineStore } from "pinia";
import { uuid } from "@/lib/common/utils";
import { containsHan, orderedSubsequenceSpan, pinyinFirstLetters } from "@/lib/common/pinyin";
import { ref, computed, watch, markRaw } from "vue";
import type {
  ColumnInfo,
  CompletionAssistantCandidate,
  CompletionAssistantObjectKind,
  CompletionAssistantRequest,
  ConnectionConfig,
  DatabaseType,
  DatabaseConnectionInfo,
  DatabaseStorageInfo,
  SqlServerCompletionContext,
  CatalogInfo,
  ForeignKeyInfo,
  ObjectInfo,
  ObjectStatistics,
  SchemaInfo,
  SidebarLayout,
  TableNameFilter,
  TableInfo,
  TreeNode,
  VectorCollectionMeta,
} from "@/types/database";
import {
  inheritNaturalTreeNodeOrder,
  migrateLegacyPinnedTreeNodeOrder,
  normalizePinnedTreeNodeOrder,
  orderItemsByPinnedTreeNodeOrder,
  pinnedTreeNodeIdentityMatches,
  removePinnedTreeNodesFromOrder,
  reorderPinnedTreeNodeOrder,
  replacePinnedTreeNodeInOrder,
  syncPinnedTreeNodeStateInPlace,
  treeNodePinIdentity,
  treeNodePinKey,
  type PinnedTreeNodeIdentity,
  type PinnedTreeNodeIdentityCanonicalizer,
} from "@/lib/app/pinnedItems";
import {
  reconcileLayout,
  buildTreeNodesFromLayout,
  emptyLayout,
  appendConnectionToLayout,
  removeConnectionFromSidebarLayout,
  findConnectionLocation,
  createGroup as createGroupOp,
  renameGroup as renameGroupOp,
  deleteGroups as deleteGroupsOp,
  connectionIdsInGroups as connectionIdsInGroupsOp,
  toggleGroupCollapsed as toggleGroupCollapsedOp,
  expandGroups as expandGroupsOp,
  collapseAllGroups as collapseAllGroupsOp,
  moveConnectionToGroup as moveConnectionToGroupOp,
  remapSidebarLayoutConnectionIds,
  mergeSidebarLayout,
  reorderEntry as reorderEntryOp,
  reorderEntries as reorderEntriesOp,
  buildConnectionGroupPathMap,
  connectionGroupDestinationRows,
  connectionGroupIdForSelection,
  connectionSidebarSearchAliases,
  type DropPosition,
  type ReorderEntriesOptions,
} from "@/lib/sidebar/sidebarLayout";
import {
  buildConnectionConfigBundle,
  filterSidebarLayoutByConnectionIds,
  filterTunnelProfilesByIds,
  parseConnectionConfigObject,
  referencedTunnelProfileIds,
  selectConnectionConfigBundle,
  snapshotConnectionsForExport,
  type ConnectionConfigBundle,
  type ConnectionExportProtection,
} from "@/lib/connection/connectionConfigTransfer";
import type { SqlCompletionColumn, SqlCompletionForeignKey, SqlCompletionObject, SqlCompletionTable } from "@/lib/sql/sqlCompletion";
import { usesOracleCurrentSchemaCompletion } from "@/lib/sql/oracleCompletionSession";
import { mergeSqlObjectNavigationType, sqlObjectNavigationTypeFromTableType } from "@/lib/sql/sqlNavigation";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useTunnelProfileStore } from "@/stores/tunnelProfileStore";
import { connectionIsDorisFamilyCatalogCapable, isInternalDorisCatalog, isSchemaAware, normalizeSidebarObjectKind, schemaNodeHasLoadableName, shouldShowDorisCatalogTree, sidebarObjectKindsForDatabase, supportsPackageMemberExpansion, usesTreeSchemaMode } from "@/lib/database/databaseCapabilities";
import {
  connectionDatabaseMetadataSchema,
  connectionObjectTreeNodeSchema,
  connectionObjectTreeQuerySchema,
  connectionShouldDiscoverJdbcSchemas,
  connectionShouldLoadIdentifierQuote,
  connectionUsesDatabaseObjectTreeMode,
  effectiveDatabaseTypeForConnection,
  gaussdbIdentifierQuoteOverride,
} from "@/lib/database/jdbcDialect";
import { buildDatabaseTreeNodes, buildDuckDbConnectionTreeNodes, compareSidebarNames, sortSidebarDatabases, sortSidebarNames, shouldIncludeDefaultDatabaseNode } from "@/lib/database/databaseTree";
import { spannerDisplayDatabase, spannerSchemaDisplayName } from "@/lib/connection/spannerResourcePath";
import { buildSqlServerDatabaseTreeNodes } from "@/lib/database/sqlServerTree";
import { collapseExpandedTreeNodes } from "@/lib/sidebar/sidebarTreeCollapse";
import { findNodePathByIdentity, nodeMatchesRegexScopeIdentity, type SidebarRegexScopeIdentity } from "@/lib/sidebar/sidebarSearchTree";
import { findDatabaseTreeNode } from "@/lib/sidebar/treeRefreshTarget";
import { simpleModeEmptyShellNeedsConfirmedLoad, treeNodeLoadedChildrenContentPresent } from "@/lib/sidebar/treeLoadedChildrenMarker";
import { shouldMarkDisconnected } from "@/lib/connection/connectionHealth";
import { connectionAttemptOriginalErrorMessage, connectionAttemptTimeoutMessage, connectionAttemptTimeoutMs } from "@/lib/connection/connectionAttemptTimeout";
import { loadTimeoutInheritanceBackup, saveTimeoutInheritanceBackup } from "@/lib/connection/timeoutInheritanceBackup";
import { migrateSqlServerLegacyCompatibilityConfig, requiresSqlServerLegacyCompatibilityComponent, SQLSERVER_LEGACY_COMPATIBILITY_DRIVER_KEY } from "@/lib/connection/sqlServerLegacyCompatibility";
import { gaussdbMTypeDisplayName } from "@/lib/table/postgresDataTypeHelp";
import { deleteTabResultSnapshotsForOwner } from "@/lib/tabs/tabResultCache";
import { disposeSqlServerActivityTracesForConnection, hasSqlServerActivityTraceForConnection } from "@/lib/sqlserver/sqlServerActivityTraceRuntime";
import { connectionUsesVisibleSchemaFilter, filterDatabaseNamesForConnection, filterSchemaNamesForConnection, filterVisibleDatabaseNames, normalizeVisibleDatabaseSelection, visibleDatabasePatternsAreEnabled } from "@/lib/database/visibleDatabases";
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
import { decodeSchemaTreeCache, decodeTableSearchIndexManifest, encodeSchemaTreeCache, encodeTableSearchIndexManifest, type TableSearchIndexManifestEntry } from "@/lib/metadata/schemaTreeCache";
import { sortSidebarTreeChildrenForParent } from "@/lib/sidebar/sidebarNodeOrdering";
import { connectionSupportsDatabaseUserAdmin } from "@/lib/database/databaseUserAdmin";
import { getTableMetadataCapabilities } from "@/lib/table/tableMetadataCapabilities";
import { mergeRedisCommandDocumentation, parseRedisCommandCatalog, parseRedisCommandDocumentation, type RedisCommandDocumentation } from "@/lib/redis/redisCommandDocs";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { decorateDatabaseSavedSqlTreeNodes, indexSavedSqlFilesByDatabase, stripDatabaseSavedSqlTreeNodes, withDatabaseSavedSqlRoot } from "@/lib/savedSql/savedSqlDatabaseTree";
import { encodeSqlServerLinkedSchema, parseSqlServerLinkedSchema } from "@/lib/database/sqlServerLinkedServers";
import { inferMongoCompletionFields, type MongoCompletionField } from "@/lib/mongo/mongoCompletion";
import { isMongoLegacyDriverProfile } from "@/lib/mongo/mongoCapabilities";
import { mongoCollectionKindFromNode, toMongoCollectionKind, visibleMongoCollections } from "@/lib/sidebar/mongoCollectionMutation";
import { completionSchemasFromTree, completionTablesFromTree } from "@/lib/metadata/completionTreeIndex";
import { kvRootNodeLabel } from "@/lib/kv/kvRootPresentation";
import { REDIS_SCAN_PAGE_SIZE_DEFAULT } from "@/lib/redis/redisKeyPattern";
import { normalizeRedisDatabaseAliases, redisDatabaseAlias, redisDatabaseLabel } from "@/lib/redis/redisDatabaseAlias";
import { normalizeRedisKeyTemplates } from "@/lib/redis/redisKeyTemplates";
import { appendAgentDriverUpdateHint, connectionUsesSsh, hasAgentDriverUpdate, hasInstalledAgentVersion, type AgentDriverInstallState } from "@/lib/connection/agentDriverInstallHint";
import { appendConnectionErrorHints, isMysqlMissingPasswordFailure, isSqliteMissingEncryptionPasswordFailure } from "@/lib/connection/connectionErrorHints";
import { connectionNeedsPasswordPrompt } from "@/lib/connection/connectionPassword";
import { appendVisibleDatabaseSelection } from "@/lib/connection/connectionVisibleDatabases";
import { buildXuguTypeMemberNodes, isXuguTypeMemberContainer } from "@/lib/sidebar/xuguTypeMembers";
import { isXuguPublicSynonymScope, isXuguSchedulerJobScope, isXuguSyntheticScope, sortXuguSchemaInfos, xuguSchemaDisplayName, XUGU_PUBLIC_SYNONYM_SCOPE, XUGU_SCHEDULER_JOB_SCOPE } from "@/lib/sidebar/xuguPublicSynonyms";
import { filterNacosNamespacesForSidebar, normalizeNacosNamespacesForDisplay } from "@/lib/nacos/nacosNamespaceVisibility";
import { buildPackageMemberNodes, markPackageNodesExpandable, packageMemberGroupOwnerId } from "@/lib/sidebar/packageMembers";
import { configuredDatabaseProductName, connectionConfigFingerprint, normalizeDatabaseConnectionInfo } from "@/lib/connection/connectionDatabaseInfo";
import { driverProfileObjectTreeProfileForConnection } from "@/lib/database/driverProfileExtensions";
import { createMetadataLoadTrace, logMetadataLoadTrace, MetadataLoadCoordinator, type MetadataLoadTraceLogger } from "@/lib/metadata/metadataLoadCoordinator";
import type { MetadataScopeInput } from "@/lib/metadata/metadataLoadScope";
import { MetadataResultCache, type MetadataCacheInvalidation } from "@/lib/metadata/metadataResultCache";
import { invalidateTableMetadataCache } from "@/lib/metadata/tableMetadataCache";
import { cancelObjectDdlLoadsForConnection, cancelObjectDdlLoadsForDatabase, invalidateObjectDdlCache } from "@/lib/metadata/objectDdlCache";
import { cancelObjectMetadataLoadsForConnection, cancelObjectMetadataLoadsForDatabase } from "@/lib/metadata/objectMetadataCache";
import { clearMetadataRuntimeCacheForConnection, clearMetadataRuntimeCacheForDatabase } from "@/lib/metadata/metadataRuntimeCache";
import { invalidateObjectBrowserRowsCache } from "@/lib/table/objectBrowserRowsCache";
import { MetadataTaskLimiter } from "@/lib/metadata/metadataTaskLimiter";
import { buildCustomTypeTreeChildren } from "@/lib/sidebar/customTypeTree";
import { TreeNodeLoadRegistry, type TreeNodeLoadHandle } from "@/lib/metadata/treeNodeLoadHandle";
import { buildXuguTablespaceChildren } from "@/lib/sidebar/xuguTablespaces";
import i18n from "@/i18n";
import type { MqAdminConfig } from "@/types/mq";
import { RABBITMQ_MQ_TENANT, resolveMqSystemKindFromConnection } from "@/lib/mq/mqConsoleDefaults";
import { applySidebarDatabaseStorage, applySidebarTableStorage, sidebarDatabaseNames, supportsSidebarDatabaseStorage, supportsSidebarTableStorage, type SidebarTableStorageScope } from "@/lib/sidebar/sidebarDatabaseStorage";
import { connectionHasConfiguredSidebarVisibleFilter, nacosVisibleNamespaceSummary, sidebarVisibleFilterSummary } from "@/lib/sidebar/sidebarVisibleFilterSummary";
import { connectionCanConfigureSidebarVisibleDatabases } from "@/lib/sidebar/sidebarVisibleFilterMenu";
import { isTdengineStableTableType } from "@/lib/table/tableEditing";

const PINNED_TREE_NODES_STORAGE_KEY = "dbx-pinned-tree-nodes";
const ACTIVE_CONNECTION_STORAGE_KEY = "dbx-active-connection";
const SIDEBAR_TABLE_NAME_FILTERS_STORAGE_KEY = "dbx-sidebar-table-name-filters";
const CONNECTION_HEALTH_CHECK_TTL_MS = 2000;
const CONNECTION_HEALTH_CHECK_TIMEOUT_MS = 5000;
const METADATA_LOAD_MIN_TIMEOUT_MS = 15_000;
const METADATA_LOAD_DISABLED_QUERY_TIMEOUT_MS = 60_000;
const DISCONNECT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_KEEPALIVE_INTERVAL_SECS = 30;
const METADATA_LIST_PAGE_CACHE_TTL_MS = 30_000;
const METADATA_LIST_PAGE_CACHE_MAX_ENTRIES = 160;
const SIDEBAR_DATABASE_STORAGE_CACHE_TTL_MS = 30_000;
const SIDEBAR_DATABASE_STORAGE_CACHE_MAX_ENTRIES = 32;
const SIDEBAR_TABLE_STORAGE_CACHE_MAX_ENTRIES = 64;
const SIDEBAR_TABLE_SEARCH_INDEX_CACHE_MAX_ENTRIES = 32;
export const COMPLETION_METADATA_CONCURRENCY = 2;
const MONGO_LEGACY_DRIVER_PROFILE = "mongodb-legacy";
const MONGO_LEGACY_DRIVER_LABEL = "MongoDB (Legacy)";
const XUGU_TABLE_CHILD_METADATA_AGENT_VERSION = "0.1.23";
const SUPERSEDED_CONNECTION_ATTEMPT_MESSAGE = "Connection attempt was superseded by a newer attempt";
const SHARDINGSPHERE_PROXY_VERSION_MARKER = "shardingsphere-proxy";

function usesShardingSphereLogicalTables(databaseInfo: DatabaseConnectionInfo | undefined): boolean {
  return databaseInfo?.productVersion?.toLowerCase().includes(SHARDINGSPHERE_PROXY_VERSION_MARKER) === true;
}

function mysqlTableListSourceChanged(config: ConnectionConfig, databaseInfo: DatabaseConnectionInfo): boolean {
  return config.db_type === "mysql" && usesShardingSphereLogicalTables(config.database_info) !== usesShardingSphereLogicalTables(databaseInfo);
}

function normalizeTableNameFilter(filter: Partial<TableNameFilter> | undefined | null): TableNameFilter {
  const normalizePatterns = (patterns: unknown): string[] => (Array.isArray(patterns) ? patterns.map((pattern) => (typeof pattern === "string" ? pattern.trim() : "")).filter(Boolean) : []);
  return {
    includePatterns: normalizePatterns(filter?.includePatterns),
    excludePatterns: normalizePatterns(filter?.excludePatterns),
  };
}

function tableNameFilterIsEmpty(filter: TableNameFilter | undefined | null): boolean {
  return !filter || (filter.includePatterns.length === 0 && filter.excludePatterns.length === 0);
}

function loadSidebarTableNameFilters(): Record<string, TableNameFilter> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed = JSON.parse(localStorage.getItem(SIDEBAR_TABLE_NAME_FILTERS_STORAGE_KEY) || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, TableNameFilter> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const filter = normalizeTableNameFilter(value as Partial<TableNameFilter>);
      if (!tableNameFilterIsEmpty(filter)) result[key] = filter;
    }
    return result;
  } catch {
    return {};
  }
}

function saveSidebarTableNameFilters(filters: Record<string, TableNameFilter>) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(SIDEBAR_TABLE_NAME_FILTERS_STORAGE_KEY, JSON.stringify(filters));
}

function sidebarObjectGroupPageSize(): number {
  const settingsStore = useSettingsStore();
  const size = settingsStore.desktopSettings.sidebar_table_page_size;
  return typeof size === "number" && size > 0 ? size : 500;
}

/**
 * Upper bound for a single remote fuzzy table-search result set.
 *
 * Every fuzzy match travels database → IPC → store → tree rendering, so an
 * unbounded result set (e.g. a single-letter query against a large schema)
 * would push thousands of rows through the whole pipeline. The budget is 4×
 * the default page size (500) and comfortably covers the reported #6190
 * schema (801 fuzzy matches) while keeping a single IPC payload bounded.
 * Queries whose fuzzy match set exceeds the budget are truncated; narrowing
 * the query reaches later tables.
 */
export const SIDEBAR_TABLE_SEARCH_RESULT_BUDGET = 2000;

function isFlatMqConnection(config: ConnectionConfig | undefined): boolean {
  if (!config || config.db_type !== "mq") return false;
  if (config.driver_profile === "kafka" || config.driver_profile === "rocketmq" || config.driver_profile === "rabbitmq") return true;
  const kind = (config.external_config as Partial<MqAdminConfig> | undefined)?.systemKind;
  return kind === "kafka" || kind === "rocketmq" || kind === "rabbitmq";
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
let pendingDataGripPayload: { format: "datagrip-import"; dataSources: string; dataSourcesLocal?: string; dbForestConfig?: string } | null = null;

interface TreeClipboardTableEntry {
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
  tableComment?: string | null;
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
    }
  | {
      kind: "saved-sql-copy";
      fileIds: string[];
    };

interface LoadTreeOptions {
  force?: boolean;
  connectedOnly?: boolean;
  expectedSidebarSearchQuery?: string;
  searchFilter?: string;
  // Explicit actions can load the unfiltered backing group while the global search
  // continues to control presentation; normal watcher refreshes still reject mismatches.
  allowGlobalSearchMismatch?: boolean;
  onChildrenApplied?: (node: TreeNode) => void;
  sidebarTableSearchParentId?: string;
  expectedSidebarTableSearchQuery?: string;
  tableNameFilterScopeKey?: string;
  expectedTableNameFilterRevision?: number;
  preserveCollapsedChildren?: boolean;
}

interface PersistedTreeChildrenLoadResult {
  hit: boolean;
  isStale: boolean;
}

type MetadataListPageResult = TableInfo[] | ObjectInfo[];

type BeforeConnectHandler = (config: ConnectionConfig) => Promise<void>;

export const CONNECTION_ATTEMPT_CANCELLED_MESSAGE = "Connection attempt was cancelled";
/** Thrown when a no-save-password connection is connected without a typed password. */
export const CONNECTION_PASSWORD_REQUIRED_MESSAGE = "Password is required for this connection";

function metadataDriverProfile(config?: ConnectionConfig): string | undefined {
  return config?.driver_profile || config?.db_type;
}

export const useConnectionStore = defineStore("connection", () => {
  const settingsStore = useSettingsStore();
  const tunnelProfileStore = useTunnelProfileStore();
  const savedSqlStore = useSavedSqlStore();
  let savedSqlFilesByDatabase = indexSavedSqlFilesByDatabase(savedSqlStore.allFiles);
  const connections = ref<ConnectionConfig[]>([]);
  const isDesktop = isTauriRuntime();
  // Prefer a safe read so Node/vitest (missing or partial storage mocks) do not
  // throw when query tabs resolve connection db_type defaults via this store.
  const activeConnectionId = ref<string | null>(
    (() => {
      try {
        const storage = globalThis.localStorage;
        if (!storage || typeof storage.getItem !== "function") return null;
        return storage.getItem(ACTIVE_CONNECTION_STORAGE_KEY);
      } catch {
        return null;
      }
    })(),
  );
  const selectedTreeNodeId = ref<string | null>(null);
  const selectedTreeNodeIds = ref<string[]>([]);
  // O(1) membership set — rebuilds only when selectedTreeNodeIds changes.
  // Avoids O(N) Array.includes() in every visible TreeItem's isMultiSelected
  // computed during scrolling and selection changes.
  const selectedTreeNodeIdsSet = computed(() => new Set(selectedTreeNodeIds.value));
  const treeSelectionAnchorId = ref<string | null>(null);
  // Legacy name: this flag now covers homogeneous checkbox selections for both
  // connections and connection groups. Connection-only toolbars still filter
  // selected ids against the saved connection list.
  const connectionMultiSelectActive = ref(false);
  const treeClipboard = ref<TreeClipboard | null>(null);

  watch(activeConnectionId, (id) => {
    try {
      const storage = globalThis.localStorage;
      if (!storage || typeof storage.setItem !== "function" || typeof storage.removeItem !== "function") return;
      if (id) storage.setItem(ACTIVE_CONNECTION_STORAGE_KEY, id);
      else storage.removeItem(ACTIVE_CONNECTION_STORAGE_KEY);
    } catch {
      // Ignore storage failures in non-browser / partial mock environments.
    }
  });
  const treeNodes = ref<TreeNode[]>([]);
  const sidebarDatabaseStorageCache = new MetadataResultCache<DatabaseStorageInfo[]>({
    ttlMs: SIDEBAR_DATABASE_STORAGE_CACHE_TTL_MS,
    maxEntries: SIDEBAR_DATABASE_STORAGE_CACHE_MAX_ENTRIES,
  });
  const sidebarDatabaseStorageInFlight = new Map<string, Promise<DatabaseStorageInfo[]>>();
  const sidebarTableStorageCache = new MetadataResultCache<ObjectStatistics[]>({
    ttlMs: SIDEBAR_DATABASE_STORAGE_CACHE_TTL_MS,
    maxEntries: SIDEBAR_TABLE_STORAGE_CACHE_MAX_ENTRIES,
  });
  const sidebarTableStorageInFlight = new Map<string, Promise<ObjectStatistics[]>>();
  const pinnedTreeNodeOrder = ref<string[]>([]);
  const pinnedTreeNodeIds = ref<Set<string>>(new Set());
  const activePinnedTreeNodeReorderKey = ref<string | null>(null);
  let pinnedTreeNodePersistQueue: Promise<void> = Promise.resolve();
  const connectedIds = ref<Set<string>>(new Set());
  const identifierQuotes = ref<Record<string, string>>({});
  const lastConnectionHealthCheckAt = ref<Record<string, number>>({});
  const agentDrivers = ref<AgentDriverInstallState[]>([]);
  let agentDriversRefreshPromise: Promise<void> | null = null;
  let localAgentDriversRefreshPromise: Promise<void> | null = null;
  const loadedTreeNodeChildrenIds = ref<Set<string>>(new Set());
  /** Simple-mode database/schema nodes loaded successfully with zero objects (not refresh stale shells). */
  const confirmedEmptyTreeNodeIds = ref<Set<string>>(new Set());
  const connectionErrors = ref<Record<string, string>>({});
  const connectingIds = ref<Set<string>>(new Set());
  const editingConnectionId = ref<string | null>(null);
  const newConnectionGroupId = ref<string | null>(null);
  const completionTablesCache = ref<Record<string, SqlCompletionTable[]>>({});
  const completionObjectsCache = ref<Record<string, SqlCompletionObject[]>>({});
  const completionColumnsCache = ref<Record<string, ColumnInfo[]>>({});
  const completionForeignKeysCache = ref<Record<string, ForeignKeyInfo[]>>({});
  const completionDatabasesCache = ref<Record<string, string[]>>({});
  const primaryVisibleObjectNames = ref<Record<string, string[]>>({});
  const sqlServerCompletionContextCache = ref<Record<string, SqlServerCompletionContext>>({});
  const elasticsearchCompletionIndicesCache = ref<Record<string, string[]>>({});
  const redisCompletionKeysCache = ref<Record<string, string[]>>({});
  const redisCommandDocsCache = ref<Record<string, RedisCommandDocumentation[]>>({});
  const redisCommandDocsCacheGeneration = new Map<string, number>();
  const mongoCompletionCollectionsCache = ref<Record<string, string[]>>({});
  const mongoCompletionFieldsCache = ref<Record<string, MongoCompletionField[]>>({});
  const schemaListCache = ref<Record<string, string[]>>({});
  const sidebarSearchQuery = ref("");
  const sidebarTableSearchQueries = ref<Record<string, string>>({});
  // Local table indexes are immutable snapshots until an explicit refresh.
  // Keep both resolved values and in-flight reads here so regex typing does
  // not reread SQLite for every keypress or issue duplicate concurrent loads.
  const sidebarTableSearchIndexCache = new Map<string, TableInfo[] | null>();
  const sidebarTableSearchIndexInFlight = new Map<string, Promise<TableInfo[] | null>>();
  const sidebarTableSearchIndexConnectionGenerations = new Map<string, number>();
  const sidebarTableSearchIndexScopeGenerations = new Map<string, number>();
  const sidebarTableSearchIndexPersistenceQueues = new Map<string, Promise<void>>();
  const sidebarTableSearchIndexInvalidation = ref<{
    revision: number;
    scopes: Array<SidebarRegexScopeIdentity & { parentNodeId: string }>;
  }>({ revision: 0, scopes: [] });
  let sidebarTableSearchIndexManifest: TableSearchIndexManifestEntry[] | null = null;
  let sidebarTableSearchIndexManifestInFlight: Promise<TableSearchIndexManifestEntry[]> | null = null;
  let sidebarTableSearchIndexManifestWriteQueue: Promise<void> = Promise.resolve();
  const sidebarTableNameFilters = ref<Record<string, TableNameFilter>>(loadSidebarTableNameFilters());
  const sidebarTableNameFilterRevisions = new Map<string, number>();
  const completionTableIndex = new Map<string, { touched: number; tables: SqlCompletionTable[] }>();
  const completionObjectIndex = new Map<string, { touched: number; objects: SqlCompletionObject[] }>();
  const completionColumnIndex = new Map<string, { touched: number; columns: SqlCompletionColumn[] }>();
  const completionColumnPrefixIndex = new Map<string, { touched: number; columns: SqlCompletionColumn[]; complete: boolean }>();
  const completionForeignKeyIndex = new Map<string, { touched: number; foreignKeys: SqlCompletionForeignKey[] }>();
  const completionInFlight = new Map<string, Promise<unknown>>();
  const completionCacheRevisions = ref<Record<string, number>>({});
  const completionMetadataLimiter = new MetadataTaskLimiter(COMPLETION_METADATA_CONCURRENCY, (event) => {
    console.debug("[DBX][completion-metadata:limit]", event);
  });
  const transferSource = ref<{
    connectionId: string;
    database: string;
    catalog?: string;
    schema?: string;
    tables?: string[];
    targetConnectionId?: string;
    targetDatabase?: string;
    targetSchema?: string;
  } | null>(null);
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
    tableNames?: string[];
  } | null>(null);
  const docsSource = ref<{
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
  const connectionGroupOptions = computed(() => connectionGroupDestinationRows(sidebarLayout.value));
  const selectedConnectionGroupId = computed(() => {
    const selectedNodeId = selectedTreeNodeId.value;
    const selectedNode = selectedNodeId ? findNode(treeNodes.value, selectedNodeId) : null;
    return connectionGroupIdForSelection(sidebarLayout.value, selectedNodeId, selectedNode?.connectionId);
  });
  let layoutPersistTimer: ReturnType<typeof setTimeout> | null = null;
  const staleTreeRefreshIds = new Set<string>();
  const activeTreeRefreshGenerations = new Map<string, number>();
  let nextTreeRefreshGeneration = 0;
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
  const tableListSourceRevisions = new Map<string, number>();
  const treeNodeLoads = new TreeNodeLoadRegistry();
  const filteredObjectGroupChildrenIds = new Set<string>();
  const primaryVisibleObjectRefreshInFlight = new Set<string>();
  let nextLocalConnectionAttempt = 0;
  let beforeConnectHandler: BeforeConnectHandler | null = null;
  let initFromDiskPromise: Promise<void> | null = null;

  // Loading/stale ownership stays on TreeNodeLoadRegistry (per-node generation), not the
  // coordinator: many specialty loaders bypass runTreeMetadataLoad, and coordinator would
  // otherwise need TreeNode/connected awareness. Keep coordinator for scope dedupe only.
  // connectionStateRevision remains for disconnect/error cleanup; reconnect also invalidates
  // tree loads via bump → treeNodeLoads.invalidateConnection.
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
    const override = gaussdbIdentifierQuoteOverride(getConfig(connectionId));
    if (override != null) return override;
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
    if (!connectionShouldLoadIdentifierQuote(config)) return;
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
    // Invalidate per-node load generations under this connection (and clear sticky
    // spinners on surviving nodes). Active loaders reclaim after ensureConnected.
    treeNodeLoads.invalidateConnection(connectionId, findConnectionNode(connectionId));
    return revision;
  }

  function connectionStateRevision(connectionId: string): number {
    return connectionStateRevisions.get(connectionId) ?? 0;
  }

  function isCurrentConnectionStateRevision(connectionId: string, revision: number): boolean {
    return connectionStateRevision(connectionId) === revision;
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

  /**
   * One-time connections are never persisted, so the backend's "not in the saved
   * list, so reclaim it" branch in `sync_connection_configs` never fires for them
   * (see dbx-core `should_retain_runtime_config`) and `disconnect_db` is the only
   * reclaim point. Removing one must disconnect it explicitly, or its runtime
   * config, pool, and tunnel live until the process exits.
   *
   * `clientAttempt` is deliberately omitted: removal is terminal, so a superseded
   * attempt number must not skip the cleanup.
   */
  function releaseOneTimeRuntimeConnections(connectionIds: string[]) {
    for (const connectionId of connectionIds) {
      let request: Promise<void>;
      try {
        request = api.disconnectDb(connectionId);
      } catch (error) {
        request = Promise.reject(error);
      }
      void trackDisconnectRequest(connectionId, request, false).catch(() => {});
    }
  }

  /**
   * A one-time connection is deleted outright rather than left behind for a
   * reconnect, so its tabs have nothing to point at once it is gone: executing in
   * one would fail with "Connection config not found". Close them regardless of
   * `disconnectTabHandlingMode`, which only makes sense for connections that can
   * still be reconnected.
   */
  async function closeOneTimeConnectionTabs(connectionIds: string[]) {
    if (!connectionIds.length) return;
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    for (const connectionId of connectionIds) {
      queryStore.closeConnectionTabs(connectionId, { force: true });
    }
  }

  async function cleanupRemovedOneTimeConnections(connectionIds: string[]) {
    try {
      await closeOneTimeConnectionTabs(connectionIds);
    } catch (error) {
      console.warn("[DBX][connection:delete:one-time-tab-cleanup-failed]", { connectionIds, error });
    }
    releaseOneTimeRuntimeConnections(connectionIds);
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
    if (!hasAgentDriverUpdate(config.db_type, agentDrivers.value, config.driver_profile, { ssh: connectionUsesSsh(config) })) return message;
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

  function refreshLocalAgentDrivers(): Promise<void> {
    if (localAgentDriversRefreshPromise) return localAgentDriversRefreshPromise;
    localAgentDriversRefreshPromise = api
      .listInstalledAgentsLocal()
      .then((drivers) => {
        agentDrivers.value = drivers;
      })
      .catch(() => undefined)
      .finally(() => {
        localAgentDriversRefreshPromise = null;
      });
    return localAgentDriversRefreshPromise;
  }

  async function supportsXuguTableChildMetadata(): Promise<boolean> {
    if (!hasInstalledAgentVersion(agentDrivers.value, "xugu", XUGU_TABLE_CHILD_METADATA_AGENT_VERSION)) {
      await refreshLocalAgentDrivers();
    }
    return hasInstalledAgentVersion(agentDrivers.value, "xugu", XUGU_TABLE_CHILD_METADATA_AGENT_VERSION);
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
    clearSidebarStorageCaches(connectionId);
    clearPrimaryVisibleObjectNames(connectionId);
    clearConnectionIdentifierQuote(connectionId);
    clearConnectionNodeLoading(connectionId);
    clearConnectionHealthCheck(connectionId);
    if (activeConnectionId.value === connectionId) activeConnectionId.value = null;
    recordConnectionError(connectionId, error);
    // 被动断链同样是元数据生命周期边界：查询/健康检查发现连接已失效后，
    // 不得继续把旧 tableMeta 当作当前代次的 warm cache（PR #6640 blocker 3）。
    invalidateConnectionMetadataLifetime(connectionId);
  }

  function recordConnectionLostError(connectionId: string, error: unknown): boolean {
    if (shouldMarkDisconnected(error)) {
      markConnectionLost(connectionId, error);
      return true;
    }
    return false;
  }

  // Metadata loaders keep this internal: match connection-loss errors before recording generic errors.
  function recordMetadataLoadError(connectionId: string, error: unknown, load?: TreeNodeLoadHandle) {
    if (load && !load.isCurrent()) return;
    if (recordConnectionLostError(connectionId, error)) return;
    recordConnectionError(connectionId, error);
  }

  async function withConnectionAttemptTimeout<T>(promise: Promise<T>, config: ConnectionConfig): Promise<T> {
    const timeoutMs = connectionAttemptTimeoutMs(config, tunnelProfileStore.profileById);
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
    config = { ...config };
    migrateSqlServerLegacyCompatibilityConfig(config);
    const connectTimeoutInherit = config.connect_timeout_inherit ?? settingsStore.editorSettings.connectTimeoutInheritConnectionIds.includes(config.id);
    const queryTimeoutInherit = config.query_timeout_inherit ?? settingsStore.editorSettings.queryTimeoutInheritConnectionIds.includes(config.id);
    const labelMap: Record<string, string> = {
      mysql: "MySQL",
      postgres: "PostgreSQL",
      sqlite: "SQLite",
      redis: "Redis",
      etcd: "etcd",
      zookeeper: "Apache ZooKeeper",
      consul: "Consul",
      duckdb: "DuckDB",
      clickhouse: "ClickHouse",
      sqlserver: "SQL Server",
      mongodb: "MongoDB",
      oracle: "Oracle",
      "mongodb-legacy": MONGO_LEGACY_DRIVER_LABEL,
      elasticsearch: "Elasticsearch",
      easysearch: "Easysearch",
      meilisearch: "Meilisearch",
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
      kingbase: "金仓KingbaseES",
      highgo: "瀚高 HighGo",
      uxdb: "优炫 UXDB",
      yashandb: "崖山 YashanDB",
      vastbase: "海量 Vastbase",
      goldendb: "金篆 GoldenDB",
      access: "Microsoft Access",
      h2: "H2",
      snowflake: "Snowflake",
      trino: "Trino",
      prestosql: "PrestoSQL",
      hive: "Hive",
      kyuubi: "Apache Kyuubi",
      impala: "Apache Impala",
      spark: "Apache Spark",
      db2: "DB2",
      informix: "Informix",
      phoenix: "Apache Phoenix",
      neo4j: "Neo4j",
      cassandra: "Cassandra",
      bigquery: "BigQuery",
      spanner: "Cloud Spanner",
      kylin: "Kylin",
      ignite: "Apache Ignite",
      ignite3: "Apache Ignite 3",
      sundb: "科蓝 SUNDB",
      oscar: "神通 OSCAR",
      influxdb: "InfluxDB",
      victoriametrics: "VictoriaMetrics",
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
    } else if (profile === "uxdb" && dbType === "postgres") {
      dbType = "uxdb" as ConnectionConfig["db_type"];
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
      // A cleared field must become absent, not "". `resolve_notes_path` treats
      // blank as unset anyway, but an empty string would still be written to
      // the config file as though a path had been chosen.
      docs_notes_path: config.docs_notes_path?.trim() ? config.docs_notes_path.trim() : undefined,
      transport_layers: Array.isArray(config.transport_layers) ? config.transport_layers : [],
      show_system_schemas: config.show_system_schemas === true,
      connect_timeout_secs: connectTimeoutInherit ? settingsStore.editorSettings.globalConnectTimeoutSecs : config.connect_timeout_secs || 10,
      connect_timeout_inherit: connectTimeoutInherit,
      query_timeout_secs: queryTimeoutInherit ? settingsStore.editorSettings.globalQueryTimeoutSecs : (config.query_timeout_secs ?? 30),
      query_timeout_inherit: queryTimeoutInherit,
      idle_timeout_secs: config.idle_timeout_secs ?? 60,
      keepalive_interval_secs: config.keepalive_interval_secs ?? DEFAULT_KEEPALIVE_INTERVAL_SECS,
      redis_database_aliases: normalizeRedisDatabaseAliases(config.redis_database_aliases),
      redis_key_templates: (() => {
        const templates = normalizeRedisKeyTemplates(config.redis_key_templates);
        return templates.length > 0 ? templates : undefined;
      })(),
      database_info: normalizeDatabaseConnectionInfo(config.database_info),
    };
  }

  function loadPinnedTreeNodeOrderFromLocalStorage(): string[] {
    try {
      if (typeof localStorage === "undefined") return [];
      const saved = localStorage.getItem(PINNED_TREE_NODES_STORAGE_KEY);
      const ids = saved ? JSON.parse(saved) : [];
      return normalizePinnedTreeNodeOrder(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
    } catch {
      return [];
    }
  }

  async function loadPinnedTreeNodeOrder(): Promise<string[]> {
    if (!isDesktop) return loadPinnedTreeNodeOrderFromLocalStorage();
    const ids = await api.loadPinnedTreeNodeIds().catch(() => []);
    const valid = normalizePinnedTreeNodeOrder(ids.filter((id): id is string => typeof id === "string"));
    if (valid.length > 0) return valid;

    // Migrate legacy localStorage values for existing desktop users.
    const legacy = loadPinnedTreeNodeOrderFromLocalStorage();
    if (legacy.length > 0) {
      await api.savePinnedTreeNodeIds(legacy).catch(() => undefined);
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(PINNED_TREE_NODES_STORAGE_KEY);
      }
    }
    return legacy;
  }

  function setPinnedTreeNodeOrder(order: readonly string[]) {
    const normalized = normalizePinnedTreeNodeOrder(order);
    pinnedTreeNodeOrder.value = normalized;
    pinnedTreeNodeIds.value = new Set(normalized);
  }

  function persistPinnedTreeNodeIds() {
    const snapshot = [...pinnedTreeNodeOrder.value];
    if (isDesktop) {
      // A later drag must never be persisted before an earlier request finishes:
      // otherwise a slow old request can overwrite the final ordering on disk.
      pinnedTreeNodePersistQueue = pinnedTreeNodePersistQueue.catch(() => undefined).then(() => api.savePinnedTreeNodeIds(snapshot).catch(() => undefined));
      return;
    }
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(PINNED_TREE_NODES_STORAGE_KEY, JSON.stringify(snapshot));
  }

  function findLoadedTreeNodeById(nodes: readonly TreeNode[], id: string): TreeNode | null {
    for (const node of nodes) {
      if (node.id === id) return node;
      const child = node.children ? findLoadedTreeNodeById(node.children, id) : null;
      if (child) return child;
      const hiddenChild = node.hiddenChildren ? findLoadedTreeNodeById(node.hiddenChildren, id) : null;
      if (hiddenChild) return hiddenChild;
    }
    return null;
  }

  function isTreeNodePinned(node: TreeNode | string): boolean {
    if (typeof node !== "string") return pinnedTreeNodeIds.value.has(treeNodePinKey(node)) || pinnedTreeNodeIds.value.has(node.id);
    if (pinnedTreeNodeIds.value.has(node)) return true;
    const loadedNode = findLoadedTreeNodeById(treeNodes.value, node);
    return !!loadedNode && pinnedTreeNodeIds.value.has(treeNodePinKey(loadedNode));
  }

  function isFixedPriorityTreeNode(node: TreeNode): boolean {
    if (node.type === "schema") {
      return !!node.connectionId && !!node.schema && isDefaultSchema(node.connectionId, node.schema);
    }
    if (node.type !== "database" && node.type !== "redis-db" && node.type !== "mongo-db") return false;
    return !!node.connectionId && typeof node.database === "string" && isDefaultDatabase(node.connectionId, node.database);
  }

  function orderByPinnedTreeNodes<T>(items: readonly T[], matches: (item: T, identity: PinnedTreeNodeIdentity) => boolean): T[] {
    return orderItemsByPinnedTreeNodeOrder(items, pinnedTreeNodeOrder.value, matches, treeNodes.value);
  }

  function syncPinnedTreeState(nodes: TreeNode[]) {
    syncPinnedTreeNodeStateInPlace(nodes, pinnedTreeNodeIds.value, pinnedTreeNodeOrder.value, isFixedPriorityTreeNode);
  }

  function isConnectionUtilityNode(node: TreeNode): boolean {
    // dameng-users / dameng-roles must be here too: they are synthesized admin
    // nodes (fixed ids, rebuilt on every re-normalization). If they were treated
    // as metadata children, withConnectionUtilityNodes would keep the old copies
    // AND append fresh ones on every useCachedChildren pass, duplicating the
    // 用户/角色 menus once per refresh cycle.
    return node.type === "user-admin" || node.type === "dameng-users" || node.type === "dameng-roles" || node.type === "dameng-job-admin" || node.type === "group-tablespaces" || node.type === "saved-sql-root";
  }

  function connectionMetadataChildren(children: TreeNode[] | undefined): TreeNode[] {
    return (children || []).filter((child) => !isConnectionUtilityNode(child));
  }

  function hasConnectionMetadataChildren(children: TreeNode[] | undefined): boolean {
    return connectionMetadataChildren(children).length > 0;
  }

  // `trustEmptyMetadataChildren` distinguishes two very different reasons this
  // reload's metadata children can come back empty: the backend's raw fetch
  // returned nothing at all (still ambiguous/possibly transient — keep the
  // stale-preserve protection below), vs. the raw fetch had data but our own
  // visible-databases/visible-schemas filter deterministically reduced it to
  // zero (e.g. the only visible database was just dropped) — that emptiness
  // is legitimate and must not be overridden by stale cached children.
  function preserveExistingConnectionMetadataChildren(parent: TreeNode, children: TreeNode[], trustEmptyMetadataChildren = false): TreeNode[] {
    if (parent.type !== "connection" || hasConnectionMetadataChildren(children)) return children;
    if (trustEmptyMetadataChildren) return children;

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
  const LEAF_TREE_NODE_TYPES = new Set<TreeNode["type"]>(["column", "index", "fkey", "trigger", "event", "type-member"]);

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

  function clearDescendantLoadedChildrenMarkers(parentId: string) {
    const descendantPrefix = `${parentId}:`;
    for (const id of loadedTreeNodeChildrenIds.value) {
      if (id.startsWith(descendantPrefix)) loadedTreeNodeChildrenIds.value.delete(id);
    }
    for (const id of confirmedEmptyTreeNodeIds.value) {
      if (id.startsWith(descendantPrefix)) confirmedEmptyTreeNodeIds.value.delete(id);
    }
  }

  /** Drop loaded/confirmed-empty markers, metadata caches, and generations for a discarded shell. */
  function forgetTreeNodeLoadState(nodeId: string) {
    filteredObjectGroupChildrenIds.delete(nodeId);
    clearLoadedChildrenCache(nodeId);
    treeNodeLoads.invalidatePrefix(nodeId);
  }

  function syncConfirmedEmptyTreeNodeId(parent: TreeNode) {
    if (parent.type !== "database" && parent.type !== "schema" && parent.type !== "linked-server-schema") return;
    const childCount = parent.children?.filter((child) => child.type !== "saved-sql-root").length ?? 0;
    if (childCount === 0) confirmedEmptyTreeNodeIds.value.add(parent.id);
    else confirmedEmptyTreeNodeIds.value.delete(parent.id);
  }

  function sameConnectionMetadataChildIds(existing: TreeNode[] | undefined, next: TreeNode[]): boolean {
    const previousIds = new Set(connectionMetadataChildren(existing).map((child) => child.id));
    const nextIds = new Set(connectionMetadataChildren(next).map((child) => child.id));
    if (previousIds.size !== nextIds.size) return false;
    for (const id of previousIds) {
      if (!nextIds.has(id)) return false;
    }
    return true;
  }

  function directChildIdWasRemoved(existing: TreeNode[] | undefined, next: TreeNode[]): boolean {
    const nextIds = new Set(next.map((child) => child.id));
    for (const child of existing ?? []) {
      // Pagination placeholders are replaced on every page fetch, not structural removals.
      if (child.type === "load-more") continue;
      if (!nextIds.has(child.id)) return true;
    }
    return false;
  }

  function shouldClearDescendantLoadedMarkers(parent: TreeNode, nextChildren: TreeNode[]): boolean {
    if (parent.type === "connection") {
      return !sameConnectionMetadataChildIds(parent.children, nextChildren);
    }
    if (parent.type === "database" || parent.type === "schema" || parent.type === "linked-server-schema" || objectTypesForGroupNode(parent.type)) {
      return directChildIdWasRemoved(parent.children, nextChildren);
    }
    return false;
  }

  function dedupeTreeNodeChildrenById(children: TreeNode[]): TreeNode[] {
    // Keep the LAST occurrence of each id (reverse pass): if a stale copy was
    // preserved ahead of a freshly synthesized node with the same id, the fresh
    // node — carrying the current members/data — is the one that must survive.
    const seen = new Set<string>();
    const deduped: TreeNode[] = [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      deduped.push(child);
    }
    deduped.reverse();
    return deduped;
  }

  function setChildren(parent: TreeNode, children: TreeNode[], options?: { trustEmptyConnectionChildren?: boolean }) {
    // Compare markers against the resolved child list (after connection preserve), not the raw loader payload.
    children = preserveExistingConnectionMetadataChildren(parent, children, options?.trustEmptyConnectionChildren === true);
    children = decorateDatabaseSavedSqlTreeNodes(children, savedSqlFilesByDatabase, parent.children);
    if (parent.type === "database") {
      children = withDatabaseSavedSqlRoot(parent, children, savedSqlFilesByDatabase);
    }
    // Defensive: sibling ids must be unique (RecycleScroller keys rows by id).
    // The Dameng users/roles admin nodes were once re-appended by every
    // re-normalization, leaving duplicate rows in the sidebar; last-wins keeps
    // the freshly synthesized copy so such a regression can never surface as
    // repeated menus or stale member data.
    children = dedupeTreeNodeChildrenById(children);
    if (shouldClearDescendantLoadedMarkers(parent, children)) {
      clearDescendantLoadedChildrenMarkers(parent.id);
      // Parent load may still be current; only supersede descendant generations.
      treeNodeLoads.invalidateDescendants(parent.id);
    }
    if (parent.children && parent.children.length > 0) {
      const oldMap = new Map(parent.children.map((c) => [c.id, c] as const));
      const nextIds = new Set(children.map((child) => child.id));
      for (const [oldId, old] of oldMap) {
        // Removed children keep no loaded markers; also bump generations so in-flight
        // loads cannot apply if the same id is recreated later.
        if (!nextIds.has(oldId) && old.type !== "load-more") {
          forgetTreeNodeLoadState(oldId);
        }
      }
      children = children.map((child) => {
        const old = oldMap.get(child.id);
        if (old?.isLoading) {
          const isExpanded = old.isExpanded;
          const isLoading = old.isLoading;
          const oldChildren = old.children;
          const objectCount = child.objectCount ?? old.objectCount;
          Object.assign(old, child);
          old.isExpanded = isExpanded;
          old.isLoading = isLoading;
          old.children = oldChildren;
          old.objectCount = objectCount;
          return old;
        }
        if (old?.isExpanded) {
          return { ...child, isExpanded: true, children: old.children, objectCount: child.objectCount ?? old.objectCount };
        }
        if (old && objectTypesForGroupNode(old.type)) {
          return { ...child, objectCount: child.objectCount ?? old.objectCount };
        }
        // Same-id collapsed database/schema shell replace (e.g. DDL → force loadDatabases):
        // prior confirmed-empty markers belong to the discarded instance and must not skip
        // the next expand reload. Do not do this for tables/groups — load-more and list
        // refresh must preserve nested loaded markers (columns, etc.).
        if (old && (old.type === "database" || old.type === "schema" || old.type === "linked-server-schema")) {
          forgetTreeNodeLoadState(child.id);
        }
        return child;
      });
    }
    const migratedPins = migrateLegacyPinnedTreeNodeOrder(children, pinnedTreeNodeOrder.value);
    if (migratedPins.changed) {
      setPinnedTreeNodeOrder(migratedPins.order);
      persistPinnedTreeNodeIds();
    }
    syncPinnedTreeState(children);
    parent.children = markRawLeafTreeNodes(children);
    loadedTreeNodeChildrenIds.value.add(parent.id);
    syncConfirmedEmptyTreeNodeId(parent);
  }

  function removePinnedTreeNodes(nodes: readonly TreeNode[], canonicalize: PinnedTreeNodeIdentityCanonicalizer = (identity) => identity, legacyKeys: readonly string[] = []): boolean {
    const nextPinnedOrder = removePinnedTreeNodesFromOrder(pinnedTreeNodeOrder.value, nodes, canonicalize, legacyKeys);
    if (nextPinnedOrder.length === pinnedTreeNodeOrder.value.length && nextPinnedOrder.every((key, index) => key === pinnedTreeNodeOrder.value[index])) return false;
    setPinnedTreeNodeOrder(nextPinnedOrder);
    syncPinnedTreeState(treeNodes.value);
    persistPinnedTreeNodeIds();
    return true;
  }

  function replacePinnedTreeNode(oldNode: TreeNode, newNode: TreeNode, canonicalize: PinnedTreeNodeIdentityCanonicalizer = (identity) => identity, legacyKeys: readonly string[] = []): boolean {
    // Use the freshly loaded sidebar node when available so the persisted key
    // carries its real id, not the id of the pre-rename object.
    const loadedReplacement = findTreeNodes(treeNodes.value, (node) => pinnedTreeNodeIdentityMatches(treeNodePinIdentity(node), treeNodePinIdentity(newNode), canonicalize))[0];
    // A caller may provide a virtual row while the sidebar object is unloaded;
    // persisting that row id would create a pin that the sidebar cannot restore.
    const nextPinnedOrder = loadedReplacement ? replacePinnedTreeNodeInOrder(pinnedTreeNodeOrder.value, oldNode, loadedReplacement, canonicalize, legacyKeys) : removePinnedTreeNodesFromOrder(pinnedTreeNodeOrder.value, [oldNode], canonicalize, legacyKeys);
    if (nextPinnedOrder.length === pinnedTreeNodeOrder.value.length && nextPinnedOrder.every((key, index) => key === pinnedTreeNodeOrder.value[index])) return false;
    setPinnedTreeNodeOrder(nextPinnedOrder);
    syncPinnedTreeState(treeNodes.value);
    persistPinnedTreeNodeIds();
    return true;
  }

  function removeTreeNode(nodeId: string) {
    const node = findNode(treeNodes.value, nodeId);
    if (node) removePinnedTreeNodes([node]);

    const parent = findParentNode(treeNodes.value, nodeId);
    if (parent?.children) {
      parent.children = parent.children.filter((c) => c.id !== nodeId);
      // Keep the group badge in sync with remaining real children (exclude load-more).
      if (parent.objectCount != null) {
        parent.objectCount = withoutLoadMoreNodes(parent.children).length;
      }
    }
    if (parent?.hiddenChildren) {
      parent.hiddenChildren = parent.hiddenChildren.filter((child) => child.id !== nodeId);
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

  function buildDamengUserNode(connectionId: string, existingConnectionNode?: TreeNode): TreeNode | undefined {
    const config = getConfig(connectionId);
    if (effectiveDatabaseTypeForConnection(config) !== "dameng") return undefined;
    const existing = existingConnectionNode?.children?.find((child) => child.type === "dameng-users");
    return {
      id: `${connectionId}:__dameng_users`,
      label: "tree.damengUsers",
      type: "dameng-users",
      connectionId,
      database: "",
      isExpanded: existing?.isExpanded ?? false,
    };
  }

  function buildDamengRoleNode(connectionId: string, existingConnectionNode?: TreeNode): TreeNode | undefined {
    const config = getConfig(connectionId);
    if (effectiveDatabaseTypeForConnection(config) !== "dameng") return undefined;
    const existing = existingConnectionNode?.children?.find((child) => child.type === "dameng-roles");
    return {
      id: `${connectionId}:__dameng_roles`,
      label: "tree.damengRoles",
      type: "dameng-roles",
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

  function buildXuguTablespacesNode(connectionId: string, existingConnectionNode?: TreeNode): TreeNode | undefined {
    const config = getConfig(connectionId);
    if (effectiveDatabaseTypeForConnection(config) !== "xugu") return undefined;
    const existing = existingConnectionNode?.children?.find((child) => child.type === "group-tablespaces");
    return {
      id: `${connectionId}:__xugu_tablespaces`,
      label: "tree.xuguTablespaces",
      type: "group-tablespaces",
      connectionId,
      // SYS_TABLESPACES/SYS_DATAFILES are scoped to the current database. The
      // optional value lets the agent switch to the configured database while
      // retaining compatibility with connections that have no default DB.
      database: config?.database || "",
      objectCount: existing?.objectCount,
      isExpanded: existing?.isExpanded ?? false,
      children: existing?.children ?? [],
    };
  }

  function withConnectionUtilityNodes(connectionId: string, children: TreeNode[], existingConnectionNode?: TreeNode): TreeNode[] {
    const nonUtilityChildren = connectionMetadataChildren(children);
    const userAdminNode = buildUserAdminNode(connectionId, existingConnectionNode);
    const damengUserNode = buildDamengUserNode(connectionId, existingConnectionNode);
    const damengRoleNode = buildDamengRoleNode(connectionId, existingConnectionNode);
    const damengJobAdminNode = buildDamengJobAdminNode(connectionId, existingConnectionNode);
    const xuguTablespacesNode = buildXuguTablespacesNode(connectionId, existingConnectionNode);
    return [...nonUtilityChildren, userAdminNode, damengUserNode, damengRoleNode, damengJobAdminNode, xuguTablespacesNode].filter(Boolean) as TreeNode[];
  }

  function withSavedSqlRoot(connectionId: string, children: TreeNode[], existingConnectionNode?: TreeNode): TreeNode[] {
    return withConnectionUtilityNodes(connectionId, children, existingConnectionNode);
  }

  function refreshDatabaseSavedSqlTrees(nodes: TreeNode[] = treeNodes.value) {
    for (const node of nodes) {
      if (node.type === "database") {
        node.children = withDatabaseSavedSqlRoot(node, node.children || [], savedSqlFilesByDatabase);
      }
      if (node.children) refreshDatabaseSavedSqlTrees(node.children);
    }
  }

  watch(
    () => savedSqlStore.treeVersion,
    () => {
      savedSqlFilesByDatabase = indexSavedSqlFilesByDatabase(savedSqlStore.allFiles);
      refreshDatabaseSavedSqlTrees();
    },
    { flush: "sync" },
  );

  function schemaCacheKey(...parts: string[]): string {
    return parts.map((part) => encodeURIComponent(part)).join(":");
  }

  function ownerAwareMetadataCacheVersion(config: ConnectionConfig | undefined, version: string): string {
    return config?.db_type === "informix" ? `${version}-informix-owner-v2` : version;
  }

  function supportedSidebarObjectTypes(config?: ConnectionConfig): DatabaseObjectTreeKind[] {
    const dbType = effectiveDatabaseTypeForConnection(config);
    return sidebarObjectKindsForDatabase(dbType);
  }

  function sidebarObjectTypesForScope(config: ConnectionConfig | undefined, schema?: string): DatabaseObjectTreeKind[] {
    if (config?.db_type === "xugu" && isXuguPublicSynonymScope(schema)) {
      return ["SYNONYM"];
    }
    if (config?.db_type === "xugu" && isXuguSchedulerJobScope(schema)) {
      return ["JOB"];
    }
    return supportedSidebarObjectTypes(config);
  }

  function objectTreeCacheVersion(config: ConnectionConfig | undefined, schema: string | undefined, baseVersion: string): string {
    const scopedVersion = config?.db_type === "xugu" && isXuguPublicSynonymScope(schema) ? `${baseVersion}-public-synonyms` : config?.db_type === "xugu" && isXuguSchedulerJobScope(schema) ? `${baseVersion}-scheduler-jobs` : baseVersion;
    return ownerAwareMetadataCacheVersion(config, scopedVersion);
  }

  /**
   * The blank guard drops junk entries reported by drivers that pad their schema list. Cloud Spanner
   * is the exception: in GoogleSQL the empty string *is* the name of the user schema, so dropping it
   * hides every table that is not in a named schema. `keepBlankSchema` is therefore opt-in per
   * database type rather than a global relaxation.
   */
  function sortSidebarSchemaInfos(schemas: readonly SchemaInfo[], keepBlankSchema = false): SchemaInfo[] {
    const byName = new Map<string, SchemaInfo>();
    for (const schema of schemas) {
      const name = schema.name.trim();
      if (!name && !keepBlankSchema) continue;
      byName.set(name, { name, comment: schema.comment ?? null });
    }
    return sortXuguSchemaInfos([...byName.values()], compareSidebarNames);
  }

  function buildExtensionManagementNode(connectionId: string, database: string): TreeNode {
    return {
      id: `${connectionId}:${database}:__extensions`,
      label: "tree.extensions",
      type: "group-extensions",
      connectionId,
      database,
      isExpanded: false,
      children: [],
    };
  }

  function objectGroupCacheKey(node: TreeNode): string {
    const config = node.connectionId ? getConfig(node.connectionId) : undefined;
    const objectTreeProfileCacheKey = driverProfileObjectTreeProfileForConnection(config)?.cacheKey;
    // objects-v8: object-group listing SQL gained a pg_type branch for
    // PostgreSQL-family user-defined types; older cached lists miss TYPE nodes.
    const baseCacheVersion = objectTreeCacheVersion(config, node.schema, config?.db_type === "oracle" ? "objects-v7" : "objects-v8");
    const cacheVersion = objectTreeProfileCacheKey ? `${baseCacheVersion}:${objectTreeProfileCacheKey}` : baseCacheVersion;
    return schemaCacheKey(node.connectionId || "", node.database || "", node.schema || "", node.type, cacheVersion);
  }

  function tableNameFilterScopeKey(parts: { connectionId?: string | null; database?: string | null; schema?: string | null; nodeKind?: string | null; catalog?: string | null }): string {
    return schemaCacheKey(parts.connectionId || "", parts.catalog || "", parts.database || "", parts.schema || "", parts.nodeKind || "group-tables");
  }

  function tableNameFilterForScope(parts: { connectionId?: string | null; database?: string | null; schema?: string | null; nodeKind?: string | null; catalog?: string | null }): TableNameFilter | undefined {
    return sidebarTableNameFilters.value[tableNameFilterScopeKey(parts)];
  }

  function activeTableNameFilterForScope(parts: { connectionId?: string | null; database?: string | null; schema?: string | null; nodeKind?: string | null; catalog?: string | null }): TableNameFilter | undefined {
    const filter = tableNameFilterForScope(parts);
    return tableNameFilterIsEmpty(filter) ? undefined : filter;
  }

  function effectiveTableNameFilterForNode(node: TreeNode, userFilter?: TableNameFilter): TableNameFilter | undefined {
    const config = node.connectionId ? getConfig(node.connectionId) : undefined;
    const profileFilter = driverProfileObjectTreeProfileForConnection(config)?.groupOverrides.find((group) => group.nodeType === node.type)?.tableNameFilter;
    if (!profileFilter) return userFilter;
    if (!userFilter) return profileFilter;
    return normalizeTableNameFilter({
      // Dedicated groups own their include range. User-defined include patterns
      // continue to apply to the default tables group, whose profile rule is an exclusion.
      includePatterns: profileFilter.includePatterns.length > 0 ? profileFilter.includePatterns : userFilter.includePatterns,
      excludePatterns: [...profileFilter.excludePatterns, ...userFilter.excludePatterns],
    });
  }

  function tableListSourceRevision(connectionId: string): number {
    return tableListSourceRevisions.get(connectionId) ?? 0;
  }

  function bumpTableListSourceRevision(connectionId: string): void {
    tableListSourceRevisions.set(connectionId, tableListSourceRevision(connectionId) + 1);
  }

  function tableNameFilterMetadataExtra(filter: TableNameFilter | undefined, sourceRevision?: number): MetadataScopeInput["extra"] {
    return {
      ...(sourceRevision === undefined ? {} : { tableListSourceRevision: sourceRevision }),
      ...(filter
        ? {
            tableNameFilterInclude: filter.includePatterns,
            tableNameFilterExclude: filter.excludePatterns,
          }
        : {}),
    };
  }

  function setSidebarTableNameFilter(scopeKey: string, filter: TableNameFilter) {
    const normalized = normalizeTableNameFilter(filter);
    const next = { ...sidebarTableNameFilters.value };
    if (tableNameFilterIsEmpty(normalized)) delete next[scopeKey];
    else next[scopeKey] = normalized;
    sidebarTableNameFilters.value = next;
    saveSidebarTableNameFilters(next);
    const revision = (sidebarTableNameFilterRevisions.get(scopeKey) ?? 0) + 1;
    sidebarTableNameFilterRevisions.set(scopeKey, revision);
    return revision;
  }

  function removeSidebarTableNameFiltersForConnections(connectionIds: Iterable<string>) {
    const encodedPrefixes = [...connectionIds].map((connectionId) => `${encodeURIComponent(connectionId)}:`);
    if (encodedPrefixes.length === 0) return;
    let changed = false;
    const next = { ...sidebarTableNameFilters.value };
    for (const key of Object.keys(next)) {
      if (!encodedPrefixes.some((prefix) => key.startsWith(prefix))) continue;
      delete next[key];
      sidebarTableNameFilterRevisions.delete(key);
      changed = true;
    }
    if (!changed) return;
    sidebarTableNameFilters.value = next;
    saveSidebarTableNameFilters(next);
  }

  function tableNameFilterRevisionMatches(options?: LoadTreeOptions): boolean {
    if (!options?.tableNameFilterScopeKey) return true;
    return (sidebarTableNameFilterRevisions.get(options.tableNameFilterScopeKey) ?? 0) === options.expectedTableNameFilterRevision;
  }

  function listTablesWithOptionalTableNameFilter(connectionId: string, database: string, schema: string, filter?: string, limit?: number, offset?: number, objectTypes?: DatabaseObjectTreeKind[], catalog?: string, tableNameFilter?: TableNameFilter) {
    if (tableNameFilter) return api.listTables(connectionId, database, schema, filter, limit, offset, objectTypes, catalog, tableNameFilter);
    if (catalog) return api.listTables(connectionId, database, schema, filter, limit, offset, objectTypes, catalog);
    if (objectTypes) return api.listTables(connectionId, database, schema, filter, limit, offset, objectTypes);
    return api.listTables(connectionId, database, schema, filter, limit, offset);
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

  // 连接元数据代次（connection generation）：disconnect / 关闭数据库 / 后端死池
  // 重连等生命周期边界会递增代次。数据标签页记录其 tableMeta 写入时的代次
  // （QueryTab.tableMetaGeneration），代次失配视同冷缓存——即使位于 30s TTL
  // 窗口内也必须重新拉取结构，且失效前启动的 in-flight 元数据请求不得把旧
  // 结果写回 tab（issue #6623 / PR #6640 review blocker 1）。
  // 语义：连接级代次影响该连接全部数据库；数据库级代次只影响单个数据库。
  // 查询代次时取两者较新者，disconnect 只 bump 连接级、closeDatabaseConnection
  // 只 bump 数据库级，因此作用域天然隔离。
  let metadataGenerationCounter = 0;
  const metadataGenerationByConnection = new Map<string, number>();
  const metadataGenerationByDatabase = new Map<string, number>();

  function metadataGenerationFor(connectionId: string, database?: string): number {
    const connectionGeneration = metadataGenerationByConnection.get(connectionId) ?? 0;
    if (database == null) return connectionGeneration;
    return Math.max(connectionGeneration, metadataGenerationByDatabase.get(`${connectionId}\x00${database}`) ?? 0);
  }

  function bumpMetadataGeneration(connectionId: string, database?: string) {
    metadataGenerationCounter += 1;
    if (database == null) {
      metadataGenerationByConnection.set(connectionId, metadataGenerationCounter);
    } else {
      metadataGenerationByDatabase.set(`${connectionId}\x00${database}`, metadataGenerationCounter);
    }
  }

  /**
   * 连接/数据库生命周期失效：shared metadata cache + 单调代次必须同步完成，
   * 这样紧随其后的 toolbar reload 立刻看到 generation mismatch，不会把旧
   * tableMeta 当成 warm。data-tab freshness 清戳经动态 import，避免与
   * queryStore 循环依赖；generation 已变时 freshness 稍晚清除也安全。
   */
  function invalidateConnectionMetadataLifetime(connectionId: string, database?: string) {
    invalidateMetadataCaches({ connectionId, database });
    bumpMetadataGeneration(connectionId, database);
    void import("@/stores/queryStore").then(({ useQueryStore }) => {
      useQueryStore().staleConnectionDataTabMetadata(connectionId, database);
    });
  }

  function invalidateMetadataCaches(match: MetadataCacheInvalidation): number {
    return metadataListPageCache.invalidate(match) + invalidateTableMetadataCache(match) + invalidateObjectBrowserRowsCache(match);
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
    const tableName = node.tableName || (node.type === "table" || node.type === "view" || node.type === "materialized_view" || node.type === "mongo-collection" || node.type === "dynamodb-table" ? node.label : undefined);
    const match = {
      connectionId: node.connectionId,
      database: node.database || undefined,
      schema: node.schema || undefined,
      tableName,
    };
    invalidateMetadataCaches(match);
    void invalidateObjectDdlCache(match);
  }

  function invalidateMetadataCache(connectionId: string, database?: string, schema?: string, tableName?: string) {
    const match = { connectionId, database, schema, tableName };
    invalidateMetadataCaches(match);
    void invalidateObjectDdlCache(match);
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
    const databaseType = options.node.connectionId ? effectiveDatabaseTypeForConnection(getConfig(options.node.connectionId)) : undefined;
    const grouped = buildGroupedObjectTreeNodes({
      nodeId: options.parentNodeId,
      connectionId: options.node.connectionId || "",
      database: options.node.database || "",
      schema: options.effectiveSchema,
      objects: options.objects.filter((object) => options.objectTypes.includes(normalizedObjectTreeKind(object.object_type))),
      databaseType,
      groupNodeType: options.node.type,
    });
    const refreshedGroup = grouped.find((group) => group.type === options.node.type);
    const children = refreshedGroup?.children ?? [];
    return supportsPackageMemberExpansion(databaseType) ? markPackageNodesExpandable(children) : children;
  }

  function completionTableDetail(comment: string | null | undefined): string | undefined {
    const normalized = comment?.trim();
    return normalized ? `→ ${normalized}` : undefined;
  }

  function tableInfosToCompletionTables(tables: readonly TableInfo[], schema?: string, catalog?: string): SqlCompletionTable[] {
    return tables.map((table) => {
      const detail = completionTableDetail(table.comment);
      return {
        name: table.name,
        catalog,
        schema,
        type: sqlObjectNavigationTypeFromTableType(table.table_type),
        ...(detail ? { detail } : {}),
        ...completionStableTableType(table.table_type),
      };
    });
  }

  function completionStableTableType(tableType: string | null | undefined): Partial<Pick<SqlCompletionTable, "tableType">> {
    if (!tableType || !isTdengineStableTableType(tableType)) return {};
    return { tableType: tableType.trim() };
  }

  function sameSidebarObjectName(left: string | undefined, right: string | undefined): boolean {
    return (left || "").toLowerCase() === (right || "").toLowerCase();
  }

  function treeNodeObjectIdentity(node: TreeNode): string {
    return `${node.type}\0${node.schema || ""}\0${node.label}`;
  }

  function mergeLocatedTreeChildren(parent: TreeNode, currentChildren: TreeNode[], pageChildren: TreeNode[], connectionId: string, database: string): TreeNode[] {
    const tableChildren = pageChildren.filter((child) => child.type === "table");
    const nonTableChildren = pageChildren.filter((child) => child.type !== "table");
    const merged = tableChildren.length ? mergeTableTreePageChildren(currentChildren, tableChildren, connectionId, database) : [...currentChildren];
    const existing = new Map(merged.map((node) => [treeNodeObjectIdentity(node), node]));
    for (const child of nonTableChildren) {
      const key = treeNodeObjectIdentity(child);
      const existingNode = existing.get(key);
      if (existingNode) {
        if (child.type === "package" && child.xuguPackageBodyAvailable === true) {
          existingNode.xuguPackageBodyAvailable = true;
          existingNode.xuguPackageBodyValid = child.xuguPackageBodyValid;
          existingNode.valid = existingNode.valid === false || child.valid === false ? false : (existingNode.valid ?? child.valid ?? null);
        }
        continue;
      }
      merged.push(child);
      existing.set(key, child);
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
    if (!options.node.connectionId || options.node.database == null) {
      return { children: [], objectCount: 0, hasMore: false, nextOffset: options.offset };
    }
    const searchFilter = (options.searchFilter ?? sidebarSearchQuery.value) || undefined;
    const userTableNameFilter = activeTableNameFilterForScope({
      connectionId: options.node.connectionId,
      database: options.node.database,
      schema: options.node.schema,
      nodeKind: options.node.type,
      catalog: options.node.catalog,
    });
    const tableNameFilter = effectiveTableNameFilterForNode(options.node, userTableNameFilter);
    const sourceRevision = tableListSourceRevision(options.node.connectionId);
    // A search must never truncate the fuzzy result set to the first page: the
    // target table can sort beyond it (e.g. "T_Erp_Nc_SuPlan_List" for
    // "erpncs" in a large ERP schema), which silently drops it from the first
    // search even though later, narrower queries succeed. Results are bounded
    // by SIDEBAR_TABLE_SEARCH_RESULT_BUDGET so a wide fuzzy query cannot push
    // an unbounded result set through database → IPC → store → tree rendering.
    // Unfiltered loads keep the page+1 probe used for load-more detection.
    const fetchLimit = searchFilter ? SIDEBAR_TABLE_SEARCH_RESULT_BUDGET : options.pageSize + 1;
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
        extra: tableNameFilterMetadataExtra(tableNameFilter, sourceRevision),
      }),
      () => listTablesWithOptionalTableNameFilter(options.node.connectionId!, options.node.database!, options.querySchema, searchFilter, fetchLimit, fetchOffset, options.objectTypes, options.node.catalog, tableNameFilter),
      { force: options.force },
    );
    const hasMore = searchFilter ? false : tables.length > options.pageSize;
    const pageTables = hasMore ? tables.slice(0, options.pageSize) : tables;
    if (tableListSourceRevision(options.node.connectionId) === sourceRevision) {
      indexCompletionTables(options.node.connectionId, options.node.database, options.effectiveSchema, tableInfosToCompletionTables(pageTables, options.effectiveSchema));
    }
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
    if (!options.node.connectionId || options.node.database == null) {
      return { children: [], objectCount: 0, hasMore: false, nextOffset: options.offset };
    }
    const searchFilter = options.searchFilter || undefined;
    const userTableNameFilter = activeTableNameFilterForScope({
      connectionId: options.node.connectionId,
      database: options.node.database,
      schema: options.node.schema,
      nodeKind: options.node.type,
      catalog: options.node.catalog,
    });
    const tableNameFilter = effectiveTableNameFilterForNode(options.node, userTableNameFilter);
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
        extra: tableNameFilterMetadataExtra(tableNameFilter),
      }),
      () =>
        tableNameFilter || options.node.catalog
          ? api.listObjects(options.node.connectionId!, options.node.database!, options.querySchema, options.objectTypes, searchFilter, fetchLimit, fetchOffset, options.node.catalog, tableNameFilter)
          : api.listObjects(options.node.connectionId!, options.node.database!, options.querySchema, options.objectTypes, searchFilter, fetchLimit, fetchOffset),
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
    const tableNameFilter = activeTableNameFilterForScope({
      connectionId: options.connectionId,
      database: options.database,
      schema: options.effectiveSchema ?? options.querySchema,
      nodeKind: "simple-tables",
    });
    const sourceRevision = tableListSourceRevision(options.connectionId);
    // A search must never truncate the fuzzy result set to the first page (see
    // loadPagedTableGroupChildren); results are bounded by
    // SIDEBAR_TABLE_SEARCH_RESULT_BUDGET, and unfiltered loads keep the
    // page+1 probe.
    const fetchLimit = searchFilter ? SIDEBAR_TABLE_SEARCH_RESULT_BUDGET : options.pageSize + 1;
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
        extra: tableNameFilterMetadataExtra(tableNameFilter, sourceRevision),
      }),
      () => listTablesWithOptionalTableNameFilter(options.connectionId, options.database, options.querySchema, searchFilter, fetchLimit, fetchOffset, undefined, undefined, tableNameFilter),
      { force: options.force },
    );
    const hasMore = searchFilter ? false : tables.length > options.pageSize;
    const pageTables = hasMore ? tables.slice(0, options.pageSize) : tables;
    if (tableListSourceRevision(options.connectionId) === sourceRevision) {
      indexCompletionTables(options.connectionId, options.database, options.effectiveSchema, tableInfosToCompletionTables(pageTables, options.effectiveSchema));
    }

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

  async function loadSimpleSupplementalObjectChildren(options: {
    node: TreeNode;
    nodeId: string;
    connectionId: string;
    database: string;
    querySchema: string;
    effectiveSchema?: string;
    objectTypes: DatabaseObjectTreeKind[];
    cacheKey: string;
    loadOptions?: LoadTreeOptions;
    load: TreeNodeLoadHandle;
  }) {
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
      const databaseType = effectiveDatabaseTypeForConnection(getConfig(options.connectionId));
      let supplementalChildren = buildSimpleObjectTreeNodes({
        nodeId: options.nodeId,
        connectionId: options.connectionId,
        database: options.database,
        schema: options.effectiveSchema,
        objects: supplementalObjects,
        databaseType,
      });
      if (supportsPackageMemberExpansion(databaseType)) {
        supplementalChildren = markPackageNodesExpandable(supplementalChildren);
      }
      if (supplementalChildren.length === 0) return;
      if (isTreeLoadSearchChanged(searchFilter, options.loadOptions)) return;
      const targetNode = treeNodeLoadTarget(options.load);
      if (!targetNode) return;

      const loadMoreNodes = (targetNode.children || []).filter((child) => child.type === "load-more");
      const currentChildren = withoutLoadMoreNodes(targetNode.children);
      const mergedChildren = mergeLocatedTreeChildren(targetNode, currentChildren, supplementalChildren, options.connectionId, options.database);
      const nextChildren = [...mergedChildren, ...loadMoreNodes];
      setChildren(targetNode, nextChildren);
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
    const liveNode = treeNodeInSidebarTree(node);
    if (!liveNode) return;
    if (staleTreeRefreshIds.has(liveNode.id)) return;
    staleTreeRefreshIds.add(liveNode.id);
    const expandedIds = collectExpandedNodeIds([liveNode]);
    clearLoadedChildrenCache(liveNode.id);
    const refreshOptions = { force: true, expectedSidebarSearchQuery: searchFilter };
    void loadTreeNodeChildren(liveNode, refreshOptions)
      .then(() => {
        if ((sidebarSearchQuery.value || "") !== searchFilter) return;
        return restoreExpandedChildren(liveNode, expandedIds, refreshOptions);
      })
      .finally(() => staleTreeRefreshIds.delete(liveNode.id));
  }

  // The metadata tree cache must not persist UI state. isExpanded flags written
  // while a schema was expanded would replay that expansion on every cache hit
  // (a manual collapse never rewrites the cache), so opening a connection would
  // keep auto-expanding a schema the user collapsed. Expansion state is instead
  // restored from the live tree (restoreExpandedChildren) within a session.
  function stripTreeNodeExpansionState(nodes: TreeNode[]): TreeNode[] {
    return nodes.map((node) => ({
      ...node,
      isExpanded: false,
      children: node.children ? stripTreeNodeExpansionState(node.children) : node.children,
    }));
  }

  async function loadPersistedTreeChildren(node: TreeNode, cacheKey: string, load: TreeNodeLoadHandle): Promise<PersistedTreeChildrenLoadResult> {
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
    const cachedChildren = normalizeCataloglessDatabaseNodes(stripTreeNodeExpansionState(expandCachedObjectBrowserNodes(decoded.children)));
    const childrenWithLinkedServers = node.type === "connection" && node.connectionId ? ensureSqlServerLinkedRootNode(node.connectionId, cachedChildren, config) : cachedChildren;
    if (node.type === "connection" && !hasConnectionMetadataChildren(childrenWithLinkedServers)) {
      logMetadataLoadTrace(metadataTraceLogger, trace, "cache-miss", { cacheStatus: "miss", resultCount: 0 });
      return { hit: false, isStale: false };
    }
    // Gate cache apply on the same per-node generation as network apply — connection
    // revision alone is not enough when a newer force-load supersedes this handle.
    const targetNode = treeNodeLoadTarget(load);
    if (!targetNode) {
      logMetadataLoadTrace(metadataTraceLogger, trace, "cache-miss", { cacheStatus: "miss" });
      return { hit: false, isStale: false };
    }
    const normalizedChildren = sortSidebarTreeChildrenForParent(targetNode, childrenWithLinkedServers, config?.db_type);
    setChildren(targetNode, targetNode.type === "connection" && targetNode.connectionId ? withSavedSqlRoot(targetNode.connectionId, normalizedChildren, targetNode) : normalizedChildren);
    targetNode.isExpanded = true;
    logMetadataLoadTrace(metadataTraceLogger, trace, "cache-hit", {
      cacheStatus: decoded.isStale ? "stale" : "hit",
      resultCount: normalizedChildren.length,
      stale: decoded.isStale,
    });
    return { hit: true, isStale: decoded.isStale };
  }

  async function savePersistedTreeChildren(cacheKey: string, children: TreeNode[]) {
    await api.saveSchemaCache(cacheKey, encodeSchemaTreeCache(stripTreeNodeExpansionState(stripDatabaseSavedSqlTreeNodes(children)))).catch(() => undefined);
  }

  function sidebarTableSearchTreeCacheKey(parent: TreeNode): string | null {
    if (!parent.connectionId || !parent.database) return null;
    if (parent.type === "group-tables") return objectGroupCacheKey(parent);
    if (parent.type !== "database" && parent.type !== "schema" && parent.type !== "linked-server-schema") return null;
    const simpleObjectDisplay = useSettingsStore().editorSettings.sidebarObjectDisplay === "simple";
    const cacheVersion = ownerAwareMetadataCacheVersion(getConfig(parent.connectionId), simpleObjectDisplay ? "objects-simple-v8" : "objects-grouped-v8");
    return schemaCacheKey(parent.connectionId, parent.database, parent.schema || "", cacheVersion);
  }

  function sidebarTableSearchIndexCacheKey(parent: TreeNode): string | null {
    const treeCacheKey = sidebarTableSearchTreeCacheKey(parent);
    if (!treeCacheKey) return null;
    // Catalog-capable databases may expose the same database name in several
    // catalogs. Their metadata tree cache keys predate catalog support, so use
    // the complete scope identity for the table index without changing those
    // shared metadata-cache formats. Catalogless scopes keep the v1 key so
    // indexes created before the regex-search manifest remain discoverable.
    if (parent.catalog) return schemaCacheKey(parent.connectionId || "", parent.catalog, parent.database || "", parent.schema || "", parent.type, "table-search-index-v2");
    return `${treeCacheKey}:table-search-index-v1`;
  }

  function getSidebarTableSearchIndexMemoryCache(cacheKey: string): TableInfo[] | null | undefined {
    if (!sidebarTableSearchIndexCache.has(cacheKey)) return undefined;
    const cached = sidebarTableSearchIndexCache.get(cacheKey) ?? null;
    sidebarTableSearchIndexCache.delete(cacheKey);
    sidebarTableSearchIndexCache.set(cacheKey, cached);
    return cached;
  }

  function setSidebarTableSearchIndexMemoryCache(cacheKey: string, entries: TableInfo[] | null) {
    sidebarTableSearchIndexCache.delete(cacheKey);
    sidebarTableSearchIndexCache.set(cacheKey, entries);
    while (sidebarTableSearchIndexCache.size > SIDEBAR_TABLE_SEARCH_INDEX_CACHE_MAX_ENTRIES) {
      const oldest = sidebarTableSearchIndexCache.keys().next().value;
      if (oldest === undefined) break;
      sidebarTableSearchIndexCache.delete(oldest);
    }
  }

  const sidebarTableSearchIndexManifestCacheKey = "dbx:sidebar-table-search-index-manifest-v1";

  function sidebarTableSearchIndexManifestEntry(parent: TreeNode, cacheKey: string): TableSearchIndexManifestEntry | null {
    if (!parent.connectionId || !parent.database || !parent.type) return null;
    const identity: SidebarRegexScopeIdentity = {
      connectionId: parent.connectionId,
      database: parent.database,
      schema: parent.schema,
      catalog: parent.catalog,
      nodeType: parent.type,
    };
    const findPath = (nodes: TreeNode[], targetId: string, path: TreeNode[] = []): TreeNode[] | null => {
      for (const node of nodes) {
        const next = [...path, node];
        if (node.id === targetId) {
          // Same-id nodes can exist in other branches; only the node matching
          // the full database context is the index parent we registered.
          if (nodeMatchesRegexScopeIdentity(node, targetId, identity)) return next;
          continue;
        }
        if (node.children) {
          const found = findPath(node.children, targetId, next);
          if (found) return found;
        }
      }
      return null;
    };
    const path = findPath(treeNodes.value, parent.id)?.map((node) => ({
      id: node.id,
      label: node.label,
      type: node.type,
      ...(node.connectionId ? { connectionId: node.connectionId } : {}),
      ...(node.database !== undefined ? { database: node.database } : {}),
      ...(node.catalog !== undefined ? { catalog: node.catalog } : {}),
      ...(node.schema !== undefined ? { schema: node.schema } : {}),
      ...(node.linkedServer !== undefined ? { linkedServer: node.linkedServer } : {}),
      ...(node.linkedCatalog !== undefined ? { linkedCatalog: node.linkedCatalog } : {}),
      ...(node.linkedSchema !== undefined ? { linkedSchema: node.linkedSchema } : {}),
    }));
    return {
      cacheKey,
      parentNodeId: parent.id,
      connectionId: parent.connectionId,
      database: parent.database,
      ...(parent.schema ? { schema: parent.schema } : {}),
      ...(parent.catalog ? { catalog: parent.catalog } : {}),
      nodeType: parent.type,
      ...(path ? { path } : {}),
    };
  }

  async function loadSidebarTableSearchIndexManifest(): Promise<TableSearchIndexManifestEntry[]> {
    if (sidebarTableSearchIndexManifest) return sidebarTableSearchIndexManifest;
    if (sidebarTableSearchIndexManifestInFlight) return sidebarTableSearchIndexManifestInFlight;
    const read = (async () => {
      const payload = await api.loadSchemaCache<unknown>(sidebarTableSearchIndexManifestCacheKey).catch(() => null);
      sidebarTableSearchIndexManifest = decodeTableSearchIndexManifest(payload);
      return sidebarTableSearchIndexManifest;
    })();
    sidebarTableSearchIndexManifestInFlight = read;
    try {
      return await read;
    } finally {
      sidebarTableSearchIndexManifestInFlight = null;
    }
  }

  function sidebarTableSearchIndexConnectionGeneration(connectionId: string): number {
    return sidebarTableSearchIndexConnectionGenerations.get(connectionId) ?? 0;
  }

  function sidebarTableSearchIndexScopeGeneration(cacheKey: string): number {
    return sidebarTableSearchIndexScopeGenerations.get(cacheKey) ?? 0;
  }

  function sidebarTableSearchIndexGenerationIsCurrent(connectionId: string, cacheKey: string, connectionGeneration: number, scopeGeneration: number): boolean {
    return connectionGeneration === sidebarTableSearchIndexConnectionGeneration(connectionId) && scopeGeneration === sidebarTableSearchIndexScopeGeneration(cacheKey);
  }

  async function serializeSidebarTableSearchIndexPersistence(cacheKey: string, operation: () => Promise<void>): Promise<void> {
    const previous = sidebarTableSearchIndexPersistenceQueues.get(cacheKey) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    sidebarTableSearchIndexPersistenceQueues.set(cacheKey, pending);
    try {
      await pending;
    } finally {
      if (sidebarTableSearchIndexPersistenceQueues.get(cacheKey) === pending) {
        sidebarTableSearchIndexPersistenceQueues.delete(cacheKey);
      }
    }
  }

  type SidebarTableSearchIndexScope = SidebarRegexScopeIdentity & {
    parentNodeId: string;
    cacheKey: string;
  };

  function sidebarTableSearchIndexScopeForNode(parent: TreeNode): SidebarTableSearchIndexScope | null {
    if (!parent.connectionId || !parent.database) return null;
    const cacheKey = sidebarTableSearchIndexCacheKey(parent);
    if (!cacheKey) return null;
    return {
      parentNodeId: parent.id,
      connectionId: parent.connectionId,
      database: parent.database,
      schema: parent.schema,
      catalog: parent.catalog,
      nodeType: parent.type,
      cacheKey,
    };
  }

  function manifestTableSearchScopeMatchesTreeRefresh(scope: TableSearchIndexManifestEntry, node: TreeNode): boolean {
    if (!node.connectionId || scope.connectionId !== node.connectionId) return false;
    const pathMatch = scope.path?.some((pathNode) => pathNode.id === node.id && pathNode.type === node.type && pathNode.connectionId === node.connectionId);
    if (pathMatch) return true;
    if (node.type === "connection") return true;
    if (node.type === "doris-catalog") return scope.catalog === node.catalog;
    if (node.type === "database") return scope.database === node.database && scope.catalog === node.catalog;
    if (node.type === "schema") return scope.database === node.database && scope.schema === node.schema && scope.catalog === node.catalog;
    if (node.type === "linked-server-schema") return scope.parentNodeId === node.id && scope.nodeType === node.type;
    if (node.type === "group-tables") return scope.parentNodeId === node.id && scope.nodeType === node.type;
    return false;
  }

  function collectActiveTableSearchScopes(node: TreeNode): SidebarTableSearchIndexScope[] {
    const scopes: SidebarTableSearchIndexScope[] = [];
    const visit = (current: TreeNode) => {
      if (sidebarTableSearchQueries.value[current.id]?.trim()) {
        const scope = sidebarTableSearchIndexScopeForNode(current);
        if (scope) scopes.push(scope);
      }
      for (const child of current.children ?? []) visit(child);
    };
    visit(node);
    return scopes;
  }

  function publishSidebarTableSearchIndexInvalidation(scopes: SidebarTableSearchIndexScope[]) {
    if (scopes.length === 0) return;
    sidebarTableSearchIndexInvalidation.value = {
      revision: sidebarTableSearchIndexInvalidation.value.revision + 1,
      scopes: scopes.map(({ cacheKey: _cacheKey, ...scope }) => scope),
    };
  }

  async function invalidateSidebarTableSearchIndexScopes(scopes: SidebarTableSearchIndexScope[], removeManifestScope: (scope: TableSearchIndexManifestEntry) => boolean): Promise<void> {
    const uniqueScopes = [...new Map(scopes.map((scope) => [scope.cacheKey, scope])).values()];
    if (uniqueScopes.length === 0) return;
    const cacheKeys = new Set(uniqueScopes.map((scope) => scope.cacheKey));
    for (const cacheKey of cacheKeys) {
      sidebarTableSearchIndexScopeGenerations.set(cacheKey, sidebarTableSearchIndexScopeGeneration(cacheKey) + 1);
      sidebarTableSearchIndexCache.delete(cacheKey);
      sidebarTableSearchIndexInFlight.delete(cacheKey);
    }

    const deletePersisted = Promise.all(
      [...cacheKeys].map((cacheKey) =>
        serializeSidebarTableSearchIndexPersistence(cacheKey, async () => {
          await api.deleteSchemaCachePrefix(cacheKey).catch(() => undefined);
        }),
      ),
    );
    sidebarTableSearchIndexManifestWriteQueue = sidebarTableSearchIndexManifestWriteQueue.then(async () => {
      const manifest = await loadSidebarTableSearchIndexManifest();
      const nextManifest = manifest.filter((scope) => !cacheKeys.has(scope.cacheKey) && !removeManifestScope(scope));
      if (nextManifest.length === manifest.length) return;
      sidebarTableSearchIndexManifest = nextManifest;
      await api.saveSchemaCache(sidebarTableSearchIndexManifestCacheKey, encodeTableSearchIndexManifest(nextManifest)).catch(() => undefined);
    });
    await Promise.all([deletePersisted, sidebarTableSearchIndexManifestWriteQueue]);
    publishSidebarTableSearchIndexInvalidation(uniqueScopes);
  }

  async function invalidateSidebarTableSearchIndexesForConnection(connectionId: string): Promise<void> {
    sidebarTableSearchIndexConnectionGenerations.set(connectionId, sidebarTableSearchIndexConnectionGeneration(connectionId) + 1);
    const rawPrefix = `${connectionId}:`;
    const encodedPrefix = `${schemaCacheKey(connectionId)}:`;
    const matchesConnectionCacheKey = (cacheKey: string) => cacheKey.startsWith(rawPrefix) || cacheKey.startsWith(encodedPrefix);
    for (const cacheKey of sidebarTableSearchIndexCache.keys()) {
      if (matchesConnectionCacheKey(cacheKey)) sidebarTableSearchIndexCache.delete(cacheKey);
    }
    for (const cacheKey of sidebarTableSearchIndexInFlight.keys()) {
      if (matchesConnectionCacheKey(cacheKey)) sidebarTableSearchIndexInFlight.delete(cacheKey);
    }
    const manifest = await loadSidebarTableSearchIndexManifest();
    const manifestScopes = manifest
      .filter((scope) => scope.connectionId === connectionId)
      .map((scope) => ({
        parentNodeId: scope.parentNodeId,
        connectionId: scope.connectionId,
        database: scope.database,
        schema: scope.schema,
        catalog: scope.catalog,
        nodeType: scope.nodeType,
        cacheKey: scope.cacheKey,
      }));
    const connectionNode = findConnectionNode(connectionId);
    const activeScopes = connectionNode ? collectActiveTableSearchScopes(connectionNode) : [];
    await invalidateSidebarTableSearchIndexScopes([...manifestScopes, ...activeScopes], (scope) => scope.connectionId === connectionId);
  }

  async function invalidateSidebarTableSearchIndexesForTreeRefresh(node: TreeNode): Promise<void> {
    const manifest = await loadSidebarTableSearchIndexManifest();
    const manifestScopes = manifest
      .filter((scope) => manifestTableSearchScopeMatchesTreeRefresh(scope, node))
      .map((scope) => ({
        parentNodeId: scope.parentNodeId,
        connectionId: scope.connectionId,
        database: scope.database,
        schema: scope.schema,
        catalog: scope.catalog,
        nodeType: scope.nodeType,
        cacheKey: scope.cacheKey,
      }));
    const activeScopes = collectActiveTableSearchScopes(node);
    await invalidateSidebarTableSearchIndexScopes([...manifestScopes, ...activeScopes], (scope) => manifestTableSearchScopeMatchesTreeRefresh(scope, node));
  }

  async function registerSidebarTableSearchIndexScope(parent: TreeNode, cacheKey: string): Promise<void> {
    const entry = sidebarTableSearchIndexManifestEntry(parent, cacheKey);
    if (!entry) return;
    sidebarTableSearchIndexManifestWriteQueue = sidebarTableSearchIndexManifestWriteQueue.then(async () => {
      const manifest = await loadSidebarTableSearchIndexManifest();
      const matchesEntryScope = (item: TableSearchIndexManifestEntry) => item.parentNodeId === entry.parentNodeId && item.connectionId === entry.connectionId && item.database === entry.database && item.schema === entry.schema && item.catalog === entry.catalog && item.nodeType === entry.nodeType;
      const existing = manifest.find((item) => matchesEntryScope(item));
      if (existing?.cacheKey === entry.cacheKey) return;
      // Re-registering a scope after its cache-key format changes replaces the
      // old manifest entry, so stale and refreshed indexes are never merged.
      sidebarTableSearchIndexManifest = [...manifest.filter((item) => !matchesEntryScope(item)), entry];
      await api.saveSchemaCache(sidebarTableSearchIndexManifestCacheKey, encodeTableSearchIndexManifest(sidebarTableSearchIndexManifest)).catch(() => undefined);
    });
    await sidebarTableSearchIndexManifestWriteQueue;
  }

  async function readSidebarTableSearchIndexCache(cacheKey: string, connectionId: string): Promise<TableInfo[] | null> {
    const cached = getSidebarTableSearchIndexMemoryCache(cacheKey);
    if (cached !== undefined) return cached;
    const pending = sidebarTableSearchIndexInFlight.get(cacheKey);
    if (pending) return pending;
    const connectionGeneration = sidebarTableSearchIndexConnectionGeneration(connectionId);
    const scopeGeneration = sidebarTableSearchIndexScopeGeneration(cacheKey);
    const read = (async () => {
      const decoded = decodeSchemaTreeCache<TreeNode[]>(await api.loadSchemaCache<unknown>(cacheKey).catch(() => null));
      const index = decoded?.tableSearchIndex;
      const entries = index ? index.entries.map((entry) => ({ name: entry.name, table_type: entry.tableType, ...(entry.comment !== undefined ? { comment: entry.comment } : {}) })) : null;
      if (!sidebarTableSearchIndexGenerationIsCurrent(connectionId, cacheKey, connectionGeneration, scopeGeneration)) return null;
      setSidebarTableSearchIndexMemoryCache(cacheKey, entries);
      return entries;
    })();
    sidebarTableSearchIndexInFlight.set(cacheKey, read);
    try {
      return await read;
    } finally {
      if (sidebarTableSearchIndexInFlight.get(cacheKey) === read) sidebarTableSearchIndexInFlight.delete(cacheKey);
    }
  }

  function findSidebarTreeNodeByIdentity(parentNodeId: string, identity: SidebarRegexScopeIdentity): TreeNode | null {
    const path = findNodePathByIdentity(treeNodes.value, parentNodeId, identity);
    return path?.[path.length - 1] ?? null;
  }

  async function loadSidebarTableSearchIndex(parentNodeId: string, identity?: SidebarRegexScopeIdentity): Promise<TableInfo[] | null> {
    // The identity disambiguates same-id nodes (e.g. database "a:b" vs schema
    // "b" under database "a") so the correct cache key is read and registered.
    const parent = identity ? findSidebarTreeNodeByIdentity(parentNodeId, identity) : findNode(treeNodes.value, parentNodeId);
    if (!parent) return null;
    const cacheKey = sidebarTableSearchIndexCacheKey(parent);
    if (!cacheKey) return null;
    const entries = await readSidebarTableSearchIndexCache(cacheKey, parent.connectionId || "");
    if (entries) await registerSidebarTableSearchIndexScope(parent, cacheKey);
    return entries;
  }

  async function loadSidebarTableSearchIndexScopes(): Promise<Array<{ scope: TableSearchIndexManifestEntry; entries: TableInfo[] }>> {
    const manifest = await loadSidebarTableSearchIndexManifest();
    const scopes: Array<{ scope: TableSearchIndexManifestEntry; entries: TableInfo[] }> = [];
    for (const scope of manifest) {
      const entries = await readSidebarTableSearchIndexCache(scope.cacheKey, scope.connectionId);
      if (entries) scopes.push({ scope, entries });
    }
    return scopes;
  }

  async function refreshSidebarTableSearchIndex(parentNodeId: string, identity?: SidebarRegexScopeIdentity): Promise<TableInfo[]> {
    const parent = identity ? findSidebarTreeNodeByIdentity(parentNodeId, identity) : findNode(treeNodes.value, parentNodeId);
    if (!parent?.connectionId || !hasTreeNodeDatabaseContext(parent)) return [];
    const connectionId = parent.connectionId;
    const cacheKey = sidebarTableSearchIndexCacheKey(parent);
    if (!cacheKey) return [];
    const connectionGeneration = sidebarTableSearchIndexConnectionGeneration(connectionId);
    const scopeGeneration = sidebarTableSearchIndexScopeGeneration(cacheKey);
    await ensureConnected(connectionId);
    const config = getConfig(connectionId);
    const querySchema = connectionObjectTreeQuerySchema(config, parent.database, parent.schema);
    const objectTypes = parent.type === "group-tables" ? (objectTypesForGroupNode(parent.type) ?? undefined) : undefined;
    const pageSize = sidebarObjectGroupPageSize();
    const entries: TableInfo[] = [];
    for (let offset = 0; ; offset += pageSize) {
      if (!sidebarTableSearchIndexGenerationIsCurrent(connectionId, cacheKey, connectionGeneration, scopeGeneration)) return [];
      const page = await listTablesWithOptionalTableNameFilter(connectionId, parent.database, querySchema, undefined, pageSize, offset, objectTypes, parent.catalog);
      entries.push(...page);
      if (page.length < pageSize) break;
    }
    const deduped = [...new Map(entries.map((entry) => [`${entry.table_type}\0${entry.name}`, entry])).values()];
    const tableSearchIndex = {
      complete: true as const,
      indexedAt: new Date().toISOString(),
      entries: deduped.map((entry) => ({ name: entry.name, tableType: entry.table_type, ...(entry.comment !== undefined ? { comment: entry.comment } : {}) })),
    };
    if (!sidebarTableSearchIndexGenerationIsCurrent(connectionId, cacheKey, connectionGeneration, scopeGeneration)) return [];
    let persisted = false;
    await serializeSidebarTableSearchIndexPersistence(cacheKey, async () => {
      if (!sidebarTableSearchIndexGenerationIsCurrent(connectionId, cacheKey, connectionGeneration, scopeGeneration)) return;
      await api.saveSchemaCache(cacheKey, encodeSchemaTreeCache<TreeNode[]>([], Date.now(), tableSearchIndex));
      if (!sidebarTableSearchIndexGenerationIsCurrent(connectionId, cacheKey, connectionGeneration, scopeGeneration)) {
        await api.deleteSchemaCachePrefix(cacheKey).catch(() => undefined);
        return;
      }
      persisted = true;
    });
    if (!persisted || !sidebarTableSearchIndexGenerationIsCurrent(connectionId, cacheKey, connectionGeneration, scopeGeneration)) return [];
    setSidebarTableSearchIndexMemoryCache(cacheKey, deduped);
    await registerSidebarTableSearchIndexScope(parent, cacheKey);
    return deduped;
  }

  async function savePersistedConnectionTreeChildren(cacheKey: string, children: TreeNode[]) {
    const metadataChildren = connectionMetadataChildren(children);
    if (metadataChildren.length === 0) return;
    await savePersistedTreeChildren(cacheKey, metadataChildren);
  }

  function connectionRootCacheKey(connectionId: string, config: ConnectionConfig | undefined): string | null {
    if (!config || connectionIsDorisFamilyCatalogCapable(config)) return null;
    if (config.db_type === "duckdb") return schemaCacheKey(connectionId, "duckdb-root");
    if (connectionUsesVisibleSchemaFilter(config)) {
      return schemaCacheKey(connectionId, config.database || "", config.db_type === "oracle" ? "schemas-v2" : "schemas", config.show_system_schemas === true ? "show-system" : "hide-system");
    }
    return schemaCacheKey(connectionId, "databases-v2");
  }

  async function hydrateTreeNodeFromCache(node: TreeNode | null, cacheKey: string | null): Promise<boolean> {
    if (!node || !cacheKey || loadedTreeNodeChildrenIds.value.has(node.id)) return false;
    const load = beginTreeNodeLoad(node);
    try {
      return (await loadPersistedTreeChildren(node, cacheKey, load)).hit;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function hydrateConnectionRootFromCache(connectionId: string, config: ConnectionConfig | undefined): Promise<boolean> {
    return hydrateTreeNodeFromCache(findConnectionNode(connectionId), connectionRootCacheKey(connectionId, config));
  }

  function isTreeNodeLoadedChildrenUsable(node: TreeNode): boolean {
    const sidebarObjectDisplay = useSettingsStore().editorSettings.sidebarObjectDisplay;
    if (!treeNodeLoadedChildrenContentPresent(node, sidebarObjectDisplay)) return false;
    if (simpleModeEmptyShellNeedsConfirmedLoad(node, sidebarObjectDisplay) && !confirmedEmptyTreeNodeIds.value.has(node.id)) {
      return false;
    }
    return true;
  }

  function canUseLoadedTreeNodeToggle(node: TreeNode): boolean {
    return loadedTreeNodeChildrenIds.value.has(node.id) && isTreeNodeLoadedChildrenUsable(node);
  }

  function useCachedChildren(node: TreeNode, options: LoadTreeOptions | undefined, load: TreeNodeLoadHandle): boolean {
    if (options?.force || !loadedTreeNodeChildrenIds.value.has(node.id)) return false;
    if (!load.isCurrent()) return false;
    if (node.type === "connection" && node.connectionId) {
      if (!hasConnectionMetadataChildren(node.children)) {
        clearLoadedChildrenCache(node.id);
        return false;
      }
      const normalizedChildren = sortSidebarTreeChildrenForParent(node, withSavedSqlRoot(node.connectionId, node.children || [], node), getConfig(node.connectionId)?.db_type);
      const liveNode = treeNodeLoadTarget(load);
      if (!liveNode) return false;
      setChildren(liveNode, normalizedChildren);
      liveNode.isExpanded = true;
    } else if (!isTreeNodeLoadedChildrenUsable(node)) {
      clearLoadedChildrenCache(node.id);
      return false;
    }
    const liveNode = treeNodeLoadTarget(load);
    if (!liveNode) return false;
    liveNode.isExpanded = true;
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
    if (isSidebarSearchQueryChanged(options)) return true;
    if (options?.allowGlobalSearchMismatch) return false;
    return (sidebarSearchQuery.value || "") !== searchFilter;
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
    confirmedEmptyTreeNodeIds.value.delete(node.id);
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

  function treeNodeInSidebarTree(node: TreeNode): TreeNode | null {
    return findNode(treeNodes.value, node.id);
  }

  function beginTreeNodeLoad(node: TreeNode): TreeNodeLoadHandle {
    return treeNodeLoads.begin(node);
  }

  function reclaimTreeNodeLoad(load: TreeNodeLoadHandle, node: TreeNode): TreeNodeLoadHandle {
    return load.reclaim(treeNodeInSidebarTree(node) ?? node);
  }

  function treeNodeLoadTarget(load: TreeNodeLoadHandle): TreeNode | null {
    return load.targetNode(
      (nodeId) => findNode(treeNodes.value, nodeId),
      (connectionId) => connectedIds.value.has(connectionId),
    ) as TreeNode | null;
  }

  function finishTreeNodeLoad(load: TreeNodeLoadHandle) {
    load.finish((nodeId) => findNode(treeNodes.value, nodeId));
  }

  /** Apply to a related node only while this load handle is still current. */
  function treeNodeLoadRelatedTarget(load: TreeNodeLoadHandle, related: TreeNode): TreeNode | null {
    if (!load.isCurrent()) return null;
    const current = treeNodeInSidebarTree(related);
    if (!current) return null;
    if (current.connectionId && !connectedIds.value.has(current.connectionId)) return null;
    return current;
  }

  function clearLoadedChildrenCache(prefix: string, options?: { deletePersisted?: boolean }) {
    for (const id of loadedTreeNodeChildrenIds.value) {
      if (id === prefix || id.startsWith(`${prefix}:`)) {
        loadedTreeNodeChildrenIds.value.delete(id);
      }
    }
    for (const id of confirmedEmptyTreeNodeIds.value) {
      if (id === prefix || id.startsWith(`${prefix}:`)) {
        confirmedEmptyTreeNodeIds.value.delete(id);
      }
    }
    for (const id of filteredObjectGroupChildrenIds) {
      if (id === prefix || id.startsWith(`${prefix}:`)) {
        filteredObjectGroupChildrenIds.delete(id);
      }
    }
    invalidateMetadataCachesByTreePrefix(prefix);
    if (options?.deletePersisted === false) return;
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
    const wasPinned = pinnedTreeNodeIds.value.has(pinKey) || pinnedTreeNodeIds.value.has(node.id);
    // Remove the legacy bare id as part of every toggle so old ambiguous pins
    // cannot continue matching objects in a different database. Newly pinned
    // nodes append to the persisted order, placing them last in their sibling
    // pin section until the user explicitly reorders them.
    const next = pinnedTreeNodeOrder.value.filter((id) => id !== node.id && id !== pinKey);
    if (!wasPinned) next.push(pinKey);
    setPinnedTreeNodeOrder(next);
    persistPinnedTreeNodeIds();

    // Pinning is infrequent; synchronizing the loaded tree here also clears any
    // stale flags created by legacy unscoped ids without rebuilding metadata.
    syncPinnedTreeState(treeNodes.value);
  }

  function findPinnedTreeNodeLocation(nodes: TreeNode[], pinKey: string): { node: TreeNode; siblings: TreeNode[] } | null {
    for (const node of nodes) {
      if (treeNodePinKey(node) === pinKey) return { node, siblings: nodes };
      if (node.children) {
        const found = findPinnedTreeNodeLocation(node.children, pinKey);
        if (found) return found;
      }
      if (node.hiddenChildren) {
        const found = findPinnedTreeNodeLocation(node.hiddenChildren, pinKey);
        if (found) return found;
      }
    }
    return null;
  }

  function collectPinnedTreeNodeReorderTargets(draggedKey: string): Set<string> {
    const dragged = findPinnedTreeNodeLocation(treeNodes.value, draggedKey);
    if (!dragged || !isTreeNodePinned(dragged.node) || isFixedPriorityTreeNode(dragged.node)) return new Set();

    const targets = new Set<string>();
    for (const sibling of dragged.siblings) {
      const siblingKey = treeNodePinKey(sibling);
      if (siblingKey === draggedKey || !isTreeNodePinned(sibling) || isFixedPriorityTreeNode(sibling)) continue;
      targets.add(siblingKey);
    }
    return targets;
  }

  const activePinnedTreeNodeReorderTargets = computed(() => {
    const draggedKey = activePinnedTreeNodeReorderKey.value;
    return draggedKey ? collectPinnedTreeNodeReorderTargets(draggedKey) : new Set<string>();
  });

  function beginPinnedTreeNodeReorder(draggedKey: string) {
    activePinnedTreeNodeReorderKey.value = draggedKey || null;
  }

  function endPinnedTreeNodeReorder() {
    activePinnedTreeNodeReorderKey.value = null;
  }

  function isPinnedTreeNodeReorderTarget(targetKey: string): boolean {
    return !!targetKey && targetKey !== activePinnedTreeNodeReorderKey.value && activePinnedTreeNodeReorderTargets.value.has(targetKey);
  }

  function canReorderPinnedTreeNodes(draggedKey: string, targetKey: string): boolean {
    if (!draggedKey || !targetKey || draggedKey === targetKey) return false;
    if (activePinnedTreeNodeReorderKey.value === draggedKey) return activePinnedTreeNodeReorderTargets.value.has(targetKey);
    return collectPinnedTreeNodeReorderTargets(draggedKey).has(targetKey);
  }

  function reorderPinnedTreeNodes(draggedKey: string, targetKey: string, position: DropPosition): boolean {
    if (position === "inside" || !canReorderPinnedTreeNodes(draggedKey, targetKey)) return false;
    const next = reorderPinnedTreeNodeOrder(pinnedTreeNodeOrder.value, draggedKey, targetKey, position);
    if (next.length === pinnedTreeNodeOrder.value.length && next.every((key, index) => key === pinnedTreeNodeOrder.value[index])) return false;
    setPinnedTreeNodeOrder(next);
    syncPinnedTreeState(treeNodes.value);
    persistPinnedTreeNodeIds();
    return true;
  }

  async function addConnection(config: ConnectionConfig, targetGroupId?: string | null) {
    const normalized = normalizeConnection(config);
    if (normalized.save_password === false) normalized.password = "";
    await persistTimeoutInheritance(normalized.id, normalized.connect_timeout_inherit === true, normalized.query_timeout_inherit === true);
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
    syncTimeoutInheritanceBackup();
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

  function completionCacheRevision(connectionId?: string, database?: string): number {
    if (!connectionId) return 0;
    const connectionRevision = completionCacheRevisions.value[connectionId] ?? 0;
    if (database == null) return connectionRevision;
    return connectionRevision + (completionCacheRevisions.value[`${connectionId}:${database}`] ?? 0);
  }

  function bumpCompletionCacheRevision(connectionId: string, database?: string) {
    const key = database == null ? connectionId : `${connectionId}:${database}`;
    completionCacheRevisions.value[key] = (completionCacheRevisions.value[key] ?? 0) + 1;
  }

  function invalidateCompletionCache(connectionId: string, database?: string) {
    bumpCompletionCacheRevision(connectionId, database);
    invalidateMetadataCaches({ connectionId, database });
    if (database == null) delete completionDatabasesCache.value[connectionId];
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
    for (const key of Object.keys(sqlServerCompletionContextCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete sqlServerCompletionContextCache.value[key];
    }
    for (const key of Object.keys(elasticsearchCompletionIndicesCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete elasticsearchCompletionIndicesCache.value[key];
    }
    for (const key of Object.keys(redisCompletionKeysCache.value)) {
      if (key === exactCacheKey || key.startsWith(cachePrefix)) delete redisCompletionKeysCache.value[key];
    }
    if (database == null) {
      delete redisCommandDocsCache.value[connectionId];
      redisCommandDocsCacheGeneration.set(connectionId, (redisCommandDocsCacheGeneration.get(connectionId) ?? 0) + 1);
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
    for (const key of completionColumnPrefixIndex.keys()) {
      if (key.startsWith(cachePrefix)) completionColumnPrefixIndex.delete(key);
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
    const oneTimeIds = connectionIds.filter((id) => getConfig(id)?.one_time === true);
    const nextConnections = connections.value.filter((c) => !removedIds.has(c.id));
    let nextLayout = sidebarLayout.value;
    for (const id of removedIds) nextLayout = removeConnectionFromSidebarLayout(nextLayout, id);
    await persistConnectionDeletion(nextConnections, nextLayout);
    applyConnectionRemoval(removedIds, nextConnections, nextLayout);
    await cleanupRemovedOneTimeConnections(oneTimeIds);
  }

  function applyConnectionRemoval(removedIds: ReadonlySet<string>, nextConnections: ConnectionConfig[], nextLayout: SidebarLayout) {
    connections.value = nextConnections;
    syncTimeoutInheritanceBackup();
    let nextPinnedOrder = pinnedTreeNodeOrder.value;
    for (const id of removedIds) {
      const prefix = `${id}:`;
      nextPinnedOrder = nextPinnedOrder.filter((pinId) => pinId !== id && !pinId.startsWith(prefix));
    }
    setPinnedTreeNodeOrder(nextPinnedOrder);
    persistPinnedTreeNodeIds();
    removeSidebarTableNameFiltersForConnections(removedIds);
    for (const id of removedIds) {
      clearConnectionError(id);
      connectionErrorRevisions.delete(id);
      connectedIds.value.delete(id);
      clearSidebarStorageCaches(id);
      clearPrimaryVisibleObjectNames(id);
      clearConnectionIdentifierQuote(id);
      clearConnectionHealthCheck(id);
    }
    sidebarLayout.value = nextLayout;
    rebuildTreeNodes();
    if (activeConnectionId.value && removedIds.has(activeConnectionId.value)) {
      activeConnectionId.value = null;
    }
    selectedTreeNodeIds.value = selectedTreeNodeIds.value.filter((id) => !removedIds.has(id));
    if (selectedTreeNodeId.value && removedIds.has(selectedTreeNodeId.value)) selectedTreeNodeId.value = null;
    if (treeSelectionAnchorId.value && removedIds.has(treeSelectionAnchorId.value)) treeSelectionAnchorId.value = null;
    for (const id of removedIds) {
      invalidateCompletionCache(id);
      void invalidateObjectDdlCache({ connectionId: id });
      clearLoadedChildrenCache(id);
      void deleteTabResultSnapshotsForOwner(id);
    }
  }

  async function removeConnection(id: string) {
    await removeConnections([id]);
  }

  async function updateConnection(config: ConnectionConfig) {
    config = normalizeConnection(config);
    if (config.save_password === false) config.password = "";
    const idx = connections.value.findIndex((c) => c.id === config.id);
    if (idx < 0) return;
    const runtimeConfigChanged = connectionConfigFingerprint(connections.value[idx]) !== connectionConfigFingerprint(config);
    const nextConnections = [...connections.value];
    nextConnections[idx] = config;
    await persistTimeoutInheritance(config.id, config.connect_timeout_inherit === true, config.query_timeout_inherit === true);
    await persistConnections(nextConnections);
    connections.value = nextConnections;
    syncTimeoutInheritanceBackup();
    rebuildTreeNodes();
    if (!runtimeConfigChanged) return;
    clearPrimaryVisibleObjectNames(config.id);
    connectedIds.value.delete(config.id);
    clearSidebarStorageCaches(config.id);
    clearConnectionIdentifierQuote(config.id);
    clearConnectionHealthCheck(config.id);
    invalidateCompletionCache(config.id);
    void invalidateObjectDdlCache({ connectionId: config.id });
    await invalidateSidebarTableSearchIndexesForConnection(config.id);
    clearLoadedChildrenCache(config.id);
    const node = findConnectionNode(config.id);
    if (node?.isExpanded) {
      await reloadConnectionDatabaseChildren(config.id);
    }
  }

  async function renameConnection(connectionId: string, name: string): Promise<boolean> {
    const trimmed = name.trim();
    if (!trimmed) return false;
    const index = connections.value.findIndex((connection) => connection.id === connectionId);
    if (index < 0 || connections.value[index].name === trimmed) return false;

    const nextConnections = [...connections.value];
    nextConnections[index] = { ...nextConnections[index], name: trimmed };
    await persistConnections(nextConnections);
    connections.value = nextConnections;
    rebuildTreeNodes();
    return true;
  }

  async function updateConnectionDatabaseInfo(connectionId: string, databaseInfo: DatabaseConnectionInfo, expectedConfigFingerprint?: string): Promise<void> {
    const normalized = normalizeDatabaseConnectionInfo(databaseInfo);
    if (!normalized) return;
    const current = connections.value.find((connection) => connection.id === connectionId);
    if (!current) return;
    if (expectedConfigFingerprint && connectionConfigFingerprint(current) !== expectedConfigFingerprint) return;
    if (JSON.stringify(current.database_info) === JSON.stringify(normalized)) return;
    const tableListSourceChanged = mysqlTableListSourceChanged(current, normalized);

    await api.saveConnectionDatabaseInfo(connectionId, normalized);
    const index = connections.value.findIndex((connection) => connection.id === connectionId);
    if (index < 0) return;
    if (expectedConfigFingerprint && connectionConfigFingerprint(connections.value[index]) !== expectedConfigFingerprint) return;
    const nextConnections = [...connections.value];
    nextConnections[index] = { ...nextConnections[index], database_info: normalized };
    connections.value = nextConnections;
    if (tableListSourceChanged) {
      // ShardingSphere switches table enumeration from information_schema to SHOW FULL TABLES.
      // Discard physical-table metadata that may have loaded before background version detection completed.
      bumpTableListSourceRevision(connectionId);
      treeNodeLoads.cancelPrefix(connectionId);
      invalidateCompletionCache(connectionId);
      void invalidateSidebarTableSearchIndexesForConnection(connectionId);
      const connectionNode = findConnectionNode(connectionId);
      if (connectionNode?.isExpanded && connectedIds.value.has(connectionId)) {
        void refreshTreeNode(connectionNode).catch((error) => {
          console.debug("[DBX][connection-info:table-metadata-refresh-failed]", { connectionId, error });
        });
      } else {
        clearLoadedChildrenCache(connectionId);
      }
    }
    // Other database info is reactive connection metadata, not tree structure. Keep
    // navigator node identities stable so an in-flight first expansion can apply
    // its loaded children after this background refresh completes.
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
    if (previousConfig.db_type !== "mongodb" || isMongoLegacyDriverProfile(previousConfig.driver_profile)) {
      return;
    }

    const expectedConfigFingerprint = connectionConfigFingerprint(previousConfig);
    const current = connections.value.find((connection) => connection.id === connectionId);
    if (!current || connectionConfigFingerprint(current) !== expectedConfigFingerprint) return;

    const savedConnections = await api.loadConnections().catch(() => null);
    const savedConfig = savedConnections?.map((connection) => normalizeConnection(connection)).find((connection) => connection.id === connectionId && connection.driver_profile === MONGO_LEGACY_DRIVER_PROFILE);
    if (!savedConfig) return;

    const savedOriginalIdentity = {
      ...savedConfig,
      driver_profile: previousConfig.driver_profile,
      driver_label: previousConfig.driver_label,
    };
    if (connectionConfigFingerprint(savedOriginalIdentity) !== expectedConfigFingerprint) return;

    const idx = connections.value.findIndex((connection) => connection.id === connectionId);
    if (idx < 0 || connectionConfigFingerprint(connections.value[idx]) !== expectedConfigFingerprint) return;
    const nextConnections = [...connections.value];
    nextConnections[idx] = {
      ...nextConnections[idx],
      driver_profile: MONGO_LEGACY_DRIVER_PROFILE,
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

  async function setDefaultSchema(connectionId: string, schema: string) {
    const config = getConfig(connectionId);
    const defaultSchema = schema.trim();
    if (!config || !defaultSchema || config.default_schema === defaultSchema || (config.db_type === "xugu" && isXuguSyntheticScope(defaultSchema))) return;
    await updateConnection({
      ...config,
      default_schema: defaultSchema,
    });
  }

  async function clearDefaultSchema(connectionId: string) {
    const config = getConfig(connectionId);
    if (!config?.default_schema) return;
    await updateConnection({
      ...config,
      default_schema: undefined,
    });
  }

  function isDefaultSchema(connectionId: string, schema: string): boolean {
    return getConfig(connectionId)?.default_schema === schema && schema !== "";
  }

  function getRedisDatabaseAlias(connectionId: string, database: string | number): string | undefined {
    return redisDatabaseAlias(getConfig(connectionId)?.redis_database_aliases, database);
  }

  async function setRedisDatabaseAlias(connectionId: string, database: string | number, alias?: string) {
    const index = typeof database === "number" ? database : Number(database);
    const configIndex = connections.value.findIndex((connection) => connection.id === connectionId);
    const config = connections.value[configIndex];
    if (!config || config.db_type !== "redis" || !Number.isInteger(index) || index < 0) return;

    const key = String(index);
    const aliases = { ...(config.redis_database_aliases || {}) };
    const normalizedAlias = alias?.trim() || "";
    if (normalizedAlias) aliases[key] = normalizedAlias;
    else delete aliases[key];

    const redisDatabaseAliases = normalizeRedisDatabaseAliases(aliases);
    const nextConnections = [...connections.value];
    nextConnections[configIndex] = {
      ...config,
      redis_database_aliases: redisDatabaseAliases,
    };
    await persistConnections(nextConnections);
    connections.value = nextConnections;

    const node = findNode(treeNodes.value, `${connectionId}:db${key}`);
    if (node?.type === "redis-db") {
      node.label = redisDatabaseLabel(index, redisDatabaseAliases, node.totalKeyCount);
    }
  }

  async function setVisibleDatabases(connectionId: string, databaseNames: string[]) {
    const config = getConfig(connectionId);
    if (!config) return;
    await updateVisibleDatabasesConfig(connectionId, normalizeVisibleDatabaseSelection(databaseNames, databaseNames));
    await reloadConnectionDatabaseChildren(connectionId);
  }

  // 显式勾选 + 通配符模式一并保存（#7164）：模式对之后新建的库持续生效
  async function setVisibleDatabaseFilter(connectionId: string, databaseNames: string[], patterns: string[]) {
    const config = getConfig(connectionId);
    if (!config) return;
    const normalizedPatterns = patterns.map((pattern) => pattern.trim()).filter((pattern) => pattern !== "");
    const idx = connections.value.findIndex((connection) => connection.id === connectionId);
    if (idx < 0) return;
    const nextConnections = [...connections.value];
    nextConnections[idx] = {
      ...nextConnections[idx],
      visible_databases: normalizeVisibleDatabaseSelection(databaseNames, databaseNames),
      visible_database_patterns: normalizedPatterns.length > 0 ? normalizedPatterns : undefined,
    };
    await persistConnections(nextConnections);
    connections.value = nextConnections;
    invalidateCompletionCache(connectionId);
    rebuildTreeNodes();
    await reloadConnectionDatabaseChildren(connectionId);
  }

  function recordPrimaryVisibleObjectNames(connectionId: string, objectNames: readonly string[]) {
    const names = [...objectNames];
    const existing = primaryVisibleObjectNames.value[connectionId];
    if (existing?.length === names.length && existing.every((name, index) => name === names[index])) return;
    primaryVisibleObjectNames.value = { ...primaryVisibleObjectNames.value, [connectionId]: names };
  }

  function clearPrimaryVisibleObjectNames(connectionId: string) {
    if (!(connectionId in primaryVisibleObjectNames.value)) return;
    const next = { ...primaryVisibleObjectNames.value };
    delete next[connectionId];
    primaryVisibleObjectNames.value = next;
  }

  function getSidebarVisibleFilterSummary(connectionId: string) {
    const config = getConfig(connectionId);
    if (config?.db_type === "nacos") return nacosVisibleNamespaceSummary(config, primaryVisibleObjectNames.value[connectionId]);
    return config ? sidebarVisibleFilterSummary(config, primaryVisibleObjectNames.value[connectionId]) : null;
  }

  function scheduleMissingPrimaryVisibleObjectNamesRefresh(connectionId: string, config: ConnectionConfig | undefined, options?: LoadTreeOptions) {
    if (options?.force || !config || primaryVisibleObjectNames.value[connectionId] || primaryVisibleObjectRefreshInFlight.has(connectionId)) return;
    if (!connectionCanConfigureSidebarVisibleDatabases(config.db_type) || !connectionHasConfiguredSidebarVisibleFilter(config)) return;
    primaryVisibleObjectRefreshInFlight.add(connectionId);
    void loadDatabases(connectionId, { force: true, connectedOnly: true })
      .catch(() => undefined)
      .finally(() => primaryVisibleObjectRefreshInFlight.delete(connectionId));
  }

  async function clearVisibleDatabases(connectionId: string) {
    const config = getConfig(connectionId);
    if (!config || (!Array.isArray(config.visible_databases) && !visibleDatabasePatternsAreEnabled(config.visible_database_patterns))) return;
    if (visibleDatabasePatternsAreEnabled(config.visible_database_patterns)) {
      const idx = connections.value.findIndex((connection) => connection.id === connectionId);
      if (idx >= 0) {
        const nextConnections = [...connections.value];
        nextConnections[idx] = { ...nextConnections[idx], visible_databases: undefined, visible_database_patterns: undefined };
        await persistConnections(nextConnections);
        connections.value = nextConnections;
        invalidateCompletionCache(connectionId);
        rebuildTreeNodes();
        await reloadConnectionDatabaseChildren(connectionId);
        return;
      }
    }
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
    } else if (config.db_type === "consul") {
      await loadConsulRoot(connectionId);
    } else if (config.db_type === "mongodb") {
      await loadMongoDatabases(connectionId);
    } else if (config.db_type === "dynamodb") {
      await loadDynamoDbTables(connectionId);
    } else if (config.db_type === "elasticsearch" || config.db_type === "easysearch" || config.db_type === "meilisearch") {
      // Reload: list indices.
      await loadElasticsearchIndices(connectionId);
    } else if (config.db_type === "milvus") {
      await loadMilvusDatabases(connectionId);
    } else if (config.db_type === "qdrant" || config.db_type === "weaviate" || config.db_type === "chromadb") {
      await loadVectorCollections(connectionId);
    } else if (config.db_type === "mq") {
      await loadMqTenants(connectionId, { force: true });
    } else if (config.db_type === "mqtt") {
      await loadMqttTopics(connectionId);
    } else if (config.db_type === "nacos") {
      await loadNacosNamespaces(connectionId, { force: true });
    } else {
      await loadDatabases(connectionId, { force: true });
    }
  }

  /**
   * Query whether this connection already has a transient password stored in the
   * backend session-credential store (a `save_password === false` connection that
   * was connected once this run). Used to skip the interactive password prompt on
   * later connects. Only returns a boolean — the password itself never leaves the
   * backend process memory.
   */
  async function hasSessionCredential(connectionId: string): Promise<boolean> {
    try {
      return await api.sessionCredentialStatus(connectionId);
    } catch {
      // Status query failure is treated as "no credential": falling back to the
      // interactive prompt is the safe, well-known path.
      return false;
    }
  }

  /**
   * Prompt for a transient password when saving is disabled, or when a server
   * confirms that a metadata-only synced connection sent no password. The
   * password is used for the immediate `connectDb` call and is persisted only
   * after a successful connection when the user selects "remember password".
   */
  async function ensureConnectionPassword(config: ConnectionConfig, force = false): Promise<{ config: ConnectionConfig; rememberPassword: boolean }> {
    if (!force && (config.save_password !== false || config.password)) return { config, rememberPassword: false };
    const { useConnectionPasswordPromptStore } = await import("@/stores/connectionPasswordPromptStore");
    const result = await useConnectionPasswordPromptStore().requestPassword({
      connectionId: config.id,
      connectionName: config.name,
    });
    if (!result) throw new Error(CONNECTION_PASSWORD_REQUIRED_MESSAGE);
    return { config: { ...config, password: result.password }, rememberPassword: result.rememberPassword };
  }

  async function persistRememberedConnectionPassword(config: ConnectionConfig, rememberPassword: boolean, expectedConfigFingerprint: string): Promise<void> {
    if (!rememberPassword) return;
    const index = connections.value.findIndex((connection) => connection.id === config.id);
    if (index < 0) return;
    if (connectionConfigFingerprint(connections.value[index]) !== expectedConfigFingerprint) return;
    const nextConnections = [...connections.value];
    nextConnections[index] = { ...nextConnections[index], password: config.password, save_password: true };
    await persistConnections(nextConnections);
    if (connectionConfigFingerprint(connections.value[index]) !== expectedConfigFingerprint) {
      await persistConnections();
      return;
    }
    connections.value = nextConnections;
    rebuildTreeNodes();
  }

  async function connectDbWithPasswordRetry(config: ConnectionConfig, localAttempt: number): Promise<{ config: ConnectionConfig; id: string; rememberPassword: boolean }> {
    try {
      const id = await withConnectionAttemptTimeout(api.connectDb(config, localAttempt), config);
      return { config, id, rememberPassword: false };
    } catch (error) {
      const message = connectionErrorMessage(error);
      if (!isMysqlMissingPasswordFailure(config, message) && !isSqliteMissingEncryptionPasswordFailure(config, message)) throw error;
      const prompted = await ensureConnectionPassword(config, true);
      config = prompted.config;
      ensureLocalConnectionAttemptActive(config.id, localAttempt);
      const id = await withConnectionAttemptTimeout(api.connectDb(config, localAttempt), config);
      return { config, id, rememberPassword: prompted.rememberPassword };
    }
  }

  async function connect(config: ConnectionConfig) {
    config = normalizeConnection(config);
    const expectedConfigFingerprint = connectionConfigFingerprint(getConfig(config.id) ?? config);
    if (getBlockingDisconnectInFlight(config.id)) await waitForBlockingDisconnectInFlight(config.id);
    const localAttempt = beginLocalConnectionAttempt(config.id);
    try {
      let rememberPassword = false;
      if (connectionNeedsPasswordPrompt(config) && !(await hasSessionCredential(config.id))) {
        const prompted = await ensureConnectionPassword(config);
        config = prompted.config;
        rememberPassword = prompted.rememberPassword;
      }
      await beforeConnectHandler?.(config);
      if (config.db_type === "sqlserver") {
        await ensureSqlServerLegacyCompatibilityComponentInstalled(config);
      }
      ensureLocalConnectionAttemptActive(config.id, localAttempt);
      const connection = await connectDbWithPasswordRetry(config, localAttempt);
      config = connection.config;
      rememberPassword ||= connection.rememberPassword;
      const id = connection.id;
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
        existing.searchAliases = connectionSidebarSearchAliases(config);
        existing.connectionId = id;
        existing.comment = config.note || null;
        existing.children = existing.children || [];
      } else {
        treeNodes.value.push({
          id,
          label: config.name,
          type: "connection",
          searchAliases: connectionSidebarSearchAliases(config),
          connectionId: id,
          isExpanded: false,
          children: [],
          comment: config.note || null,
        });
      }
      try {
        await persistRememberedConnectionPassword(config, rememberPassword, expectedConfigFingerprint);
      } catch (error) {
        setConnectionError(id, i18n.global.t("connection.rememberPasswordSaveFailed", { message: connectionErrorMessage(error) }));
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
    clearSidebarStorageCaches(connectionId);
    clearPrimaryVisibleObjectNames(connectionId);
    clearConnectionIdentifierQuote(connectionId);
    clearConnectionHealthCheck(connectionId);
    if (activeConnectionId.value === connectionId) activeConnectionId.value = null;
    invalidateCompletionCache(connectionId);
    cancelObjectDdlLoadsForConnection(connectionId);
    cancelObjectMetadataLoadsForConnection(connectionId);
    await disconnectRequest;
    return true;
  }

  async function disconnect(connectionId: string) {
    const stateRevision = bumpConnectionStateRevision(connectionId);
    const shouldRemoveOneTimeConnection = getConfig(connectionId)?.one_time === true;
    if (hasSqlServerActivityTraceForConnection(connectionId)) await disposeSqlServerActivityTracesForConnection(connectionId);
    const disconnectRequest = startDisconnectRequest(connectionId);
    cancelLocalConnectionAttempt(connectionId);

    connectedIds.value.delete(connectionId);
    clearSidebarStorageCaches(connectionId);
    clearPrimaryVisibleObjectNames(connectionId);
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
    cancelObjectDdlLoadsForConnection(connectionId);
    cancelObjectMetadataLoadsForConnection(connectionId);
    clearMetadataRuntimeCacheForConnection(connectionId);
    // Disconnecting only tears down the live session. Keep the schema snapshot so
    // reconnecting can render databases and table names before the remote refresh.
    clearLoadedChildrenCache(connectionId, { deletePersisted: false });
    if (activeConnectionId.value === connectionId) {
      activeConnectionId.value = null;
    }
    invalidateCompletionCache(connectionId);
    invalidateObjectBrowserRowsCache({ connectionId });
    await invalidateSidebarTableSearchIndexesForConnection(connectionId);
    const { useQueryStore } = await import("@/stores/queryStore");
    const queryStore = useQueryStore();
    // 断开连接是明确的元数据新鲜度边界：数据标签页保留展示/编辑状态，但
    // 其 tableMeta 不得再被视为 warm cache（issue #6623——reconnect 后重开
    // 同表必须重新拉取结构）。completion/object-browser 缓存上面已清；
    // 这里再走统一 helper，bump 连接代次并清 data-tab freshness。
    invalidateConnectionMetadataLifetime(connectionId);
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
    // Tab handling is synchronous in memory, but persistence is debounced. Flush
    // the scoped tab state before disconnect returns so a quick reconnect/restart
    // cannot restore tabs that the selected policy already removed.
    await queryStore.flushPendingPersist().catch(() => undefined);
    await disconnectRequest;
    if (isCurrentConnectionStateRevision(connectionId, stateRevision)) {
      clearConnectionError(connectionId);
    }
    if (shouldRemoveOneTimeConnection && isCurrentConnectionStateRevision(connectionId, stateRevision)) {
      await removeConnection(connectionId);
    }
  }

  /**
   * "断开并忘记本次密码"：关闭连接池（保留其它已保存连接的凭据），并清除该
   * `save_password === false` 连接本次运行期的会话密码，使下一次连接必须重新输入。
   * 若该连接本无会话凭据，后端会返回错误并在此抛出（不静默吞掉），避免误报成功。
   */
  async function disconnectAndForgetConnectionPassword(connectionId: string) {
    await disconnect(connectionId);
    await api.forgetSessionCredential(connectionId);
  }

  async function closeDatabaseConnection(connectionId: string, database: string) {
    if (hasSqlServerActivityTraceForConnection(connectionId, database)) await disposeSqlServerActivityTracesForConnection(connectionId, database);
    cancelObjectDdlLoadsForDatabase(connectionId, database);
    cancelObjectMetadataLoadsForDatabase(connectionId, database);
    await api.closeDatabaseConnection(connectionId, database);
    clearMetadataRuntimeCacheForDatabase(connectionId, database);
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
    // Keep database-level disconnect consistent with connection-level cleanup:
    // the next restore must observe the post-policy tab set, not the debounced
    // snapshot from before this database was closed.
    await queryStore.flushPendingPersist().catch(() => undefined);
    const node = findDatabaseTreeNode(treeNodes.value, connectionId, database);
    if (node) {
      node.isExpanded = false;
      node.children = [];
      clearLoadedChildrenCache(node.id);
    }
    invalidateCompletionCache(connectionId, database);
    clearSidebarStorageCaches(connectionId, database);
    invalidateObjectBrowserRowsCache({ connectionId, database });
    // 数据库级生命周期边界：与连接级断开一致，数据标签页的元数据 freshness
    // 戳必须作废，重开/刷新时重新拉取结构（issue #6623）。bump 数据库级代次
    // 只影响该库的在途回写与 reload 判定，不影响本连接其它库。
    invalidateConnectionMetadataLifetime(connectionId, database);
  }

  async function ensureConnected(connectionId: string, options: { activate?: boolean; verifyHealth?: boolean } = {}) {
    if (connectedIds.value.has(connectionId)) {
      // Pure navigation can safely trust the existing connected state. Its
      // destination will perform the real API request, while blocking here on
      // a health probe makes an otherwise local tab switch take up to 5s.
      if (options.verifyHealth === false) return;
      if (hasRecentConnectionHealthCheck(connectionId)) return;
      // Optimistic: verify backend pool is actually healthy
      try {
        await withConnectionHealthTimeout(connectionId, api.checkConnectionHealth(connectionId));
        markConnectionHealthChecked(connectionId);
        return;
      } catch {
        // Backend pool is dead — remove from connectedIds and reconnect.
        // 死池重连同样跨越了连接生命周期：shared 表元数据缓存与数据标签页的
        // 元数据 freshness 都必须作废，否则自动重连后仍可能复用断链前的旧
        // 字段结构（issue #6623）。
        cancelObjectDdlLoadsForConnection(connectionId);
        cancelObjectMetadataLoadsForConnection(connectionId);
        clearMetadataRuntimeCacheForConnection(connectionId);
        connectedIds.value.delete(connectionId);
        clearPrimaryVisibleObjectNames(connectionId);
        clearConnectionHealthCheck(connectionId);
        if (activeConnectionId.value === connectionId) activeConnectionId.value = null;
        invalidateConnectionMetadataLifetime(connectionId);
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
    const expectedConfigFingerprint = connectionConfigFingerprint(config);
    if (getBlockingDisconnectInFlight(connectionId)) await waitForBlockingDisconnectInFlight(connectionId);
    const existingConnect = connectInFlight.get(connectionId);
    if (existingConnect) {
      await existingConnect;
      if (options.activate !== false) activeConnectionId.value = connectionId;
      return;
    }
    const localAttempt = beginLocalConnectionAttempt(connectionId);
    const connectPromise = (async () => {
      let rememberPassword = false;
      // Fast-path the common case (password saved or no password needed) so the
      // in-flight dedup above keeps its exact microtask cadence; only await the
      // interactive prompt when the connection actually needs a typed password.
      if (connectionNeedsPasswordPrompt(config) && !(await hasSessionCredential(connectionId))) {
        const prompted = await ensureConnectionPassword(config);
        config = prompted.config;
        rememberPassword = prompted.rememberPassword;
      }
      await beforeConnectHandler?.(config);
      if (config.db_type === "sqlserver") {
        await ensureSqlServerLegacyCompatibilityComponentInstalled(config);
      }
      ensureLocalConnectionAttemptActive(connectionId, localAttempt);
      const connection = await connectDbWithPasswordRetry(config, localAttempt);
      config = connection.config;
      rememberPassword ||= connection.rememberPassword;
      const id = connection.id;
      await ensureLocalConnectionAttemptActiveAfterConnectResult(connectionId, localAttempt, id);
      await syncMongoLegacyDriverFallback(connectionId, config);
      await ensureLocalConnectionAttemptActiveAfterConnectResult(connectionId, localAttempt, id);
      connectedIds.value.add(connectionId);
      void refreshConnectedDatabaseInfo(connectionId, config);
      await refreshConnectionIdentifierQuote(connectionId, config);
      markSuccessfulLocalConnectionAttempt(connectionId, localAttempt);
      markConnectionHealthChecked(connectionId);
      clearConnectionError(connectionId);
      try {
        await persistRememberedConnectionPassword(config, rememberPassword, expectedConfigFingerprint);
      } catch (error) {
        setConnectionError(connectionId, i18n.global.t("connection.rememberPasswordSaveFailed", { message: connectionErrorMessage(error) }));
      }
    })();
    connectInFlight.set(connectionId, connectPromise);
    try {
      await connectPromise;
      if (options.activate !== false) activeConnectionId.value = connectionId;
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

  function sidebarDatabaseStorageRequestKey(connectionId: string, databases: readonly string[]): string {
    return `${connectionId}\0${[...databases].sort().join("\0")}`;
  }

  function sidebarDatabaseStorageCacheScope(connectionId: string, databases: readonly string[]): MetadataScopeInput {
    return { kind: "sidebar-database-storage", connectionId, extra: { databases: [...databases].sort() } };
  }

  function sidebarTableStorageCacheScope(scope: SidebarTableStorageScope): MetadataScopeInput {
    return { kind: "sidebar-table-storage", connectionId: scope.connectionId, database: scope.database, schema: scope.schema };
  }

  function clearSidebarStorageCaches(connectionId: string, database?: string) {
    if (database === undefined) sidebarDatabaseStorageCache.invalidate({ connectionId });
    sidebarTableStorageCache.invalidate(database === undefined ? { connectionId } : { connectionId, database });
    const connectionPrefix = `${connectionId}\0`;
    if (database === undefined) {
      for (const key of sidebarDatabaseStorageInFlight.keys()) {
        if (key.startsWith(connectionPrefix)) sidebarDatabaseStorageInFlight.delete(key);
      }
    }
    const tablePrefix = database === undefined ? connectionPrefix : `${connectionId}\0${database}\0`;
    for (const key of sidebarTableStorageInFlight.keys()) {
      if (key.startsWith(tablePrefix)) sidebarTableStorageInFlight.delete(key);
    }
  }

  async function loadSidebarDatabaseStorage(connectionId: string, options?: { force?: boolean }): Promise<void> {
    if (settingsStore.editorSettings.sidebarObjectInfoMode !== "size" || !connectedIds.value.has(connectionId)) return;
    if (!supportsSidebarDatabaseStorage(getConfig(connectionId))) return;
    const connectionNode = findConnectionNode(connectionId);
    const databases = sidebarDatabaseNames(connectionNode?.children);
    if (!databases.length) return;

    const requestKey = sidebarDatabaseStorageRequestKey(connectionId, databases);
    const cacheScope = sidebarDatabaseStorageCacheScope(connectionId, databases);
    const cached = sidebarDatabaseStorageCache.get(cacheScope);
    if (!options?.force && cached) {
      applySidebarDatabaseStorage(connectionNode?.children, cached.value);
      return;
    }

    let request = sidebarDatabaseStorageInFlight.get(requestKey);
    if (!request) {
      request = api.listDatabaseStorage(connectionId, databases);
      sidebarDatabaseStorageInFlight.set(requestKey, request);
    }
    try {
      const storage = await request;
      if (sidebarDatabaseStorageInFlight.get(requestKey) !== request || !connectedIds.value.has(connectionId)) return;
      sidebarDatabaseStorageCache.set(cacheScope, storage);
      const currentNode = findConnectionNode(connectionId);
      const currentNames = sidebarDatabaseNames(currentNode?.children);
      if (sidebarDatabaseStorageRequestKey(connectionId, currentNames) === requestKey) {
        applySidebarDatabaseStorage(currentNode?.children, storage);
      }
    } catch (error) {
      console.debug("[DBX][sidebar-database-storage:unavailable]", { connectionId, error });
    } finally {
      if (sidebarDatabaseStorageInFlight.get(requestKey) === request) {
        sidebarDatabaseStorageInFlight.delete(requestKey);
      }
    }
  }

  function sidebarTableStorageRequestKey(scope: SidebarTableStorageScope): string {
    return `${scope.connectionId}\0${scope.database}\0${scope.schema}`;
  }

  async function loadSidebarTableStorage(scope: SidebarTableStorageScope, options?: { force?: boolean }): Promise<void> {
    if (settingsStore.editorSettings.sidebarObjectInfoMode !== "size" || !connectedIds.value.has(scope.connectionId)) return;
    if (!supportsSidebarTableStorage(getConfig(scope.connectionId))) return;
    const requestKey = sidebarTableStorageRequestKey(scope);
    const cacheScope = sidebarTableStorageCacheScope(scope);
    const cached = sidebarTableStorageCache.get(cacheScope);
    if (!options?.force && cached) {
      applySidebarTableStorage(treeNodes.value, scope, cached.value);
      return;
    }

    let request = options?.force ? undefined : sidebarTableStorageInFlight.get(requestKey);
    if (!request) {
      request = api.listObjectStatistics(scope.connectionId, scope.database, scope.schema);
      sidebarTableStorageInFlight.set(requestKey, request);
    }
    try {
      const statistics = await request;
      if (sidebarTableStorageInFlight.get(requestKey) !== request || !connectedIds.value.has(scope.connectionId)) return;
      sidebarTableStorageCache.set(cacheScope, statistics);
      applySidebarTableStorage(treeNodes.value, scope, statistics);
    } catch (error) {
      console.debug("[DBX][sidebar-table-storage:unavailable]", { ...scope, error });
    } finally {
      if (sidebarTableStorageInFlight.get(requestKey) === request) {
        sidebarTableStorageInFlight.delete(requestKey);
      }
    }
  }

  const sidebarDatabaseStorageScope = computed(() => {
    if (settingsStore.editorSettings.sidebarObjectInfoMode !== "size") return "";
    return [...connectedIds.value]
      .filter((connectionId) => supportsSidebarDatabaseStorage(getConfig(connectionId)))
      .map((connectionId) => sidebarDatabaseStorageRequestKey(connectionId, sidebarDatabaseNames(findConnectionNode(connectionId)?.children)))
      .sort()
      .join("\n");
  });

  watch(
    sidebarDatabaseStorageScope,
    () => {
      if (settingsStore.editorSettings.sidebarObjectInfoMode !== "size") return;
      for (const connectionId of connectedIds.value) {
        void loadSidebarDatabaseStorage(connectionId);
      }
    },
    { flush: "post" },
  );

  async function loadXuguTablespaces(node: TreeNode, options?: LoadTreeOptions) {
    if (node.type !== "group-tablespaces" || !node.connectionId) return;
    const connectionId = node.connectionId;
    const config = getConfig(connectionId);
    if (effectiveDatabaseTypeForConnection(config) !== "xugu") return;
    return runTreeMetadataLoad(
      {
        kind: "xugu-tablespaces",
        connectionId,
        database: node.database || undefined,
        driverProfile: metadataDriverProfile(config),
      },
      async () => {
        let load = beginTreeNodeLoad(node);
        try {
          await ensureConnected(connectionId);
          load = reclaimTreeNodeLoad(load, node);
          if (useCachedChildren(node, options, load)) return;
          const tablespaces = await withMetadataLoadTimeout(connectionId, api.listXuguTablespaces(connectionId, node.database || undefined), "Xugu tablespaces");
          const targetNode = treeNodeLoadTarget(load);
          if (!targetNode) return;
          const children = buildXuguTablespaceChildren(targetNode, tablespaces);
          setChildren(targetNode, children);
          targetNode.objectCount = children.length;
          targetNode.isExpanded = true;
        } catch (error) {
          // Storage metadata is an optional, read-only enhancement. A user
          // without SYS_* view access should see an empty group rather than a
          // connection-level RPC error that blocks the rest of the tree.
          console.debug("[DBX][xugu-tablespaces:unavailable]", { connectionId, error });
          const targetNode = treeNodeLoadTarget(load);
          if (targetNode) {
            setChildren(targetNode, []);
            targetNode.objectCount = 0;
            targetNode.isExpanded = true;
          }
        } finally {
          finishTreeNodeLoad(load);
        }
      },
      options,
    );
  }

  async function loadDatabases(connectionId: string, options?: LoadTreeOptions) {
    const configForScope = getConfig(connectionId);
    const searchFilter = activeTreeLoadSearchFilter(options);
    if (!options?.force && !options?.connectedOnly && !searchFilter) {
      const cacheHit = await hydrateConnectionRootFromCache(connectionId, configForScope);
      if (cacheHit) {
        // Render the last known metadata immediately; network validation and refresh
        // continue in the background so opening a connection never waits on them.
        void loadDatabases(connectionId, { ...options, force: true }).catch(() => undefined);
        return;
      }
    }
    return runTreeMetadataLoad(
      {
        kind: "connection-databases",
        connectionId,
        driverProfile: metadataDriverProfile(configForScope),
      },
      async () => {
        const node = findConnectionNode(connectionId);
        if (!node) return;
        let load = beginTreeNodeLoad(node);
        try {
          if (options?.connectedOnly) {
            if (!connectedIds.value.has(connectionId)) return;
          } else {
            await ensureConnected(connectionId);
            load = reclaimTreeNodeLoad(load, node);
          }
          const config = getConfig(connectionId);
          if (useCachedChildren(node, options, load)) {
            scheduleMissingPrimaryVisibleObjectNamesRefresh(connectionId, config, options);
            return;
          }

          if (config?.db_type === "duckdb") {
            const cacheKey = schemaCacheKey(connectionId, "duckdb-root");
            if (!options?.force) {
              const cached = await loadPersistedTreeChildren(node, cacheKey, load);
              if (cached.hit) {
                if (cached.isStale) refreshStaleTreeNode(node);
                else scheduleMissingPrimaryVisibleObjectNamesRefresh(connectionId, config, options);
                return;
              }
            }
            const [databases, schemas] = await Promise.all([withMetadataLoadTimeout(connectionId, api.listDatabases(connectionId), "databases"), withMetadataLoadTimeout(connectionId, api.listSchemas(connectionId, "main"), "schemas")]);
            const databaseNames = databases.map((database) => database.name);
            const visibleNames = filterDatabaseNamesForConnection(databaseNames, config);
            const visibleNameSet = new Set(visibleNames);
            const visibleDatabases = databases.filter((database) => visibleNameSet.has(database.name));
            const visibleSchemas = visibleNameSet.has("main") ? schemas : [];
            const children = withSavedSqlRoot(connectionId, buildDuckDbConnectionTreeNodes(connectionId, visibleDatabases, visibleSchemas), node);
            if (isSidebarSearchQueryChanged(options)) return;
            const targetNode = treeNodeLoadTarget(load);
            if (!targetNode) return;
            recordPrimaryVisibleObjectNames(connectionId, databaseNames);
            setChildren(targetNode, children, { trustEmptyConnectionChildren: databaseNames.length > 0 && visibleNames.length === 0 });
            await savePersistedConnectionTreeChildren(cacheKey, targetNode.children || children);
          } else if (config && connectionUsesVisibleSchemaFilter(config)) {
            const schemaFilterConfig = config;
            const effectiveDb = schemaFilterConfig.database || "";
            const showSystemSchemas = schemaFilterConfig.show_system_schemas === true;
            const cacheKey = schemaCacheKey(connectionId, effectiveDb, config.db_type === "oracle" ? "schemas-v2" : "schemas", showSystemSchemas ? "show-system" : "hide-system");
            if (!options?.force) {
              const cached = await loadPersistedTreeChildren(node, cacheKey, load);
              if (cached.hit) {
                if (cached.isStale) refreshStaleTreeNode(node);
                else scheduleMissingPrimaryVisibleObjectNamesRefresh(connectionId, config, options);
                return;
              }
            }
            const schemas = await withMetadataLoadTimeout(connectionId, api.listSchemas(connectionId, effectiveDb), "schemas");
            const visibleSchemas = filterSchemaNamesForConnection(schemas, schemaFilterConfig, effectiveDb || "", { showSystemSchemas });
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
            const targetNode = treeNodeLoadTarget(load);
            if (!targetNode) return;
            recordPrimaryVisibleObjectNames(connectionId, schemas);
            setChildren(targetNode, withSavedSqlRoot(connectionId, schemaNodes, targetNode), { trustEmptyConnectionChildren: schemas.length > 0 && visibleSchemas.length === 0 });
            await savePersistedConnectionTreeChildren(cacheKey, targetNode.children || schemaNodes);
          } else {
            // Doris / StarRocks multi-catalog: when external catalogs exist,
            // render a catalog grouping layer (catalog → database → tables).
            // When only `internal` is present, fall through to the flat database
            // list (no regression for single-catalog deployments).
            let dorisCatalogs: CatalogInfo[] | null = null;
            if (connectionIsDorisFamilyCatalogCapable(config)) {
              dorisCatalogs = await withMetadataLoadTimeout(connectionId, api.listDorisCatalogs(connectionId), "catalogs").catch((error: unknown) => {
                recordMetadataLoadError(connectionId, error, load);
                return null;
              });
            }
            if (dorisCatalogs && shouldShowDorisCatalogTree(dorisCatalogs)) {
              const cacheKey = schemaCacheKey(connectionId, "doris-catalogs");
              if (!options?.force) {
                const cached = await loadPersistedTreeChildren(node, cacheKey, load);
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
              const targetNode = treeNodeLoadTarget(load);
              if (!targetNode) return;
              setChildren(targetNode, children);
              await savePersistedConnectionTreeChildren(cacheKey, targetNode.children || children);
            } else {
              const cacheKey = schemaCacheKey(connectionId, "databases-v2");
              if (!options?.force) {
                const cached = await loadPersistedTreeChildren(node, cacheKey, load);
                if (cached.hit) {
                  if (cached.isStale) refreshStaleTreeNode(node);
                  else scheduleMissingPrimaryVisibleObjectNamesRefresh(connectionId, config, options);
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
                // Cloud Spanner reports the full resource path as the database
                // name; show only the database id so the sidebar stays readable.
                displayLabel: effectiveDbType === "spanner" ? spannerDisplayDatabase : undefined,
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
              const targetNode = treeNodeLoadTarget(load);
              if (!targetNode) return;
              recordPrimaryVisibleObjectNames(
                connectionId,
                databases.map((database) => database.name),
              );
              setChildren(targetNode, children, { trustEmptyConnectionChildren: databases.length > 0 && visibleNames.length === 0 });
              await savePersistedConnectionTreeChildren(cacheKey, targetNode.children || children);
            }
          }
          const liveNode = treeNodeLoadTarget(load);
          if (liveNode) liveNode.isExpanded = true;
          if (options?.force) void loadSidebarDatabaseStorage(connectionId, { force: true });
        } catch (e) {
          recordMetadataLoadError(connectionId, e, load);
          throw e;
        } finally {
          finishTreeNodeLoad(load);
        }
      },
      options,
    );
  }

  async function loadConnectedConnectionRootForSidebarSearch(connectionId: string) {
    if (!connectedIds.value.has(connectionId)) return;
    const config = getConfig(connectionId);
    if (!config || ["redis", "etcd", "zookeeper", "consul", "mongodb", "dynamodb", "elasticsearch", "easysearch", "meilisearch", "milvus", "qdrant", "weaviate", "chromadb", "mq", "nacos"].includes(config.db_type)) return;
    const node = findConnectionNode(connectionId);
    if (!node || node.type !== "connection" || hasConnectionMetadataChildren(node.children)) return;
    const scope = { kind: "connection-databases" as const, connectionId, driverProfile: metadataDriverProfile(config) };
    const inFlight = metadataLoadCoordinator.inFlightPromise<void>(scope);
    if (inFlight) {
      await inFlight;
      return;
    }
    if (node.isLoading) return;

    const wasExpanded = !!node.isExpanded;
    const load = beginTreeNodeLoad(node);
    try {
      await loadDatabases(connectionId, { connectedOnly: true });
    } finally {
      const liveNode = treeNodeInSidebarTree(node);
      if (liveNode) liveNode.isExpanded = wasExpanded;
      finishTreeNodeLoad(load);
    }
  }

  async function loadRedisDatabases(connectionId: string) {
    const node = findConnectionNode(connectionId);
    if (!node) return;

    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(connectionId);
      load = reclaimTreeNodeLoad(load, node);
      const dbs = await withMetadataLoadTimeout(connectionId, api.redisListDatabases(connectionId), "Redis databases");
      const config = getConfig(connectionId);
      const visibleNames = filterVisibleDatabaseNames(
        dbs.map((db) => String(db.db)),
        config?.visible_databases,
      );
      const visibleNameSet = new Set(visibleNames);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      recordPrimaryVisibleObjectNames(
        connectionId,
        dbs.map((db) => String(db.db)),
      );
      setChildren(
        targetNode,
        withSavedSqlRoot(
          connectionId,
          dbs
            .filter((db) => visibleNameSet.has(String(db.db)))
            .map((db) => ({
              id: `${connectionId}:db${db.db}`,
              label: redisDatabaseLabel(db.db, config?.redis_database_aliases, db.keys),
              type: "redis-db" as const,
              connectionId,
              database: String(db.db),
              loadedKeyCount: 0,
              totalKeyCount: db.keys,
              isExpanded: false,
              children: [],
            })),
          targetNode,
        ),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadEtcdRoot(connectionId: string) {
    const node = findConnectionNode(connectionId);
    if (!node) return;

    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(connectionId);
      load = reclaimTreeNodeLoad(load, node);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
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
            {
              id: `${connectionId}:etcd-access-control`,
              label: "用户和角色",
              type: "etcd-access-control" as const,
              connectionId,
              database: "",
              isExpanded: false,
              children: [],
            },
            {
              id: `${connectionId}:etcd-dashboard`,
              label: "服务仪表盘",
              type: "etcd-dashboard" as const,
              connectionId,
              database: "",
              isExpanded: false,
              children: [],
            },
          ],
          targetNode,
        ),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadZooKeeperRoot(connectionId: string) {
    const node = findConnectionNode(connectionId);
    if (!node) return;

    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(connectionId);
      load = reclaimTreeNodeLoad(load, node);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
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
          targetNode,
        ),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadConsulRoot(connectionId: string) {
    const node = findConnectionNode(connectionId);
    if (!node) return;

    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(connectionId);
      load = reclaimTreeNodeLoad(load, node);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
        withSavedSqlRoot(
          connectionId,
          [
            {
              id: `${connectionId}:consul`,
              label: kvRootNodeLabel("consul"),
              type: "consul-root" as const,
              connectionId,
              database: "",
              isExpanded: false,
              children: [],
            },
            {
              id: `${connectionId}:consul-overview`,
              label: i18n.global.t("consul.ui.overview"),
              type: "consul-overview" as const,
              connectionId,
              database: "",
              isExpanded: false,
              children: [],
            },
          ],
          targetNode,
        ),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadMqttTopics(connectionId: string) {
    const node = findConnectionNode(connectionId);
    if (!node) return;

    node.isLoading = true;
    try {
      await ensureConnected(connectionId);
      // MQTT subscription state belongs to the console. The global sidebar only
      // exposes a single navigation entry and must not keep a second topic tree.
      const consoleNode: TreeNode = {
        id: `${connectionId}:mqtt-topic:__console__`,
        label: "connection.mqttConsoleTitle",
        type: "mqtt-topic" as const,
        connectionId,
        children: [],
        isExpanded: false,
      };
      setChildren(node, [consoleNode]);
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

    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(connectionId);
      load = reclaimTreeNodeLoad(load, node);
      if (useCachedChildren(node, options, load)) return;

      const config = getConfig(connectionId);
      if (isFlatMqConnection(config)) {
        // Kafka/RocketMQ have no tenant/namespace concept; RabbitMQ pins a synthetic
        // tenant and exposes virtual hosts as namespaces inside the console. Create a
        // synthetic child that opens the MQ admin console directly when clicked.
        const mqTenant = resolveMqSystemKindFromConnection(config) === "rabbitmq" ? RABBITMQ_MQ_TENANT : "_flat_mq";
        const targetNode = treeNodeLoadTarget(load);
        if (!targetNode) return;
        setChildren(targetNode, [
          {
            id: schemaCacheKey(connectionId, "mq-tenant", mqTenant),
            label: "Topics",
            type: "mq-tenant" as const,
            connectionId,
            mqTenant,
            mqInitialTab: "topics",
          },
        ]);
      } else {
        const tenants = await withMetadataLoadTimeout(connectionId, api.mqListTenants(connectionId), "message queue tenants");
        const tenantNames = sortSidebarNames(tenants.map((tenant) => tenant.name).filter((name) => !!name.trim()));
        const targetNode = treeNodeLoadTarget(load);
        if (!targetNode) return;
        setChildren(
          targetNode,
          tenantNames.map((tenant) => ({
            id: schemaCacheKey(connectionId, "mq-tenant", tenant),
            label: tenant,
            type: "mq-tenant" as const,
            connectionId,
            mqTenant: tenant,
          })),
        );
      }
      const liveNode = treeNodeLoadTarget(load);
      if (liveNode) liveNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadNacosNamespaces(connectionId: string, options?: LoadTreeOptions) {
    const node = findConnectionNode(connectionId);
    if (!node) return;

    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(connectionId);
      load = reclaimTreeNodeLoad(load, node);
      if (useCachedChildren(node, options, load)) return;

      const sidebarSnapshot = await api.nacosSidebarSnapshot(connectionId);
      const namespaces = normalizeNacosNamespacesForDisplay(sidebarSnapshot.namespaces);
      const visibleNamespaces = filterNacosNamespacesForSidebar(namespaces, getConfig(connectionId)?.visible_databases);
      const sorted = [...visibleNamespaces].sort((left, right) => {
        const leftLabel = left.namespaceShowName || left.namespace || "public";
        const rightLabel = right.namespaceShowName || right.namespace || "public";
        return leftLabel.localeCompare(rightLabel);
      });
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      recordPrimaryVisibleObjectNames(
        connectionId,
        namespaces.map((namespace) => namespace.namespace),
      );
      const children: TreeNode[] = [
        ...sorted.map((namespace) => {
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
      ];
      if (sidebarSnapshot.accessControl.listUsers.supported === true || sidebarSnapshot.accessControl.listRoleBindings.supported === true) {
        children.push({
          id: `${connectionId}:nacos-access-control`,
          label: "nacos.accessControlSidebarLabel",
          type: "nacos-access-control" as const,
          connectionId,
          database: "",
          isExpanded: false,
          children: [],
        });
      }
      setChildren(targetNode, children);
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
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
    node.label = redisDatabaseLabel(db, getConfig(connectionId)?.redis_database_aliases, node.totalKeyCount);
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

    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(connectionId);
      load = reclaimTreeNodeLoad(load, node);
      const dbs = await withMetadataLoadTimeout(connectionId, api.mongoListDatabases(connectionId), "MongoDB databases");
      const config = getConfig(connectionId);
      const visibleDbs = filterDatabaseNamesForConnection(dbs, config);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      recordPrimaryVisibleObjectNames(connectionId, dbs);
      setChildren(
        targetNode,
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
          targetNode,
        ),
        { trustEmptyConnectionChildren: dbs.length > 0 && visibleDbs.length === 0 },
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadDynamoDbTables(connectionId: string) {
    const node = findConnectionNode(connectionId);
    if (!node) return;

    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(connectionId);
      load = reclaimTreeNodeLoad(load, node);
      const config = getConfig(connectionId);
      const region = config?.database?.trim() || "us-east-1";
      const tables = await withMetadataLoadTimeout(connectionId, api.documentListCollections(connectionId, region), "DynamoDB tables");
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
        [...tables]
          .sort((left, right) => compareSidebarNames(left.name, right.name))
          .map((table) => ({
            id: `${connectionId}:__dynamodb_table:${table.id}`,
            label: table.name,
            type: "dynamodb-table" as const,
            connectionId,
            database: region,
            tableName: table.name,
            isExpanded: false,
          })),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  /**
   * Connect an Elasticsearch root without expanding or listing indices.
   * Used when first opening a connection (test/connect) — connectivity uses
   * GET / or the configured check path via ensureConnected/test_connection.
   * Expanding the node lists indices via loadElasticsearchIndices.
   */
  async function openElasticsearchConnectionTree(connectionId: string) {
    const node = findConnectionNode(connectionId);
    if (!node) return;

    // Only ensure connectivity (GET / or configured path); do not expand or list indices.
    try {
      await ensureConnected(connectionId);
    } catch (e) {
      recordMetadataLoadError(connectionId, e);
      throw e;
    }
  }

  async function loadElasticsearchIndices(connectionId: string) {
    const node = findConnectionNode(connectionId);
    if (!node) return;

    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(connectionId);
      load = reclaimTreeNodeLoad(load, node);
      const isMeilisearch = getConfig(connectionId)?.db_type === "meilisearch";
      const indices = await withMetadataLoadTimeout(connectionId, isMeilisearch ? api.meilisearchListIndexes(connectionId) : api.elasticsearchListIndices(connectionId), isMeilisearch ? "Meilisearch indexes" : "Elasticsearch indices");
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
        withSavedSqlRoot(
          connectionId,
          [
            ...sortSidebarNames(indices).map((index) => ({
              id: `${connectionId}:__collection:${index}`,
              label: index,
              type: "elasticsearch-index" as const,
              connectionId,
              database: "default",
              isExpanded: false,
            })),
            ...(isMeilisearch
              ? [
                  {
                    id: `${connectionId}:__meilisearch_system`,
                    label: "meilisearch.systemManagement",
                    type: "meilisearch-system" as const,
                    connectionId,
                    database: "default",
                    isExpanded: false,
                  },
                ]
              : []),
          ],
          targetNode,
        ),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      const targetNode = treeNodeLoadTarget(load);
      if (targetNode && getConfig(connectionId)?.db_type === "meilisearch") {
        const existingChildren = (targetNode.children || []).filter((child) => child.type !== "meilisearch-system");
        setChildren(
          targetNode,
          withSavedSqlRoot(
            connectionId,
            [
              ...existingChildren,
              {
                id: `${connectionId}:__meilisearch_system`,
                label: "meilisearch.systemManagement",
                type: "meilisearch-system",
                connectionId,
                database: "default",
                isExpanded: false,
              },
            ],
            targetNode,
          ),
        );
        targetNode.isExpanded = true;
      }
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadMilvusDatabases(connectionId: string) {
    const node = findConnectionNode(connectionId);
    if (!node) return;

    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(connectionId);
      load = reclaimTreeNodeLoad(load, node);
      const dbs = await withMetadataLoadTimeout(connectionId, api.documentListDatabases(connectionId), "Milvus databases");
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
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
          targetNode,
        ),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadVectorCollections(connectionId: string, database?: string) {
    const config = getConfig(connectionId);
    const isMilvus = config?.db_type === "milvus";
    const effectiveDb = database || config?.database || (config?.db_type === "chromadb" ? "default_database" : "default");
    // Milvus groups collections under a per-database node; other vector stores stay flat under the connection.
    const node = isMilvus && database ? findNode(treeNodes.value, `${connectionId}:${database}`) : findConnectionNode(connectionId);
    if (!node) return;

    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(connectionId);
      load = reclaimTreeNodeLoad(load, node);
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
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(targetNode, isMilvus && database ? collectionChildren : withSavedSqlRoot(connectionId, collectionChildren, targetNode));
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadMongoCollections(connectionId: string, database: string) {
    const nodeId = `${connectionId}:${database}`;
    const node = findNode(treeNodes.value, nodeId);
    if (!node) return;

    const load = beginTreeNodeLoad(node);
    try {
      const collections = await api.mongoListCollections(connectionId, database);
      const collectionEntries = visibleMongoCollections(collections);
      const collectionChildren = [...collectionEntries]
        .sort((left, right) => compareSidebarNames(left.name, right.name))
        .map((col) => ({
          id: `${nodeId}:${col.name}`,
          label: col.name,
          type: "mongo-collection" as const,
          connectionId,
          database,
          meta: { collectionKind: toMongoCollectionKind(col.kind) },
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
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(targetNode, children);
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
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
        let load = beginTreeNodeLoad(node);
        try {
          await ensureConnected(connectionId);
          load = reclaimTreeNodeLoad(load, node);
          if (useCachedChildren(node, options, load)) return;
          const config = getConfig(connectionId);
          const showSystemSchemas = config?.show_system_schemas === true;
          // schemas-v5 invalidates cached children created before the public
          // synonym scope was placed after all real schemas.
          const cacheVersion = ownerAwareMetadataCacheVersion(config, config?.db_type === "xugu" ? "schemas-v5" : "schemas-v3");
          const cacheKey = schemaCacheKey(connectionId, database, cacheVersion, showSystemSchemas ? "show-system" : "hide-system");
          if (!options?.force) {
            const cached = await loadPersistedTreeChildren(node, cacheKey, load);
            if (cached.hit) {
              if (cached.isStale) refreshStaleTreeNode(node);
              return;
            }
          }

          const schemas = sortSidebarSchemaInfos(await withMetadataLoadTimeout(connectionId, api.listSchemaInfos(connectionId, database), "schemas"), effectiveDatabaseTypeForConnection(config) === "spanner");
          const visibleSchemaNames = new Set(
            filterSchemaNamesForConnection(
              schemas.map((schema) => schema.name),
              getConfig(connectionId),
              database,
              { showSystemSchemas },
            ),
          );
          // The public-synonym scope is a protocol namespace, not a user
          // schema. Keep it discoverable even when a visible-schema filter is
          // configured, while preserving the raw key for object routing.
          if (config?.db_type === "xugu" && schemas.some((schema) => isXuguPublicSynonymScope(schema.name))) {
            visibleSchemaNames.add(XUGU_PUBLIC_SYNONYM_SCOPE);
          }
          if (config?.db_type === "xugu" && schemas.some((schema) => isXuguSchedulerJobScope(schema.name))) {
            visibleSchemaNames.add(XUGU_SCHEDULER_JOB_SCOPE);
          }
          const children: TreeNode[] = schemas
            .filter((schema) => visibleSchemaNames.has(schema.name))
            .map((schema) => {
              const s = schema.name;
              return {
                id: `${connectionId}:${database}:${s}`,
                label: config?.db_type === "xugu" ? xuguSchemaDisplayName(s) : config?.db_type === "spanner" ? spannerSchemaDisplayName(s) : s,
                type: "schema" as const,
                connectionId,
                database,
                schema: s,
                comment: schema.comment,
                isExpanded: false,
                children: [],
              };
            });
          if (schemas.length === 0 && connectionShouldDiscoverJdbcSchemas(getConfig(connectionId))) {
            // Generic JDBC drivers vary widely: prefer schema navigation when the
            // driver reports schemas, but keep the legacy flat object tree when it
            // reports none so non-schema engines do not expand into an empty node.
            await loadTables(connectionId, database, undefined, options);
            return;
          }
          if (isPostgresLikeForExtensions(getConfig(connectionId)?.db_type)) {
            children.push(buildExtensionManagementNode(connectionId, database));
          }
          if (isSidebarSearchQueryChanged(options)) return;
          const targetNode = treeNodeLoadTarget(load);
          if (!targetNode) return;
          setChildren(targetNode, children);
          await savePersistedTreeChildren(cacheKey, children);
          const currentTargetNode = treeNodeLoadTarget(load);
          if (currentTargetNode) currentTargetNode.isExpanded = true;
        } catch (e) {
          recordMetadataLoadError(connectionId, e, load);
          throw e;
        } finally {
          finishTreeNodeLoad(load);
        }
      },
      options,
    );
  }

  async function loadSqlServerDatabaseObjects(connectionId: string, database: string, options?: LoadTreeOptions) {
    const nodeId = `${connectionId}:${database}`;
    const node = findNode(treeNodes.value, nodeId);
    if (!node) return;
    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(connectionId);
      load = reclaimTreeNodeLoad(load, node);
      if (useCachedChildren(node, options, load)) return;
      const simpleObjectDisplay = useSettingsStore().editorSettings.sidebarObjectDisplay === "simple";
      const config = getConfig(connectionId);
      const showSystemSchemas = config?.show_system_schemas === true;
      const cacheKey = schemaCacheKey(connectionId, database, simpleObjectDisplay ? "sqlserver-schemas-simple-v4" : "sqlserver-schemas-grouped-v4", showSystemSchemas ? "show-system" : "hide-system");
      if (!options?.force) {
        const cached = await loadPersistedTreeChildren(node, cacheKey, load);
        if (cached.hit) {
          if (cached.isStale) refreshStaleTreeNode(node);
          return;
        }
      }
      const schemas = filterSchemaNamesForConnection(await api.listSchemas(connectionId, database), config, database, { showSystemSchemas });
      const children = buildSqlServerDatabaseTreeNodes(connectionId, database, schemas);
      if (isSidebarSearchQueryChanged(options)) return;
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(targetNode, children);
      await savePersistedTreeChildren(cacheKey, children);
      const currentTargetNode = treeNodeLoadTarget(load);
      if (currentTargetNode) currentTargetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadSqlServerLinkedServers(connectionId: string, options?: LoadTreeOptions) {
    const node = findNode(treeNodes.value, sqlServerLinkedRootId(connectionId));
    if (!node) return;
    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(connectionId);
      load = reclaimTreeNodeLoad(load, node);
      if (useCachedChildren(node, options, load)) return;
      const config = getConfig(connectionId);
      const database = sqlServerLinkedRuntimeDatabase(config);
      const linkedServers = await api.listSqlServerLinkedServers(connectionId);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
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
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadSqlServerLinkedServerCatalogs(node: TreeNode, options?: LoadTreeOptions) {
    if (!node.connectionId || !node.linkedServer) return;
    const connectionId = node.connectionId;
    const server = node.linkedServer;
    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(connectionId);
      load = reclaimTreeNodeLoad(load, node);
      if (useCachedChildren(node, options, load)) return;
      const catalogs = await api.listSqlServerLinkedServerCatalogs(connectionId, server);
      const database = node.database || sqlServerLinkedRuntimeDatabase(getConfig(connectionId));
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
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
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadSqlServerLinkedServerSchemas(node: TreeNode, options?: LoadTreeOptions) {
    if (!node.connectionId || !node.linkedServer || !node.linkedCatalog) return;
    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(node.connectionId);
      load = reclaimTreeNodeLoad(load, node);
      if (useCachedChildren(node, options, load)) return;
      const schemas = await api.listSqlServerLinkedServerSchemas(node.connectionId, node.linkedServer, node.linkedCatalog);
      const database = node.database || sqlServerLinkedRuntimeDatabase(getConfig(node.connectionId));
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
        sortSidebarNames(schemas)
          .filter((schema) => schema.trim())
          .map((schema) => {
            const encodedSchema = encodeSqlServerLinkedSchema({
              server: targetNode.linkedServer!,
              catalog: targetNode.linkedCatalog!,
              schema,
            });
            return {
              id: `${targetNode.connectionId}:${database}:${encodedSchema}`,
              label: schema,
              type: "linked-server-schema" as const,
              connectionId: targetNode.connectionId,
              database,
              schema: encodedSchema,
              linkedServer: targetNode.linkedServer,
              linkedCatalog: targetNode.linkedCatalog,
              linkedSchema: schema,
              isExpanded: false,
              children: [],
            };
          }),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(node.connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  // Doris / StarRocks multi-catalog: load the databases under a catalog node.
  async function loadDorisCatalogDatabases(node: TreeNode, options?: LoadTreeOptions) {
    if (!node.connectionId || !node.catalog) return;
    const connectionId = node.connectionId;
    const catalog = node.catalog;
    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(connectionId);
      load = reclaimTreeNodeLoad(load, node);
      if (useCachedChildren(node, options, load)) return;
      const config = getConfig(connectionId);
      const databases = await withMetadataLoadTimeout(connectionId, api.listDorisCatalogDatabases(connectionId, catalog), "databases");
      const visibleNames = filterDatabaseNamesForConnection(
        databases.map((database) => database.name),
        config,
      );
      const visibleNameSet = new Set(visibleNames);
      const visibleDatabases = databases.filter((database) => visibleNameSet.has(database.name));
      let databaseNodes: TreeNode[];
      if (isInternalDorisCatalog(node.catalogType, catalog)) {
        // The internal catalog's databases are rendered as standard database
        // nodes so they reuse the existing table-loading / table-open paths.
        // Detection is type-based (catalogType=`internal`), so StarRocks
        // `default_catalog` routes here too — its tables carry no catalog.
        databaseNodes = buildDatabaseTreeNodes(connectionId, visibleDatabases, { includeDefaultWhenEmpty: false });
      } else {
        databaseNodes = sortSidebarDatabases(visibleDatabases).flatMap((database) => {
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
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(targetNode, databaseNodes);
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
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
    const searchFilterForScope = activeTreeLoadSearchFilter(options);
    const pageSizeForScope = sidebarObjectGroupPageSize();
    return runTreeMetadataLoad(
      {
        kind: "schema-tables",
        connectionId,
        database,
        schema: undefined,
        nodeKind: "database",
        objectTypes: objectTypesForScope,
        searchFilter: searchFilterForScope,
        limit: simpleObjectDisplayForScope ? (searchFilterForScope ? SIDEBAR_TABLE_SEARCH_RESULT_BUDGET : pageSizeForScope + 1) : undefined,
        offset: 0,
        sidebarDisplayMode: simpleObjectDisplayForScope ? "simple" : "grouped",
        driverProfile: metadataDriverProfile(configForScope),
        extra: options?.sidebarTableSearchParentId ? { sidebarTableSearchParentId: options.sidebarTableSearchParentId } : undefined,
      },
      async () => {
        let load = beginTreeNodeLoad(node);
        try {
          await ensureConnected(connectionId);
          load = reclaimTreeNodeLoad(load, node);
          if (useCachedChildren(node, options, load)) return;
          const searchFilter = activeTreeLoadSearchFilter(options);
          const tableNameFilter = activeTableNameFilterForScope({
            connectionId,
            database,
            nodeKind: "simple-tables",
            catalog,
          });
          const cacheKey = schemaCacheKey(connectionId, `doris-catalog:${catalog}`, database, "objects-simple-v5");
          if (!options?.force && !searchFilter && !tableNameFilter) {
            const cached = await loadPersistedTreeChildren(node, cacheKey, load);
            if (cached.hit) {
              if (cached.isStale) refreshStaleTreeNode(node);
              return;
            }
          }
          const pageSize = pageSizeForScope;
          const fetchLimit = searchFilter ? SIDEBAR_TABLE_SEARCH_RESULT_BUDGET : pageSize + 1;
          const fetchOffset = searchFilter ? undefined : 0;
          const tables = await withMetadataLoadTimeout(connectionId, listTablesWithOptionalTableNameFilter(connectionId, database, "", searchFilter, fetchLimit, fetchOffset, objectTypesForScope, catalog, tableNameFilter), "tables");
          const hasMore = searchFilter ? false : tables.length > pageSize;
          const pageTables = hasMore ? tables.slice(0, pageSize) : tables;
          indexCompletionTables(connectionId, database, undefined, tableInfosToCompletionTables(pageTables, undefined), catalog);
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
          if (!tableNameFilterRevisionMatches(options)) return;
          const targetNode = treeNodeLoadTarget(load);
          if (!targetNode) return;
          targetNode.objectCount = children.filter((child) => child.type !== "load-more").length;
          setChildren(targetNode, children);
          if (!searchFilter && !options?.sidebarTableSearchParentId && !tableNameFilter) {
            await savePersistedTreeChildren(cacheKey, children);
          }
          const currentTargetNode = treeNodeLoadTarget(load);
          if (currentTargetNode) currentTargetNode.isExpanded = true;
        } catch (e) {
          recordMetadataLoadError(connectionId, e, load);
          throw e;
        } finally {
          finishTreeNodeLoad(load);
        }
      },
      options,
    );
  }

  async function loadTables(connectionId: string, database: string, schema?: string, options?: LoadTreeOptions) {
    const configForScope = getConfig(connectionId);
    const simpleObjectDisplayForScope = useSettingsStore().editorSettings.sidebarObjectDisplay === "simple";
    const objectTypesForScope = simpleObjectDisplayForScope ? sidebarObjectTypesForScope(configForScope, schema) : undefined;
    const searchFilter = activeTreeLoadSearchFilter(options);
    const querySchemaForScope = connectionObjectTreeQuerySchema(configForScope, database, schema);
    const effectiveSchemaForScope = connectionObjectTreeNodeSchema(configForScope, database, schema);
    const tableNameFilterForScope = activeTableNameFilterForScope({
      connectionId,
      database,
      schema: effectiveSchemaForScope ?? querySchemaForScope,
      nodeKind: simpleObjectDisplayForScope ? "simple-tables" : "group-tables",
    });
    if (!options?.force && simpleObjectDisplayForScope && !searchFilter && !options?.sidebarTableSearchParentId && !tableNameFilterForScope) {
      // `schema != null`, not truthiness: Cloud Spanner's GoogleSQL default schema is the empty
      // string, and its node id carries the trailing separator (`conn:db:`). A truthiness test
      // collapses that to the database node id, so the loaded tables were attached to the
      // database node instead of the schema node, leaving `(default)` permanently empty.
      const nodeId = schema != null ? `${connectionId}:${database}:${schema}` : `${connectionId}:${database}`;
      const cacheKey = schemaCacheKey(connectionId, database, schema || "", objectTreeCacheVersion(configForScope, schema, "objects-simple-v8"));
      if (await hydrateTreeNodeFromCache(findNode(treeNodes.value, nodeId), cacheKey)) {
        void loadTables(connectionId, database, schema, { ...options, force: true }).catch(() => undefined);
        return;
      }
    }
    return runTreeMetadataLoad(
      {
        kind: "schema-tables",
        connectionId,
        database,
        schema,
        nodeKind: schema != null ? "schema" : "database",
        objectTypes: objectTypesForScope,
        searchFilter: activeTreeLoadSearchFilter(options),
        limit: simpleObjectDisplayForScope ? sidebarObjectGroupPageSize() + 1 : undefined,
        offset: 0,
        sidebarDisplayMode: simpleObjectDisplayForScope ? "simple" : "grouped",
        driverProfile: metadataDriverProfile(configForScope),
        extra: options?.sidebarTableSearchParentId ? { sidebarTableSearchParentId: options.sidebarTableSearchParentId } : undefined,
      },
      async () => {
        // `schema != null`, not truthiness: Cloud Spanner's GoogleSQL default schema is the empty
        // string, and its node id carries the trailing separator (`conn:db:`). A truthiness test
        // collapses that to the database node id, so the loaded tables were attached to the
        // database node instead of the schema node, leaving `(default)` permanently empty.
        const nodeId = schema != null ? `${connectionId}:${database}:${schema}` : `${connectionId}:${database}`;
        const node = findNode(treeNodes.value, nodeId);
        if (!node) return;
        let load = beginTreeNodeLoad(node);
        try {
          await ensureConnected(connectionId);
          load = reclaimTreeNodeLoad(load, node);
          if (useCachedChildren(node, options, load)) return;
          const simpleObjectDisplay = useSettingsStore().editorSettings.sidebarObjectDisplay === "simple";
          const searchFilter = activeTreeLoadSearchFilter(options);
          const config = getConfig(connectionId);
          const objectTreeProfile = driverProfileObjectTreeProfileForConnection(config);
          const isPublicSynonymScope = config?.db_type === "xugu" && isXuguPublicSynonymScope(schema);
          const isSchedulerJobScope = config?.db_type === "xugu" && isXuguSchedulerJobScope(schema);
          const baseCacheVersion = objectTreeCacheVersion(config, schema, simpleObjectDisplay ? "objects-simple-v8" : "objects-grouped-v8");
          const cacheVersion = !simpleObjectDisplay && objectTreeProfile?.cacheKey ? `${baseCacheVersion}:${objectTreeProfile.cacheKey}` : baseCacheVersion;
          const cacheKey = schemaCacheKey(connectionId, database, schema || "", cacheVersion);
          const querySchema = connectionObjectTreeQuerySchema(config, database, schema);
          const effectiveSchema = connectionObjectTreeNodeSchema(config, database, schema);
          const tableNameFilter = activeTableNameFilterForScope({
            connectionId,
            database,
            schema,
            nodeKind: simpleObjectDisplay ? "simple-tables" : "group-tables",
          });
          const isSidebarTableSearch = !!options?.sidebarTableSearchParentId;
          if (!options?.force && !searchFilter && !tableNameFilter) {
            const cached = await loadPersistedTreeChildren(node, cacheKey, load);
            if (cached.hit) {
              if (cached.isStale) refreshStaleTreeNode(node);
              return;
            }
          }

          const nonTableObjectTypes = simpleObjectDisplay ? sidebarObjectTypesForScope(config, schema).filter((objectType) => objectType !== "TABLE") : [];
          let children: TreeNode[];
          let nextObjectCount: number | undefined;
          if (simpleObjectDisplay && !isPublicSynonymScope && !isSchedulerJobScope) {
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
              searchFilter: options?.searchFilter === "" ? "" : searchFilter || undefined,
              force: options?.force,
            });
            children = page.hasMore && !searchFilter ? appendTableTreeLoadMoreNode(page.children, buildLoadMoreNode(node, page.nextOffset, pageSize), page.loadMoreParent) : page.children;
            nextObjectCount = page.objectCount;
          } else if (simpleObjectDisplay) {
            // The synthetic public scope contains no tables. Avoid issuing a
            // table-list query against the protocol namespace; supplemental
            // object loading below will add only its SYNONYM entries.
            children = [];
            nextObjectCount = 0;
          } else {
            children = buildObjectGroupPlaceholderNodes({
              nodeId,
              connectionId,
              database,
              schema: effectiveSchema,
              objectTypes: sidebarObjectTypesForScope(config, schema),
              groupOverrides: objectTreeProfile?.groupOverrides,
            });
            if (!schema && isPostgresLikeForExtensions(config?.db_type)) {
              children.push(buildExtensionManagementNode(connectionId, database));
            }
          }
          if (isTreeLoadSearchChanged(searchFilter, options)) return;
          if (!tableNameFilterRevisionMatches(options)) return;
          const targetNode = treeNodeLoadTarget(load);
          if (!targetNode) return;
          if (nextObjectCount !== undefined) targetNode.objectCount = nextObjectCount;
          setChildren(targetNode, children);
          if (!searchFilter && !isSidebarTableSearch && !tableNameFilter) {
            await savePersistedTreeChildren(cacheKey, children);
          }
          const currentTargetNode = treeNodeLoadTarget(load);
          if (!currentTargetNode) return;
          currentTargetNode.isExpanded = true;
          if (simpleObjectDisplay && !searchFilter && !isSidebarTableSearch && nonTableObjectTypes.length > 0) {
            void loadSimpleSupplementalObjectChildren({
              node: currentTargetNode,
              nodeId,
              connectionId,
              database,
              querySchema,
              effectiveSchema,
              objectTypes: nonTableObjectTypes,
              cacheKey,
              loadOptions: options,
              load,
            });
          }
        } catch (e) {
          recordMetadataLoadError(connectionId, e, load);
          throw e;
        } finally {
          finishTreeNodeLoad(load);
        }
      },
      options,
    );
  }

  async function loadObjectGroupChildren(node: TreeNode, options?: LoadTreeOptions) {
    const packageOwnerId = packageMemberGroupOwnerId(node);
    const packageConfig = node.connectionId ? getConfig(node.connectionId) : undefined;
    if (packageOwnerId && effectiveDatabaseTypeForConnection(packageConfig) === "xugu") {
      const packageNode = findNode(treeNodes.value, packageOwnerId);
      if (packageNode?.type === "package") await loadPackageMembers(packageNode, options);
      return;
    }

    const configForScope = node.connectionId ? getConfig(node.connectionId) : undefined;
    const objectTypesForScope = objectTypesForGroupNode(node.type);
    const pageSizeForScope = sidebarObjectGroupPageSize();
    const searchFilter = activeTreeLoadSearchFilter(options);
    const querySchemaForScope = connectionObjectTreeQuerySchema(configForScope, node.database || "", node.schema);
    const effectiveSchemaForScope = connectionObjectTreeNodeSchema(configForScope, node.database || "", node.schema);
    const tableNameFilterForScope = activeTableNameFilterForScope({
      connectionId: node.connectionId,
      database: node.database,
      schema: effectiveSchemaForScope ?? querySchemaForScope,
      nodeKind: node.type,
      catalog: node.catalog,
    });
    if (!options?.force && !searchFilter && !options?.sidebarTableSearchParentId && !tableNameFilterForScope) {
      if (await hydrateTreeNodeFromCache(node, objectGroupCacheKey(node))) {
        filteredObjectGroupChildrenIds.delete(node.id);
        void loadObjectGroupChildren(node, { ...options, force: true }).catch(() => undefined);
        return;
      }
    }
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
        let load = beginTreeNodeLoad(node);
        try {
          await ensureConnected(node.connectionId);
          load = reclaimTreeNodeLoad(load, node);
          if (useCachedChildren(node, options, load)) {
            filteredObjectGroupChildrenIds.delete(node.id);
            return;
          }
          const objectTypes = objectTypesForGroupNode(node.type);
          const parentNodeId = objectGroupRefreshParentId(node);
          if (!objectTypes || !parentNodeId) return;

          const config = getConfig(node.connectionId);
          const querySchema = connectionObjectTreeQuerySchema(config, node.database, node.schema);
          const effectiveSchema = connectionObjectTreeNodeSchema(config, node.database, node.schema);
          const cacheKey = objectGroupCacheKey(node);
          const searchFilter = activeTreeLoadSearchFilter(options);
          const tableNameFilter = activeTableNameFilterForScope({
            connectionId: node.connectionId,
            database: node.database,
            schema: node.schema,
            nodeKind: node.type,
            catalog: node.catalog,
          });
          const isSidebarTableSearch = !!options?.sidebarTableSearchParentId;
          if (!options?.force && !searchFilter && !tableNameFilter) {
            const cached = await loadPersistedTreeChildren(node, cacheKey, load);
            if (cached.hit) {
              filteredObjectGroupChildrenIds.delete(node.id);
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
              searchFilter: options?.searchFilter === "" ? "" : searchFilter || undefined,
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
          if (!tableNameFilterRevisionMatches(options)) return;
          const targetNode = treeNodeLoadTarget(load);
          if (!targetNode) return;
          targetNode.objectCount = nextObjectCount;
          setChildren(targetNode, children);
          if (searchFilter) filteredObjectGroupChildrenIds.add(targetNode.id);
          else filteredObjectGroupChildrenIds.delete(targetNode.id);
          options?.onChildrenApplied?.(targetNode);
          if (!searchFilter && !isSidebarTableSearch && !tableNameFilter) {
            await savePersistedTreeChildren(cacheKey, children);
          }
          const currentTargetNode = treeNodeLoadTarget(load);
          if (currentTargetNode) currentTargetNode.isExpanded = true;
        } catch (e) {
          recordMetadataLoadError(node.connectionId, e, load);
          throw e;
        } finally {
          finishTreeNodeLoad(load);
        }
      },
      options,
    );
  }

  async function loadCustomTypeChildren(node: TreeNode, options?: LoadTreeOptions) {
    if (node.type !== "type" || !node.connectionId || !hasTreeNodeDatabaseContext(node)) return;
    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(node.connectionId);
      load = reclaimTreeNodeLoad(load, node);
      if (useCachedChildren(node, options, load)) return;
      const schema = node.schema || node.database;
      const details = await api.getCustomTypeDetails(node.connectionId, node.database, schema, node.objectName || node.label);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      const children = buildCustomTypeTreeChildren(targetNode, details);
      targetNode.customTypeKind = details.kind;
      targetNode.hasMembers = children.length > 0;
      setChildren(targetNode, children);
      targetNode.isExpanded = children.length > 0;
    } catch (error) {
      recordMetadataLoadError(node.connectionId, error, load);
      throw error;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadMoreObjectGroupChildren(node: TreeNode, options?: { searchFilter?: string }) {
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
        let load = beginTreeNodeLoad(node);
        // Parent writes must honor the parent's generation too — load-more begins on the
        // placeholder node, so a replaced/invalidated parent must reject the merge.
        const parentEpoch = treeNodeLoads.observe(parent.id);
        try {
          await ensureConnected(parentConnectionId);
          load = reclaimTreeNodeLoad(load, node);
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
            const targetParent = treeNodeLoadRelatedTarget(load, parent);
            if (!targetParent || !parentEpoch.isCurrent()) return;
            const currentChildren = withoutTableTreeLoadMoreNodes(targetParent.children);
            const mergedChildren = mergeTableTreePageChildren(currentChildren, page.children, parentConnectionId, parentDatabase);
            const nextChildren = page.hasMore ? appendTableTreeLoadMoreNode(mergedChildren, buildLoadMoreNode(targetParent, page.nextOffset, loadMore.pageSize), page.loadMoreParent) : mergedChildren;
            targetParent.objectCount = mergedChildren.length;
            setChildren(targetParent, nextChildren);
            await savePersistedTreeChildren(schemaCacheKey(parentConnectionId, parentDatabase, parent.schema || "", ownerAwareMetadataCacheVersion(config, "objects-simple-v8")), nextChildren);
            const currentTargetParent = treeNodeLoadRelatedTarget(load, parent);
            if (currentTargetParent && parentEpoch.isCurrent()) currentTargetParent.isExpanded = true;
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
              searchFilter: options?.searchFilter,
              force: false,
            });
            const targetParent = treeNodeLoadRelatedTarget(load, parent);
            if (!targetParent || !parentEpoch.isCurrent()) return;
            const currentChildren = withoutTableTreeLoadMoreNodes(targetParent.children);
            mergedChildren = mergeTableTreePageChildren(currentChildren, page.children, parentConnectionId, parentDatabase);
            nextChildren = page.hasMore ? appendTableTreeLoadMoreNode(mergedChildren, buildLoadMoreNode(targetParent, page.nextOffset, loadMore.pageSize), page.loadMoreParent) : mergedChildren;
          } else {
            const page = await loadPagedObjectGroupChildren({
              node: parent,
              parentNodeId,
              querySchema,
              effectiveSchema,
              objectTypes,
              offset: loadMore.offset,
              pageSize: loadMore.pageSize,
              searchFilter: options?.searchFilter,
              force: false,
            });
            const targetParent = treeNodeLoadRelatedTarget(load, parent);
            if (!targetParent || !parentEpoch.isCurrent()) return;
            const currentChildren = withoutLoadMoreNodes(targetParent.children);
            mergedChildren = mergeLocatedTreeChildren(targetParent, currentChildren, page.children, parentConnectionId, parentDatabase);
            nextChildren = page.hasMore ? [...mergedChildren, buildLoadMoreNode(targetParent, page.nextOffset, loadMore.pageSize)] : mergedChildren;
            targetParent.objectCount = mergedChildren.length;
            setChildren(targetParent, nextChildren);
            await savePersistedTreeChildren(objectGroupCacheKey(targetParent), nextChildren);
            const currentTargetParent = treeNodeLoadRelatedTarget(load, parent);
            if (currentTargetParent && parentEpoch.isCurrent()) currentTargetParent.isExpanded = true;
            return;
          }
          const targetParent = treeNodeLoadRelatedTarget(load, parent);
          if (!targetParent || !parentEpoch.isCurrent()) return;
          targetParent.objectCount = mergedChildren.length;
          setChildren(targetParent, nextChildren);
          await savePersistedTreeChildren(objectGroupCacheKey(targetParent), nextChildren);
          const currentTargetParent = treeNodeLoadRelatedTarget(load, parent);
          if (currentTargetParent && parentEpoch.isCurrent()) currentTargetParent.isExpanded = true;
        } catch (e) {
          recordMetadataLoadError(parentConnectionId, e, load);
          throw e;
        } finally {
          finishTreeNodeLoad(load);
        }
      },
    );
  }

  async function loadExtensions(connectionId: string, database: string) {
    const node = findNode(treeNodes.value, `${connectionId}:${database}:__extensions`);
    if (!node) return;
    let load = beginTreeNodeLoad(node);
    try {
      await ensureConnected(connectionId);
      load = reclaimTreeNodeLoad(load, node);
      if (useCachedChildren(node, undefined, load)) return;
      const extensions = await withMetadataLoadTimeout(connectionId, api.listExtensions(connectionId, database), "extensions");
      const children: TreeNode[] = extensions.map((ext) => ({
        id: `${node.id}:${ext.schema || ""}:${ext.name}`,
        label: ext.name,
        type: "extension" as const,
        connectionId,
        database,
        schema: ext.schema ?? undefined,
        comment: ext.comment ?? null,
        meta: ext,
        isExpanded: false,
      }));
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(targetNode, children);
      targetNode.objectCount = children.length;
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
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
          let load = beginTreeNodeLoad(parent);
          try {
            load = reclaimTreeNodeLoad(load, parent);
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
            const targetParent = treeNodeLoadTarget(load);
            if (!targetParent) return false;
            const currentChildren = withoutLoadMoreNodes(targetParent.children);
            const loadMoreNodes = (targetParent.children || []).filter((child) => child.type === "load-more");
            const mergedChildren = mergeLocatedTreeChildren(targetParent, currentChildren, page.children, target.connectionId, target.database);
            setChildren(targetParent, [...mergedChildren, ...loadMoreNodes]);
            targetParent.objectCount = Math.max(targetParent.objectCount ?? currentChildren.length, mergedChildren.length);
            targetParent.isExpanded = true;
            return true;
          } finally {
            finishTreeNodeLoad(load);
          }
        }

        const matchingGroups = findTreeNodes(treeNodes.value, (node) => {
          return (
            (node.type === "group-tables" || node.type === "group-dolt-system-tables" || node.type === "group-views" || node.type === "group-materialized-views") &&
            node.connectionId === target.connectionId &&
            sameSidebarObjectName(node.database, target.database) &&
            (!target.schema || sameSidebarObjectName(node.schema, target.schema))
          );
        });

        for (const group of matchingGroups) {
          const objectTypes = objectTypesForGroupNode(group.type);
          const parentNodeId = objectGroupRefreshParentId(group);
          if (!objectTypes || !parentNodeId) continue;

          let load = beginTreeNodeLoad(group);
          try {
            load = reclaimTreeNodeLoad(load, group);
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

            const targetGroup = treeNodeLoadTarget(load);
            if (!targetGroup) continue;
            const currentChildren = withoutLoadMoreNodes(targetGroup.children);
            const loadMoreNodes = (targetGroup.children || []).filter((child) => child.type === "load-more");
            const mergedChildren = mergeLocatedTreeChildren(targetGroup, currentChildren, page.children, target.connectionId, target.database);
            setChildren(targetGroup, [...mergedChildren, ...loadMoreNodes]);
            targetGroup.objectCount = Math.max(targetGroup.objectCount ?? currentChildren.length, mergedChildren.length);
            targetGroup.isExpanded = true;
            loaded = true;
          } finally {
            finishTreeNodeLoad(load);
          }
        }

        return loaded;
      },
    );
  }

  async function loadAllObjectGroupChildren(parent: TreeNode) {
    if (!parent.connectionId || !hasTreeNodeDatabaseContext(parent)) return;
    if (!objectTypesForGroupNode(parent.type)) return;
    const liveParent = treeNodeInSidebarTree(parent);
    if (!liveParent) return;
    if (!isTreeNodeChildrenLoaded(liveParent.id) || filteredObjectGroupChildrenIds.has(liveParent.id)) {
      let isPreparedPageCurrent: (() => boolean) | undefined;
      await loadObjectGroupChildren(liveParent, {
        force: true,
        searchFilter: "",
        allowGlobalSearchMismatch: true,
        onChildrenApplied: (targetNode) => {
          const epoch = treeNodeLoads.observe(targetNode.id);
          isPreparedPageCurrent = () => epoch.isCurrent();
        },
      });
      if (!isPreparedPageCurrent?.()) return;
    }

    const refreshedParent = treeNodeInSidebarTree(parent);
    if (!refreshedParent) return;
    const load = beginTreeNodeLoad(refreshedParent);
    try {
      const liveParent = treeNodeLoadTarget(load);
      if (!liveParent) return;

      let loadMoreNode = findTreeNodes(liveParent.children ?? [], (child) => child.type === "load-more")[0];
      while (loadMoreNode?.loadMore) {
        await loadMoreObjectGroupChildren(loadMoreNode, { searchFilter: "" });
        if (!load.isCurrent()) return;
        const currentParent = treeNodeLoadTarget(load);
        if (!currentParent) return;
        loadMoreNode = findTreeNodes(currentParent.children ?? [], (child) => child.type === "load-more")[0];
      }
      const finishedParent = treeNodeLoadTarget(load);
      if (finishedParent) finishedParent.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(refreshedParent.connectionId!, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
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
    let load = beginTreeNodeLoad(node);

    try {
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
      const effectiveDbType = effectiveDatabaseTypeForConnection(config);
      const metadataCapabilities = getTableMetadataCapabilities(effectiveDbType);
      const isXugu = effectiveDbType === "xugu";
      const supportsXuguChildMetadata = isXugu && node.type === "table" && (await supportsXuguTableChildMetadata());
      load = reclaimTreeNodeLoad(load, node);
      if (supportsXuguChildMetadata) {
        children.push({
          id: `${parentId}:__constraints`,
          label: "tree.constraints",
          type: "group-constraints",
          connectionId,
          database,
          schema,
          catalog,
          tableName: table,
          isExpanded: false,
          children: [],
        });
      }
      const isMongoView = node.type === "mongo-collection" && mongoCollectionKindFromNode(node) === "view";
      if ((node.type === "table" || node.type === "mongo-collection") && !isMongoView && !parseSqlServerLinkedSchema(schema)) {
        if (metadataCapabilities.indexes && !isXugu) {
          children.push({
            id: `${parentId}:__indexes`,
            label: "tree.indexes",
            type: "group-indexes",
            connectionId,
            database,
            schema,
            catalog,
            tableName: table,
            // Keep the Mongo collection kind available to index actions so
            // views do not offer unsupported index creation or deletion.
            meta: node.type === "mongo-collection" ? node.meta : undefined,
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
        if (isXugu) {
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
          if (supportsXuguChildMetadata) {
            children.push(
              {
                id: `${parentId}:__table-partitions`,
                label: "tree.partitions",
                type: "group-table-partitions",
                connectionId,
                database,
                schema,
                catalog,
                tableName: table,
                isExpanded: false,
                children: [],
              },
              {
                id: `${parentId}:__table-subpartitions`,
                label: "tree.subpartitions",
                type: "group-table-subpartitions",
                connectionId,
                database,
                schema,
                catalog,
                tableName: table,
                isExpanded: false,
                children: [],
              },
            );
          }
        }
      }

      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(targetNode, children);
      targetNode.isExpanded = true;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadColumns(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
    const parentId = nodeId ?? (schema ? `${connectionId}:${database}:${schema}:${table}:__columns` : `${connectionId}:${database}:${table}:__columns`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    const load = beginTreeNodeLoad(node);
    try {
      if (effectiveDatabaseTypeForConnection(getConfig(connectionId)) === "mongodb") {
        const fields = await listMongoCompletionFields(connectionId, database, table);
        const targetNode = treeNodeLoadTarget(load);
        if (!targetNode) return;
        setChildren(
          targetNode,
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
        targetNode.isExpanded = true;
        return;
      }
      const querySchema = metadataQuerySchema(connectionId, database, schema);
      const columns = await api.getColumns(connectionId, database, querySchema, table, catalog);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      const connConfig = getConfig(connectionId);
      const isGaussdbM = effectiveDatabaseTypeForConnection(connConfig) === "gaussdb" && connConfig?.driver_profile?.toLowerCase() === "gaussdb-m";
      setChildren(
        targetNode,
        columns.map((col) => ({
          id: `${parentId}:${col.name}`,
          label: `${col.name} (${isGaussdbM ? gaussdbMTypeDisplayName(col.data_type) : col.data_type})`,
          type: "column" as const,
          connectionId,
          database,
          schema,
          tableName: table,
          meta: col,
        })),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadIndexes(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
    const parentId = nodeId ?? (schema ? `${connectionId}:${database}:${schema}:${table}:__indexes` : `${connectionId}:${database}:${table}:__indexes`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    const load = beginTreeNodeLoad(node);
    try {
      const effectiveDbType = effectiveDatabaseTypeForConnection(getConfig(connectionId));
      const metadataCapabilities = getTableMetadataCapabilities(effectiveDbType);
      const isMongoView = effectiveDbType === "mongodb" && node.type === "group-indexes" && mongoCollectionKindFromNode(node) === "view";
      if (!metadataCapabilities.indexes || isMongoView) {
        const targetNode = treeNodeLoadTarget(load);
        if (!targetNode) return;
        setChildren(targetNode, []);
        targetNode.isExpanded = true;
        return;
      }
      const querySchema = metadataQuerySchema(connectionId, database, schema);
      const indexes = await api.listIndexes(connectionId, database, querySchema, table, catalog);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      const mongoCollectionKind = effectiveDbType === "mongodb" && targetNode.type === "group-indexes" ? mongoCollectionKindFromNode(targetNode) : undefined;
      setChildren(
        targetNode,
        indexes.map((idx) => ({
          id: `${parentId}:${idx.name}`,
          label: `${idx.name} (${idx.columns.join(", ")})`,
          type: "index" as const,
          connectionId,
          database,
          schema,
          tableName: table,
          meta: mongoCollectionKind ? { ...idx, collectionKind: mongoCollectionKind } : idx,
        })),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadForeignKeys(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
    const parentId = nodeId ?? (schema ? `${connectionId}:${database}:${schema}:${table}:__fkeys` : `${connectionId}:${database}:${table}:__fkeys`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    const load = beginTreeNodeLoad(node);
    try {
      const metadataCapabilities = getTableMetadataCapabilities(effectiveDatabaseTypeForConnection(getConfig(connectionId)));
      if (!metadataCapabilities.foreignKeys) {
        const targetNode = treeNodeLoadTarget(load);
        if (!targetNode) return;
        setChildren(targetNode, []);
        targetNode.isExpanded = true;
        return;
      }
      const querySchema = metadataQuerySchema(connectionId, database, schema);
      const fkeys = await api.listForeignKeys(connectionId, database, querySchema, table, catalog);
      const cacheKey = `${connectionId}:${database}:${schema || ""}:${table}`;
      completionForeignKeysCache.value[cacheKey] = fkeys;
      evictOldestCacheEntries(completionForeignKeysCache.value, COMPLETION_CACHE_MAX);
      indexCompletionForeignKeys(connectionId, database, table, schema, sqlCompletionForeignKeys(fkeys));
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
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
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadTriggers(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
    const parentId = nodeId ?? (schema ? `${connectionId}:${database}:${schema}:${table}:__triggers` : `${connectionId}:${database}:${table}:__triggers`);
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;

    const load = beginTreeNodeLoad(node);
    try {
      const metadataCapabilities = getTableMetadataCapabilities(effectiveDatabaseTypeForConnection(getConfig(connectionId)));
      if (!metadataCapabilities.triggers) {
        const targetNode = treeNodeLoadTarget(load);
        if (!targetNode) return;
        setChildren(targetNode, []);
        targetNode.isExpanded = true;
        return;
      }
      const querySchema = metadataQuerySchema(connectionId, database, schema);
      const triggers = await api.listTriggers(connectionId, database, querySchema, table, catalog);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      const isXugu = effectiveDatabaseTypeForConnection(getConfig(connectionId)) === "xugu";
      setChildren(
        targetNode,
        triggers.map((tr) => {
          const xuguDetails = isXugu ? [tr.timing, tr.event, tr.level, tr.enabled === false ? i18n.global.t("objects.disabled") : null, tr.valid === false ? i18n.global.t("objects.invalid") : null].filter(Boolean).join(" · ") : `${tr.timing} ${tr.event}`;
          return {
            id: `${parentId}:${tr.name}`,
            label: `${tr.name} (${xuguDetails})`,
            objectName: tr.name,
            type: "trigger" as const,
            connectionId,
            database,
            schema,
            tableName: table,
            comment: isXugu ? tr.comment : undefined,
            valid: isXugu ? tr.valid : undefined,
            meta: tr,
          };
        }),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadConstraints(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
    const parentId = nodeId ?? `${connectionId}:${database}:${schema || ""}:${table}:__constraints`;
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;
    const load = beginTreeNodeLoad(node);
    try {
      const constraints = await api.listConstraints(connectionId, database, metadataQuerySchema(connectionId, database, schema), table, catalog);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
        constraints.map((constraint) => ({
          id: `${parentId}:${constraint.name}`,
          label: `${constraint.name} (${constraint.constraint_type})${constraint.valid ? "" : " · INVALID"}`,
          type: "constraint" as const,
          connectionId,
          database,
          schema,
          tableName: table,
          meta: constraint,
        })),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadPartitions(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
    const parentId = nodeId ?? `${connectionId}:${database}:${schema || ""}:${table}:__table-partitions`;
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;
    const load = beginTreeNodeLoad(node);
    try {
      const partitions = await api.listPartitions(connectionId, database, metadataQuerySchema(connectionId, database, schema), table, catalog);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
        partitions.map((partition) => ({
          id: `${parentId}:${partition.name}`,
          label: `${partition.name} (${partition.partition_type}${partition.value ? `: ${partition.value}` : ""})`,
          type: "partition" as const,
          connectionId,
          database,
          schema,
          tableName: table,
          meta: partition,
        })),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadSubpartitions(connectionId: string, database: string, table: string, schema?: string, nodeId?: string, catalog?: string) {
    const parentId = nodeId ?? `${connectionId}:${database}:${schema || ""}:${table}:__table-subpartitions`;
    const node = findNode(treeNodes.value, parentId);
    if (!node) return;
    const load = beginTreeNodeLoad(node);
    try {
      const partitions = await api.listSubpartitions(connectionId, database, metadataQuerySchema(connectionId, database, schema), table, catalog);
      const targetNode = treeNodeLoadTarget(load);
      if (!targetNode) return;
      setChildren(
        targetNode,
        partitions.map((partition) => ({
          id: `${parentId}:${partition.name}`,
          label: `${partition.name} (${partition.partition_type}${partition.value ? `: ${partition.value}` : ""})`,
          type: "subpartition" as const,
          connectionId,
          database,
          schema,
          tableName: table,
          meta: partition,
        })),
      );
      targetNode.isExpanded = true;
    } catch (e) {
      recordMetadataLoadError(connectionId, e, load);
      throw e;
    } finally {
      finishTreeNodeLoad(load);
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
      } else if (config?.db_type === "consul") {
        await loadConsulRoot(node.connectionId);
      } else if (config?.db_type === "mongodb") {
        await loadMongoDatabases(node.connectionId);
      } else if (config?.db_type === "dynamodb") {
        await loadDynamoDbTables(node.connectionId);
      } else if (config?.db_type === "elasticsearch" || config?.db_type === "easysearch" || config?.db_type === "meilisearch") {
        await loadElasticsearchIndices(node.connectionId);
      } else if (config?.db_type === "milvus") {
        await loadMilvusDatabases(node.connectionId);
      } else if (config?.db_type === "qdrant" || config?.db_type === "weaviate" || config?.db_type === "chromadb") {
        await loadVectorCollections(node.connectionId);
      } else if (config?.db_type === "mq") {
        await loadMqTenants(node.connectionId, options);
      } else if (config?.db_type === "mqtt") {
        await loadMqttTopics(node.connectionId);
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
    } else if (node.type === "group-tablespaces" && node.connectionId) {
      await loadXuguTablespaces(node, options);
    } else if (node.type === "database" && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      if (node.catalog && node.catalog !== "internal") {
        await loadDorisCatalogTables(node, options);
      } else {
        const config = getConfig(node.connectionId);
        const effectiveDbType = effectiveDatabaseTypeForConnection(config);
        if (config?.db_type === "sqlserver") {
          await loadSqlServerDatabaseObjects(node.connectionId, node.database, options);
        } else if ((usesTreeSchemaMode(effectiveDbType) && !connectionUsesDatabaseObjectTreeMode(config)) || connectionShouldDiscoverJdbcSchemas(config)) {
          await loadSchemas(node.connectionId, node.database, options);
        } else {
          await loadTables(node.connectionId, node.database, undefined, options);
        }
      }
    } else if (node.type === "schema" && node.connectionId && hasTreeNodeDatabaseContext(node) && schemaNodeHasLoadableName(effectiveDatabaseTypeForConnection(getConfig(node.connectionId)), node.schema)) {
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
    } else if (node.type === "type" && isXuguTypeMemberContainer(node, getConfig(node.connectionId || "")?.db_type)) {
      // Xugu object types expose attributes and methods through the scoped
      // completion endpoint. Do not route them through the generic custom-type
      // loader, which treats the type name as a table and issues getColumns.
      await loadXuguTypeMembers(node, options);
    } else if (node.type === "type") {
      await loadCustomTypeChildren(node, options);
    } else if (node.type === "group-columns" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadColumns(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (node.type === "group-indexes" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadIndexes(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (node.type === "group-fkeys" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadForeignKeys(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (node.type === "group-triggers" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadTriggers(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (node.type === "group-constraints" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadConstraints(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (node.type === "group-table-partitions" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadPartitions(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (node.type === "group-table-subpartitions" && node.connectionId && hasTreeNodeDatabaseContext(node) && node.tableName) {
      await loadSubpartitions(node.connectionId, node.database, node.tableName, node.schema, node.id, node.catalog);
    } else if (objectTypesForGroupNode(node.type)) {
      await loadObjectGroupChildren(node, options);
    } else if (node.type === "group-partitions") {
      node.isExpanded = true;
    } else if (node.type === "group-extensions" && node.connectionId && hasTreeNodeDatabaseContext(node)) {
      await loadExtensions(node.connectionId, node.database || "");
    }
  }

  async function restoreExpandedChildren(node: TreeNode, expandedIds: Set<string>, options?: LoadTreeOptions, isCurrent: () => boolean = () => true) {
    if (!isCurrent()) return;
    if (!node.children) return;
    for (const child of node.children) {
      if (!isCurrent()) return;
      if (!expandedIds.has(child.id)) continue;
      await loadTreeNodeChildren(child, options);
      if (!isCurrent()) return;
      await restoreExpandedChildren(child, expandedIds, options, isCurrent);
    }
  }

  async function refreshTreeNode(node: TreeNode) {
    invalidateCompletionCachesForNode(node);
    invalidateMetadataCachesForNode(node);
    if (objectTypesForGroupNode(node.type)) {
      clearLoadedChildrenCache(node.id, { deletePersisted: false });
      await loadObjectGroupChildren(node, { force: true });
      await invalidateSidebarTableSearchIndexesForTreeRefresh(node);
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
    const previousChildren = node.children;
    const previousHiddenChildren = node.hiddenChildren;
    const previousObjectCount = node.objectCount;
    const previousExpanded = node.isExpanded;
    const previousLoadedIds = [...loadedTreeNodeChildrenIds.value].filter((id) => id === node.id || id.startsWith(`${node.id}:`));
    const previousConfirmedEmptyIds = [...confirmedEmptyTreeNodeIds.value].filter((id) => id === node.id || id.startsWith(`${node.id}:`));
    const connectionRevision = node.connectionId ? connectionStateRevision(node.connectionId) : undefined;
    const refreshGeneration = ++nextTreeRefreshGeneration;
    activeTreeRefreshGenerations.set(node.id, refreshGeneration);
    const ownsRefreshGeneration = () => activeTreeRefreshGenerations.get(node.id) === refreshGeneration;
    const isCurrentRefresh = () => ownsRefreshGeneration() && (!node.connectionId || connectionStateRevision(node.connectionId) === connectionRevision);
    try {
      await clearPersistedTreeCacheForNode(node);
      if (!isCurrentRefresh()) return;
      clearLoadedChildrenCache(node.id);
      if (node.type !== "connection-group") {
        node.children = [];
      }
      await loadTreeNodeChildren(node, { force: true });
      if (isCurrentRefresh()) {
        await restoreExpandedChildren(node, expandedIds, { force: true }, isCurrentRefresh);
        if (isCurrentRefresh()) await invalidateSidebarTableSearchIndexesForTreeRefresh(node);
      }
    } catch (error) {
      // A stale failure must never overwrite a newer successful (including empty) result.
      if (isCurrentRefresh()) {
        const target = treeNodeInSidebarTree(node);
        if (target) {
          target.children = previousChildren;
          target.hiddenChildren = previousHiddenChildren;
          target.objectCount = previousObjectCount;
          target.isExpanded = previousExpanded;
          clearLoadedChildrenCache(target.id, { deletePersisted: false });
          for (const id of previousLoadedIds) loadedTreeNodeChildrenIds.value.add(id);
          for (const id of previousConfirmedEmptyIds) confirmedEmptyTreeNodeIds.value.add(id);
        }
      }
      throw error;
    } finally {
      if (ownsRefreshGeneration()) {
        activeTreeRefreshGenerations.delete(node.id);
      }
    }
  }

  async function refreshTreeNodeForTableNameFilter(node: TreeNode, scopeKey: string, revision: number) {
    invalidateMetadataCachesForNode(node);
    if (objectTypesForGroupNode(node.type)) {
      clearLoadedChildrenCache(node.id);
      await loadObjectGroupChildren(node, {
        force: true,
        tableNameFilterScopeKey: scopeKey,
        expectedTableNameFilterRevision: revision,
      });
      return;
    }
    await refreshTreeNode(node);
  }

  async function refreshDatabaseTreeNode(connectionId: string, database: string, catalog?: string) {
    const node = findDatabaseTreeNode(treeNodes.value, connectionId, database, catalog);
    if (node) {
      await refreshTreeNode(node);
      return;
    }
    if (catalog) {
      const catalogNode = findNode(treeNodes.value, dorisCatalogId(connectionId, catalog));
      if (catalogNode) {
        await refreshTreeNode(catalogNode);
        return;
      }
    }
    await loadDatabases(connectionId, { force: true });
  }

  async function refreshObjectListTreeNode(connectionId: string, database: string, schema?: string, catalog?: string) {
    const match = { connectionId, database, schema };
    invalidateMetadataCaches(match);
    void invalidateObjectDdlCache(match);
    const shouldRefreshSchemaNode = !!schema && !catalog;
    const node = shouldRefreshSchemaNode ? findNode(treeNodes.value, `${connectionId}:${database}:${schema}`) : null;
    if (node) {
      await refreshTreeNode(node);
    } else {
      await refreshDatabaseTreeNode(connectionId, database, catalog);
    }
    void loadSidebarTableStorage({ connectionId, database, schema: schema || "" }, { force: true });
  }

  function isSchemaAwareDatabase(connectionId: string): boolean {
    return isSchemaAware(getConfig(connectionId)?.db_type);
  }

  function isPostgresLikeForExtensions(dbType?: string): boolean {
    return dbType === "postgres" || dbType === "gaussdb" || dbType === "kwdb" || dbType === "opengauss" || dbType === "highgo" || dbType === "uxdb" || dbType === "vastbase" || dbType === "kingbase";
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

  function completionTableScopeKey(connectionId: string, database: string, schema?: string, catalog?: string): string {
    return `${connectionId}:${database}:${catalog?.toLowerCase() ?? ""}:${schema?.toLowerCase() ?? ""}`;
  }

  function completionColumnsKey(connectionId: string, database: string, table: string, schema?: string, catalog?: string, context?: { tableQuoted?: boolean; schemaQuoted?: boolean }): string {
    const databaseType = getConfig(connectionId)?.db_type;
    if (databaseType === "oracle" || databaseType === "oceanbase-oracle") {
      const normalizedTable = context?.tableQuoted === false ? table.toUpperCase() : table;
      const normalizedSchema = schema && context?.schemaQuoted === false ? schema.toUpperCase() : (schema ?? "");
      return `${connectionId}:${database}:${catalog ?? ""}:${normalizedSchema}:${normalizedTable}`;
    }
    const baseKey = `${completionTableScopeKey(connectionId, database, schema, catalog)}:${table.toLowerCase()}`;
    if (databaseType !== "postgres" || (!context?.tableQuoted && !context?.schemaQuoted)) return baseKey;
    const quotedSchema = context.schemaQuoted ? encodeURIComponent(schema ?? "") : "";
    const quotedTable = context.tableQuoted ? encodeURIComponent(table) : "";
    return `${baseKey}:quoted:s=${quotedSchema}:t=${quotedTable}`;
  }

  function completionColumnPrefixKey(connectionId: string, database: string, table: string, schema: string | undefined, prefix: string, catalog?: string, context?: { tableQuoted?: boolean; schemaQuoted?: boolean }): string {
    return `${completionColumnsKey(connectionId, database, table, schema, catalog, context)}:prefix:${prefix.trim().toLowerCase()}`;
  }

  function completionForeignKeysKey(connectionId: string, database: string, table: string, schema?: string): string {
    return `${completionScopeKey(connectionId, database, schema)}:${table.toLowerCase()}:fkeys`;
  }

  function completionTableCacheKeyMatches(key: string, connectionId: string, database: string, tableName: string, schema?: string, catalog?: string): boolean {
    const normalizedKey = key.toLowerCase();
    const prefix = `${connectionId}:${database}:`.toLowerCase();
    if (!normalizedKey.startsWith(prefix)) return false;
    const tableToken = `:${tableName.toLowerCase()}`;
    const tableOffset = normalizedKey.lastIndexOf(tableToken);
    if (tableOffset < prefix.length) return false;
    const trailing = normalizedKey.slice(tableOffset + tableToken.length);
    if (trailing && !trailing.startsWith(":")) return false;
    const normalizedSchema = schema?.trim().toLowerCase();
    const normalizedCatalog = catalog?.trim().toLowerCase();
    const scope = normalizedKey.slice(prefix.length, tableOffset);
    if (normalizedCatalog) {
      const catalogScope = `${normalizedCatalog}:${normalizedSchema ?? ""}`;
      return scope === catalogScope || (!!normalizedSchema && scope === normalizedSchema);
    }
    if (!normalizedSchema) return true;
    return scope === normalizedSchema || scope.endsWith(`:${normalizedSchema}`);
  }

  function invalidateCompletionTableCache(connectionId: string, database: string, tableName: string, schema?: string, catalog?: string): number {
    bumpCompletionCacheRevision(connectionId, database);
    const matches = (key: string) => completionTableCacheKeyMatches(key, connectionId, database, tableName, schema, catalog);
    let removed = 0;
    for (const cache of [completionColumnsCache.value, completionForeignKeysCache.value]) {
      for (const key of Object.keys(cache)) {
        if (!matches(key)) continue;
        delete cache[key];
        removed++;
      }
    }
    for (const cache of [completionColumnIndex, completionForeignKeyIndex, completionInFlight]) {
      for (const key of cache.keys()) {
        if (!matches(key)) continue;
        cache.delete(key);
        removed++;
      }
    }
    for (const key of completionColumnPrefixIndex.keys()) {
      const prefixMarker = key.toLowerCase().lastIndexOf(":prefix:");
      const baseKey = prefixMarker >= 0 ? key.slice(0, prefixMarker) : key;
      if (!matches(baseKey)) continue;
      completionColumnPrefixIndex.delete(key);
      removed++;
    }
    return removed;
  }

  function invalidateCompletionCachesForNode(node: TreeNode) {
    if (!node.connectionId) return;
    if (typeof node.database !== "string") {
      invalidateCompletionCache(node.connectionId);
      return;
    }
    if (node.tableName) {
      invalidateCompletionTableCache(node.connectionId, node.database, node.tableName, node.schema, node.catalog);
      return;
    }
    invalidateCompletionCache(node.connectionId, node.database);
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
      parent_type: request.parent_type ?? "",
      match_mode: request.match_mode ?? "prefix",
    });
  }

  async function completionAssistantSearch(request: CompletionAssistantRequest, requestRevision = completionCacheRevision(request.connection_id, request.database)) {
    return withCompletionInFlight(`${request.connection_id}:${request.database}:assistant:${requestRevision}:${completionAssistantRequestKey(request)}`, async () => {
      await ensureConnected(request.connection_id);
      return api.completionAssistantSearch(request);
    });
  }

  async function loadPackageMembers(node: TreeNode, options?: LoadTreeOptions): Promise<void> {
    if (node.type !== "package" || !node.connectionId || !node.database) return;
    const databaseType = effectiveDatabaseTypeForConnection(getConfig(node.connectionId));
    if (!supportsPackageMemberExpansion(databaseType)) return;
    const connectionId = node.connectionId;
    const database = node.database;
    const schema = node.schema;
    const packageName = node.objectName || node.label;
    let load = beginTreeNodeLoad(node);

    try {
      await runTreeMetadataLoad(
        {
          kind: "package-members",
          connectionId,
          database,
          schema,
          nodeKind: node.type,
          extra: { packageName },
        },
        async () => {
          await ensureConnected(connectionId);
          load = reclaimTreeNodeLoad(load, node);
          const response = await completionAssistantSearch({
            connection_id: connectionId,
            database,
            schema: schema ?? null,
            object_kinds: ["routine"],
            mask: "",
            case_sensitive: true,
            global_search: false,
            max_results: 1000,
            search_in_comments: false,
            search_in_definitions: false,
            parent_schema: schema ?? null,
            parent_name: packageName,
            ...(databaseType === "xugu" ? { parent_type: "package" as const } : {}),
            match_mode: "prefix",
          });
          const targetNode = treeNodeLoadTarget(load);
          if (!targetNode) return;
          setChildren(targetNode, buildPackageMemberNodes(targetNode, response.candidates, databaseType));
          targetNode.isExpanded = true;
        },
        options,
      );
    } catch (error) {
      recordMetadataLoadError(connectionId, error, load);
      throw error;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  async function loadXuguTypeMembers(node: TreeNode, options?: Pick<LoadTreeOptions, "force" | "preserveCollapsedChildren">): Promise<void> {
    if (!isXuguTypeMemberContainer(node, getConfig(node.connectionId || "")?.db_type)) return;
    const connectionId = node.connectionId;
    const database = node.database;
    if (!connectionId || !database) return;
    if (node.isExpanded && !options?.force) {
      node.isExpanded = false;
      if (!sidebarSearchQuery.value && !options?.preserveCollapsedChildren) releaseCollapsedTreeNodeChildren(node.id);
      return;
    }
    if (!options?.force && node.children && node.children.length > 0) {
      node.isExpanded = true;
      return;
    }

    const schema = node.schema || "";
    const parentName = node.objectName || node.label;
    let load = beginTreeNodeLoad(node);
    try {
      await runTreeMetadataLoad(
        {
          kind: "xugu-type-members",
          connectionId,
          database,
          schema,
          nodeKind: node.type,
          extra: { typeName: parentName },
        },
        async () => {
          await ensureConnected(connectionId);
          load = reclaimTreeNodeLoad(load, node);
          const [attributes, methods] = await Promise.all([
            completionAssistantSearch({
              connection_id: connectionId,
              database,
              schema,
              object_kinds: ["column"],
              mask: "",
              max_results: 500,
              global_search: false,
              parent_schema: schema,
              parent_name: parentName,
              parent_type: "type",
              match_mode: "prefix",
            }),
            completionAssistantSearch({
              connection_id: connectionId,
              database,
              schema,
              object_kinds: ["routine"],
              mask: "",
              max_results: 500,
              global_search: false,
              parent_schema: schema,
              parent_name: parentName,
              parent_type: "type",
              match_mode: "prefix",
            }),
          ]);
          const targetNode = treeNodeLoadTarget(load);
          if (!targetNode) return;
          const children = buildXuguTypeMemberNodes(targetNode, [...attributes.candidates, ...methods.candidates], {
            attributes: "tree.attributes",
            methods: "tree.methods",
          });
          setChildren(targetNode, children);
          targetNode.isExpanded = children.length > 0;
          if (children.length === 0) targetNode.xuguTypeMembersExpandable = false;
        },
      );
    } catch (error) {
      recordMetadataLoadError(connectionId, error, load);
      throw error;
    } finally {
      finishTreeNodeLoad(load);
    }
  }

  const ORACLE_SYSTEM_COMPLETION_SCHEMAS = new Set(["SYS", "SYSTEM", "SYSMAN", "DBSNMP", "OUTLN", "XDB", "MDSYS", "CTXSYS", "WMSYS"]);
  const FILTERED_ROUTINE_COMPLETION_DATABASES = new Set<DatabaseType>(["mysql", "postgres", "sqlserver", "oracle"]);

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
        const detail = completionTableDetail(candidate.comment);
        const table: SqlCompletionTable = {
          name: candidate.name,
          schema: candidate.schema ?? undefined,
          type: sqlObjectNavigationTypeFromTableType(candidate.data_type || candidate.kind),
          ...(detail ? { detail } : {}),
          ...completionStableTableType(candidate.data_type),
        };
        if (!withOracleMetadata) return table;
        const metadataDetail = candidate.schema ? `${candidate.schema} · ${(candidate.data_type || candidate.kind).toLowerCase()}` : candidate.kind;
        return {
          ...table,
          detail: table.detail ? `${metadataDetail}  ${table.detail}` : metadataDetail,
          applyName: completionCandidateApplyName(candidate.name, candidate.schema, preferredSchema),
          boost: completionCandidateSchemaBoost(candidate.schema, preferredSchema),
        };
      });
  }

  function completionAssistantObjects(candidates: CompletionAssistantCandidate[], preferredSchema?: string, oracleMetadata = false): SqlCompletionObject[] {
    return candidates
      .map((candidate): SqlCompletionObject | null => {
        const candidateType = candidate.data_type?.toUpperCase();
        const type = candidate.kind === "procedure" ? "procedure" : candidate.kind === "function" ? "function" : candidate.kind === "sequence" ? "sequence" : candidate.kind === "object" && candidateType === "PACKAGE" ? "package" : null;
        if (!type) return null;
        const dataType = candidate.data_type && !["FUNCTION", "PROCEDURE", "PACKAGE"].includes(candidateType ?? "") ? candidate.data_type : undefined;
        return {
          name: candidate.name,
          schema: candidate.schema ?? undefined,
          type,
          parentSchema: candidate.parent_schema ?? undefined,
          parentName: candidate.parent_name ?? undefined,
          dataType,
          signature: candidate.signature ?? undefined,
          comment: candidate.comment ?? null,
          applyName: completionCandidateApplyName(candidate.name, candidate.schema, preferredSchema),
          boost: oracleMetadata ? completionCandidateSchemaBoost(candidate.schema, preferredSchema) : completionRoutineSchemaBoost(candidate.schema, preferredSchema),
        };
      })
      .filter((object): object is SqlCompletionObject => object != null);
  }

  function completionRoutineSchemaBoost(schema: string | null | undefined, preferredSchema?: string): number {
    if (schema && preferredSchema && schema.toLowerCase() === preferredSchema.toLowerCase()) return 1000;
    if (schema?.toUpperCase() === "PUBLIC") return 600;
    return 0;
  }

  function completionAssistantIdentifierMatches(candidate: string, requested: string, quoted?: boolean): boolean {
    return quoted ? candidate === requested : candidate.toLowerCase() === requested.toLowerCase();
  }

  function completionAssistantColumns(candidates: CompletionAssistantCandidate[], table: string, schema?: string, context?: { tableQuoted?: boolean; schemaQuoted?: boolean }): SqlCompletionColumn[] {
    const requestedSchema = schema?.trim();
    return candidates
      .filter((candidate) => {
        if (candidate.kind !== "column") return false;
        const parentName = candidate.parent_name?.trim();
        if (parentName && !completionAssistantIdentifierMatches(parentName, table, context?.tableQuoted)) return false;
        const parentSchema = candidate.parent_schema?.trim() || candidate.schema?.trim();
        if (requestedSchema && parentSchema && !completionAssistantIdentifierMatches(parentSchema, requestedSchema, context?.schemaQuoted)) return false;
        return true;
      })
      .map((candidate) => ({
        name: candidate.name,
        table: candidate.parent_name ?? table,
        schema: candidate.parent_schema ?? candidate.schema ?? schema,
        dataType: candidate.data_type ?? undefined,
        comment: candidate.comment ?? null,
      }));
  }

  async function listCompletionAssistantTables(connectionId: string, database: string, filter: string, limit?: number, schema?: string, globalSearch = false, currentSchema?: string, requestRevision = completionCacheRevision(connectionId, database)): Promise<SqlCompletionTable[]> {
    const oracleAssistant = getConfig(connectionId)?.db_type === "oracle";
    const preferredSchema = oracleAssistant ? completionPreferredSchema(connectionId, globalSearch ? currentSchema : (schema ?? currentSchema)) : schema?.trim() || undefined;
    const objectKinds: CompletionAssistantObjectKind[] = ["table", "view"];
    const response = await completionAssistantSearch(
      {
        connection_id: connectionId,
        database,
        schema: preferredSchema ?? null,
        object_kinds: objectKinds,
        mask: filter.trim(),
        max_results: limit ?? 200,
        global_search: globalSearch,
        parent_schema: globalSearch ? null : (schema ?? null),
        match_mode: "prefix",
      },
      requestRevision,
    );
    const tables = completionAssistantTables(response.candidates, preferredSchema, oracleAssistant);
    if (requestRevision === completionCacheRevision(connectionId, database)) indexCompletionTables(connectionId, database, schema, tables);
    return tables;
  }

  async function listCompletionAssistantObjects(
    connectionId: string,
    database: string,
    filter: string,
    limit: number | undefined,
    schema: string | undefined,
    parentName: string | undefined,
    globalSearch: boolean,
    currentSchema: string | undefined,
    objectKinds: CompletionAssistantObjectKind[],
    caseSensitive: boolean,
  ): Promise<SqlCompletionObject[]> {
    const databaseType = getConfig(connectionId)?.db_type;
    const oracleAssistant = databaseType === "oracle";
    const requestedSchema = schema?.trim() || currentSchema?.trim() || undefined;
    const sequenceOnly = objectKinds.length === 1 && objectKinds[0] === "sequence";
    const preferredSchema = oracleAssistant ? completionPreferredSchema(connectionId, currentSchema) : requestedSchema || (!sequenceOnly && databaseType === "postgres" ? "public" : databaseType === "mysql" ? database : undefined);
    const response = await completionAssistantSearch({
      connection_id: connectionId,
      database,
      schema: oracleAssistant ? (preferredSchema ?? null) : (requestedSchema ?? null),
      object_kinds: objectKinds,
      mask: filter.trim(),
      case_sensitive: caseSensitive,
      max_results: limit ?? 200,
      global_search: globalSearch,
      parent_schema: globalSearch || sequenceOnly ? null : (schema ?? null),
      parent_name: parentName ?? null,
      match_mode: "prefix",
    });
    const objects = completionAssistantObjects(response.candidates, preferredSchema, oracleAssistant).map((object) => ({
      ...object,
      applyName: databaseType === "sqlserver" && object.schema ? `${object.schema}.${object.name}` : object.applyName,
    }));
    indexCompletionObjects(connectionId, database, schema, objects);
    return objects;
  }

  async function listCompletionAssistantColumns(connectionId: string, database: string, table: string, schema?: string, context?: { tableQuoted?: boolean; schemaQuoted?: boolean }, requestRevision = completionCacheRevision(connectionId, database)): Promise<SqlCompletionColumn[]> {
    const response = await completionAssistantSearch(
      {
        connection_id: connectionId,
        database,
        schema: schema ?? null,
        object_kinds: ["column"],
        mask: "",
        max_results: 500,
        parent_schema: schema ?? null,
        parent_name: table,
        match_mode: "prefix",
      },
      requestRevision,
    );
    const columns = completionAssistantColumns(response.candidates, table, schema, context);
    if (columns.length > 0 && requestRevision === completionCacheRevision(connectionId, database)) indexCompletionColumns(connectionId, database, table, schema, columns, undefined, context);
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
    const score = schema && preferredSchema && schema === preferredSchema.toLowerCase() ? 10_000 : 0;
    if (!normalized) return score;
    if (text === normalized) return score + 9_000 - text.length;
    if (text.startsWith(normalized)) return score + 7_500 - text.length;
    const segments = completionNameSegments(table.name);
    if (segments.some((segment) => segment.startsWith(normalized))) return score + 7_200 - text.length;
    const acronym = completionNameAcronym(table.name);
    if (acronym === normalized) return score + 7_100 - text.length;
    if (acronym.startsWith(normalized)) return score + 6_900 - text.length;
    // DataGrip-style pinyin initials for Han names, e.g. "zzj" → 总租金,
    // including ordered subsequences like "zj" → 总租金.
    if (/^[a-z0-9]+$/.test(normalized) && containsHan(text)) {
      const pinyinInitials = pinyinFirstLetters(text);
      if (pinyinInitials === normalized) return score + 7_050 - text.length;
      if (pinyinInitials.startsWith(normalized)) return score + 6_850 - text.length;
      const subsequence = orderedSubsequenceSpan(pinyinInitials, normalized);
      if (subsequence) return score + 5_000 - subsequence.first * 30 - subsequence.span * 10 - text.length;
    }
    if (normalized.length <= segments.length && segments.every((segment, index) => segment.startsWith(normalized[index] ?? ""))) return score + 6_700 - text.length;
    if (text.includes(normalized)) return score + 4_000 - text.length;
    const subsequenceScore = orderedSubsequenceScore(text, normalized);
    return subsequenceScore < 0 ? -1 : score + subsequenceScore;
  }

  function objectMatchScore(object: SqlCompletionObject, filter: string, preferredSchema?: string): number {
    const tableLike: SqlCompletionTable = { name: object.name, schema: object.schema };
    return tableMatchScore(tableLike, filter, preferredSchema);
  }

  function indexCompletionTables(connectionId: string, database: string, schema: string | undefined, tables: SqlCompletionTable[], catalog?: string) {
    const groups = new Map<string, SqlCompletionTable[]>();
    for (const table of tables) {
      const tableSchema = table.schema ?? schema;
      const tableCatalog = table.catalog ?? catalog;
      const key = completionTableScopeKey(connectionId, database, tableSchema, tableCatalog);
      const list = groups.get(key) ?? [];
      list.push({ ...table, catalog: tableCatalog, schema: tableSchema });
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

  function indexCompletionColumns(connectionId: string, database: string, table: string, schema: string | undefined, columns: SqlCompletionColumn[], catalog?: string, context?: { tableQuoted?: boolean; schemaQuoted?: boolean }) {
    touchCompletionIndex(completionColumnIndex, completionColumnsKey(connectionId, database, table, schema, catalog, context), {
      columns,
    });
  }

  function indexCompletionColumnPrefix(connectionId: string, database: string, table: string, schema: string | undefined, prefix: string, columns: SqlCompletionColumn[], complete: boolean, catalog?: string, context?: { tableQuoted?: boolean; schemaQuoted?: boolean }) {
    touchCompletionIndex(completionColumnPrefixIndex, completionColumnPrefixKey(connectionId, database, table, schema, prefix, catalog, context), { columns, complete });
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

  function lookupLocalCompletionTables(connectionId: string, database: string, filter = "", limit?: number, schema?: string, catalog?: string): SqlCompletionTable[] {
    const scopePrefix = `${connectionId}:${database}:${catalog?.toLowerCase() ?? ""}:`;
    const allScopes = [...completionTableIndex.entries()].filter(([key]) => key.startsWith(scopePrefix)).map(([, entry]) => entry);
    const preferred = schema ? completionTableIndex.get(completionTableScopeKey(connectionId, database, schema, catalog)) : undefined;
    const scopes = schema ? (preferred ? [preferred] : []) : allScopes;
    const treeTables = completionTablesFromTree(treeNodes.value, connectionId, database, schema, catalog);
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

  function lookupLocalCompletionColumns(connectionId: string, database: string, table: string, schema?: string, catalog?: string, context?: { tableQuoted?: boolean; schemaQuoted?: boolean }): SqlCompletionColumn[] {
    return completionColumnIndex.get(completionColumnsKey(connectionId, database, table, schema, catalog, context))?.columns ?? [];
  }

  function completionColumnPrefixEntry(connectionId: string, database: string, table: string, schema: string | undefined, prefix: string, catalog?: string, context?: { tableQuoted?: boolean; schemaQuoted?: boolean }): { columns: SqlCompletionColumn[]; complete: boolean } | undefined {
    const normalizedPrefix = prefix.trim().toLowerCase();
    const exact = completionColumnPrefixIndex.get(completionColumnPrefixKey(connectionId, database, table, schema, normalizedPrefix, catalog, context));
    if (exact) return exact;

    const marker = `${completionColumnsKey(connectionId, database, table, schema, catalog, context)}:prefix:`;
    let reusable: { prefix: string; columns: SqlCompletionColumn[] } | undefined;
    for (const [key, entry] of completionColumnPrefixIndex) {
      if (!entry.complete || !key.startsWith(marker)) continue;
      const cachedPrefix = key.slice(marker.length);
      if (!normalizedPrefix.startsWith(cachedPrefix) || (reusable && cachedPrefix.length <= reusable.prefix.length)) continue;
      reusable = { prefix: cachedPrefix, columns: entry.columns };
    }
    if (!reusable) return undefined;
    return {
      columns: reusable.columns.filter((column) => column.name.toLowerCase().startsWith(normalizedPrefix)),
      complete: true,
    };
  }

  function lookupLocalCompletionColumnsByPrefix(connectionId: string, database: string, table: string, schema: string | undefined, prefix: string, catalog?: string, context?: { tableQuoted?: boolean; schemaQuoted?: boolean }): SqlCompletionColumn[] {
    return completionColumnPrefixEntry(connectionId, database, table, schema, prefix, catalog, context)?.columns ?? [];
  }

  function lookupLocalCompletionForeignKeys(connectionId: string, database: string, table: string, schema?: string): SqlCompletionForeignKey[] {
    return completionForeignKeyIndex.get(completionForeignKeysKey(connectionId, database, table, schema))?.foreignKeys ?? [];
  }

  async function listCompletionColumnsByPrefix(connectionId: string, database: string, table: string, schema: string | undefined, prefix: string, catalog?: string, context?: { tableQuoted?: boolean; schemaQuoted?: boolean }): Promise<SqlCompletionColumn[]> {
    const normalizedPrefix = prefix.trim();
    if (normalizedPrefix.length < 2) return [];
    const databaseType = effectiveDatabaseTypeForConnection(getConfig(connectionId));
    if (databaseType !== "postgres" && databaseType !== "mysql") return [];
    const completionTable = table;
    const completionSchema = schema?.trim() || (databaseType === "mysql" ? database : undefined);
    const cacheKey = completionColumnPrefixKey(connectionId, database, completionTable, completionSchema, normalizedPrefix, catalog, context);
    const cached = completionColumnPrefixEntry(connectionId, database, completionTable, completionSchema, normalizedPrefix, catalog, context);
    if (cached) return cached.columns;
    const requestRevision = completionCacheRevision(connectionId, database);
    return withCompletionInFlight(
      `column-prefix:${requestRevision}:${cacheKey}`,
      async () => {
        const existing = completionColumnPrefixIndex.get(cacheKey);
        if (existing) return existing.columns;
        await ensureConnected(connectionId);
        const response = await completionAssistantSearch(
          {
            connection_id: connectionId,
            database,
            schema: completionSchema ?? null,
            object_kinds: ["column"],
            mask: normalizedPrefix,
            max_results: 128,
            parent_schema: completionSchema ?? null,
            parent_name: completionTable,
            match_mode: "prefix",
          },
          requestRevision,
        );
        const columns = completionAssistantColumns(response.candidates, completionTable, completionSchema, context);
        if (requestRevision === completionCacheRevision(connectionId, database)) {
          indexCompletionColumnPrefix(connectionId, database, completionTable, completionSchema, normalizedPrefix, columns, !response.incomplete, catalog, context);
        }
        return columns;
      },
      { scope: completionLimiterScope(connectionId, database), kind: "column-prefix" },
    );
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

  async function getSqlServerCompletionContext(connectionId: string, database: string): Promise<SqlServerCompletionContext> {
    const cacheKey = `${connectionId}:${database}`;
    if (sqlServerCompletionContextCache.value[cacheKey]) {
      return sqlServerCompletionContextCache.value[cacheKey];
    }
    return withCompletionInFlight(`${cacheKey}:sqlserver-completion-context`, async () => {
      await ensureConnected(connectionId);
      const context = await api.getSqlServerCompletionContext(connectionId, database);
      sqlServerCompletionContextCache.value[cacheKey] = context;
      evictOldestCacheEntries(sqlServerCompletionContextCache.value, COMPLETION_CACHE_MAX);
      return context;
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
  // `\\xNN` is binary only when it has an even number of preceding slashes.
  const BINARY_REDIS_KEY_ESCAPE = /(^|[^\\])(?:\\\\)*\\x[0-9a-f]{2}/i;

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
      const keys = result.keys
        .map((key) => key.key_display)
        .filter((key) => !BINARY_REDIS_KEY_ESCAPE.test(key))
        .slice(0, REDIS_COMPLETION_KEYS_MAX);
      redisCompletionKeysCache.value[cacheKey] = keys;
      evictOldestCacheEntries(redisCompletionKeysCache.value, COMPLETION_CACHE_MAX);
      return keys;
    });
  }

  async function listRedisCompletionCommandDocs(connectionId: string, database: string): Promise<RedisCommandDocumentation[]> {
    const cached = redisCommandDocsCache.value[connectionId];
    if (cached) return cached;
    return withCompletionInFlight(`${connectionId}:redis-command-docs`, async () => {
      const generation = redisCommandDocsCacheGeneration.get(connectionId) ?? 0;
      await ensureConnected(connectionId);
      const db = Number.parseInt(database, 10) || 0;
      let docs: RedisCommandDocumentation[];
      try {
        // Redis recommends COMMAND DOCS for complete, version-aware client metadata.
        const docsResult = await api.redisExecuteCommand(connectionId, db, "COMMAND DOCS");
        docs = parseRedisCommandDocumentation(docsResult.value);
        try {
          const catalogResult = await api.redisExecuteCommand(connectionId, db, "COMMAND");
          docs = mergeRedisCommandDocumentation(docs, parseRedisCommandCatalog(catalogResult.value));
        } catch {
          // Documentation still provides useful grammar when COMMAND is restricted.
        }
      } catch (docsError) {
        // Redis before 7.0 lacks COMMAND DOCS; COMMAND still reports its actual command inventory.
        try {
          const result = await api.redisExecuteCommand(connectionId, db, "COMMAND");
          docs = parseRedisCommandCatalog(result.value);
        } catch {
          throw docsError;
        }
      }
      if ((redisCommandDocsCacheGeneration.get(connectionId) ?? 0) === generation) {
        redisCommandDocsCache.value[connectionId] = docs;
        evictOldestCacheEntries(redisCommandDocsCache.value, COMPLETION_CACHE_MAX);
      }
      return docs;
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

  function listCompletionTableMetadata(connectionId: string, database: string, schema: string, filter?: string, limit?: number, catalog?: string): Promise<TableInfo[]> {
    if (catalog) return api.listTables(connectionId, database, schema, filter, limit, undefined, undefined, catalog);
    return api.listTables(connectionId, database, schema, filter, limit);
  }

  async function listCompletionTables(connectionId: string, database: string, filter = "", limit?: number, schema?: string, globalSearch = false, currentSchema?: string, catalog?: string, options: { activateConnection?: boolean } = {}): Promise<SqlCompletionTable[]> {
    const trimmedFilter = filter.trim();
    const normalizedFilter = trimmedFilter.toLowerCase();
    // Remote queries (Dameng/Oracle) are case-sensitive, so the cache key must
    // preserve original casing — otherwise "TEST" and "test" collide and the
    // second lookup returns the first's stale results. Local lookups below stay
    // case-insensitive because tableMatchScore normalizes internally.
    const relaxedFilter = relaxedCompletionTableFilter(trimmedFilter);
    const cacheKey = `${connectionId}:${database}:${catalog ?? ""}:${trimmedFilter}:${limit ?? ""}:${schema ?? ""}:${globalSearch ? "global" : "scoped"}:${currentSchema ?? ""}`;
    if (completionTablesCache.value[cacheKey]) {
      return completionTablesCache.value[cacheKey];
    }
    const requestRevision = completionCacheRevision(connectionId, database);

    return withCompletionInFlight(
      `${cacheKey}:tables`,
      async () => {
        await ensureConnected(connectionId, { activate: options.activateConnection !== false });

        if (isSchemaAwareDatabase(connectionId)) {
          if (normalizedFilter || limit) {
            let results: SqlCompletionTable[] = [];
            try {
              results = await listCompletionAssistantTables(connectionId, database, trimmedFilter, limit, schema, globalSearch, currentSchema, requestRevision);
            } catch {
              if (schema) {
                const tables = await listCompletionTableMetadata(connectionId, database, schema, trimmedFilter, limit, catalog);
                results = tableInfosToCompletionTables(tables, schema, catalog);
              } else {
                results = lookupLocalCompletionTables(connectionId, database, normalizedFilter, limit, undefined, catalog);
              }
            }
            if (results.length === 0 && relaxedFilter) {
              if (globalSearch) {
                try {
                  results = await listCompletionAssistantTables(connectionId, database, relaxedFilter, expandedCompletionLimit(limit), schema, true, currentSchema, requestRevision);
                } catch {
                  results = [];
                }
              } else if (schema) {
                try {
                  const tables = await listCompletionTableMetadata(connectionId, database, schema, relaxedFilter, expandedCompletionLimit(limit), catalog);
                  results = tableInfosToCompletionTables(tables, schema, catalog);
                } catch {
                  results = [];
                }
              } else {
                results = lookupLocalCompletionTables(connectionId, database, relaxedFilter, expandedCompletionLimit(limit), undefined, catalog);
              }
            }
            const limitedTables = limit ? dedupeCompletionTables(results).slice(0, limit) : results;
            if (requestRevision !== completionCacheRevision(connectionId, database)) return listCompletionTables(connectionId, database, filter, limit, schema, globalSearch, currentSchema, catalog, options);
            completionTablesCache.value[cacheKey] = limitedTables;
            indexCompletionTables(connectionId, database, undefined, limitedTables, catalog);
            evictOldestCacheEntries(completionTablesCache.value, COMPLETION_CACHE_MAX);
            return completionTablesCache.value[cacheKey];
          }

          let scopedTables: SqlCompletionTable[];
          if (schema) {
            const tables = await listCompletionTableMetadata(connectionId, database, schema, undefined, undefined, catalog);
            scopedTables = tableInfosToCompletionTables(tables, schema, catalog);
          } else {
            scopedTables = lookupLocalCompletionTables(connectionId, database, normalizedFilter, limit, undefined, catalog);
          }
          if (requestRevision !== completionCacheRevision(connectionId, database)) return listCompletionTables(connectionId, database, filter, limit, schema, globalSearch, currentSchema, catalog, options);
          completionTablesCache.value[cacheKey] = scopedTables;
          indexCompletionTables(connectionId, database, undefined, completionTablesCache.value[cacheKey], catalog);
          evictOldestCacheEntries(completionTablesCache.value, COMPLETION_CACHE_MAX);
          return completionTablesCache.value[cacheKey];
        }

        const querySchema = catalog ? "" : connectionDatabaseMetadataSchema(getConfig(connectionId), database);
        let tables = await listCompletionTableMetadata(connectionId, database, querySchema, trimmedFilter, limit, catalog);
        if (tables.length === 0 && relaxedFilter) {
          tables = await listCompletionTableMetadata(connectionId, database, querySchema, relaxedFilter, expandedCompletionLimit(limit), catalog);
        }
        if (requestRevision !== completionCacheRevision(connectionId, database)) return listCompletionTables(connectionId, database, filter, limit, schema, globalSearch, currentSchema, catalog, options);
        completionTablesCache.value[cacheKey] = tableInfosToCompletionTables(tables, undefined, catalog);
        completionTablesCache.value[cacheKey] = limit ? completionTablesCache.value[cacheKey].slice(0, limit) : completionTablesCache.value[cacheKey];
        indexCompletionTables(connectionId, database, schema, completionTablesCache.value[cacheKey], catalog);
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
      const key = `${table.catalog ?? ""}.${table.schema ?? ""}.${table.name}`.toLowerCase();
      const existingIndex = indexByKey.get(key);
      if (existingIndex != null) {
        const existing = deduped[existingIndex];
        // Loaded tree metadata can distinguish materialized views even when an older completion endpoint only reports VIEW.
        const detail = existing.detail ?? table.detail;
        deduped[existingIndex] = {
          ...table,
          ...existing,
          ...(detail ? { detail } : {}),
          type: mergeSqlObjectNavigationType(existing.type, table.type),
        };
        continue;
      }
      indexByKey.set(key, deduped.length);
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
    parentName?: string,
    globalSearch = false,
    currentSchema?: string,
    objectKinds: CompletionAssistantObjectKind[] = ["routine"],
    caseSensitive = false,
  ): Promise<SqlCompletionObject[]> {
    const normalizedFilter = filter.trim().toLowerCase();
    const cacheFilter = caseSensitive ? filter.trim() : normalizedFilter;
    const databaseType = getConfig(connectionId)?.db_type;
    const filteredRoutineAssistant = !!databaseType && FILTERED_ROUTINE_COMPLETION_DATABASES.has(databaseType) && (!!normalizedFilter || typeof limit === "number" || !!parentName || globalSearch);
    const cacheKey = filteredRoutineAssistant
      ? `${connectionId}:${database}:${schema ?? ""}:${parentName ?? ""}:${cacheFilter}:${limit ?? ""}:${globalSearch ? "global" : "scoped"}:${currentSchema ?? ""}:${[...objectKinds].sort().join(",")}:${caseSensitive ? "case-sensitive" : "case-insensitive"}`
      : `${connectionId}:${database}:${schema ?? ""}`;
    if (!completionObjectsCache.value[cacheKey]) {
      await withCompletionInFlight(
        `${cacheKey}:objects`,
        async () => {
          await ensureConnected(connectionId);
          if (filteredRoutineAssistant) {
            try {
              completionObjectsCache.value[cacheKey] = dedupeCompletionObjects(await listCompletionAssistantObjects(connectionId, database, filter, limit, schema, parentName, globalSearch, currentSchema, objectKinds, caseSensitive));
            } catch {
              if (objectKinds.length === 1 && objectKinds[0] === "sequence") {
                completionObjectsCache.value[cacheKey] = [];
              } else {
                const objects = isSchemaAwareDatabase(connectionId) ? await listSchemaAwareCompletionObjects(connectionId, database, schema) : await api.listCompletionObjects(connectionId, database, connectionDatabaseMetadataSchema(getConfig(connectionId), database, schema));
                completionObjectsCache.value[cacheKey] = dedupeCompletionObjects(objects.map(toSqlCompletionObject).filter((object): object is SqlCompletionObject => object != null));
              }
            }
          } else {
            const objects = isSchemaAwareDatabase(connectionId) ? await listSchemaAwareCompletionObjects(connectionId, database, schema) : await api.listCompletionObjects(connectionId, database, connectionDatabaseMetadataSchema(getConfig(connectionId), database, schema));
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
      signature: object.signature ?? undefined,
      comment: object.comment ?? null,
    };
  }

  function fuzzyCompletionObjectMatch(object: SqlCompletionObject, filter: string): boolean {
    return fuzzyTextMatch(object.name, filter) || (!!object.schema && fuzzyTextMatch(object.schema, filter)) || (!!object.parentName && fuzzyTextMatch(object.parentName, filter)) || (!!object.parentSchema && fuzzyTextMatch(`${object.parentSchema}.${object.parentName ?? ""}`, filter));
  }

  function fuzzyTextMatch(value: string, filter: string): boolean {
    if (!filter) return true;
    const text = value.toLowerCase();
    if (text.includes(filter)) return true;
    // Pinyin initials, e.g. "zzj" or "zj" matches 总租金.
    if (/^[a-z0-9]+$/.test(filter) && containsHan(text)) {
      const pinyinInitials = pinyinFirstLetters(text);
      if (pinyinInitials.startsWith(filter) || orderedSubsequenceSpan(pinyinInitials, filter)) return true;
    }
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
      const key = `${object.type}:${object.schema ?? ""}:${object.name}:${object.parentName ?? ""}:${object.signature?.trim() ?? ""}`.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(object);
    }
    return deduped;
  }

  async function listCompletionColumns(connectionId: string, database: string, table: string, schema?: string, context?: { clientSessionId?: string; version?: number; tableQuoted?: boolean; schemaQuoted?: boolean }, catalog?: string): Promise<SqlCompletionColumn[]> {
    const config = getConfig(connectionId);
    const oracleIdentifier = config?.db_type === "oracle" || config?.db_type === "oceanbase-oracle";
    const uppercaseUnquotedIdentifier = oracleIdentifier || config?.db_type === "saphana";
    const completionTable = uppercaseUnquotedIdentifier && context?.tableQuoted === false ? table.toUpperCase() : table;
    const rawCompletionSchema = schema?.trim() || (config?.db_type === "dameng" ? config.username?.trim() || undefined : undefined);
    const completionSchema = uppercaseUnquotedIdentifier && rawCompletionSchema && context?.schemaQuoted === false ? rawCompletionSchema.toUpperCase() : rawCompletionSchema;
    const usesCurrentSchema = usesOracleCurrentSchemaCompletion(config?.db_type, completionSchema);
    if (isSchemaAwareDatabase(connectionId) && !connectionUsesDatabaseObjectTreeMode(config) && !completionSchema && !usesCurrentSchema) {
      return [];
    }
    const sessionCacheScope = usesCurrentSchema && context?.clientSessionId ? `:${context.clientSessionId}:${context.version ?? 0}` : "";
    const cacheKey = `${completionColumnsKey(connectionId, database, completionTable, completionSchema, catalog, context)}${sessionCacheScope}`;
    if (!completionColumnsCache.value[cacheKey]) {
      const requestRevision = completionCacheRevision(connectionId, database);
      await withCompletionInFlight(
        `${cacheKey}:columns`,
        async () => {
          await ensureConnected(connectionId);
          // Use assistant metadata opportunistically, then fall back to canonical metadata.
          if (!usesCurrentSchema && !catalog) {
            try {
              const assistantColumns = await listCompletionAssistantColumns(connectionId, database, completionTable, completionSchema, context, requestRevision);
              if (assistantColumns.length > 0) {
                const columns = assistantColumns.map((column) => ({
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
                if (requestRevision !== completionCacheRevision(connectionId, database)) return;
                completionColumnsCache.value[cacheKey] = columns;
                evictOldestCacheEntries(completionColumnsCache.value, COMPLETION_CACHE_MAX);
                return;
              }
            } catch {
              // Fall back to the existing metadata path below.
            }
          }
          const querySchema = usesCurrentSchema ? "" : metadataQuerySchema(connectionId, database, completionSchema);
          const columns = await api.getColumns(connectionId, database, querySchema, completionTable, catalog, usesCurrentSchema ? context?.clientSessionId : undefined);
          if (requestRevision !== completionCacheRevision(connectionId, database)) return;
          completionColumnsCache.value[cacheKey] = columns;
          evictOldestCacheEntries(completionColumnsCache.value, COMPLETION_CACHE_MAX);
        },
        { scope: completionLimiterScope(connectionId, database), kind: "columns" },
      );
    }

    if (!completionColumnsCache.value[cacheKey]) {
      return listCompletionColumns(connectionId, database, table, schema, context, catalog);
    }

    const columns = completionColumnsCache.value[cacheKey].map((column) => ({
      name: column.name,
      table: completionTable,
      schema: completionSchema,
      dataType: column.data_type,
      isNullable: column.is_nullable,
      comment: column.comment,
    }));
    if (!usesCurrentSchema) indexCompletionColumns(connectionId, database, completionTable, completionSchema, columns, catalog, context);
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
      const requestRevision = completionCacheRevision(connectionId, database);
      await withCompletionInFlight(
        `${cacheKey}:fkeys`,
        async () => {
          await ensureConnected(connectionId);
          const querySchema = metadataQuerySchema(connectionId, database, schema);
          const foreignKeys = await api.listForeignKeys(connectionId, database, querySchema, table);
          if (requestRevision !== completionCacheRevision(connectionId, database)) return;
          completionForeignKeysCache.value[cacheKey] = foreignKeys;
          evictOldestCacheEntries(completionForeignKeysCache.value, COMPLETION_CACHE_MAX);
        },
        { scope: completionLimiterScope(connectionId, database), kind: "foreignKeys" },
      );
    }
    if (!completionForeignKeysCache.value[cacheKey]) return listCompletionForeignKeys(connectionId, database, table, schema);

    const foreignKeys = sqlCompletionForeignKeys(completionForeignKeysCache.value[cacheKey]);
    indexCompletionForeignKeys(connectionId, database, table, schema, foreignKeys);
    return foreignKeys;
  }

  function refreshCompletionTables(connectionId: string, database: string, filter = "", limit?: number, schema?: string, globalSearch = false, currentSchema?: string, catalog?: string): Promise<SqlCompletionTable[]> {
    return listCompletionTables(connectionId, database, filter, limit, schema, globalSearch, currentSchema, catalog);
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

  function refreshCompletionColumns(connectionId: string, database: string, table: string, schema?: string, context?: { clientSessionId?: string; version?: number; tableQuoted?: boolean; schemaQuoted?: boolean }, catalog?: string): Promise<SqlCompletionColumn[]> {
    return listCompletionColumns(connectionId, database, table, schema, context, catalog);
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
    await api.saveConnections(nextConnections.filter((connection) => connection.one_time !== true));
  }

  function sameIds(left: string[], right: string[]) {
    return left.length === right.length && left.every((id, index) => id === right[index]);
  }

  async function persistTimeoutInheritanceIds(connectIds: string[], queryIds: string[]) {
    if (sameIds(connectIds, settingsStore.editorSettings.connectTimeoutInheritConnectionIds) && sameIds(queryIds, settingsStore.editorSettings.queryTimeoutInheritConnectionIds)) return;
    await settingsStore.updateEditorSettingsAndPersist({
      connectTimeoutInheritConnectionIds: connectIds,
      queryTimeoutInheritConnectionIds: queryIds,
    });
  }

  async function persistTimeoutInheritance(connectionId: string, connectInherit: boolean, queryInherit: boolean) {
    const connectIds = new Set(settingsStore.editorSettings.connectTimeoutInheritConnectionIds);
    const queryIds = new Set(settingsStore.editorSettings.queryTimeoutInheritConnectionIds);
    if (connectInherit) connectIds.add(connectionId);
    else connectIds.delete(connectionId);
    if (queryInherit) queryIds.add(connectionId);
    else queryIds.delete(connectionId);
    await persistTimeoutInheritanceIds([...connectIds], [...queryIds]);
  }

  function syncTimeoutInheritanceBackup(source: ConnectionConfig[] = connections.value) {
    const connectSnapshots: Record<string, number> = {};
    const querySnapshots: Record<string, number> = {};
    for (const connection of source) {
      if (connection.connect_timeout_inherit === true) connectSnapshots[connection.id] = connection.connect_timeout_secs || settingsStore.editorSettings.globalConnectTimeoutSecs;
      if (connection.query_timeout_inherit === true) querySnapshots[connection.id] = connection.query_timeout_secs ?? settingsStore.editorSettings.globalQueryTimeoutSecs;
    }
    saveTimeoutInheritanceBackup({
      version: 1,
      globalConnectTimeoutSecs: settingsStore.editorSettings.globalConnectTimeoutSecs,
      globalQueryTimeoutSecs: settingsStore.editorSettings.globalQueryTimeoutSecs,
      connectSnapshots,
      querySnapshots,
    });
  }

  async function persistConnectionDeletion(nextConnections: ConnectionConfig[], nextLayout: SidebarLayout) {
    const previousConnections = connections.value;
    const previousLayout = sidebarLayout.value;
    const previousConnectTimeoutIds = [...settingsStore.editorSettings.connectTimeoutInheritConnectionIds];
    const previousQueryTimeoutIds = [...settingsStore.editorSettings.queryTimeoutInheritConnectionIds];
    const nextConnectTimeoutIds = previousConnectTimeoutIds.filter((id) => nextConnections.some((connection) => connection.id === id));
    const nextQueryTimeoutIds = previousQueryTimeoutIds.filter((id) => nextConnections.some((connection) => connection.id === id));
    const connectionsChanged = nextConnections.length !== previousConnections.length || nextConnections.some((connection, index) => connection !== previousConnections[index]);
    const timeoutSettingsChanged = !sameIds(nextConnectTimeoutIds, previousConnectTimeoutIds) || !sameIds(nextQueryTimeoutIds, previousQueryTimeoutIds);
    const layoutChanged = nextLayout !== previousLayout;
    let connectionsPersisted = false;
    let timeoutSettingsPersisted = false;
    let layoutSaveStarted = false;

    try {
      if (connectionsChanged) {
        await persistConnections(nextConnections);
        connectionsPersisted = true;
      }
      if (timeoutSettingsChanged) {
        await persistTimeoutInheritanceIds(nextConnectTimeoutIds, nextQueryTimeoutIds);
        timeoutSettingsPersisted = true;
      }
      if (layoutChanged) {
        layoutSaveStarted = true;
        await api.saveSidebarLayout(nextLayout);
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      if (layoutSaveStarted) {
        try {
          await api.saveSidebarLayout(previousLayout);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (timeoutSettingsPersisted) {
        try {
          await persistTimeoutInheritanceIds(previousConnectTimeoutIds, previousQueryTimeoutIds);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (connectionsPersisted) {
        try {
          await persistConnections(previousConnections);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length) {
        const details = rollbackErrors.map((rollbackError) => (rollbackError instanceof Error ? rollbackError.message : String(rollbackError))).join("; ");
        const recoveryError = new Error(`Connection deletion failed and recovery was incomplete: ${details}`);
        (recoveryError as Error & { cause?: unknown }).cause = error;
        throw recoveryError;
      }
      throw error;
    }
  }

  async function applyGlobalTimeouts({ connectTimeoutSecs, queryTimeoutSecs }: { connectTimeoutSecs?: number; queryTimeoutSecs?: number }) {
    const nextConnections = connections.value.map((connection) => {
      const nextConnectTimeout = connectTimeoutSecs !== undefined && connection.connect_timeout_inherit === true ? connectTimeoutSecs : connection.connect_timeout_secs;
      const nextQueryTimeout = queryTimeoutSecs !== undefined && connection.query_timeout_inherit === true ? queryTimeoutSecs : connection.query_timeout_secs;
      if (nextConnectTimeout === connection.connect_timeout_secs && nextQueryTimeout === connection.query_timeout_secs) return connection;
      return { ...connection, connect_timeout_secs: nextConnectTimeout, query_timeout_secs: nextQueryTimeout };
    });
    if (nextConnections.some((connection, index) => connection !== connections.value[index])) {
      await persistConnections(nextConnections);
      connections.value = nextConnections;
    }
    syncTimeoutInheritanceBackup();
  }

  async function migrateTimeoutInheritance(saved: ConnectionConfig[]) {
    const migrationVersion = settingsStore.editorSettings.timeoutInheritanceMigrationVersion;
    const backup = loadTimeoutInheritanceBackup();
    const connectIdsBefore = new Set(settingsStore.editorSettings.connectTimeoutInheritConnectionIds);
    const queryIdsBefore = new Set(settingsStore.editorSettings.queryTimeoutInheritConnectionIds);
    const globalConnectTimeoutSecs = migrationVersion < 2 && backup ? backup.globalConnectTimeoutSecs : settingsStore.editorSettings.globalConnectTimeoutSecs;
    const globalQueryTimeoutSecs = migrationVersion < 2 && backup ? backup.globalQueryTimeoutSecs : settingsStore.editorSettings.globalQueryTimeoutSecs;

    const resolveInheritance = (connection: ConnectionConfig, scope: "connect" | "query") => {
      const explicit = scope === "connect" ? connection.connect_timeout_inherit : connection.query_timeout_inherit;
      if (explicit === true || explicit === false) return explicit;
      const ids = scope === "connect" ? connectIdsBefore : queryIdsBefore;
      const snapshots = scope === "connect" ? backup?.connectSnapshots : backup?.querySnapshots;
      const value = Number(scope === "connect" ? (connection.connect_timeout_secs ?? 10) : (connection.query_timeout_secs ?? 30));
      const snapshot = snapshots?.[connection.id];
      if (snapshot !== undefined && (ids.has(connection.id) || migrationVersion < 2)) return value === snapshot;
      if (ids.has(connection.id)) return true;
      if (scope === "connect" && migrationVersion < 2) return value === 10;
      if (scope === "query" && migrationVersion < 1) return value === 30;
      return false;
    };

    const connectIds = saved.filter((connection) => resolveInheritance(connection, "connect")).map((connection) => connection.id);
    const queryIds = saved.filter((connection) => resolveInheritance(connection, "query")).map((connection) => connection.id);
    settingsStore.updateEditorSettings({
      globalConnectTimeoutSecs,
      connectTimeoutInheritConnectionIds: connectIds,
      globalQueryTimeoutSecs,
      queryTimeoutInheritConnectionIds: queryIds,
      timeoutInheritanceMigrationVersion: 2,
    });
    if (migrationVersion !== 2 || !sameIds(connectIds, [...connectIdsBefore]) || !sameIds(queryIds, [...queryIdsBefore])) {
      await settingsStore.persistEditorSettings();
    }
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
            comment: node.comment,
            searchAliases: node.searchAliases,
            pinned: node.pinned,
            children: withSavedSqlRoot(node.connectionId!, existing.children || [], existing),
          });
        }
        if (node.type === "connection" && node.connectionId) {
          return inheritNaturalTreeNodeOrder(node, { ...node, children: withSavedSqlRoot(node.connectionId, node.children || []) });
        }
        return node;
      });
    const mergedNodes = mergeState(freshNodes);
    const migratedPins = migrateLegacyPinnedTreeNodeOrder(mergedNodes, pinnedTreeNodeOrder.value);
    if (migratedPins.changed) {
      setPinnedTreeNodeOrder(migratedPins.order);
      persistPinnedTreeNodeIds();
    }
    syncPinnedTreeState(mergedNodes);
    treeNodes.value = mergedNodes;
  }

  function updateLayoutAndRebuild(nextLayout: SidebarLayout) {
    sidebarLayout.value = nextLayout;
    rebuildTreeNodes();
    persistSidebarLayoutDebounced();
  }

  async function removeConnectionGroups(groupIds: Iterable<string>, deleteConnections = false): Promise<string[]> {
    const uniqueGroupIds = [...new Set(groupIds)];
    const previousLayout = sidebarLayout.value;
    const connectionIds = deleteConnections ? connectionIdsInGroupsOp(sidebarLayout.value, uniqueGroupIds).filter((id) => connections.value.some((connection) => connection.id === id)) : [];
    const oneTimeIds = connectionIds.filter((id) => getConfig(id)?.one_time === true);
    const removedConnectionIds = new Set(connectionIds);
    const nextConnections = removedConnectionIds.size ? connections.value.filter((connection) => !removedConnectionIds.has(connection.id)) : connections.value;
    let layoutAfterConnectionRemoval = previousLayout;
    for (const id of removedConnectionIds) layoutAfterConnectionRemoval = removeConnectionFromSidebarLayout(layoutAfterConnectionRemoval, id);
    const nextLayout = deleteGroupsOp(layoutAfterConnectionRemoval, uniqueGroupIds);
    if (nextLayout === previousLayout && nextConnections === connections.value) return [];

    await persistConnectionDeletion(nextConnections, nextLayout);
    if (removedConnectionIds.size) {
      applyConnectionRemoval(removedConnectionIds, nextConnections, nextLayout);
    } else {
      sidebarLayout.value = nextLayout;
      rebuildTreeNodes();
    }
    await cleanupRemovedOneTimeConnections(oneTimeIds);

    const remainingGroupIds = new Set(nextLayout.groups.map((group) => group.id));
    const removedGroupIds = new Set(previousLayout.groups.filter((group) => !remainingGroupIds.has(group.id)).map((group) => group.id));
    if (removedGroupIds.size) {
      const nextPinnedOrder = pinnedTreeNodeOrder.value.filter((pinId) => !removedGroupIds.has(pinId));
      if (nextPinnedOrder.length !== pinnedTreeNodeOrder.value.length) {
        setPinnedTreeNodeOrder(nextPinnedOrder);
        persistPinnedTreeNodeIds();
      }
      selectedTreeNodeIds.value = selectedTreeNodeIds.value.filter((id) => !removedGroupIds.has(id));
      if (selectedTreeNodeId.value && removedGroupIds.has(selectedTreeNodeId.value)) selectedTreeNodeId.value = null;
      if (treeSelectionAnchorId.value && removedGroupIds.has(treeSelectionAnchorId.value)) treeSelectionAnchorId.value = null;
      if (!selectedTreeNodeIds.value.length) connectionMultiSelectActive.value = false;
    }
    return connectionIds;
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

  async function exportConnectionsToFile(protection: ConnectionExportProtection, selectedConnectionIds?: Iterable<string>) {
    if (protection.mode === "encrypted" && !protection.passphrase) throw new Error("passphrase_required");

    const tunnelProfileStore = useTunnelProfileStore();
    await tunnelProfileStore.init();
    // Older DBX versions ignore inheritance flags, so always include the
    // effective numeric values as a backward-compatible snapshot.
    const exportedConnections = snapshotConnectionsForExport(connections.value, {
      connectTimeoutSecs: () => settingsStore.editorSettings.globalConnectTimeoutSecs,
      queryTimeoutSecs: () => settingsStore.editorSettings.globalQueryTimeoutSecs,
    });
    const exportData = buildConnectionConfigBundle(exportedConnections, sidebarLayout.value, tunnelProfileStore.profiles, selectedConnectionIds);
    const json = JSON.stringify(exportData);
    let content: string;
    if (protection.mode === "encrypted") {
      const { encryptConfig } = await import("@/lib/backend/configCrypto");
      const payload = await encryptConfig(json, protection.passphrase);
      content = JSON.stringify(payload, null, 2);
    } else {
      content = JSON.stringify(exportData, null, 2);
    }

    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        filters: [{ name: "JSON", extensions: ["json"] }],
        defaultPath: "dbx-connections.json",
      });
      if (!path) return "cancelled" as const;
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
    return "saved" as const;
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
    let dbForestConfig = "";

    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const { matchDataGripImportFiles } = await import("@/lib/imports/datagripImport");
      const paths = await open({
        multiple: true,
        filters: [{ name: "DataGrip configuration files", extensions: ["xml"] }],
        title: i18n.global.t("configExport.importDatagripDialogTitle"),
      });
      if (!paths || paths.length === 0) return null;
      // Tauri's fs scope authorizes only the exact paths picked in the dialog,
      // so every file read below must be explicitly selected — sibling files in
      // the same directory (e.g. dataSources.local.xml) are NOT readable.
      let picked: { dataSources: string; local?: string; forest?: string };
      try {
        picked = matchDataGripImportFiles(Array.isArray(paths) ? paths : [paths]);
      } catch (error) {
        if ((error as Error & { code?: string })?.code === "DATAGRIP_IMPORT_MISSING_DATASOURCES") {
          throw new Error(i18n.global.t("configExport.importDatagripSelectFiles"));
        }
        throw error;
      }
      dataSources = await readTextFile(picked.dataSources);
      if (picked.local) {
        dataSourcesLocal = await readTextFile(picked.local);
      } else {
        console.warn("[DataGrip Import] dataSources.local.xml not selected; usernames will fall back to defaults");
      }
      if (picked.forest) {
        dbForestConfig = await readTextFile(picked.forest);
      } else {
        console.warn("[DataGrip Import] db-forest-config.xml not selected; legacy group tree skipped");
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
      const dsFile = fileList.find((f) => /^dataSources\.xml$/i.test(f.name));
      const localFile = fileList.find((f) => /^dataSources\.local\.xml$/i.test(f.name));
      const forestFile = fileList.find((f) => /^db-forest-config\.xml$/i.test(f.name));
      if (!dsFile) throw new Error("Select dataSources.xml");
      dataSources = await dsFile.text();
      if (localFile) {
        dataSourcesLocal = await localFile.text();
      }
      if (forestFile) {
        dbForestConfig = await forestFile.text();
      }
    }

    return {
      content: JSON.stringify({ format: "datagrip-import", dataSources, dataSourcesLocal, dbForestConfig }),
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

  async function parseConnectionsImport(content: string, passphrase: string | null): Promise<ConnectionConfigBundle> {
    if (!passphrase && content.trimStart().startsWith("<")) {
      const { parseNavicatConnections } = await import("@/lib/imports/navicatImport");
      return { connections: await parseNavicatConnections(content) };
    }

    if (!passphrase) {
      const { isDbeaverImportPayload, parseDbeaverImport } = await import("@/lib/imports/dbeaverImport");
      const { isDataGripImportPayload, parseDataGripImport } = await import("@/lib/imports/datagripImport");
      if (isDataGripImportPayload(content)) {
        const payload = JSON.parse(content) as {
          format: "datagrip-import";
          dataSources: string;
          dataSourcesLocal?: string;
          dbForestConfig?: string;
        };
        pendingDataGripPayload = payload;
        const result = parseDataGripImport(payload);
        return { connections: result.connections, layout: result.layout };
      }
      if (isDbeaverImportPayload(content)) {
        const result = await parseDbeaverImport(content);
        return { connections: result.connections, layout: result.layout };
      }
      return parseConnectionConfigObject(JSON.parse(content));
    }

    const { decryptConfig } = await import("@/lib/backend/configCrypto");
    const json = await decryptConfig(JSON.parse(content), passphrase);
    return parseConnectionConfigObject(JSON.parse(json));
  }

  async function applyConnectionsImport(preview: ConnectionConfigBundle, selectedConnectionIds?: Iterable<string>): Promise<{ count: number; layout?: SidebarLayout }> {
    const selected = selectConnectionConfigBundle(preview, selectedConnectionIds);
    const imported = selected.connections.map((connection) => ({ ...connection }));
    let importedLayout = selected.layout;
    const importedConnections: ConnectionConfig[] = [];
    const importedConnectionIdMap = new Map<string, string>();
    for (const config of imported) {
      const duplicate = [...connections.value, ...importedConnections].find((connection) => connection.name === config.name && connection.host === config.host && connection.port === config.port);
      if (duplicate) {
        if (typeof config.id === "string") importedConnectionIdMap.set(config.id, duplicate.id);
        continue;
      }
      const importedId = config.id;
      config.id = uuid();
      if (typeof importedId === "string") importedConnectionIdMap.set(importedId, config.id);
      importedConnections.push(normalizeConnection(config));
    }
    const importedTunnelProfileIds = referencedTunnelProfileIds(importedConnections);
    const importedTunnelProfiles = filterTunnelProfilesByIds(selected.tunnelProfiles ?? [], importedTunnelProfileIds);
    if (importedTunnelProfiles.length) {
      const importedTunnelProfileStore = useTunnelProfileStore();
      await importedTunnelProfileStore.init();
      const merged = [...importedTunnelProfileStore.profiles];
      for (const profile of importedTunnelProfiles) {
        if (!profile || typeof profile.id !== "string" || !profile.id) continue;
        const index = merged.findIndex((existing) => existing.id === profile.id);
        if (index >= 0) merged[index] = profile;
        else merged.push(profile);
      }
      await importedTunnelProfileStore.saveProfiles(merged);
    }
    for (const connection of importedConnections) await addConnection(connection);
    if (importedLayout) {
      importedLayout = filterSidebarLayoutByConnectionIds(remapSidebarLayoutConnectionIds(importedLayout, importedConnectionIdMap), importedConnectionIdMap.values());
    }
    return { count: importedConnections.length, layout: importedLayout };
  }

  async function importConnectionsFromFile(content: string, passphrase: string | null, selectedConnectionIds?: Iterable<string>): Promise<{ count: number; layout?: SidebarLayout }> {
    const preview = await parseConnectionsImport(content, passphrase);
    return applyConnectionsImport(preview, selectedConnectionIds);
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
      mergeSidebarLayout(sidebarLayout.value, layout),
    );
    updateLayoutAndRebuild(reconciledLayout);
  }

  async function initFromDisk() {
    // Connection normalization and timeout migration depend on persisted global
    // settings. Startup helpers may initialize connections before App.initApp().
    await settingsStore.initEditorSettings();
    if (!initFromDiskPromise) {
      initFromDiskPromise = (async () => {
        const [pinnedOrder, saved] = await Promise.all([loadPinnedTreeNodeOrder(), api.loadConnections(), tunnelProfileStore.init()]);
        setPinnedTreeNodeOrder(pinnedOrder);
        await migrateTimeoutInheritance(saved);
        const loadedConnections = saved.map(normalizeConnection);
        const loadedIds = new Set(loadedConnections.map((connection) => connection.id));
        // One-time deep-link connections are intentionally filtered from disk
        // persistence. Keep them in the live list when an unrelated disk reload
        // (for example, the scheduled-backup poll) completes while they are open.
        const runtimeOneTimeConnections = connections.value.filter((connection) => connection.one_time === true && !loadedIds.has(connection.id));
        connections.value = [...loadedConnections, ...runtimeOneTimeConnections];
        if (loadedConnections.some((connection, index) => (connection.connect_timeout_inherit === true && connection.connect_timeout_secs !== saved[index]?.connect_timeout_secs) || (connection.query_timeout_inherit === true && connection.query_timeout_secs !== saved[index]?.query_timeout_secs))) {
          await persistConnections();
        }
        syncTimeoutInheritanceBackup();
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

  function cancelTreeNodeLoad(nodeId: string): void {
    // Supersede any in-flight loader for this node so a collapse issued while
    // the load is still running (or a loader that never resolves) cannot
    // reclaim ownership after connection recovery or re-expand the node.
    treeNodeLoads.cancelPrefix(nodeId);
    const node = findNode(treeNodes.value, nodeId);
    if (node) node.isLoading = false;
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
    removePinnedTreeNodes,
    replacePinnedTreeNode,
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
    connectionGroupOptions,
    selectedConnectionGroupId,
    getConfig,
    connectionIdentifierQuote,
    isTreeNodePinned,
    orderByPinnedTreeNodes,
    toggleTreeNodePin,
    beginPinnedTreeNodeReorder,
    endPinnedTreeNodeReorder,
    isPinnedTreeNodeReorderTarget,
    canReorderPinnedTreeNodes,
    reorderPinnedTreeNodes,
    addConnection,
    copyConnectionsToTreeClipboard,
    pasteConnectionClipboard,
    addEphemeralConnection,
    updateConnection,
    renameConnection,
    applyGlobalTimeouts,
    updateConnectionDatabaseInfo,
    setDefaultDatabase,
    clearDefaultDatabase,
    isDefaultDatabase,
    setDefaultSchema,
    clearDefaultSchema,
    isDefaultSchema,
    getRedisDatabaseAlias,
    setRedisDatabaseAlias,
    setVisibleDatabases,
    setVisibleDatabaseFilter,
    clearVisibleDatabases,
    ensureVisibleDatabase,
    setVisibleSchemas,
    clearVisibleSchemas,
    recordPrimaryVisibleObjectNames,
    getSidebarVisibleFilterSummary,
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
    metadataGenerationFor,
    disconnectAndForgetConnectionPassword,
    hasSessionCredential,
    closeDatabaseConnection,
    ensureConnected,
    loadConnectedConnectionRootForSidebarSearch,
    isTreeNodeChildrenLoaded,
    canUseLoadedTreeNodeToggle,
    releaseCollapsedTreeNodeChildren,
    cancelTreeNodeLoad,
    setBeforeConnectHandler,
    initFromDisk,
    loadDatabases,
    loadSidebarDatabaseStorage,
    loadSidebarTableStorage,
    loadRedisDatabases,
    refreshRedisDbKeyCounts,
    loadEtcdRoot,
    loadZooKeeperRoot,
    loadConsulRoot,
    loadMqTenants,
    loadMqttTopics,
    loadNacosNamespaces,
    updateRedisDbKeyStats,
    loadMongoDatabases,
    loadDynamoDbTables,
    loadMilvusDatabases,
    openElasticsearchConnectionTree,
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
    loadCustomTypeChildren,
    loadPackageMembers,
    loadXuguTablespaces,
    loadXuguTypeMembers,
    loadMoreObjectGroupChildren,
    loadAllObjectGroupChildren,
    loadTableGroups,
    loadTreeNodeChildren,
    loadColumns,
    loadIndexes,
    loadForeignKeys,
    loadTriggers,
    loadConstraints,
    loadPartitions,
    loadSubpartitions,
    listCompletionTables,
    listCompletionObjects,
    listCompletionColumns,
    listCompletionColumnsByPrefix,
    listCompletionForeignKeys,
    listCompletionSchemas,
    listCompletionDatabases,
    getSqlServerCompletionContext,
    lookupLocalCompletionTables,
    lookupLocalCompletionObjects,
    lookupLocalCompletionColumns,
    lookupLocalCompletionColumnsByPrefix,
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
    listRedisCompletionCommandDocs,
    listMongoCompletionCollections,
    listMongoCompletionFields,
    invalidateCompletionCache,
    invalidateCompletionTableCache,
    completionCacheRevision,
    invalidateMetadataCache,
    exportConnectionsToFile,
    readImportFile,
    parseConnectionsImport,
    applyConnectionsImport,
    importConnectionsFromFile,
    applyDataGripKeychainPasswords,
    applySidebarLayout,
    transferSource,
    schemaDiffSource,
    dataCompareSource,
    sqlFileSource,
    diagramSource,
    docsSource,
    tableImportSource,
    tableDataGenerateSource,
    fieldLineageSource,
    databaseSearchSource,
    databaseExportSource,
    sidebarSearchQuery,
    sidebarTableSearchQueries,
    sidebarTableSearchIndexInvalidation,
    sidebarTableNameFilters,
    tableNameFilterScopeKey,
    tableNameFilterForScope,
    setSidebarTableNameFilter,
    refreshTreeNodeForTableNameFilter,
    setSidebarTableSearchQuery,
    refreshSidebarTableSearch,
    loadSidebarTableSearchIndex,
    loadSidebarTableSearchIndexScopes,
    refreshSidebarTableSearchIndex,
    createConnectionGroup(name: string, parentGroupId?: string | null) {
      const result = createGroupOp(sidebarLayout.value, name, parentGroupId);
      updateLayoutAndRebuild(result.layout);
      return result.groupId;
    },
    renameConnectionGroup(groupId: string, name: string) {
      updateLayoutAndRebuild(renameGroupOp(sidebarLayout.value, groupId, name));
    },
    async deleteConnectionGroup(groupId: string) {
      await removeConnectionGroups([groupId]);
    },
    async deleteConnectionGroups(groupIds: Iterable<string>, deleteConnections = false) {
      return await removeConnectionGroups(groupIds, deleteConnections);
    },
    connectionIdsInGroups(groupIds: Iterable<string>) {
      return connectionIdsInGroupsOp(sidebarLayout.value, groupIds);
    },
    toggleConnectionGroupCollapsed(groupId: string) {
      updateLayoutAndRebuild(toggleGroupCollapsedOp(sidebarLayout.value, groupId));
    },
    expandConnectionGroups(groupIds: Iterable<string>) {
      updateLayoutAndRebuild(expandGroupsOp(sidebarLayout.value, groupIds));
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
    reorderSidebarEntries(draggedIds: string[], targetId: string, position: DropPosition, options?: ReorderEntriesOptions) {
      const layout = reorderEntriesOp(sidebarLayout.value, draggedIds, targetId, position, options);
      if (layout !== sidebarLayout.value) updateLayoutAndRebuild(layout);
    },
  };
});

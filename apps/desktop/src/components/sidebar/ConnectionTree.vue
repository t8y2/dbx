<script setup lang="ts">
import { ref, shallowRef, computed, nextTick, watch, provide, onMounted, onUnmounted, type Component, type ComponentPublicInstance, type CSSProperties } from "vue";
import { useI18n } from "vue-i18n";
import { translateBackendError } from "@/i18n/backend-errors";
import { Search, X, ListOrdered, ArrowDownAZ, ArrowUpZA, Server, Database, FolderTree, Table2, Eye, RotateCcw, Loader2, Unplug } from "@lucide/vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSidebarMenuPresentation } from "@/composables/useSidebarMenuPresentation";
import { useToast } from "@/composables/useToast";
import type { ColumnInfo, ObjectSourceKind, QueryTab, TableInfo, TableNameFilter, TreeNode, TreeNodeType } from "@/types/database";
import type { ElasticsearchIndexMetadataKind } from "@/lib/backend/tauri";
import { listEventTriggers } from "@/lib/backend/api";
import {
  filterLocallySearchedTables,
  filterSidebarSearchRootsByConnectionState,
  filterSidebarTree,
  filterSidebarTreeToConnectedConnections,
  findNodePathByIdentity,
  mergeSidebarRegexIndexScopes,
  resolveSidebarFilterGuards,
  type SidebarRegexIndexScope,
  type SidebarRegexScopeIdentity,
  localTableSearchParentTypes,
} from "@/lib/sidebar/sidebarSearchTree";
import { createSidebarLabelMatcher } from "@/lib/sidebar/sidebarSearch";
import { firstSidebarSearchMatchDataNode, hasActiveSidebarSearch } from "@/lib/sidebar/sidebarSearchEnter";
import { collectSidebarRegexIndexScopes } from "@/lib/sidebar/sidebarRegexSearchIndex";
import { collectSidebarGlobalSearchIndexes, sidebarIndexedObjectGroupTypes } from "@/lib/sidebar/sidebarGlobalSearchIndex";
import { runSidebarSearchTasks } from "./sidebarSearchTaskRunner";
import { resolveSidebarSearchDatabaseScope } from "@/lib/sidebar/sidebarSearchDatabaseScope";
import { useSidebarSearchIndexes } from "@/composables/useSidebarSearchIndexes";
import { useSidebarRemoteSearch } from "@/composables/useSidebarRemoteSearch";
import { collectSidebarRemoteSearchResults, mergeSidebarRemoteSearchResults, type SidebarRemoteSearchResult } from "@/lib/sidebar/sidebarRemoteSearch";
import { isCancelSearchShortcut, isCopySidebarSelectionShortcut, isDisconnectSidebarConnectionShortcut, isEditSidebarConnectionShortcut, isEditSidebarTableStructureShortcut, isPasteSidebarSelectionShortcut, isRefreshDataShortcut, isViewTableDdlShortcut } from "@/lib/editor/keyboardShortcuts";
import { sidebarNodeSupportsDdlView } from "@/lib/sidebar/sidebarTreeDdlShortcut";
import { DEFAULT_DATABASE_TREE_LABEL, hasTreeNodeDatabaseContext } from "@/lib/sidebar/treeNodeContext";
import { objectSourceTargetForTreeNode } from "@/lib/sidebar/treeNodeClick";
import { exactOracleTriggerNodeMetadata } from "@/lib/database/oracleTriggerIdentity";
import { supportsTypeObjectSource } from "@/lib/database/databaseObjectCapabilities";
import { copyToClipboard } from "@/lib/common/clipboard";
import { connectionPasteTargetGroupId, copySelectedConnectionsToClipboards, selectedConnectionDisconnectTargets, selectedConnectionEditTarget } from "@/lib/sidebar/sidebarConnectionSelection";
import { formatSidebarTableCopyText } from "@/lib/sidebar/sidebarTableNameCopy";
import { pruneTreeSelectionToVisibleNodeIds } from "@/lib/sidebar/sidebarTreeSelection";
import { sidebarUserAdminVisibility } from "@/lib/sidebar/sidebarUserAdminVisibility";
import { isEditableSidebarTypeSearchTarget, sidebarTypeSearchNextQuery } from "@/lib/sidebar/sidebarTypeSearch";
import { isInternalDorisCatalog, usesTreeSchemaMode } from "@/lib/database/databaseFeatureSupport";
import { connectionObjectTreeNodeSchema, connectionShouldDiscoverJdbcSchemas, connectionUsesConnectionRootSchemaMode, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import {
  activeTabSidebarTarget,
  expandSidebarLocatePath,
  findSidebarConnectionNode,
  findSidebarNodeForActiveTab,
  findSidebarNodeForTarget,
  findNodePathForTarget,
  scrollTopForSidebarNode,
  shouldScrollActiveSidebarSelection,
  type ActiveTabSidebarTarget,
  type SidebarNodeScrollAlign,
} from "@/lib/sidebar/sidebarActiveTabTarget";
import { findLoadedTableTargetForCandidate, queryContextTargetFromCandidate, queryCursorTableCandidate, type QueryCursorTableCandidate } from "@/lib/sql/queryCursorTableTarget";
import { createFlatTreeIndex, flatTreeRowsChanged, getSidebarTreeRowHeight, SIDEBAR_TREE_PRERENDER_COUNT, SIDEBAR_TREE_SCROLL_BUFFER, SIDEBAR_TREE_VIRTUALIZE_HYSTERESIS, SIDEBAR_TREE_VIRTUALIZE_THRESHOLD, flattenTree, shouldVirtualizeFlatTree, type FlatTreeNode } from "@/composables/useFlatTree";
import { sidebarTreeContextKey } from "@/lib/sidebar/sidebarTreeContext";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHostInstance } from "@/lib/sidebar/sidebarTreeRuntime";
import { createSidebarPasteHandlerRegistry } from "@/lib/sidebar/sidebarPasteHandlerRegistry";
import { insertSidebarTableSearchControls, isSidebarTableSearchControlNode, sidebarSearchableObjectGroupTypes } from "@/lib/sidebar/sidebarTableSearchControl";
import { createSidebarTableSearchDebouncer, scheduleExclusiveSidebarTableSearchDebounce } from "@/lib/sidebar/sidebarTableSearchIndex";
import TreeItem from "./TreeItem.vue";
import ProductionContextBadge from "@/components/common/ProductionContextBadge.vue";
import { isSidebarProductionContainer, showSidebarRowProductionBadge, showSidebarStickyProductionBadge } from "@/lib/sidebar/sidebarProductionBadge";
import { resolvePlainStickyContainerIndex } from "@/lib/sidebar/sidebarStickyProductionContext";
import ActiveConnectionFilterButton from "./ActiveConnectionFilterButton.vue";
import SidebarListOptionsIcon from "./SidebarListOptionsIcon.vue";
import SidebarLocateButton from "./SidebarLocateButton.vue";
import SidebarRegexToggleButton from "./SidebarRegexToggleButton.vue";
import SidebarTreeRuntimeHost from "./SidebarTreeRuntimeHost.vue";
import SidebarTreeItemDialogs from "./SidebarTreeItemDialogs.vue";
import SidebarTableVGroupDialog from "./SidebarTableVGroupDialog.vue";
import InstallExtensionDialog from "@/components/objects/InstallExtensionDialog.vue";
import ExtensionDetailsDialog from "@/components/objects/ExtensionDetailsDialog.vue";
import EventTriggerDetailsDialog from "@/components/objects/EventTriggerDetailsDialog.vue";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import LightDropdown from "@/components/ui/LightDropdown.vue";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { Switch } from "@/components/ui/switch";
import { cancelPendingSidebarDataOpen, runSidebarDataOpenImmediately, type SidebarDataOpenRequest } from "@/lib/sidebar/sidebarDataOpenCoordinator";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { codeMirrorSqlDialect } from "@/lib/database/jdbcDialect";
import { sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";
import { createSidebarActionTarget, findSidebarActionTarget, matchesSidebarActionTarget, type SidebarActionRequest, type SidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";
import { syncSidebarTreeNodeExpansion } from "@/lib/sidebar/sidebarTreeExpansion";
import { openSidebarDangerDialog } from "@/lib/sidebar/sidebarDangerDialog";
import { resetSidebarTreeDialogState } from "./sidebarTreeDialogState";
import type { OracleTriggerSqlBinding } from "@/lib/database/oracleTriggerSql";
import { SidebarDdlViewDialog, SidebarElasticsearchIndexMetadataDialog, SidebarObjectSourceDialog, SidebarProcedureExecutionDialog, SidebarVisibleDatabasesDialog, SidebarVisibleNacosNamespacesDialog, SidebarVisibleSchemasDialog } from "./sidebarAsyncDialogs";
import { sortConnectionListForDisplay } from "@/lib/sidebar/connectionListSort";
import { orderSidebarConnectionUtilitiesForDisplay } from "@/lib/sidebar/sidebarNodeOrdering";
import { sidebarDisplayTableName } from "@/lib/sidebar/sidebarTableNameDisplay";
import { sidebarTreeDisplayLabel, sidebarTreeSecondaryValue } from "@/lib/sidebar/sidebarTreeLabel";
import { canTreeNodePin, sidebarPinnedActionSlotWidthPx, alignedSidebarCommentLabelWidths, isSidebarCommentAlignableNode, sidebarTreeNaturalContentWidth, sidebarTreeNodeComment, usesFullWidthTreeLabel } from "@/lib/sidebar/sidebarTreeItemLayout";
import { sidebarHorizontalWheelDelta } from "@/lib/sidebar/sidebarScrollbar";
import { formatSidebarObjectStorage, sidebarTableStorageScopes, supportsSidebarTableStorage } from "@/lib/sidebar/sidebarDatabaseStorage";
import { sidebarScrollbarGeometry as calculateSidebarScrollbarGeometry } from "@/lib/sidebar/sidebarScrollbar";
import { createSidebarLayoutMonitor, type SidebarExpandedConnectionInfo } from "@/lib/sidebar/sidebarLayoutMonitor";
import { disconnectSidebarConnections } from "@/lib/sidebar/sidebarConnectionDisconnect";
import { compileSearchRegex } from "@/lib/common/searchPattern";
import type { ObjectDependencyTarget, ObjectDetailsSection } from "@/lib/database/objectDependencyDetails";
import type { SqlObjectNavigationTarget } from "@/lib/sql/sqlNavigation";

const { t, locale } = useI18n();
const store = useConnectionStore();
const queryStore = useQueryStore();
const savedSqlStore = useSavedSqlStore();
const settingsStore = useSettingsStore();
const { toast } = useToast();
const searchQuery = ref("");
const deferredSearchQuery = ref("");
const regexMode = ref(false);
// The saved preference applies to the top search only; database-inline searches
// retain their local/remote contracts. Regex continues to override plain text.
const searchMatchMode = computed(() => settingsStore.editorSettings.sidebarSearchMatchMode);
store.sidebarSearchQuery = "";
const showConnectedConnectionsOnly = ref(false);
const isDisconnectingAllActiveConnections = ref(false);
const searchInputRef = ref<HTMLInputElement>();
const rootRef = ref<HTMLElement>();
const sidebarTreeRowHeight = computed(() => getSidebarTreeRowHeight(settingsStore.editorSettings.sidebarDensity));
const sidebarRootStyle = computed<Record<string, string>>(() => ({
  fontSize: `${settingsStore.editorSettings.sidebarFontSize}px`,
  "--sidebar-tree-row-height": `${sidebarTreeRowHeight.value}px`,
}));
const pointerInsideTree = ref(false);
const treeScrollerRef = ref<InstanceType<typeof RecycleScroller> | null>(null);
const plainTreeScrollerRef = ref<HTMLElement | null>(null);
const treeScrollShellRef = ref<HTMLElement | null>(null);
const sidebarScrollbarTrackRef = ref<HTMLElement | null>(null);
const sidebarHorizontalScrollbarTrackRef = ref<HTMLElement | null>(null);
const sidebarContextMenuRef = ref<{ close: () => void } | null>(null);
const sidebarContextMenuItems = ref<ContextMenuItem[]>([]);
const { presentMenu, SidebarMenuPreferencesDialog, sidebarMenuPreferencesOpen, sidebarMenuPreferences } = useSidebarMenuPresentation();
const emit = defineEmits<{
  "open-settings": [initialTab: string];
  "open-connection-settings": [connectionId: string];
  "add-to-ai": [nodes: TreeNode | TreeNode[]];
  "open-dependency-object": [context: ObjectDependencyTarget, target: SqlObjectNavigationTarget];
}>();

const sidebarContextMenuTarget = ref<SidebarActionTarget | null>(null);
const sidebarTreeItemDialogController = ref<Record<string, any> | null>(null);
const sidebarInstallExtensionTarget = ref<TreeNode | null>(null);
const sidebarInstallExtensionDialogRef = ref<InstanceType<typeof InstallExtensionDialog> | null>(null);
const sidebarExtensionDetailsTarget = ref<TreeNode | null>(null);
const sidebarExtensionDetailsDialogRef = ref<InstanceType<typeof ExtensionDetailsDialog> | null>(null);
const sidebarEventTriggerDetailsTarget = ref<TreeNode | null>(null);
const sidebarEventTriggerDetailsDialogRef = ref<InstanceType<typeof EventTriggerDetailsDialog> | null>(null);
const sidebarTreeRuntimeHostRef = ref<SidebarTreeRuntimeHostInstance | null>(null);
const sidebarTreeRuntime = createSidebarTreeRuntime();
const sidebarTreeRuntimeInitialNode: TreeNode = { id: "__sidebar-runtime__", label: "", type: "connection-group" };
const sidebarDdlTarget = ref<TreeNode | null>(null);
const sidebarDdlOpen = ref(false);
const sidebarElasticsearchIndexMetadataTarget = ref<{ node: TreeNode; kind: ElasticsearchIndexMetadataKind } | null>(null);
const sidebarElasticsearchIndexMetadataOpen = ref(false);
const sidebarObjectSourceTarget = ref<{ node: TreeNode; initialEditing: boolean; initialSection?: ObjectDetailsSection; createTrigger?: SidebarActionRequest<OracleTriggerSqlBinding> } | null>(null);
const sidebarObjectSourceOpen = ref(false);
const sidebarProcedureTarget = ref<TreeNode | null>(null);
const sidebarProcedureOpen = ref(false);
const sidebarVisibleDatabasesTarget = ref<TreeNode | null>(null);
const sidebarVisibleDatabasesOpen = ref(false);
const sidebarVisibleSchemasTarget = ref<TreeNode | null>(null);
const sidebarVisibleSchemasOpen = ref(false);
const sidebarVisibleNacosNamespacesTarget = ref<TreeNode | null>(null);
const sidebarVisibleNacosNamespacesOpen = ref(false);
const sidebarTableNameFilterTarget = ref<TreeNode | null>(null);
const sidebarTableNameFilterOpen = ref(false);
const tableNameFilterIncludeDraft = ref("");
const tableNameFilterExcludeDraft = ref("");
let sidebarActionGeneration = 0;
const sidebarDdlDatabaseType = computed(() => {
  const connectionId = sidebarDdlTarget.value?.connectionId;
  return connectionId ? effectiveDatabaseTypeForConnection(store.getConfig(connectionId)) : undefined;
});
const sidebarObjectSourceResolvedTarget = computed(() => (sidebarObjectSourceTarget.value ? objectSourceTargetForTreeNode(sidebarObjectSourceTarget.value.node) : null));
const sidebarObjectSourceType = computed(() => sidebarObjectSourceResolvedTarget.value?.objectType ?? null);
const sidebarObjectSourceDatabaseType = computed(() => {
  const connectionId = sidebarObjectSourceTarget.value?.node.connectionId;
  return connectionId ? effectiveDatabaseTypeForConnection(store.getConfig(connectionId)) : undefined;
});
const sidebarObjectSourceDialect = computed(() => codeMirrorSqlDialect(sidebarObjectSourceDatabaseType.value));
const sidebarObjectSourceFormatDialect = computed(() => sqlFormatDialectForDbType(sidebarObjectSourceDatabaseType.value));
type SearchScope = "connection" | "database" | "schema" | "table" | "view";
const selectedSearchScopes = ref<SearchScope[]>([]);
const searchCollapsedIds = ref<Set<string>>(new Set());
let searchTimer: number | undefined;
const remoteTableSearchDebouncer = createSidebarTableSearchDebouncer();
// Local-mode table searches debounce like remote ones: rapid typing coalesces
// into a single index load/build instead of one full build per keystroke.
const localTableSearchDebouncer = createSidebarTableSearchDebouncer();
const tableSearchFocusRestoreTokens = new Map<string, number>();
let tableSearchFocusRestoreTokenSeq = 0;
let latestTableSearchInteractionParentId: string | null = null;
let latestTableSearchInteractionId = 0;
let tableSearchInteractionIdSeq = 0;
let localTableSearchFocusPending = false;

type TableSearchSelection = {
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
};

type TableSearchFocusRestore = {
  interactionId: number;
  parentNodeId: string;
  shouldRestoreFocus: boolean;
  selection: TableSearchSelection | null;
};

watch(
  searchQuery,
  (value) => {
    const normalized = regexMode.value ? value.trim() : value.trim().toLowerCase();
    window.clearTimeout(searchTimer);

    if (!normalized) {
      deferredSearchQuery.value = "";
      return;
    }

    searchTimer = window.setTimeout(() => {
      deferredSearchQuery.value = normalized;
    }, 300);
  },
  { flush: "sync" },
);

watch(regexMode, (enabled) => {
  window.clearTimeout(searchTimer);
  searchTimer = undefined;
  // Re-evaluate immediately so a pending ordinary-search debounce cannot
  // overwrite a case-sensitive regular expression after the mode changes.
  deferredSearchQuery.value = enabled ? searchQuery.value.trim() : searchQuery.value.trim().toLowerCase();
});

watch(
  [showConnectedConnectionsOnly, () => store.connectedIds.size],
  ([showConnectedOnly, activeConnectionCount]) => {
    if (showConnectedOnly && activeConnectionCount === 0) showConnectedConnectionsOnly.value = false;
  },
  { flush: "sync" },
);

async function disconnectAllActiveConnections() {
  if (isDisconnectingAllActiveConnections.value) return;
  const connectionIds = [...store.connectedIds];
  if (!connectionIds.length) {
    showConnectedConnectionsOnly.value = false;
    return;
  }

  isDisconnectingAllActiveConnections.value = true;
  try {
    const result = await disconnectSidebarConnections(connectionIds, (connectionId) => store.disconnect(connectionId));
    if (!result.failed) {
      toast(t("connection.disconnectedSelected", { count: connectionIds.length }), 2000);
    } else if (result.succeeded > 0) {
      toast(t("connection.disconnectSelectedPartial", { succeeded: result.succeeded, failed: result.failed }), 5000);
    } else {
      const message = result.firstError instanceof Error ? result.firstError.message : String(result.firstError);
      toast(t("connection.saveFailed", { message }), 5000);
    }
  } finally {
    isDisconnectingAllActiveConnections.value = false;
    if (store.connectedIds.size === 0) showConnectedConnectionsOnly.value = false;
  }
}

watch(
  () => settingsStore.editorSettings.sidebarTableSearchEnabled,
  (enabled) => {
    if (enabled) return;
    const parentNodeIds = Object.keys(store.sidebarTableSearchQueries);
    if (parentNodeIds.length === 0) return;

    for (const parentNodeId of parentNodeIds) {
      remoteTableSearchDebouncer.cancel(parentNodeId);
      localTableSearchDebouncer.cancel(parentNodeId);
      tableSearchFocusRestoreTokens.delete(parentNodeId);
      store.setSidebarTableSearchQuery(parentNodeId, "");
    }
    latestTableSearchInteractionParentId = null;
    latestTableSearchInteractionId = 0;
    void Promise.all(parentNodeIds.map((parentNodeId) => store.refreshSidebarTableSearch(parentNodeId))).catch(() => {});
  },
);

const sidebarFilterGuards = computed(() => resolveSidebarFilterGuards(showConnectedConnectionsOnly.value, searchQuery.value, hasSearchScopeFilter.value));
// Connected-only filtering changes only root visibility, so descendant-local
// features stay available while operations requiring the full root list pause.
const isTreeSearchFiltering = computed(() => sidebarFilterGuards.value.isTreeSearchFiltering);
const isRootListPartial = computed(() => sidebarFilterGuards.value.isRootListPartial);

const SEARCH_SCOPE_TO_NODE_TYPES: Record<SearchScope, TreeNodeType[]> = {
  connection: ["connection"],
  database: ["database", "redis-db", "mq-tenant", "nacos-namespace", "consul-root", "mongo-db"],
  schema: ["schema"],
  table: ["table", "mongo-collection", "mongo-bucket", "dynamodb-table", "vector-collection", "elasticsearch-index"],
  view: ["view"],
};

// Sticky-row container types. When browsing a large number of children (e.g.
// hundreds of tables) under one of these and scrolling down, the row is kept
// pinned at the top so the active container stays identifiable and can be
// collapsed with one click.
//
// Database-level containers are always preferred. Schema is only a fallback,
// used when the upward path has NO database-level ancestor at all: Dameng /
// Oracle / oceanbase-oracle expose `connection -> schema -> tables` (no database
// node, via connectionUsesVisibleSchemaFilter). For Postgres/SQLServer, whose
// tree is `connection -> database -> schema -> tables`, the sticky walk prefers
// the database node, so schema never shadows it.
const DATABASE_LEVEL_TYPES = new Set<TreeNodeType>(SEARCH_SCOPE_TO_NODE_TYPES.database);
const SCHEMA_LEVEL_TYPES = new Set<TreeNodeType>(["schema"]);

const searchScopeOptions = computed(() => {
  return [
    { scope: "connection", label: t("sidebar.searchScopeConnection"), icon: Server },
    { scope: "database", label: t("sidebar.searchScopeDatabase"), icon: Database },
    { scope: "schema", label: t("sidebar.searchScopeSchema"), icon: FolderTree },
    { scope: "table", label: t("sidebar.searchScopeTable"), icon: Table2 },
    { scope: "view", label: t("sidebar.searchScopeView"), icon: Eye },
  ] as const satisfies ReadonlyArray<{ scope: SearchScope; label: string; icon: Component }>;
});
const connectionListSortMenuItems = computed(() => [
  { value: "manual", label: t("sidebar.sortConnectionsManual"), icon: ListOrdered },
  { value: "asc", label: t("sidebar.sortConnectionsAscending"), icon: ArrowDownAZ },
  { value: "desc", label: t("sidebar.sortConnectionsDescending"), icon: ArrowUpZA },
]);

const isConnectionListAlphabeticallySorted = computed(() => settingsStore.editorSettings.sidebarConnectionSortMode !== "manual");
const sidebarListOptionsLabel = computed(() => t("sidebar.listOptions"));
const sidebarListOptionItems = computed(() => [
  ...(["fuzzy", "contains"] as const).map((mode, index) => ({
    value: `match:${mode}`,
    label: t(mode === "fuzzy" ? "sidebar.searchMatchModeFuzzy" : "sidebar.searchMatchModeContains"),
    groupLabel: index === 0 ? t("sidebar.searchMatchMode") : undefined,
    tooltip: t("sidebar.searchMatchModeTooltip"),
    role: "menuitemradio" as const,
    disabled: regexMode.value,
  })),
  ...connectionListSortMenuItems.value.map((item, index) => ({
    ...item,
    value: `sort:${item.value}`,
    role: "menuitemradio" as const,
    separatorBefore: index === 0,
    groupLabel: index === 0 ? t("sidebar.sortConnections") : undefined,
  })),
  ...searchScopeOptions.value.map((item, index) => ({
    value: `scope:${item.scope}`,
    role: "menuitemcheckbox" as const,
    label: item.label,
    icon: item.icon,
    separatorBefore: index === 0,
    groupLabel: index === 0 ? t("sidebar.filterByType") : undefined,
  })),
  ...(hasSearchScopeFilter.value
    ? [
        {
          value: "clear-scopes",
          label: t("sidebar.clearFilter"),
          icon: RotateCcw,
          separatorBefore: true,
        },
      ]
    : []),
]);
const selectedSidebarListOptions = computed(() => [`match:${searchMatchMode.value}`, `sort:${settingsStore.editorSettings.sidebarConnectionSortMode}`, ...selectedSearchScopes.value.map((scope) => `scope:${scope}`)]);
const hasCustomSidebarListOptions = computed(() => isConnectionListAlphabeticallySorted.value || hasSearchScopeFilter.value);

function updateConnectionListSortMode(mode: string) {
  if (mode === "manual" || mode === "asc" || mode === "desc") {
    settingsStore.updateEditorSettings({ sidebarConnectionSortMode: mode });
  }
}

const hasSearchScopeFilter = computed(() => selectedSearchScopes.value.length > 0);
const searchableNodeTypes = computed<Set<TreeNodeType> | undefined>(() => {
  if (!hasSearchScopeFilter.value) return undefined;
  const types = new Set<TreeNodeType>();
  for (const scope of selectedSearchScopes.value) {
    for (const nodeType of SEARCH_SCOPE_TO_NODE_TYPES[scope]) {
      types.add(nodeType);
    }
  }
  return types;
});

function toggleSearchScope(scope: SearchScope) {
  const idx = selectedSearchScopes.value.indexOf(scope);
  if (idx >= 0) {
    selectedSearchScopes.value.splice(idx, 1);
  } else {
    selectedSearchScopes.value.push(scope);
  }
}

function selectSidebarListOption(value: string) {
  if (value === "match:fuzzy" || value === "match:contains") {
    if (!regexMode.value) settingsStore.updateEditorSettings({ sidebarSearchMatchMode: value === "match:contains" ? "contains" : "fuzzy" });
    return;
  }
  if (value.startsWith("sort:")) {
    updateConnectionListSortMode(value.slice("sort:".length));
    return;
  }
  if (value.startsWith("scope:")) {
    toggleSearchScope(value.slice("scope:".length) as SearchScope);
    return;
  }
  if (value === "clear-scopes") clearSearchScopeFilter();
}

function clearSearchScopeFilter() {
  selectedSearchScopes.value = [];
}

function scheduleSidebarTableSearchRefresh(parentNodeId: string, options?: { focusRestore?: TableSearchFocusRestore }) {
  if (isTreeSearchFiltering.value) {
    remoteTableSearchDebouncer.cancel(parentNodeId);
    localTableSearchDebouncer.cancel(parentNodeId);
    return;
  }
  const restoreToken = options?.focusRestore?.shouldRestoreFocus ? ++tableSearchFocusRestoreTokenSeq : 0;
  if (restoreToken) {
    tableSearchFocusRestoreTokens.clear();
    tableSearchFocusRestoreTokens.set(parentNodeId, restoreToken);
  }
  scheduleExclusiveSidebarTableSearchDebounce(parentNodeId, remoteTableSearchDebouncer, localTableSearchDebouncer, () => {
    void store.refreshSidebarTableSearch(parentNodeId).then(() => {
      if (!restoreToken) return;
      if (tableSearchFocusRestoreTokens.get(parentNodeId) !== restoreToken) return;
      tableSearchFocusRestoreTokens.delete(parentNodeId);
      const focusRestore = options?.focusRestore;
      if (!focusRestore || !isCurrentTableSearchInteraction(focusRestore)) return;
      restoreTableSearchInput(focusRestore);
    });
  });
}

function captureTableSearchFocus(parentNodeId: string): TableSearchFocusRestore {
  const interactionId = ++tableSearchInteractionIdSeq;
  const active = document.activeElement;
  const isActiveSearchInput = active instanceof HTMLInputElement && active.dataset.sidebarTableSearchParentId === parentNodeId;

  return {
    interactionId,
    parentNodeId,
    shouldRestoreFocus: isActiveSearchInput,
    selection: isActiveSearchInput
      ? {
          start: active.selectionStart ?? active.value.length,
          end: active.selectionEnd ?? active.value.length,
          direction: active.selectionDirection ?? "none",
        }
      : null,
  };
}

function isCurrentTableSearchInteraction(focusRestore: TableSearchFocusRestore): boolean {
  return latestTableSearchInteractionParentId === focusRestore.parentNodeId && latestTableSearchInteractionId === focusRestore.interactionId;
}

function restoreTableSearchInput(focusRestore: TableSearchFocusRestore) {
  void nextTick(async () => {
    if (!isCurrentTableSearchInteraction(focusRestore) || !focusRestore.shouldRestoreFocus) return;
    const root = rootRef.value;
    if (!root) return;
    const active = document.activeElement;
    if (active !== document.body && !(active instanceof HTMLInputElement && active.dataset.sidebarTableSearchParentId === focusRestore.parentNodeId)) return;

    // Filtering can move the old scroll position into another database/schema.
    // Reveal the edited scope before looking for its input: the original row
    // may not even be mounted in the virtual renderer at the old position.
    const pinnedSearchIsVisible = stickyTableSearchNode.value?.node.tableSearchParentId === focusRestore.parentNodeId && !stickyHeaderStyle.value.transform;
    const searchIndex = flatNodes.value.findIndex(({ node }) => isSidebarTableSearchControlNode(node) && node.tableSearchParentId === focusRestore.parentNodeId);
    if (searchIndex < 0) return;
    const scroller = currentTreeScroller();
    if (!pinnedSearchIsVisible && scroller) {
      scroller.scrollTop = scrollTopForSidebarNode({
        index: searchIndex,
        currentScrollTop: scroller.scrollTop,
        viewportHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
        rowHeight: sidebarTreeRowHeight.value,
        topOcclusionHeight: sidebarTreeRowHeight.value,
        align: "nearest",
      });
      updateSidebarScrollMetrics();
      if (useVirtualTree.value) treeScrollerRef.value?.updateVisibleItems(true);
      await nextTick();
      if (!isCurrentTableSearchInteraction(focusRestore)) return;
    }
    // Prefer the pinned copy when both the original row and overlay exist.
    const inputs = Array.from(root.querySelectorAll<HTMLInputElement>("[data-sidebar-table-search-parent-id]")).filter((item) => item.dataset.sidebarTableSearchParentId === focusRestore.parentNodeId);
    const input = inputs.find((item) => item.closest(".sticky-database-header")) ?? inputs[0];
    if (!input) return;

    // Keep the browser's current selection when the tree update preserved the
    // input element. Only restore focus and selection if the async update
    // actually displaced focus or recreated the input.
    if (document.activeElement === input) return;
    if (document.activeElement !== document.body) return;

    input.focus({ preventScroll: true });
    const selection = focusRestore.selection;
    if (!selection) {
      const end = input.value.length;
      input.setSelectionRange(end, end);
      return;
    }

    const valueLength = input.value.length;
    const start = Math.min(selection.start, valueLength);
    const end = Math.min(selection.end, valueLength);
    input.setSelectionRange(start, end, selection.direction);
  });
}

const userAdminVisibility = computed(() => sidebarUserAdminVisibility(store.treeNodes, store.getConfig));
const displayedTreeNodes = computed(() => sortConnectionListForDisplay(orderSidebarConnectionUtilitiesForDisplay(userAdminVisibility.value.nodes), settingsStore.editorSettings.sidebarConnectionSortMode));
const localTableSearchResults = ref<Record<string, TableInfo[] | null>>({});
const localTableSearchRequestRevisions = new Map<string, number>();
type InvalidatedTableSearchScope = SidebarRegexScopeIdentity & { parentNodeId: string };
const pendingInvalidatedTableSearchScopes = new Map<string, InvalidatedTableSearchScope>();
function globalSearchConnectionRoots() {
  return [...store.connectedIds].flatMap((connectionId) => {
    const path = findNodePathByIdentity(store.treeNodes, connectionId, { connectionId, database: "", nodeType: "connection" });
    const root = path?.[path.length - 1];
    return root ? [{ connectionId, root }] : [];
  });
}

const globalSearchContext = [
  () => regexMode.value,
  () => settingsStore.editorSettings.sidebarGlobalSearchLocal,
  () => settingsStore.editorSettings.sidebarObjectDisplay,
  () => settingsStore.editorSettings.sidebarSearchOpenedDatabasesOnly,
  () => [...store.connectedIds].sort().join("\0"),
  () => [...queryStore.openDatabaseKeys].sort().join("\0"),
  () => {
    if (!settingsStore.editorSettings.sidebarSearchOpenedDatabasesOnly) return "";
    // Tree-only opens do not change editor tab keys. Observe scope membership,
    // not descendant metadata or expansion flags, to avoid restarting builds.
    return JSON.stringify(
      globalSearchConnectionRoots().map(({ connectionId, root }) => {
        const scope = resolveSidebarSearchDatabaseScope(root, { enabled: true, isChildrenLoaded: store.isTreeNodeChildrenLoaded, openDatabaseKeys: queryStore.openDatabaseKeys });
        return [connectionId, [...(scope ?? [])].sort()];
      }),
    );
  },
  () => store.sidebarTableSearchIndexInvalidation.revision,
  () => selectedSearchScopes.value.join(","),
];
const { scopes: globalTableSearchScopes, isLoading: isGlobalIndexLoading } = useSidebarSearchIndexes({
  query: deferredSearchQuery,
  context: globalSearchContext,
  load: loadGlobalTableSearchIndexes,
  onError: (error) => toast(error instanceof Error ? error.message : String(error), 5000),
});
const {
  results: remoteSearchResults,
  isLoading: isRemoteSearchLoading,
  removeVerifiedTriggerNode: removeVerifiedRemoteTriggerNode,
} = useSidebarRemoteSearch({
  query: searchQuery,
  enabled: computed(() => !regexMode.value && !settingsStore.editorSettings.sidebarGlobalSearchLocal && !searchableNodeTypes.value),
  context: [...globalSearchContext, () => store.sidebarObjectSearchRevision],
  load: loadGlobalRemoteSearchResults,
  onError: (error) => toast(error instanceof Error ? error.message : String(error), 5000),
});
const isSidebarSearchLoading = computed(() => isGlobalIndexLoading.value || isRemoteSearchLoading.value);

async function loadGlobalRemoteSearchResults(query: string, signal: AbortSignal, onProgress: (results: SidebarRemoteSearchResult[]) => void) {
  const results: SidebarRemoteSearchResult[][] = [];
  await runSidebarSearchTasks(
    globalSearchConnectionRoots().map(({ connectionId, root }, index) => async () => {
      if (signal.aborted || !store.connectedIds.has(connectionId)) return;
      results[index] = await collectSidebarRemoteSearchResults({
        root,
        connectionId,
        databaseScope: resolveSidebarSearchDatabaseScope(root, { enabled: settingsStore.editorSettings.sidebarSearchOpenedDatabasesOnly, isChildrenLoaded: store.isTreeNodeChildrenLoaded, openDatabaseKeys: queryStore.openDatabaseKeys }),
        signal,
        isSimpleParent: (node) => !sidebarIndexedObjectGroupTypes.has(node.type) && isGlobalTableIndexParent(node),
        discover: discoverGlobalSearchChildren,
        search: (node, publish) => store.searchSidebarObjects(node, query, signal, publish),
        onProgress,
        onError: (error) => toast(error instanceof Error ? error.message : String(error), 5000),
      });
    }),
  );
  return results.flat();
}

function isGlobalTableIndexParent(node: TreeNode): boolean {
  if (sidebarIndexedObjectGroupTypes.has(node.type)) return true;
  if (settingsStore.editorSettings.sidebarObjectDisplay !== "simple") return false;
  if (node.type === "schema" || node.type === "linked-server-schema") return true;
  if (node.type !== "database") return false;
  const config = store.getConfig(node.connectionId || "");
  return config?.db_type !== "sqlserver" && !(usesTreeSchemaMode(effectiveDatabaseTypeForConnection(config)) && !connectionUsesDatabaseObjectTreeMode(config)) && !connectionShouldDiscoverJdbcSchemas(config);
}

async function discoverGlobalSearchChildren(node: TreeNode): Promise<readonly TreeNode[]> {
  if (node.children?.some((child) => sidebarIndexedObjectGroupTypes.has(child.type) || child.type === "database" || child.type === "schema" || child.type === "doris-catalog")) return node.children;
  if (!node.connectionId || !store.connectedIds.has(node.connectionId) || store.isTreeNodeChildrenLoaded(node.id)) return node.children ?? [];
  const wasExpanded = node.isExpanded;
  try {
    if (node.type === "connection") {
      await store.loadConnectedConnectionRootForSidebarSearch(node.connectionId, { sidebarSearch: true });
    } else {
      await store.loadTreeNodeChildren(node, { searchFilter: "", allowGlobalSearchMismatch: true, expectedSidebarSearchQuery: "", sidebarSearch: true });
    }
    return node.children ?? [];
  } finally {
    node.isExpanded = wasExpanded;
  }
}

async function loadGlobalTableSearchIndexes(shouldCancel: () => boolean, onProgress: (scopes: SidebarRegexIndexScope[]) => void): Promise<SidebarRegexIndexScope[]> {
  if (searchableNodeTypes.value && !["table", "view", "materialized_view"].some((type) => searchableNodeTypes.value?.has(type as TreeNodeType))) return [];
  if (regexMode.value || settingsStore.editorSettings.sidebarGlobalSearchLocal) {
    return collectSidebarRegexIndexScopes(
      {
        loadSidebarTableSearchIndexScopes: () => store.loadSidebarTableSearchIndexScopes(),
        loadSidebarTableSearchIndex: (parent) => store.loadSidebarTableSearchIndex(parent.parentNodeId, parent),
      },
      store.treeNodes,
      shouldCancel,
    );
  }
  const results: SidebarRegexIndexScope[][] = [];
  await runSidebarSearchTasks(
    globalSearchConnectionRoots().map(({ connectionId, root }, index) => async () => {
      if (shouldCancel() || !store.connectedIds.has(connectionId)) return;
      const databaseScope = resolveSidebarSearchDatabaseScope(root, {
        enabled: settingsStore.editorSettings.sidebarSearchOpenedDatabasesOnly,
        isChildrenLoaded: store.isTreeNodeChildrenLoaded,
        openDatabaseKeys: queryStore.openDatabaseKeys,
      });
      try {
        results[index] = await collectSidebarGlobalSearchIndexes(
          {
            loadCachedScopes: async () =>
              (await store.loadSidebarTableSearchIndexScopes((scope) => scope.connectionId === connectionId && (settingsStore.editorSettings.sidebarObjectDisplay === "simple" ? !scope.nodeType.startsWith("group-") : sidebarIndexedObjectGroupTypes.has(scope.nodeType as TreeNodeType)))).map(
                ({ scope, entries, stale }) => ({ ...scope, entries, stale }),
              ),
            isIndexParent: isGlobalTableIndexParent,
            discover: discoverGlobalSearchChildren,
            loadIndex: (node, options) => {
              if (shouldCancel() || !store.connectedIds.has(connectionId)) return Promise.resolve(null);
              return store.ensureSidebarTableSearchIndex(node.id, deferredSearchQuery.value, { connectionId, database: node.database ?? "", schema: node.schema, catalog: node.catalog, nodeType: node.type }, { connectedOnly: true, refresh: options?.refresh });
            },
            onError: (_node, error) => toast(error instanceof Error ? error.message : String(error), 5000),
          },
          [root],
          connectionId,
          databaseScope,
          shouldCancel,
          (scopes) => {
            results[index] = scopes;
            onProgress(results.flat());
          },
        );
      } catch (error) {
        if (!shouldCancel()) toast(error instanceof Error ? error.message : String(error), 5000);
      }
    }),
  );
  return results.flat();
}

function filterGloballyIndexedTables(nodes: TreeNode[]): TreeNode[] {
  if (!deferredSearchQuery.value) return nodes;
  const matcher = createSidebarLabelMatcher(deferredSearchQuery.value, { regexMode: regexMode.value, matchMode: searchMatchMode.value });
  const matchingScopes = globalTableSearchScopes.value.map((scope) => ({ ...scope, entries: scope.entries.filter((entry) => !!matcher(entry.name) || !!matcher(entry.comment || "")) })).filter((scope) => scope.entries.length > 0);
  return mergeSidebarRegexIndexScopes(nodes, matchingScopes);
}

function scheduleLocalSidebarTableSearchRefresh(parentNodeId: string, focusRestore?: TableSearchFocusRestore) {
  if (isTreeSearchFiltering.value) {
    localTableSearchDebouncer.cancel(parentNodeId);
    remoteTableSearchDebouncer.cancel(parentNodeId);
    return;
  }
  scheduleExclusiveSidebarTableSearchDebounce(parentNodeId, localTableSearchDebouncer, remoteTableSearchDebouncer, () => {
    void loadLocalTableSearchResults(parentNodeId, false, focusRestore);
  });
}

function invalidatedTableSearchScopeKey(scope: InvalidatedTableSearchScope): string {
  return [scope.connectionId, scope.catalog ?? "", scope.database, scope.schema ?? "", scope.nodeType, scope.parentNodeId].join("\0");
}

async function loadLocalTableSearchResults(parentNodeId: string, refresh = false, focusRestore?: TableSearchFocusRestore, identity?: SidebarRegexScopeIdentity) {
  const requestRevision = (localTableSearchRequestRevisions.get(parentNodeId) ?? 0) + 1;
  localTableSearchRequestRevisions.set(parentNodeId, requestRevision);
  try {
    const query = store.sidebarTableSearchQueries[parentNodeId]?.trim() ?? "";
    const entries = await store.ensureSidebarTableSearchIndex(parentNodeId, query, identity, { refresh });
    if (localTableSearchRequestRevisions.get(parentNodeId) !== requestRevision) return;
    if (query || refresh) localTableSearchResults.value = { ...localTableSearchResults.value, [parentNodeId]: entries };
  } finally {
    if (focusRestore) restoreTableSearchInput(focusRestore);
  }
}

function refreshPendingInvalidatedTableSearchScopes() {
  for (const [scopeKey, scope] of pendingInvalidatedTableSearchScopes) {
    const query = store.sidebarTableSearchQueries[scope.parentNodeId]?.trim() ?? "";
    if (!settingsStore.editorSettings.sidebarTableSearchLocal || !query) {
      pendingInvalidatedTableSearchScopes.delete(scopeKey);
      continue;
    }
    if (!store.connectedIds.has(scope.connectionId)) continue;
    if (!findNodePathByIdentity(store.treeNodes, scope.parentNodeId, scope)) continue;
    pendingInvalidatedTableSearchScopes.delete(scopeKey);
    void loadLocalTableSearchResults(scope.parentNodeId, true, undefined, scope).catch((error) => {
      console.debug("[DBX][sidebar-table-search:index-rebuild-failed]", { scope, error });
    });
  }
}

watch(
  () => store.sidebarTableSearchIndexInvalidation,
  (invalidation) => {
    if (!invalidation.scopes.length) return;
    const nextResults = { ...localTableSearchResults.value };
    for (const scope of invalidation.scopes) {
      delete nextResults[scope.parentNodeId];
      localTableSearchDebouncer.cancel(scope.parentNodeId);
      pendingInvalidatedTableSearchScopes.set(invalidatedTableSearchScopeKey(scope), scope);
    }
    localTableSearchResults.value = nextResults;
    refreshPendingInvalidatedTableSearchScopes();
  },
);

const filteredNodes = computed(() => {
  let nodes = displayedTreeNodes.value;
  if (showConnectedConnectionsOnly.value) {
    nodes = filterSidebarTreeToConnectedConnections(nodes, store.connectedIds);
  }

  nodes = filterLocallySearchedTables(nodes, { enabled: settingsStore.editorSettings.sidebarTableSearchLocal, queries: store.sidebarTableSearchQueries, indexedResults: localTableSearchResults.value });
  nodes = filterGloballyIndexedTables(nodes);
  nodes = mergeSidebarRemoteSearchResults(nodes, remoteSearchResults.value);

  const q = deferredSearchQuery.value;
  nodes = filterSidebarTree(nodes, q, searchCollapsedIds.value, searchableNodeTypes.value, {
    regexMode: regexMode.value,
    matchMode: searchMatchMode.value,
    resolveLabel: (node) => (node.type === "nacos-access-control" ? t("nacos.accessControlSidebarLabel") : node.label),
  });
  if (q && !regexMode.value) {
    nodes = filterSidebarSearchRootsByConnectionState(nodes, store.connectedIds);
  }

  return nodes;
});

const projectedConnectionIds = computed<ReadonlySet<string> | null>(() => {
  if (!isRootListPartial.value && !deferredSearchQuery.value) return null;
  const connectionIds = new Set<string>();
  const visit = (nodes: readonly TreeNode[]) => {
    for (const node of nodes) {
      if (node.type === "connection" && node.connectionId) connectionIds.add(node.connectionId);
      if (node.children?.length) visit(node.children);
    }
  };
  visit(filteredNodes.value);
  return connectionIds;
});

const flatNodes = computed<FlatTreeNode[]>(() =>
  insertSidebarTableSearchControls(flattenTree(filteredNodes.value), {
    enabled: settingsStore.editorSettings.sidebarTableSearchEnabled && !isTreeSearchFiltering.value,
    sidebarObjectDisplay: settingsStore.editorSettings.sidebarObjectDisplay,
    activeQueries: store.sidebarTableSearchQueries,
  }),
);

// Debug instrumentation for the "expanded tree leaves the scroll shell stuck
// (e.g. Dameng connection expanded and the viewport froze near half height)"
// class of layout bugs. Feeds the layout monitor with expand events and
// tree-size changes so its anomaly reports can describe the transition.
function readExpandedSidebarConnections(): SidebarExpandedConnectionInfo[] {
  const expanded: SidebarExpandedConnectionInfo[] = [];
  for (const node of filteredNodes.value) {
    if (node.type !== "connection" && node.type !== "connection-group") continue;
    if (!node.isExpanded) continue;
    let descendantCount = 0;
    const stack = [...(node.children ?? [])];
    while (stack.length > 0) {
      const child = stack.pop() as TreeNode;
      descendantCount += 1;
      if (child.children) stack.push(...child.children);
    }
    expanded.push({ id: node.id, label: node.label, type: node.type, descendantCount });
  }
  return expanded;
}

// Which schema nodes are expanded right now — lets the layout monitor tell a
// user-initiated expand (an expand-toggle event precedes it) from a
// programmatic one (the schema shows up here without one).
function readExpandedSidebarSchemas(): Array<{ id: string; label: string }> {
  const expanded: Array<{ id: string; label: string }> = [];
  for (const connection of filteredNodes.value) {
    if (connection.type !== "connection" && connection.type !== "connection-group") continue;
    const stack = [...(connection.children ?? [])];
    while (stack.length > 0) {
      const child = stack.pop() as TreeNode;
      if (child.type === "schema" && child.isExpanded) expanded.push({ id: child.id, label: child.label });
      if (child.children) stack.push(...child.children);
    }
  }
  return expanded;
}

const sidebarLayoutMonitor = createSidebarLayoutMonitor({
  readContext: () => ({
    flatNodeCount: flatNodes.value.length,
    useVirtualTree: useVirtualTree.value,
    virtualItemSize: sidebarTreeRowHeight.value,
    scrollerEl: currentTreeScroller(),
    shellEl: treeScrollShellRef.value,
    rootEl: rootRef.value ?? null,
    virtualScroller: (treeScrollerRef.value as unknown as Record<string, unknown> | null) ?? null,
    expandedConnections: readExpandedSidebarConnections(),
  }),
});

watch(flatNodes, refreshPendingInvalidatedTableSearchScopes, { flush: "post" });

const sidebarCommentLabelWidths = shallowRef(new Map<string, number>());
let sidebarCommentMeasureFrame = 0;
const sidebarTreeContentWidth = ref(0);
let sidebarTreeContentMeasureFrame = 0;
const sidebarTableNameDisplayTypes = new Set<TreeNodeType>(["table", "view", "materialized_view", "mongo-collection", "dynamodb-table", "vector-collection", "elasticsearch-index"]);
const sidebarStorageDisplayTypes = new Set<TreeNodeType>(["database", "table", "materialized_view"]);

function sidebarCommentLabel(node: TreeNode): string {
  const label = sidebarTableNameDisplayTypes.has(node.type) ? sidebarDisplayTableName(node.label, settingsStore.editorSettings.sidebarHiddenTablePrefixes) : sidebarTreeDisplayLabel(node, t, node.connectionId ? effectiveDatabaseTypeForConnection(store.getConfig(node.connectionId)) : undefined);
  return node.valid === false ? `${label} · INVALID` : label;
}

// Shared by the aligned comment column and the full horizontal content width.
// Pin controls are reserved separately so unpinned siblings stay aligned too.
const sidebarTreeLeadingWidthItems = computed(() =>
  flatNodes.value.map(({ id, depth, node }) => {
    const config = node.connectionId ? store.getConfig(node.connectionId) : undefined;
    const badges: string[] = [];
    if (node.type === "column" && node.meta) badges.push(t((node.meta as ColumnInfo).is_nullable ? "structureEditor.nullable" : "structureEditor.notNull"));
    if (["database", "redis-db", "mongo-db"].includes(node.type) && node.connectionId && typeof node.database === "string" && store.isDefaultDatabase(node.connectionId, node.database)) badges.push(t("editor.defaultDatabase"));
    if (node.type === "schema" && node.connectionId && node.schema && store.isDefaultSchema(node.connectionId, node.schema)) badges.push(t("editor.defaultSchema"));
    if (showSidebarRowProductionBadge(node, config) && isSidebarProductionContainer(node)) badges.push("PROD");
    const secondary = sidebarTreeSecondaryValue(node, t, config ? effectiveDatabaseTypeForConnection(config) : undefined);
    const leadingExtraWidth = (secondary && node.type === "elasticsearch-index" ? 16 : 0) + (node.type === "oracle-db-links" ? 26 : 0);
    return { id, depth, node, label: sidebarCommentLabel(node), badges, secondary, leadingExtraWidth };
  }),
);

function measureSidebarTreeLeadingWidth(item: (typeof sidebarTreeLeadingWidthItems.value)[number], context: CanvasRenderingContext2D): number {
  return context.measureText(item.label).width + item.leadingExtraWidth + item.badges.reduce((width, badge) => width + context.measureText(badge).width + 24, 0) + (item.secondary ? context.measureText(item.secondary).width + 8 : 0);
}

function measureSidebarCommentLabelWidths() {
  sidebarCommentMeasureFrame = 0;
  if (settingsStore.editorSettings.sidebarObjectInfoMode !== "comment-aligned" || typeof document === "undefined" || !rootRef.value) {
    sidebarCommentLabelWidths.value = new Map();
    return;
  }

  const context = document.createElement("canvas").getContext("2d");
  if (!context) return;
  const style = window.getComputedStyle(rootRef.value);
  context.font = `${style.fontWeight} 10px ${style.fontFamily}`;
  const badgePaddingAndGapWidth = 16;
  const nullableBadgeWidth = context.measureText(t("structureEditor.nullable")).width + badgePaddingAndGapWidth;
  const notNullBadgeWidth = context.measureText(t("structureEditor.notNull")).width + badgePaddingAndGapWidth;
  context.font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  sidebarCommentLabelWidths.value = alignedSidebarCommentLabelWidths(
    sidebarTreeLeadingWidthItems.value.map((item) => ({
      id: item.id,
      depth: item.depth,
      alignable: isSidebarCommentAlignableNode(item.node),
      hasComment: !!sidebarTreeNodeComment(item.node, settingsStore.editorSettings.sidebarShowConnectionNotes),
      labelWidth: settingsStore.editorSettings.sidebarAllowHorizontalScroll
        ? measureSidebarTreeLeadingWidth(item, context)
        : context.measureText(item.label).width + (item.node.type === "column" && item.node.meta ? ((item.node.meta as ColumnInfo).is_nullable ? nullableBadgeWidth : notNullBadgeWidth) : 0),
    })),
  );
}

function scheduleSidebarCommentLabelMeasure() {
  if (typeof window === "undefined") {
    measureSidebarCommentLabelWidths();
    return;
  }
  if (sidebarCommentMeasureFrame) window.cancelAnimationFrame(sidebarCommentMeasureFrame);
  sidebarCommentMeasureFrame = window.requestAnimationFrame(measureSidebarCommentLabelWidths);
}

// Describe every expanded row, including those outside the virtual viewport.
// Keep text measurement independent of mounted TreeItems so scrolling cannot
// change the horizontal range or truncate a newly materialized row.
const sidebarTreeNaturalWidthItems = computed(() =>
  sidebarTreeLeadingWidthItems.value.map((item) => {
    const { depth, node } = item;
    const mode = settingsStore.editorSettings.sidebarObjectInfoMode;
    const comment = mode.startsWith("comment-") ? (sidebarTreeNodeComment(node, settingsStore.editorSettings.sidebarShowConnectionNotes) ?? undefined) : undefined;
    const config = node.connectionId ? store.getConfig(node.connectionId) : undefined;
    const badges = [...item.badges];
    const leadingExtraWidth = item.leadingExtraWidth + (node.pinned || store.isTreeNodePinned(node) ? sidebarPinnedActionSlotWidthPx : 0);
    let trailingWidth = showSidebarRowProductionBadge(node, config) && !isSidebarProductionContainer(node) ? 24 : 0;
    // Reserve status/control slots regardless of transient connected/loading
    // state, avoiding horizontal jumps when a connection changes status.
    if (node.type === "database") trailingWidth += 14;
    if (node.type === "connection") {
      trailingWidth += 38;
      if (config?.read_only) badges.push(t("connection.readOnlyBadge"));
    }
    return {
      ...item,
      depth,
      usesNaturalWidth: usesFullWidthTreeLabel(node.type, settingsStore.editorSettings.sidebarAllowHorizontalScroll),
      comment,
      rightAlignedComment: mode === "comment-right",
      trailingText: (mode === "size" || mode === "comment-and-size") && sidebarStorageDisplayTypes.has(node.type) ? formatSidebarObjectStorage(node.sizeBytes) : undefined,
      trailingWidth,
      leadingExtraWidth,
      badges,
      alignedWidth: comment && mode === "comment-aligned" && node.type !== "connection" ? (sidebarCommentLabelWidths.value.get(node.id) ?? 0) + (canTreeNodePin(node.type) ? sidebarPinnedActionSlotWidthPx : 0) : 0,
    };
  }),
);

function measureSidebarTreeContentWidth() {
  sidebarTreeContentMeasureFrame = 0;
  if (!settingsStore.editorSettings.sidebarAllowHorizontalScroll || typeof document === "undefined" || !rootRef.value) {
    sidebarTreeContentWidth.value = 0;
    return;
  }

  const context = document.createElement("canvas").getContext("2d");
  if (!context) return;
  const style = window.getComputedStyle(rootRef.value);
  context.font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  sidebarTreeContentWidth.value = sidebarTreeNaturalContentWidth(
    sidebarTreeNaturalWidthItems.value.map((item) => ({
      ...item,
      leadingWidth: Math.max(item.alignedWidth, measureSidebarTreeLeadingWidth(item, context)),
    })),
    (text) => context.measureText(text).width,
    settingsStore.editorSettings.sidebarIndent,
  );
  syncStickyRowHorizontalPosition();
  void nextTick(scheduleSidebarScrollMetricsUpdate);
}

function scheduleSidebarTreeContentWidthMeasure() {
  if (typeof window === "undefined") {
    measureSidebarTreeContentWidth();
    return;
  }
  if (sidebarTreeContentMeasureFrame) window.cancelAnimationFrame(sidebarTreeContentMeasureFrame);
  sidebarTreeContentMeasureFrame = window.requestAnimationFrame(measureSidebarTreeContentWidth);
}

watch(
  [
    sidebarTreeLeadingWidthItems,
    locale,
    () => settingsStore.editorSettings.sidebarAllowHorizontalScroll,
    () => settingsStore.editorSettings.sidebarObjectInfoMode,
    () => settingsStore.editorSettings.sidebarShowConnectionNotes,
    () => settingsStore.editorSettings.sidebarHiddenTablePrefixes,
    () => settingsStore.editorSettings.uiFontFamily,
    () => settingsStore.editorSettings.uiScale,
    () => settingsStore.editorSettings.sidebarFontSize,
  ],
  scheduleSidebarCommentLabelMeasure,
  {
    flush: "post",
    immediate: true,
  },
);

watch(
  [sidebarTreeNaturalWidthItems, () => settingsStore.editorSettings.uiFontFamily, () => settingsStore.editorSettings.uiScale, () => settingsStore.editorSettings.sidebarIndent, () => settingsStore.editorSettings.sidebarFontSize, () => settingsStore.editorSettings.sidebarDensity],
  scheduleSidebarTreeContentWidthMeasure,
  {
    flush: "post",
    immediate: true,
  },
);

const visibleSidebarTableStorageScopes = computed(() => {
  if (settingsStore.editorSettings.sidebarObjectInfoMode !== "size" && settingsStore.editorSettings.sidebarObjectInfoMode !== "comment-and-size") return [];
  return sidebarTableStorageScopes(flatNodes.value.map(({ node }) => node)).filter((scope) => supportsSidebarTableStorage(store.getConfig(scope.connectionId)));
});

watch(
  visibleSidebarTableStorageScopes,
  (scopes) => {
    for (const scope of scopes) void store.loadSidebarTableStorage(scope);
  },
  { flush: "post", immediate: true },
);
// Build all lookup tables in one linear pass whenever the visible tree changes.
// Selection, scrolling and sticky headers then avoid repeated full-array scans.
const flatTreeIndex = computed(() =>
  createFlatTreeIndex(flatNodes.value, {
    isSelectable: (node) => !isSidebarTableSearchControlNode(node),
    isBoundary: (type) => type === "connection" || type === "connection-group",
    isDatabaseContainer: (type) => DATABASE_LEVEL_TYPES.has(type),
    isSchemaContainer: (type) => SCHEMA_LEVEL_TYPES.has(type),
  }),
);
const visibleNodes = computed<TreeNode[]>(() => flatTreeIndex.value.visibleNodes);
const selectableVisibleNodes = computed<TreeNode[]>(() => flatTreeIndex.value.selectableVisibleNodes);
const selectableVisibleNodeIndexById = computed(() => flatTreeIndex.value.selectableVisibleNodeIndexById);
// Virtualization with hysteresis: switching between the plain and virtual
// renderers remounts the tree (scroll reset), so once virtualized stay virtual
// until the tree drops well below the threshold — otherwise search/filter
// oscillation around the boundary would thrash between the two branches.
const treeVirtualizationArmed = ref(false);
watch(
  () => flatNodes.value.length,
  (count) => {
    if (treeVirtualizationArmed.value) {
      if (count < SIDEBAR_TREE_VIRTUALIZE_THRESHOLD - SIDEBAR_TREE_VIRTUALIZE_HYSTERESIS) {
        treeVirtualizationArmed.value = false;
      }
    } else if (shouldVirtualizeFlatTree(count)) {
      treeVirtualizationArmed.value = true;
    }
  },
  { immediate: true },
);
const useVirtualTree = computed(() => treeVirtualizationArmed.value);

// The plain and virtual branches mount separate scroller elements; keep the
// scroll position when the renderer flips so crossing the threshold does not
// jump the user back to the top.
watch(useVirtualTree, (virtual, wasVirtual) => {
  const previous = (wasVirtual ? treeScrollerRef.value?.$el : plainTreeScrollerRef.value) as HTMLElement | undefined;
  const savedScrollTop = previous?.scrollTop ?? 0;
  if (!savedScrollTop) return;
  void nextTick(() => {
    const next = (virtual ? treeScrollerRef.value?.$el : plainTreeScrollerRef.value) as HTMLElement | undefined;
    if (next) next.scrollTop = savedScrollTop;
  });
});
const activeTab = computed(() => queryStore.tabs.find((tab) => tab.id === queryStore.activeTabId));
const hasTreeMultiSelection = computed(() => store.connectionMultiSelectActive || store.selectedTreeNodeIds.length > 1);

watch(
  () => [userAdminVisibility.value.hiddenNodeIds, store.selectedTreeNodeId, store.treeSelectionAnchorId, [...store.selectedTreeNodeIds]] as const,
  ([hiddenNodeIds]) => {
    if (!hiddenNodeIds.size) return;
    const next = pruneTreeSelectionToVisibleNodeIds(
      { has: (id) => !hiddenNodeIds.has(id) },
      {
        nodeIds: store.selectedTreeNodeIds,
        activeNodeId: store.selectedTreeNodeId,
        anchorNodeId: store.treeSelectionAnchorId,
      },
    );
    if (next.nodeIds.length !== store.selectedTreeNodeIds.length) store.selectedTreeNodeIds = [...next.nodeIds];
    if (next.activeNodeId !== store.selectedTreeNodeId) store.selectedTreeNodeId = next.activeNodeId;
    if (next.anchorNodeId !== store.treeSelectionAnchorId) store.treeSelectionAnchorId = next.anchorNodeId;
    if (!next.nodeIds.length) store.connectionMultiSelectActive = false;
  },
  { flush: "post", immediate: true },
);

watch(
  () => (hasTreeMultiSelection.value ? flatTreeIndex.value.nodeById : null),
  (visibleNodeIds) => {
    if (!visibleNodeIds) return;
    const next = pruneTreeSelectionToVisibleNodeIds(visibleNodeIds, {
      nodeIds: store.selectedTreeNodeIds,
      activeNodeId: store.selectedTreeNodeId,
      anchorNodeId: store.treeSelectionAnchorId,
    });
    const selectionChanged = next.nodeIds.length !== store.selectedTreeNodeIds.length || next.nodeIds.some((id, index) => id !== store.selectedTreeNodeIds[index]);
    if (!selectionChanged && next.activeNodeId === store.selectedTreeNodeId && next.anchorNodeId === store.treeSelectionAnchorId) return;
    store.selectedTreeNodeIds = [...next.nodeIds];
    store.selectedTreeNodeId = next.activeNodeId;
    store.treeSelectionAnchorId = next.anchorNodeId;
    if (!next.nodeIds.length) store.connectionMultiSelectActive = false;
  },
  { flush: "post" },
);

// --- Sticky database header ---
// Both renderers use the same overlay instead of CSS `position: sticky` on
// individual rows. A shared overlay can be pushed out by the next connection
// boundary, while native sticky rows would cover that non-sticky connection.
const stickyScrollTop = ref(0);
const plainStickyContainerIndex = ref(-1);
const sidebarScrollMetrics = ref({ scrollTop: 0, scrollLeft: 0, clientHeight: 0, clientWidth: 0, scrollHeight: 0, scrollWidth: 0 });
const stickyRowRef = ref<HTMLElement | null>(null);
const isScrollingSidebar = ref(false);
const isDraggingSidebarScrollbar = ref(false);
const isDraggingSidebarHorizontalScrollbar = ref(false);
let sidebarScrollbarResizeObserver: ResizeObserver | null = null;
let sidebarScrollbarAnimationFrame = 0;
let sidebarScrollbarDragOffset = 0;
let sidebarHorizontalScrollbarDragOffset = 0;
let sidebarScrollingTimer = 0;

function updateSidebarScrollMetrics() {
  const scroller = currentTreeScroller();
  if (!scroller) {
    sidebarScrollMetrics.value = { scrollTop: 0, scrollLeft: 0, clientHeight: 0, clientWidth: 0, scrollHeight: 0, scrollWidth: 0 };
    syncStickyRowHorizontalPosition(null);
    return;
  }

  stickyScrollTop.value = scroller.scrollTop;
  if (useVirtualTree.value || isTreeSearchFiltering.value) {
    plainStickyContainerIndex.value = -1;
  } else {
    const scrollerTop = scroller.getBoundingClientRect().top + scroller.clientTop;
    const rows = Array.from(scroller.querySelectorAll<HTMLElement>("[data-node-id]")).map((row) => ({ nodeId: row.dataset.nodeId ?? "", top: row.getBoundingClientRect().top }));
    plainStickyContainerIndex.value = resolvePlainStickyContainerIndex(flatNodes.value, flatTreeIndex.value, rows, scrollerTop);
  }
  sidebarScrollMetrics.value = {
    scrollTop: scroller.scrollTop,
    scrollLeft: scroller.scrollLeft,
    clientHeight: scroller.clientHeight,
    clientWidth: scroller.clientWidth,
    scrollHeight: scroller.scrollHeight,
    scrollWidth: scroller.scrollWidth,
  };
  syncStickyRowHorizontalPosition(scroller);
}

function scheduleSidebarScrollMetricsUpdate() {
  window.cancelAnimationFrame(sidebarScrollbarAnimationFrame);
  sidebarScrollbarAnimationFrame = window.requestAnimationFrame(updateSidebarScrollMetrics);
}

function onTreeScroll() {
  isScrollingSidebar.value = true;
  window.clearTimeout(sidebarScrollingTimer);
  sidebarScrollingTimer = window.setTimeout(() => {
    isScrollingSidebar.value = false;
  }, 700);
  syncStickyRowHorizontalPosition();
  scheduleSidebarScrollMetricsUpdate();
}

function onTreeWheel(event: WheelEvent) {
  const scroller = currentTreeScroller();
  if (!scroller || !settingsStore.editorSettings.sidebarAllowHorizontalScroll || !event.shiftKey) return;
  if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true]")) return;
  const delta = sidebarHorizontalWheelDelta({
    enabled: true,
    shiftKey: event.shiftKey,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaMode: event.deltaMode,
    lineHeight: sidebarTreeRowHeight.value,
    scrollLeft: scroller.scrollLeft,
    clientWidth: scroller.clientWidth,
    scrollWidth: scroller.scrollWidth,
  });
  if (delta === 0) return;
  const previous = scroller.scrollLeft;
  scroller.scrollLeft += delta;
  if (scroller.scrollLeft === previous) return;
  syncStickyRowHorizontalPosition(scroller);
  event.preventDefault();
  scheduleSidebarScrollMetricsUpdate();
}

// RecycleScroller only emits scrollStart/scrollEnd, not continuous scroll, so
// attach a native passive listener on its root element once it mounts.
watch(
  treeScrollerRef,
  (scroller, _old, onCleanup) => {
    const el = (scroller?.$el as HTMLElement | undefined) ?? null;
    if (!el) return;
    el.addEventListener("scroll", onTreeScroll, { passive: true });
    onCleanup(() => el.removeEventListener("scroll", onTreeScroll));
  },
  { flush: "post" },
);

watch(
  [treeScrollerRef, plainTreeScrollerRef, useVirtualTree],
  (_value, _oldValue, onCleanup) => {
    sidebarScrollbarResizeObserver?.disconnect();
    sidebarScrollbarResizeObserver = null;

    const scroller = currentTreeScroller();
    if (!scroller) return;

    sidebarScrollbarResizeObserver = new ResizeObserver(scheduleSidebarScrollMetricsUpdate);
    sidebarScrollbarResizeObserver.observe(scroller);
    const content = scroller.querySelector<HTMLElement>(".connection-tree-content");
    if (content) sidebarScrollbarResizeObserver.observe(content);
    scheduleSidebarScrollMetricsUpdate();

    onCleanup(() => {
      sidebarScrollbarResizeObserver?.disconnect();
      sidebarScrollbarResizeObserver = null;
    });
  },
  { flush: "post" },
);

const stickyContainerIndex = computed(() => {
  if (isTreeSearchFiltering.value) return -1;
  if (!useVirtualTree.value) return plainStickyContainerIndex.value;
  const nodes = flatNodes.value;
  const len = nodes.length;
  if (len === 0) return -1;

  const topIndex = Math.min(Math.floor(stickyScrollTop.value / sidebarTreeRowHeight.value), len - 1);
  const containerIndex = flatTreeIndex.value.stickyContainerIndexByIndex[topIndex] ?? -1;
  if (containerIndex < 0) return -1;
  return stickyScrollTop.value > containerIndex * sidebarTreeRowHeight.value ? containerIndex : -1;
});

const stickyNode = computed<FlatTreeNode | null>(() => flatNodes.value[stickyContainerIndex.value] ?? null);

// Search controls belong to their parent subtree, including schema and table
// group scopes. Build the lookup once per tree change, not on every scroll.
type StickyTableSearchScope = { item: FlatTreeNode; endIndex: number };
function buildTableSearchScopeIndex(nodes: readonly FlatTreeNode[]): (StickyTableSearchScope | undefined)[] {
  const stack: { depth: number; scope: StickyTableSearchScope }[] = [];
  const byIndex: (StickyTableSearchScope | undefined)[] = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const item = nodes[index];
    while (stack.length && item.depth <= stack[stack.length - 1].depth) {
      stack.pop()!.scope.endIndex = index;
    }
    if (isSidebarTableSearchControlNode(item.node)) {
      const scope = { item, endIndex: nodes.length };
      stack.push({ depth: item.depth - 1, scope });
    }
    byIndex.push(stack[stack.length - 1]?.scope);
  }
  return byIndex;
}
const tableSearchScopeByIndex = computed(() => buildTableSearchScopeIndex(flatNodes.value));

const stickyTableSearchScope = computed(() => {
  const containerIndex = stickyContainerIndex.value;
  if (containerIndex < 0) return null;
  // The search row pins as it reaches the bottom of the database header.
  const topIndex = Math.min(Math.floor(stickyScrollTop.value / sidebarTreeRowHeight.value), flatNodes.value.length - 1);
  const nextNode = flatNodes.value[topIndex + 1];
  const index = nextNode && isSidebarTableSearchControlNode(nextNode.node) ? topIndex + 1 : topIndex;
  const scope = tableSearchScopeByIndex.value[index];
  if (!scope || flatTreeIndex.value.stickyContainerIndexByIndex[index] !== containerIndex) return null;
  // A sibling group/schema ends the search scope, not the database header.
  // Remove only the search row before it would cover that sibling. Database
  // and connection boundaries still push the complete overlay out below.
  const scopeEndsInSameContainer = flatTreeIndex.value.stickyContainerIndexByIndex[scope.endIndex] === containerIndex;
  if (scopeEndsInSameContainer && scope.endIndex * sidebarTreeRowHeight.value - stickyScrollTop.value <= 2 * sidebarTreeRowHeight.value) return null;
  return scope;
});
const stickyTableSearchNode = computed(() => stickyTableSearchScope.value?.item ?? null);

function syncStickyRowHorizontalPosition(scroller = currentTreeScroller()) {
  const row = stickyRowRef.value;
  if (!row) return;

  if (!settingsStore.editorSettings.sidebarAllowHorizontalScroll || !scroller) {
    row.style.removeProperty("width");
    row.style.removeProperty("transform");
    return;
  }

  row.style.width = `${Math.max(scroller.clientWidth, sidebarTreeContentWidth.value)}px`;
  row.style.transform = `translate3d(${-scroller.scrollLeft}px, 0, 0)`;
}

watch(
  [stickyNode, useVirtualTree, treeScrollerRef, plainTreeScrollerRef],
  () => {
    void nextTick(() => syncStickyRowHorizontalPosition());
  },
  { flush: "post", immediate: true },
);
const stickyHeaderHeight = computed(() => sidebarTreeRowHeight.value * (stickyTableSearchNode.value ? 2 : 1));

const stickyHeaderStyle = computed<CSSProperties>(() => {
  const currentIndex = stickyContainerIndex.value;
  if (currentIndex < 0) return {};
  const node = flatNodes.value[currentIndex];
  if (!node) return {};
  const nextContainerIndex = SCHEMA_LEVEL_TYPES.has(node.type) ? flatTreeIndex.value.nextSchemaContainerIndexByIndex[currentIndex] : flatTreeIndex.value.nextDatabaseContainerIndexByIndex[currentIndex];
  const nextBoundaryIndex = flatTreeIndex.value.nextBoundaryIndexByIndex[currentIndex] ?? -1;
  const nextCollisionIndex = nextContainerIndex < 0 ? nextBoundaryIndex : nextBoundaryIndex < 0 ? nextContainerIndex : Math.min(nextContainerIndex, nextBoundaryIndex);
  if (nextCollisionIndex < 0) return {};
  let distanceToNext = nextCollisionIndex * sidebarTreeRowHeight.value - stickyScrollTop.value;
  if (!useVirtualTree.value) {
    const scroller = plainTreeScrollerRef.value;
    const nextNodeId = flatNodes.value[nextCollisionIndex]?.id;
    const nextRow = nextNodeId ? Array.from(scroller?.querySelectorAll<HTMLElement>("[data-node-id]") ?? []).find((row) => row.dataset.nodeId === nextNodeId) : undefined;
    if (scroller && nextRow) distanceToNext = nextRow.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }
  if (distanceToNext >= stickyHeaderHeight.value) return {};
  return {
    transform: `translateY(${Math.min(0, distanceToNext - stickyHeaderHeight.value)}px)`,
  };
});

// Keep the badge outside the translated header so production-to-production
// handovers do not cover or remount it. Both tree renderers share this context.
const stickyProductionContext = computed(() => {
  const node = stickyNode.value?.node;
  return showSidebarStickyProductionBadge(node, node?.connectionId ? store.getConfig(node.connectionId) : undefined);
});

// Clamp tracking when the tree rebuilds, preserving the search input in the
// overlay when its results change instead of unmounting it on each keystroke.
watch(flatNodes, (nodes, previousNodes) => {
  // The diagnostic events walk the whole expanded tree; only do that work when
  // the layout monitor is actually armed (dev default, disabled in production).
  if (sidebarLayoutMonitor.isEnabled()) {
    const previousCount = previousNodes?.length ?? 0;
    if (nodes.length !== previousCount) {
      const previousIds = new Set((previousNodes ?? []).map((entry) => entry.id));
      const added = nodes
        .filter((entry) => !previousIds.has(entry.id))
        .slice(0, 5)
        .map((entry) => ({ type: entry.node.type, label: entry.node.label }));
      sidebarLayoutMonitor.recordEvent({
        type: "tree-change",
        prevCount: previousCount,
        count: nodes.length,
        expandedConnections: readExpandedSidebarConnections(),
        added,
        expandedSchemas: readExpandedSidebarSchemas(),
      });
    }
  }
  const contextMenuTarget = sidebarContextMenuTarget.value;
  if (contextMenuTarget) {
    const visibleContextMenuTarget = nodes.find(({ node }) => matchesSidebarActionTarget(node, contextMenuTarget))?.node;
    if (!visibleContextMenuTarget || visibleContextMenuTarget.valid === false) {
      sidebarContextMenuRef.value?.close();
      sidebarContextMenuItems.value = [];
      sidebarContextMenuTarget.value = null;
    }
  }
  stickyScrollTop.value = Math.min(stickyScrollTop.value, Math.max(0, nodes.length * sidebarTreeRowHeight.value - sidebarScrollMetrics.value.clientHeight));
  void nextTick(scheduleSidebarScrollMetricsUpdate);
  // After a structural change (list grew/shrunk, e.g. a Dameng connection
  // expands or collapses) or a same-length search projection replacement,
  // reconcile the virtual scroller with the browser's scroll position. The
  // recycle pool is rebuilt from the live scrollTop, but scrollTop is only
  // clamped on the next layout, so right after a shrink the pool can still
  // target a window beyond the new content — the viewport then lands inside
  // the end spacer and shows a blank region until the next scroll event.
  // Reading scrollHeight forces that layout (applying the clamp), then one
  // explicit pool refresh keeps the rendered window aligned.
  if (!flatTreeRowsChanged(nodes, previousNodes)) return;
  if (!useVirtualTree.value) return;
  void nextTick(() => {
    const scroller = treeScrollerRef.value;
    if (!scroller) return;
    const el = scroller.$el as HTMLElement | undefined;
    if (!el) return;
    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
    if (el.scrollTop > maxScrollTop) el.scrollTop = maxScrollTop;
    scroller.updateVisibleItems(true);
  });
});

const sidebarTreeOverflowClass = computed(() => (settingsStore.editorSettings.sidebarAllowHorizontalScroll ? "overflow-x-auto sidebar-tree-horizontal-scroll" : "overflow-x-hidden"));
const sidebarTreeScrollerStyle = computed<CSSProperties>(() => ({ "--sidebar-tree-content-width": `${sidebarTreeContentWidth.value}px` }) as CSSProperties);

const hasSidebarVerticalOverflow = computed(() => sidebarScrollMetrics.value.scrollHeight > sidebarScrollMetrics.value.clientHeight + 1);
const hasSidebarHorizontalOverflow = computed(() => settingsStore.editorSettings.sidebarAllowHorizontalScroll && sidebarScrollMetrics.value.scrollWidth > sidebarScrollMetrics.value.clientWidth + 1);

watch(
  () => settingsStore.editorSettings.sidebarAllowHorizontalScroll,
  (enabled) =>
    void nextTick(() => {
      const scroller = currentTreeScroller();
      if (!enabled && scroller) scroller.scrollLeft = 0;
      syncStickyRowHorizontalPosition(scroller);
      scheduleSidebarScrollMetricsUpdate();
    }),
  { flush: "post" },
);

function sidebarScrollbarGeometry() {
  const { scrollTop, clientHeight, scrollHeight } = sidebarScrollMetrics.value;
  const trackHeight = sidebarScrollbarTrackRef.value?.clientHeight ?? Math.max(0, clientHeight - 8);
  const { thumbOffset, thumbSize, maxThumbOffset, maxScrollOffset } = calculateSidebarScrollbarGeometry({
    scrollOffset: scrollTop,
    viewportSize: clientHeight,
    contentSize: scrollHeight,
    trackSize: trackHeight,
  });
  return { thumbTop: thumbOffset, thumbHeight: thumbSize, maxThumbTop: maxThumbOffset, maxScrollTop: maxScrollOffset };
}

const sidebarScrollbarThumbStyle = computed<CSSProperties>(() => {
  const { thumbTop, thumbHeight } = sidebarScrollbarGeometry();
  return {
    height: `${thumbHeight}px`,
    transform: `translateY(${thumbTop}px)`,
  };
});

function setSidebarScrollFromPointer(clientY: number, offset: number) {
  const scroller = currentTreeScroller();
  const track = sidebarScrollbarTrackRef.value;
  if (!scroller || !track) return;

  const rect = track.getBoundingClientRect();
  const { maxThumbTop, maxScrollTop } = sidebarScrollbarGeometry();
  if (maxThumbTop <= 0) return;

  const thumbTop = Math.min(maxThumbTop, Math.max(0, clientY - rect.top - offset));
  scroller.scrollTop = (thumbTop / maxThumbTop) * maxScrollTop;
  updateSidebarScrollMetrics();
}

function stopSidebarScrollbarDrag() {
  isDraggingSidebarScrollbar.value = false;
  window.removeEventListener("pointermove", onSidebarScrollbarPointerMove);
  window.removeEventListener("pointerup", stopSidebarScrollbarDrag);
  window.removeEventListener("pointercancel", stopSidebarScrollbarDrag);
}

function onSidebarScrollbarPointerMove(event: PointerEvent) {
  event.preventDefault();
  setSidebarScrollFromPointer(event.clientY, sidebarScrollbarDragOffset);
}

function onSidebarScrollbarTrackPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  const { thumbHeight } = sidebarScrollbarGeometry();
  sidebarScrollbarDragOffset = thumbHeight / 2;
  setSidebarScrollFromPointer(event.clientY, sidebarScrollbarDragOffset);
  isDraggingSidebarScrollbar.value = true;
  window.addEventListener("pointermove", onSidebarScrollbarPointerMove);
  window.addEventListener("pointerup", stopSidebarScrollbarDrag);
  window.addEventListener("pointercancel", stopSidebarScrollbarDrag);
}

function onSidebarScrollbarThumbPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  const track = sidebarScrollbarTrackRef.value;
  if (!track) return;

  const rect = track.getBoundingClientRect();
  const { thumbTop } = sidebarScrollbarGeometry();
  sidebarScrollbarDragOffset = event.clientY - rect.top - thumbTop;
  isDraggingSidebarScrollbar.value = true;
  window.addEventListener("pointermove", onSidebarScrollbarPointerMove);
  window.addEventListener("pointerup", stopSidebarScrollbarDrag);
  window.addEventListener("pointercancel", stopSidebarScrollbarDrag);
}

function sidebarHorizontalScrollbarGeometry() {
  const { scrollLeft, clientWidth, scrollWidth } = sidebarScrollMetrics.value;
  const trackWidth = sidebarHorizontalScrollbarTrackRef.value?.clientWidth ?? clientWidth;
  const { thumbOffset, thumbSize, maxThumbOffset, maxScrollOffset } = calculateSidebarScrollbarGeometry({
    scrollOffset: scrollLeft,
    viewportSize: clientWidth,
    contentSize: scrollWidth,
    trackSize: trackWidth,
  });
  return { thumbLeft: thumbOffset, thumbWidth: thumbSize, maxThumbLeft: maxThumbOffset, maxScrollLeft: maxScrollOffset };
}

const sidebarHorizontalScrollbarThumbStyle = computed<CSSProperties>(() => {
  const { thumbLeft, thumbWidth } = sidebarHorizontalScrollbarGeometry();
  return {
    width: `${thumbWidth}px`,
    transform: `translateX(${thumbLeft}px)`,
  };
});

function setSidebarHorizontalScrollFromPointer(clientX: number, offset: number) {
  const scroller = currentTreeScroller();
  const track = sidebarHorizontalScrollbarTrackRef.value;
  if (!scroller || !track) return;

  const rect = track.getBoundingClientRect();
  const { maxThumbLeft, maxScrollLeft } = sidebarHorizontalScrollbarGeometry();
  if (maxThumbLeft <= 0) return;

  const thumbLeft = Math.min(maxThumbLeft, Math.max(0, clientX - rect.left - offset));
  scroller.scrollLeft = (thumbLeft / maxThumbLeft) * maxScrollLeft;
  syncStickyRowHorizontalPosition(scroller);
  updateSidebarScrollMetrics();
}

function stopSidebarHorizontalScrollbarDrag() {
  isDraggingSidebarHorizontalScrollbar.value = false;
  window.removeEventListener("pointermove", onSidebarHorizontalScrollbarPointerMove);
  window.removeEventListener("pointerup", stopSidebarHorizontalScrollbarDrag);
  window.removeEventListener("pointercancel", stopSidebarHorizontalScrollbarDrag);
}

function onSidebarHorizontalScrollbarPointerMove(event: PointerEvent) {
  event.preventDefault();
  setSidebarHorizontalScrollFromPointer(event.clientX, sidebarHorizontalScrollbarDragOffset);
}

function onSidebarHorizontalScrollbarTrackPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  const { thumbWidth } = sidebarHorizontalScrollbarGeometry();
  sidebarHorizontalScrollbarDragOffset = thumbWidth / 2;
  setSidebarHorizontalScrollFromPointer(event.clientX, sidebarHorizontalScrollbarDragOffset);
  isDraggingSidebarHorizontalScrollbar.value = true;
  window.addEventListener("pointermove", onSidebarHorizontalScrollbarPointerMove);
  window.addEventListener("pointerup", stopSidebarHorizontalScrollbarDrag);
  window.addEventListener("pointercancel", stopSidebarHorizontalScrollbarDrag);
}

function onSidebarHorizontalScrollbarThumbPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  const track = sidebarHorizontalScrollbarTrackRef.value;
  if (!track) return;

  const rect = track.getBoundingClientRect();
  const { thumbLeft } = sidebarHorizontalScrollbarGeometry();
  sidebarHorizontalScrollbarDragOffset = event.clientX - rect.left - thumbLeft;
  isDraggingSidebarHorizontalScrollbar.value = true;
  window.addEventListener("pointermove", onSidebarHorizontalScrollbarPointerMove);
  window.addEventListener("pointerup", stopSidebarHorizontalScrollbarDrag);
  window.addEventListener("pointercancel", stopSidebarHorizontalScrollbarDrag);
}

const pasteHandlerRegistry = createSidebarPasteHandlerRegistry();

provide(sidebarTreeContextKey, {
  getVisibleNodes: () => selectableVisibleNodes.value,
  getVisibleNodeIndex: (id: string) => selectableVisibleNodeIndexById.value.get(id) ?? -1,
  getVisibleFlatNodes: () => flatNodes.value.filter((item) => !isSidebarTableSearchControlNode(item.node)),
  focusTreeNode: (nodeId: string) => {
    void focusSidebarTreeNode(nodeId);
  },
  getProjectedConnectionIds: () => projectedConnectionIds.value,
  // Cover both sides of the input debounce: the immediate query prevents a
  // collapse while a projection is about to start, and the deferred query
  // keeps the currently rendered projection alive while clearing settles.
  isSearchProjectionActive: () => isTreeSearchFiltering.value || !!deferredSearchQuery.value,
  removeVerifiedTriggerNode: removeVerifiedRemoteTriggerNode,
  getTreeLoadSearchOptions: () => {
    if (!deferredSearchQuery.value) return undefined;
    return { searchFilter: "", allowGlobalSearchMismatch: true, expectedSidebarSearchQuery: "" };
  },
  setTableSearchQuery: (parentNodeId, query, local) => {
    const focusRestore = captureTableSearchFocus(parentNodeId);
    latestTableSearchInteractionParentId = parentNodeId;
    latestTableSearchInteractionId = focusRestore.interactionId;
    store.setSidebarTableSearchQuery(parentNodeId, query);
    if (local) {
      localTableSearchFocusPending = true;
      void nextTick(() => {
        restoreTableSearchInput(focusRestore);
        localTableSearchFocusPending = false;
      });
      scheduleLocalSidebarTableSearchRefresh(parentNodeId, focusRestore);
    } else scheduleSidebarTableSearchRefresh(parentNodeId, { focusRestore });
  },
  refreshTableSearchIndex: (parentNodeId) => {
    // Re-fetch the live object list before rebuilding the local index. The
    // index refresh used to scan the database correctly, but the tree itself
    // still contained the old first page, so newly-created tables could not
    // be rendered even though they were present in the refreshed index.
    const findNode = (nodes: TreeNode[]): TreeNode | undefined => {
      for (const node of nodes) {
        if (node.id === parentNodeId) return node;
        const found = node.children ? findNode(node.children) : undefined;
        if (found) return found;
      }
      return undefined;
    };
    void (async () => {
      const parent = findNode(store.treeNodes);
      if (parent?.connectionId && parent.database && (parent.type === "database" || parent.type === "schema" || parent.type === "linked-server-schema" || sidebarSearchableObjectGroupTypes().has(parent.type))) {
        // Refresh only the searched object group. Refreshing the database/schema
        // node also reloads views, routines, triggers, etc., causing a visible
        // redraw of the whole sidebar for a single-group operation.
        if (sidebarSearchableObjectGroupTypes().has(parent.type)) {
          await store.loadObjectGroupChildren(parent, { force: true });
        } else if (localTableSearchParentTypes.has(parent.type)) {
          await store.loadTables(parent.connectionId, parent.database, parent.schema, { force: true });
        }
      }
      await loadLocalTableSearchResults(parentNodeId, true);
    })().catch((error) => {
      // Keep refresh failures inside the UI action boundary instead of
      // leaving an unhandled Promise rejection when metadata loading fails.
      toast(error instanceof Error ? error.message : String(error), 5000);
    });
  },
  registerPasteHandler: pasteHandlerRegistry.register,
});
provide(sidebarTreeRuntimeKey, sidebarTreeRuntime);

function bindSidebarTreeRuntimeHost(host: Element | ComponentPublicInstance | null) {
  const runtimeHost = host as SidebarTreeRuntimeHostInstance | null;
  sidebarTreeRuntimeHostRef.value = runtimeHost;
  sidebarTreeRuntime.bindHost(runtimeHost);
}

const pendingRenameNodeId = ref<string | null>(null);
const highlightedNodeId = ref<string | null>(null);
let highlightTimer: number | undefined;

// 等待虚拟列表渲染后再高亮。
function waitForSidebarRenderFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

// 重新触发定位高亮，支持连续定位同一节点。
async function flashSidebarNode(nodeId: string) {
  window.clearTimeout(highlightTimer);
  highlightedNodeId.value = null;
  await nextTick();
  await waitForSidebarRenderFrame();

  highlightedNodeId.value = nodeId;
  highlightTimer = window.setTimeout(() => {
    if (highlightedNodeId.value === nodeId) highlightedNodeId.value = null;
  }, 1800);
}

function topOcclusionHeightForSidebarNode(nodeId: string): number {
  const sticky = stickyNode.value;
  if (!sticky || sticky.id === nodeId) return 0;
  return stickyHeaderHeight.value;
}

/** Select and reveal a freshly created table group. */
async function focusCreatedTableVGroup(groupId: string) {
  store.selectedTreeNodeId = groupId;
  await scrollToSidebarNode(groupId);
}

async function scrollToSidebarNode(nodeId: string, options?: { align?: SidebarNodeScrollAlign }) {
  await nextTick();

  const index = flatTreeIndex.value.flatNodeIndexById.get(nodeId) ?? -1;
  const scroller = currentTreeScroller();
  if (!scroller || index < 0) return;

  const nextScrollTop = scrollTopForSidebarNode({
    index,
    currentScrollTop: scroller.scrollTop,
    viewportHeight: scroller.clientHeight,
    scrollHeight: scroller.scrollHeight,
    rowHeight: sidebarTreeRowHeight.value,
    topOcclusionHeight: topOcclusionHeightForSidebarNode(nodeId),
    ...(options?.align ? { align: options.align } : {}),
  });
  if (nextScrollTop !== scroller.scrollTop) {
    scroller.scrollTop = nextScrollTop;
  }
}

// Arrow-key navigation moves the selection first; only after the row re-renders
// as the tabbable one (tabindex follows selection) can focus follow it.
async function focusSidebarTreeNode(nodeId: string) {
  await nextTick();
  // Scroll before querying the row: the virtualized tree only keeps rows in
  // the materialized window in the DOM, so querying first would never find an
  // out-of-window row and focus would stall at the window edge. Scrolling is
  // index-driven (no DOM lookup) and a no-op when the row is already visible;
  // one render frame lets RecycleScroller materialize the target row.
  await scrollToSidebarNode(nodeId);
  const root = rootRef.value;
  if (!root) return;
  await waitForSidebarRenderFrame();
  const row = root.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`);
  if (!row) return;
  row.focus({ preventScroll: true });
}

function sidebarDialogOpen(): boolean {
  return sidebarDdlOpen.value || sidebarElasticsearchIndexMetadataOpen.value || sidebarObjectSourceOpen.value || sidebarProcedureOpen.value || sidebarVisibleDatabasesOpen.value || sidebarVisibleSchemasOpen.value || sidebarVisibleNacosNamespacesOpen.value || sidebarTableNameFilterOpen.value;
}

function restoreSidebarTreeFocusAfterDialog(nodeId: string | null | undefined) {
  if (!nodeId) return;
  void nextTick(() => {
    if (!sidebarDialogOpen()) void focusSidebarTreeNode(nodeId);
  });
}

async function focusSelectedNode() {
  const nodeId = store.selectedTreeNodeId;
  if (nodeId) await focusSidebarTreeNode(nodeId);
}

function clearSidebarSelection() {
  // Clicking the blank area of the tree clears the current selection. Row
  // clicks call event.stopPropagation(), so this only fires for blank clicks
  // (issue #681 — selection wasn't cleared in double-click activation mode).
  store.connectionMultiSelectActive = false;
  store.selectedTreeNodeId = null;
  store.selectedTreeNodeIds = [];
  store.treeSelectionAnchorId = null;
}

async function createNewGroup() {
  const groupId = store.createConnectionGroup(t("connectionGroup.newGroupDefault"));
  await startRenamingCreatedGroup(groupId);
}

async function startRenamingCreatedGroup(groupId: string) {
  pendingRenameNodeId.value = groupId;
  store.selectedTreeNodeId = groupId;
  if (isRootListPartial.value) {
    searchQuery.value = "";
    deferredSearchQuery.value = "";
    showConnectedConnectionsOnly.value = false;
    clearSearchScopeFilter();
  }

  await scrollToSidebarNode(groupId);
  store.selectedTreeNodeId = groupId;
}

async function startRenamingSavedSqlNode(nodeId: string) {
  pendingRenameNodeId.value = nodeId;
  store.selectedTreeNodeId = nodeId;
  store.selectedTreeNodeIds = [nodeId];
  await scrollToSidebarNode(nodeId);
  store.selectedTreeNodeId = nodeId;
}

async function startRenamingConnectionNode(connectionId: string) {
  pendingRenameNodeId.value = connectionId;
  store.selectedTreeNodeId = connectionId;
  store.selectedTreeNodeIds = [connectionId];
  await scrollToSidebarNode(connectionId);
  store.selectedTreeNodeId = connectionId;
}

function expandSidebarNodePath(nodePath: TreeNode[]): void {
  expandSidebarLocatePath(nodePath, store.canUseLoadedTreeNodeToggle);

  // 表分组行同样是投影出的合成节点（不登记已加载子节点，上面的守卫会跳过），
  // 折叠状态存在布局里，必须经布局 op 展开，否则下次投影又把它折叠回去。
  for (const node of nodePath) {
    if (node.type !== "table-vgroup" || !node.vgroupId) continue;
    const group = store.tableVGroupLayoutFor(node)?.groups.find((current) => current.id === node.vgroupId);
    if (group?.collapsed) store.toggleTableVGroupCollapsed(node, node.vgroupId);
  }

  // Connection groups never register loaded tree children, so the guard above
  // skips them and a collapsed group keeps the target out of the visible flat
  // tree. Reopen them through the layout op so the expansion is persisted and
  // survives the next layout rebuild; flipping isExpanded directly would be
  // reverted by that rebuild (issue #7387).
  const collapsedGroupIds = nodePath.filter((node) => node.type === "connection-group" && !node.isExpanded).map((node) => node.id);
  if (collapsedGroupIds.length > 0) {
    store.expandConnectionGroups(collapsedGroupIds);
  }
}

async function locateActiveTabInSidebar() {
  await locateTabInSidebar(activeTab.value, "smart");
}

async function locateTabInSidebar(tab: QueryTab | undefined | null, align: SidebarNodeScrollAlign = "center") {
  try {
    await locateTabInSidebarTarget(tab, align);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 5000);
  }
}

async function locateTabInSidebarTarget(tab: QueryTab | undefined | null, align: SidebarNodeScrollAlign) {
  if (!tab) return;

  const tabTarget = activeTabSidebarTarget(tab);
  const locatesSavedSql = tabTarget?.type === "saved-sql-file";
  const savedSqlFile = locatesSavedSql ? savedSqlStore.getFile(tabTarget.savedSqlId) : undefined;
  const connId = savedSqlFile?.connectionId ?? tab.connectionId;

  // Reconnect if the connection was disconnected (children are cleared on disconnect)
  if (connId && !store.connectedIds.has(connId)) {
    const config = store.getConfig(connId);
    if (!config) return;
    try {
      await store.connect(config);
    } catch {
      return;
    }
  }

  const config = connId ? store.getConfig(connId) : undefined;
  const cursorCandidate = locatesSavedSql ? null : queryCursorTableCandidate(tab, effectiveDatabaseTypeForConnection(config));
  const tabTableCandidate = locatesSavedSql || cursorCandidate ? null : tableLocateCandidateFromTarget(tabTarget, config);
  const locateTableCandidate = cursorCandidate ?? tabTableCandidate;
  const fallbackTarget = locatesSavedSql ? tabTarget : (queryContextTargetFromCandidate(tab, cursorCandidate) ?? tabTarget);
  let initialTarget = locateTableCandidate ? tableTargetFromCandidate(locateTableCandidate) : fallbackTarget;
  if (!initialTarget) return;
  if (initialTarget.type === "query-context" && connectionUsesConnectionRootSchemaMode(config)) {
    const schema = initialTarget.schema || initialTarget.database;
    initialTarget = { ...initialTarget, database: schema, schema };
  }

  // Ensure the tree is loaded deep enough to contain the preferred target.
  // Saved SQL rows live below their database's runtime Queries node. Loading
  // the database context first also makes explicit locate work after reconnect.
  const treeLoadTarget: ActiveTabSidebarTarget =
    locatesSavedSql && savedSqlFile?.connectionId && savedSqlFile.database
      ? {
          type: "query-context",
          connectionId: savedSqlFile.connectionId,
          catalog: savedSqlFile.catalog,
          database: savedSqlFile.database,
        }
      : initialTarget;
  await ensureTreeLoadedForTarget(treeLoadTarget, { requireDatabaseChildren: locatesSavedSql });

  // Clear any active search filter so the node is visible
  if (isRootListPartial.value) {
    searchQuery.value = "";
    deferredSearchQuery.value = "";
    showConnectedConnectionsOnly.value = false;
    clearSearchScopeFilter();
  }

  let target = resolveLoadedLocateTarget(initialTarget, locateTableCandidate);
  let nodePath = target ? findNodePathForTarget(target, store.treeNodes) : null;
  if (!nodePath && !locatesSavedSql) {
    // The first load may have served a stale schema cache whose async refresh
    // replaced the database node before its tables finished loading, so the
    // table isn't in the tree yet. Force a synchronous reload and retry once so
    // locate reaches the table, not just the database (issue #715).
    await ensureTreeLoadedForTarget(treeLoadTarget, { force: true });
    target = resolveLoadedLocateTarget(initialTarget, locateTableCandidate);
    nodePath = target ? findNodePathForTarget(target, store.treeNodes) : null;
  }

  if (!nodePath && locateTableCandidate) {
    await store.loadTableForLocate(locateTableCandidate);
    target = resolveLoadedLocateTarget(initialTarget, locateTableCandidate);
    nodePath = target ? findNodePathForTarget(target, store.treeNodes) : null;
  }

  if (!nodePath && cursorCandidate && fallbackTarget) {
    await ensureTreeLoadedForTarget(fallbackTarget);
    target = fallbackTarget;
    nodePath = findNodePathForTarget(fallbackTarget, store.treeNodes);
  }

  if (!nodePath) {
    toast(t("sidebar.locateTargetNotFound"), 5000);
    return;
  }

  expandSidebarNodePath(nodePath);

  await nextTick();

  const match = target ? findSidebarNodeForTarget(target, flatNodes.value) : null;
  if (!match) return;

  store.selectedTreeNodeId = match.id;
  store.selectedTreeNodeIds = [match.id];
  store.treeSelectionAnchorId = match.id;
  store.connectionMultiSelectActive = false;
  await nextTick();

  await scrollToSidebarNode(match.id, { align });
  await flashSidebarNode(match.id);
}

function tableTargetFromCandidate(candidate: QueryCursorTableCandidate): ActiveTabSidebarTarget {
  return {
    type: "table",
    connectionId: candidate.connectionId,
    database: candidate.database,
    catalog: candidate.catalog,
    schema: candidate.schema,
    tableName: candidate.tableName,
  };
}

function tableLocateCandidateFromTarget(target: ActiveTabSidebarTarget | null, config: ReturnType<typeof store.getConfig>): QueryCursorTableCandidate | null {
  if (target?.type === "hbase-table") return { connectionId: target.connectionId, database: target.namespace, tableName: target.tableName };
  if (target?.type !== "table") return null;
  const database = connectionUsesConnectionRootSchemaMode(config) && target.schema ? target.schema : target.database;
  return {
    connectionId: target.connectionId,
    database,
    catalog: target.catalog,
    schema: target.schema,
    tableName: target.tableName,
  };
}

function resolveLoadedLocateTarget(target: ActiveTabSidebarTarget, candidate: QueryCursorTableCandidate | null): ActiveTabSidebarTarget | null {
  if (!candidate) return target;
  return findLoadedTableTargetForCandidate(store.treeNodes, candidate);
}

async function ensureTreeLoadedForTarget(target: ActiveTabSidebarTarget, opts?: { force?: boolean; requireDatabaseChildren?: boolean }) {
  if (target.type === "saved-sql-file" || target.type === "etcd-root" || target.type === "etcd-dashboard" || target.type === "etcd-access-control" || target.type === "zookeeper-root" || target.type === "consul-root") return;
  const connId = target.connectionId;
  if (!connId) return;

  const config = store.getConfig(connId);
  if (!config) return;

  // When forcing, bypass the cached children check so we reload from the
  // source. A stale schema cache otherwise serves children and triggers an
  // async background refresh that can replace nodes mid-flight, leaving the
  // tree without the target table by the time we search for it (issue #715).
  const force = opts?.force ?? false;
  const loadOptions = force ? { force: true } : undefined;

  if (target.type === "connection") return;

  // Ensure databases are loaded under the connection
  const connNode = findSidebarConnectionNode(store.treeNodes, connId);
  if (connNode && (force || !connNode.children || connNode.children.length === 0)) {
    try {
      if (config.db_type === "redis") {
        await store.loadRedisDatabases(connId, { showAll: true });
      } else if (config.db_type === "mongodb") {
        await store.loadMongoDatabases(connId);
      } else if (config.db_type === "dynamodb") {
        await store.loadDynamoDbTables(connId);
      } else if (config.db_type === "elasticsearch" || config.db_type === "easysearch" || config.db_type === "meilisearch" || config.db_type === "solr" || config.db_type === "couchdb") {
        await store.loadElasticsearchIndices(connId);
      } else if (config.db_type === "milvus") {
        // Milvus collections belong below a database, even during a forced locate retry.
        await store.loadMilvusDatabases(connId);
      } else if (config.db_type === "qdrant" || config.db_type === "weaviate" || config.db_type === "chromadb") {
        await store.loadVectorCollections(connId);
      } else if (config.db_type === "mqtt") {
        await store.loadMqttTopics(connId);
      } else if (config.db_type === "mq") {
        await store.loadMqTenants(connId, loadOptions);
      } else if (config.db_type === "nacos") {
        await store.loadNacosNamespaces(connId, loadOptions);
      } else {
        await store.loadDatabases(connId, loadOptions);
      }
    } catch {
      return;
    }
  }

  if (config.db_type === "mq" || config.db_type === "nacos" || config.db_type === "consul") return;
  if (!("database" in target) || !target.database) return;

  if (target.type === "redis-db") {
    if (!findNodePathForTarget(target, store.treeNodes)) await store.loadRedisDatabases(connId, { showAll: true });
    return;
  }
  if (target.type === "mongo-collection" || target.type === "mongo-gridfs") {
    if (force || !findNodePathForTarget(target, store.treeNodes)) await store.loadMongoCollections(connId, target.database);
    return;
  }
  if (target.type === "vector-collection") {
    if (force || !findNodePathForTarget(target, store.treeNodes)) await store.loadVectorCollections(connId, target.database);
    return;
  }
  // Locating a database only needs its ancestors, not its entire object list.
  if (!opts?.requireDatabaseChildren && target.type === "query-context" && !target.schema && findNodePathForTarget(target, store.treeNodes)) return;

  const usesExactCatalogScope = target.type === "query-context" || target.type === "table";
  const targetCatalog = usesExactCatalogScope ? target.catalog : undefined;
  if (usesExactCatalogScope) {
    const catalogNode = findDorisCatalogNode(store.treeNodes, connId, targetCatalog);
    if (catalogNode && (force || !catalogNode.children || catalogNode.children.length === 0)) {
      try {
        await store.loadDorisCatalogDatabases(catalogNode, loadOptions);
      } catch {
        return;
      }
    }
  }

  // Find the database node
  const targetSchema = "schema" in target ? target.schema : undefined;
  const effectiveDbType = effectiveDatabaseTypeForConnection(config);
  if ((target.type === "table" || target.type === "query-context") && connectionUsesConnectionRootSchemaMode(config)) {
    const schemaName = targetSchema || target.database;
    if (!schemaName) return;
    const schemaNode = findSchemaNode(store.treeNodes, connId, schemaName, schemaName);
    if (!schemaNode) return;
    if (target.type === "query-context") return;
    if (force || !schemaNode.children || schemaNode.children.length === 0) {
      await store.loadTables(connId, schemaNode.database || schemaName, schemaNode.schema ?? schemaName, loadOptions);
    }
    await ensureTableObjectGroupsLoaded({ ...target, database: schemaNode.database || schemaName, schema: schemaNode.schema ?? schemaName }, loadOptions);
    return;
  }

  const dbNode = findDatabaseNode(store.treeNodes, connId, target.database, targetCatalog, usesExactCatalogScope);
  if (!dbNode) return;
  if (targetCatalog) {
    if (!opts?.requireDatabaseChildren && target.type === "query-context" && !target.schema) return;
    if (force || (opts?.requireDatabaseChildren ? !store.canUseLoadedTreeNodeToggle(dbNode) : !dbNode.children?.length)) await store.loadDorisCatalogTables(dbNode, loadOptions);
    if (target.type === "table") await ensureTableObjectGroupsLoaded(target, loadOptions);
    return;
  }
  // Runtime Queries children do not mean that the database metadata was loaded.
  const databaseChildrenLoaded = opts?.requireDatabaseChildren ? store.canUseLoadedTreeNodeToggle(dbNode) : !!dbNode.children && dbNode.children.length > 0;
  const usesSchemaTree = (usesTreeSchemaMode(effectiveDbType) && !connectionUsesDatabaseObjectTreeMode(config)) || connectionShouldDiscoverJdbcSchemas(config);
  const shouldLoadSchemaTables = target.type === "table" && !!targetSchema && usesSchemaTree;
  if (!force && databaseChildrenLoaded && !shouldLoadSchemaTables) return;

  // Load database contents
  try {
    if (config.db_type === "sqlserver") {
      if (force || !databaseChildrenLoaded) {
        await store.loadSqlServerDatabaseObjects(connId, target.database, loadOptions);
      }
      if (targetSchema) {
        const schemaNode = findSchemaNode(store.treeNodes, connId, target.database, targetSchema);
        if (schemaNode && (force || !schemaNode.children || schemaNode.children.length === 0)) {
          await store.loadTables(connId, target.database, targetSchema, loadOptions);
        }
      }
    } else if (usesSchemaTree) {
      if (force || !databaseChildrenLoaded) {
        await store.loadSchemas(connId, target.database, loadOptions);
      }
      // If we have a schema, also load tables under that schema
      if (targetSchema) {
        const schemaNode = findSchemaNode(store.treeNodes, connId, target.database, targetSchema);
        if (schemaNode && (force || !schemaNode.children || schemaNode.children.length === 0)) {
          await store.loadTables(connId, target.database, targetSchema, loadOptions);
        }
      }
    } else {
      await store.loadTables(connId, target.database, undefined, loadOptions);
    }

    if (target.type === "table") {
      await ensureTableObjectGroupsLoaded(target, loadOptions);
    }
  } catch {
    // Node just won't have children loaded
  }
}

async function ensureTableObjectGroupsLoaded(target: Extract<ActiveTabSidebarTarget, { type: "table" }>, options?: { force?: boolean }) {
  const groups = findTableObjectGroupNodes(store.treeNodes, target);
  for (const group of groups) {
    if (!options?.force && group.children && group.children.length > 0) continue;
    await store.loadObjectGroupChildren(group, options);
  }
}

function findTableObjectGroupNodes(nodes: TreeNode[], target: Extract<ActiveTabSidebarTarget, { type: "table" }>): TreeNode[] {
  const matches: TreeNode[] = [];
  for (const node of nodes) {
    if (
      (node.type === "group-tables" || node.type === "group-dolt-system-tables" || node.type === "group-views" || node.type === "group-materialized-views") &&
      node.connectionId === target.connectionId &&
      sameTreeName(node.database, target.database) &&
      (node.catalog || undefined) === (target.catalog || undefined) &&
      (!target.schema || sameTreeName(node.schema, target.schema))
    ) {
      matches.push(node);
    }
    if (node.children) {
      matches.push(...findTableObjectGroupNodes(node.children, target));
    }
  }
  return matches;
}

function sameTreeName(left: string | undefined, right: string | undefined): boolean {
  return (left || "").toLowerCase() === (right || "").toLowerCase();
}

function findDorisCatalogNode(nodes: TreeNode[], connId: string, catalog: string | undefined): TreeNode | null {
  for (const node of nodes) {
    if (node.type === "doris-catalog" && node.connectionId === connId) {
      const matches = catalog ? sameTreeName(node.catalog, catalog) : isInternalDorisCatalog(node.catalogType, node.catalog);
      if (matches) return node;
    }
    if (node.children) {
      const found = findDorisCatalogNode(node.children, connId, catalog);
      if (found) return found;
    }
  }
  return null;
}

function findDatabaseNode(nodes: TreeNode[], connId: string, database: string, catalog?: string, exactCatalog = false): TreeNode | null {
  for (const node of nodes) {
    const catalogMatches = !exactCatalog || (catalog ? sameTreeName(node.catalog, catalog) : !node.catalog);
    if (node.type === "database" && node.connectionId === connId && sameTreeName(node.database, database) && catalogMatches) {
      return node;
    }
    if (node.children) {
      const found = findDatabaseNode(node.children, connId, database, catalog, exactCatalog);
      if (found) return found;
    }
  }
  return null;
}

function findSchemaNode(nodes: TreeNode[], connId: string, database: string, schema: string): TreeNode | null {
  for (const node of nodes) {
    if (node.type === "schema" && node.connectionId === connId && sameTreeName(node.database, database) && sameTreeName(node.schema || node.label, schema)) {
      return node;
    }
    if (node.children) {
      const found = findSchemaNode(node.children, connId, database, schema);
      if (found) return found;
    }
  }
  return null;
}

function onSearchToggle(node: TreeNode) {
  if (!isTreeSearchFiltering.value || !node.children) return;
  const next = new Set(searchCollapsedIds.value);
  if (node.isExpanded) {
    next.add(node.id);
    const collectDescendants = (children: readonly TreeNode[]) => {
      for (const child of children) {
        next.add(child.id);
        if (child.children?.length) collectDescendants(child.children);
      }
    };
    collectDescendants(node.children);
  } else {
    next.delete(node.id);
  }
  searchCollapsedIds.value = next;
}

function onNodeToggled(node: TreeNode, expanded: boolean) {
  // Explicit cached toggles may act on a search copy; synchronize only the
  // expansion state, never replace the live subtree with projected children.
  syncSidebarTreeNodeExpansion(store.treeNodes, node, expanded);
  if (isTreeSearchFiltering.value) return;
  sidebarLayoutMonitor.recordEvent({
    type: "expand-toggle",
    nodeId: node.id,
    label: node.label,
    nodeType: node.type,
    expanded,
  });
}

let contextMenuRequest = 0;
function openSidebarContextMenu(event: MouseEvent, node: TreeNode, openContextMenu: (event: MouseEvent, itemsOverride?: ContextMenuItem[]) => void) {
  event.preventDefault();
  event.stopPropagation();
  const request = ++contextMenuRequest;
  const items = sidebarTreeRuntime.buildContextMenu(node);
  const resolved = sidebarTreeRuntime.resolveContextMenu(node, items);
  const show = (menuItems: ContextMenuItem[]) => {
    if (request !== contextMenuRequest) return;
    menuItems = presentMenu(menuItems, node.type);
    sidebarContextMenuTarget.value = createSidebarActionTarget(node);
    sidebarContextMenuItems.value = menuItems;
    // Pass the current row's resolved menu atomically, including async plugin items.
    openContextMenu(event, menuItems);
  };
  if (resolved instanceof Promise) {
    const cancelPending = () => {
      contextMenuRequest += 1;
    };
    document.addEventListener("pointerdown", cancelPending, { capture: true, once: true });
    void resolved
      .then(show)
      .catch(() => show(items))
      .finally(() => {
        document.removeEventListener("pointerdown", cancelPending, true);
      });
  } else show(resolved);
}

function updateSidebarTreeItemDialogController(controller: Record<string, any> | null) {
  sidebarTreeItemDialogController.value = controller;
}

async function openSidebarInstallExtension(node: TreeNode) {
  sidebarInstallExtensionTarget.value = createSidebarActionTarget(node);
  await nextTick();
  sidebarInstallExtensionDialogRef.value?.show();
}

async function openSidebarExtensionDetails(node: TreeNode) {
  sidebarExtensionDetailsTarget.value = createSidebarActionTarget(node);
  await nextTick();
  sidebarExtensionDetailsDialogRef.value?.show();
}

async function openSidebarEventTriggerDetails(node: TreeNode) {
  sidebarEventTriggerDetailsTarget.value = createSidebarActionTarget(node);
  await nextTick();
  sidebarEventTriggerDetailsDialogRef.value?.show();
  // 打开详情时静默拉取最新事件触发器数据，只更新当前节点的 meta 与对话框，
  // 不重建整个侧边栏列表（避免每次打开都强制刷新触发器列表）。
  if (!node.connectionId || !node.database) return;
  try {
    const triggers = await listEventTriggers(node.connectionId, node.database);
    const fresh = triggers.find((et) => et.name === node.label);
    if (fresh) {
      node.meta = fresh;
      sidebarEventTriggerDetailsTarget.value = createSidebarActionTarget({ ...node, meta: fresh });
    }
  } catch {
    // 拉取失败时保留首次打开的缓存值。
  }
}

function beginSidebarAction(): number {
  sidebarActionGeneration += 1;
  sidebarDdlOpen.value = false;
  sidebarElasticsearchIndexMetadataOpen.value = false;
  sidebarObjectSourceOpen.value = false;
  sidebarProcedureOpen.value = false;
  sidebarVisibleDatabasesOpen.value = false;
  sidebarVisibleSchemasOpen.value = false;
  sidebarVisibleNacosNamespacesOpen.value = false;
  sidebarTableNameFilterOpen.value = false;
  sidebarDdlTarget.value = null;
  sidebarElasticsearchIndexMetadataTarget.value = null;
  sidebarObjectSourceTarget.value = null;
  sidebarProcedureTarget.value = null;
  sidebarVisibleDatabasesTarget.value = null;
  sidebarVisibleSchemasTarget.value = null;
  sidebarVisibleNacosNamespacesTarget.value = null;
  sidebarTableNameFilterTarget.value = null;
  return sidebarActionGeneration;
}

function tableDdlObjectTypeForSidebarNode(type: TreeNodeType): ObjectSourceKind | undefined {
  if (type === "view") return "VIEW";
  if (type === "materialized_view") return "MATERIALIZED_VIEW";
  return undefined;
}

function openSidebarDdl(node: TreeNode) {
  if (!node.connectionId || !hasTreeNodeDatabaseContext(node)) return;
  beginSidebarAction();
  sidebarDdlTarget.value = createSidebarActionTarget(node);
  sidebarDdlOpen.value = true;
}

function openSidebarDdlForSelection(): boolean {
  const selectedNodeId = store.selectedTreeNodeId;
  const node = selectedNodeId ? flatTreeIndex.value.nodeById.get(selectedNodeId) : null;
  if (!node || !sidebarNodeSupportsDdlView(node)) return false;
  void sidebarTreeRuntimeHostRef.value?.openDdlForSelection?.(node, store.selectedTreeNodeIds);
  return true;
}

function openSidebarTableStructureForSelection(): boolean {
  const selectedNodeId = store.selectedTreeNodeId;
  const node = selectedNodeId ? flatTreeIndex.value.nodeById.get(selectedNodeId) : null;
  if (!node) return false;
  return sidebarTreeRuntimeHostRef.value?.openStructureEditorForSelection?.(node) ?? false;
}

function requestSelectedSidebarRefresh(): boolean {
  const selectedNodeId = store.selectedTreeNodeId;
  const node = selectedNodeId ? flatTreeIndex.value.nodeById.get(selectedNodeId) : null;
  if (node && sidebarTreeRuntimeHostRef.value?.refreshNode?.(node)) {
    return true;
  }
  void refreshAllSidebarTree();
  return true;
}

async function refreshAllSidebarTree() {
  try {
    await store.reloadFromDisk();
    await store.refreshAllTree();
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e) }), 5000);
  }
}

function openSidebarElasticsearchIndexMetadata(node: TreeNode, kind: ElasticsearchIndexMetadataKind) {
  if (!node.connectionId) return;
  beginSidebarAction();
  sidebarElasticsearchIndexMetadataTarget.value = { node: createSidebarActionTarget(node), kind };
  sidebarElasticsearchIndexMetadataOpen.value = true;
}

function openSidebarObjectSource(node: TreeNode, initialEditing: boolean, initialSection?: ObjectDetailsSection, createTrigger?: SidebarActionRequest<OracleTriggerSqlBinding>) {
  if (!node.connectionId || !hasTreeNodeDatabaseContext(node) || !objectSourceTargetForTreeNode(node)) return;
  // TYPE/TYPE_BODY only have a source implementation on Xugu; PostgreSQL-family
  // connections list user-defined types without a CREATE TYPE getter this cycle.
  if ((node.type === "type" || node.type === "type-body") && !supportsTypeObjectSource(store.getConfig(node.connectionId)?.db_type)) return;
  const target = createSidebarActionTarget(node);
  beginSidebarAction();
  // issue #9035：弹窗立即挂载。此前先 await ensureConnected 再开弹窗，这段时间
  // 界面上没有任何反馈；现在连接与取源都在弹窗自身的加载态之内完成。
  sidebarObjectSourceTarget.value = { node: target, initialEditing, initialSection, createTrigger };
  sidebarObjectSourceOpen.value = true;
}

function openSidebarSettings(initialTab: string) {
  emit("open-settings", initialTab);
}

function openSidebarProcedure(node: TreeNode) {
  if (node.type !== "procedure" || !node.connectionId || !hasTreeNodeDatabaseContext(node)) return;
  beginSidebarAction();
  sidebarProcedureTarget.value = createSidebarActionTarget(node);
  sidebarProcedureOpen.value = true;
}

function openSidebarData(node: TreeNode, requireSelection: boolean, openMode: "default" | "new-tab", runner: (node: TreeNode, request: SidebarDataOpenRequest) => Promise<void>) {
  const target = createSidebarActionTarget(node);
  runSidebarDataOpenImmediately(
    {
      connectionKey: target.connectionId || target.id,
      // Explicit new-tab opens are intentional independent work; ordinary
      // navigation keeps latest-request-wins behavior.
      supersede: openMode !== "new-tab",
    },
    (request) => {
      if (requireSelection && store.selectedTreeNodeId !== target.id) return;
      return runner(target, request);
    },
  );
}

function openSidebarVisibleDatabases(node: TreeNode) {
  if (node.type !== "connection" || !node.connectionId) return;
  beginSidebarAction();
  sidebarVisibleDatabasesTarget.value = createSidebarActionTarget(node);
  sidebarVisibleDatabasesOpen.value = true;
}

function openSidebarVisibleSchemas(node: TreeNode) {
  if ((node.type !== "connection" && node.type !== "database") || !node.connectionId) return;
  const database = node.type === "database" ? node.database : store.getConfig(node.connectionId)?.database;
  if (database == null) return;
  beginSidebarAction();
  sidebarVisibleSchemasTarget.value = createSidebarActionTarget({ ...node, database });
  sidebarVisibleSchemasOpen.value = true;
}

function openSidebarVisibleNacosNamespaces(node: TreeNode) {
  if (node.type !== "connection" || !node.connectionId || store.getConfig(node.connectionId)?.db_type !== "nacos") return;
  beginSidebarAction();
  sidebarVisibleNacosNamespacesTarget.value = createSidebarActionTarget(node);
  sidebarVisibleNacosNamespacesOpen.value = true;
}

function tableNameFilterScopeForNode(node: TreeNode): string | null {
  if (!node.connectionId || !hasTreeNodeDatabaseContext(node)) return null;
  return store.tableNameFilterScopeKey({
    connectionId: node.connectionId,
    database: node.database,
    schema: node.schema,
    nodeKind: node.type,
    catalog: node.catalog,
  });
}

function patternsFromDraft(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

function openSidebarTableNameFilters(node: TreeNode) {
  const scopeKey = tableNameFilterScopeForNode(node);
  if (!scopeKey) return;
  beginSidebarAction();
  sidebarTableNameFilterTarget.value = createSidebarActionTarget(node);
  const filter = store.sidebarTableNameFilters[scopeKey];
  tableNameFilterIncludeDraft.value = filter?.includePatterns.join("\n") ?? "";
  tableNameFilterExcludeDraft.value = filter?.excludePatterns.join("\n") ?? "";
  sidebarTableNameFilterOpen.value = true;
}

async function saveSidebarTableNameFilters() {
  const target = sidebarTableNameFilterTarget.value;
  if (!target) return;
  const scopeKey = tableNameFilterScopeForNode(target);
  if (!scopeKey) return;
  const filter: TableNameFilter = {
    includePatterns: patternsFromDraft(tableNameFilterIncludeDraft.value),
    excludePatterns: patternsFromDraft(tableNameFilterExcludeDraft.value),
  };
  const revision = store.setSidebarTableNameFilter(scopeKey, filter);
  sidebarTableNameFilterOpen.value = false;
  const currentTarget = findSidebarActionTarget(store.treeNodes, target);
  if (currentTarget) {
    try {
      await store.refreshTreeNodeForTableNameFilter(currentTarget, scopeKey, revision);
    } catch (error: any) {
      toast(error?.message || String(error), 5000);
    }
  }
}

function clearSidebarTableNameFilters() {
  tableNameFilterIncludeDraft.value = "";
  tableNameFilterExcludeDraft.value = "";
}

function openSidebarProcedureSql(sql: string) {
  const target = sidebarProcedureTarget.value;
  if (!target?.connectionId || !target.database || !sql) return;
  const tabId = queryStore.createTab(target.connectionId, target.database, `Execute - ${target.label}`, "query", target.schema, undefined, target.catalog);
  queryStore.updateSql(tabId, sql);
}

async function executeSidebarProcedureSql(sql: string) {
  const target = sidebarProcedureTarget.value;
  if (!target?.connectionId || !target.database || !sql) return;
  const tabId = queryStore.createTab(target.connectionId, target.database, `Execute - ${target.label}`, "query", target.schema, undefined, target.catalog);
  queryStore.updateSql(tabId, sql);
  await queryStore.executeTabSql(tabId, sql);
}

async function refreshSidebarActionTarget() {
  const target = sidebarObjectSourceTarget.value?.createTrigger?.target || sidebarObjectSourceTarget.value?.node || sidebarDdlTarget.value || sidebarInstallExtensionTarget.value;
  if (!target) return;
  const currentTarget = findSidebarActionTarget(store.treeNodes, target);
  if (!currentTarget) return;
  try {
    await store.refreshTreeNode(currentTarget);
  } catch (error: any) {
    toast(error?.message || String(error), 5000);
  }
}

watch(sidebarDdlOpen, (open) => {
  if (!open) sidebarDdlTarget.value = null;
});

watch(sidebarElasticsearchIndexMetadataOpen, (open) => {
  if (!open) sidebarElasticsearchIndexMetadataTarget.value = null;
});

watch(sidebarObjectSourceOpen, (open) => {
  if (!open) {
    const nodeId = sidebarObjectSourceTarget.value?.createTrigger?.target.id || sidebarObjectSourceTarget.value?.node.id;
    sidebarObjectSourceTarget.value = null;
    restoreSidebarTreeFocusAfterDialog(nodeId);
  }
});

watch(sidebarProcedureOpen, (open) => {
  if (!open) {
    const nodeId = sidebarProcedureTarget.value?.id;
    sidebarProcedureTarget.value = null;
    restoreSidebarTreeFocusAfterDialog(nodeId);
  }
});

watch(sidebarVisibleDatabasesOpen, (open) => {
  if (!open) {
    const nodeId = sidebarVisibleDatabasesTarget.value?.id;
    sidebarVisibleDatabasesTarget.value = null;
    restoreSidebarTreeFocusAfterDialog(nodeId);
  }
});

watch(sidebarVisibleSchemasOpen, (open) => {
  if (!open) {
    const nodeId = sidebarVisibleSchemasTarget.value?.id;
    sidebarVisibleSchemasTarget.value = null;
    restoreSidebarTreeFocusAfterDialog(nodeId);
  }
});

watch(sidebarVisibleNacosNamespacesOpen, (open) => {
  if (!open) {
    const nodeId = sidebarVisibleNacosNamespacesTarget.value?.id;
    sidebarVisibleNacosNamespacesTarget.value = null;
    restoreSidebarTreeFocusAfterDialog(nodeId);
  }
});

watch(sidebarTableNameFilterOpen, (open) => {
  if (!open) {
    const nodeId = sidebarTableNameFilterTarget.value?.id;
    sidebarTableNameFilterTarget.value = null;
    restoreSidebarTreeFocusAfterDialog(nodeId);
  }
});

function collapseAllTreeNodes() {
  store.collapseAllTreeNodes();
  // 与 onSearchToggle 一致：scope-only 过滤也要填充 searchCollapsedIds，
  // 否则 filteredNodes 会用空集合把所有分组重建成展开态，“全部折叠”空操作。
  if (isTreeSearchFiltering.value) {
    searchCollapsedIds.value = new Set(flatTreeIndex.value.expandableNodeIds);
  }
}

function currentTreeScroller(): HTMLElement | null {
  return ((useVirtualTree.value ? treeScrollerRef.value?.$el : plainTreeScrollerRef.value) as HTMLElement | undefined) ?? null;
}

async function selectActiveTabSidebarNode(options: { scroll: boolean }) {
  if (!settingsStore.editorSettings.autoSelectActiveSidebarNode) return;
  const tab = activeTab.value;
  if (!tab) return;

  let match = findSidebarNodeForActiveTab(tab, flatNodes.value);
  if (!match) {
    const target = activeTabSidebarTarget(tab);
    const nodePath = target ? findNodePathForTarget(target, store.treeNodes) : null;
    if (nodePath && nodePath.length > 0) {
      expandSidebarNodePath(nodePath);
      await nextTick();
      if (activeTab.value?.id !== tab.id) return;
      match = findSidebarNodeForActiveTab(tab, flatNodes.value);
    }
  }
  if (!match) return;
  if (activeTab.value?.id !== tab.id) return;

  if (store.connectionMultiSelectActive || store.selectedTreeNodeId !== match.id || store.treeSelectionAnchorId !== match.id || store.selectedTreeNodeIds.length !== 1 || store.selectedTreeNodeIds[0] !== match.id) {
    store.selectedTreeNodeId = match.id;
    store.selectedTreeNodeIds = [match.id];
    store.treeSelectionAnchorId = match.id;
    store.connectionMultiSelectActive = false;
  }
  if (!options.scroll) return;

  await nextTick();

  const index = flatTreeIndex.value.flatNodeIndexById.get(match.id) ?? -1;
  const scroller = currentTreeScroller();
  if (!scroller || index < 0) return;

  const nextScrollTop = scrollTopForSidebarNode({
    index,
    currentScrollTop: scroller.scrollTop,
    viewportHeight: scroller.clientHeight,
    scrollHeight: scroller.scrollHeight,
    rowHeight: sidebarTreeRowHeight.value,
    topOcclusionHeight: topOcclusionHeightForSidebarNode(match.id),
  });
  if (nextScrollTop !== scroller.scrollTop) {
    scroller.scrollTop = nextScrollTop;
  }
}

watch(
  [() => activeTab.value?.id ?? null, flatNodes, () => settingsStore.editorSettings.autoSelectActiveSidebarNode],
  ([activeTabId, _nodes, autoSelectEnabled], [previousActiveTabId, _previousNodes, previousAutoSelectEnabled]) => {
    void selectActiveTabSidebarNode({
      scroll: shouldScrollActiveSidebarSelection({
        activeTabId,
        previousActiveTabId,
        autoSelectEnabled,
        previousAutoSelectEnabled,
      }),
    });
  },
  { flush: "post" },
);

function focusSearch(target: Element | null = null): boolean {
  const tableSearchControl = target?.closest<HTMLElement>("[data-sidebar-table-search-control]");
  if (tableSearchControl) {
    const input = tableSearchControl.querySelector<HTMLInputElement>("[data-sidebar-table-search-parent-id]");
    if (input) {
      input.focus();
      input.select();
      return true;
    }
  }
  const input = searchInputRef.value;
  if (!input) return false;
  input.focus();
  input.select();
  return true;
}

function onSearchKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.isComposing && !event.defaultPrevented) {
    const node = firstSidebarSearchMatchDataNode(visibleNodes.value, hasActiveSidebarSearch(searchQuery.value, store.sidebarTableSearchQueries));
    if (node) {
      event.preventDefault();
      sidebarTreeRuntimeHostRef.value?.handleRowClick(node, 1);
    }
    return;
  }
  if (!isCancelSearchShortcut(event)) return;
  event.preventDefault();
  searchQuery.value = "";
}

function focusSearchAtEnd() {
  nextTick(() => {
    const input = searchInputRef.value;
    if (!input) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  if (localTableSearchFocusPending) return;
  if (sidebarShortcutTargetIsActive(event.target)) {
    if (sidebarShortcutTargetAllowsAppShortcut(event.target) && isEditConnectionShortcut(event)) {
      if (requestSelectedConnectionEdit()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (sidebarShortcutTargetAllowsAppShortcut(event.target) && isDisconnectConnectionShortcut(event)) {
      if (requestSelectedConnectionDisconnect()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (sidebarShortcutTargetAllowsAppShortcut(event.target) && isCopySidebarSelectionShortcut(event, settingsStore.editorSettings.shortcuts)) {
      if (copySelectedSidebarNames()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (sidebarShortcutTargetAllowsAppShortcut(event.target) && isPasteSidebarSelectionShortcut(event, settingsStore.editorSettings.shortcuts)) {
      if (requestSelectedSidebarPaste()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (sidebarShortcutTargetAllowsAppShortcut(event.target) && isViewTableDdlShortcut(event, settingsStore.editorSettings.shortcuts)) {
      if (openSidebarDdlForSelection()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (sidebarShortcutTargetAllowsAppShortcut(event.target) && isEditSidebarTableStructureShortcut(event, settingsStore.editorSettings.shortcuts)) {
      if (openSidebarTableStructureForSelection()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    if (sidebarShortcutTargetAllowsAppShortcut(event.target) && isRefreshDataShortcut(event, settingsStore.editorSettings.shortcuts)) {
      if (requestSelectedSidebarRefresh()) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
  }

  if (!pointerInsideTree.value || isEditableSidebarTypeSearchTarget(event.target) || isEditableSidebarTypeSearchTarget(document.activeElement)) return;
  if (isCancelSearchShortcut(event)) {
    if (!searchQuery.value) return;
    event.preventDefault();
    searchQuery.value = "";
    focusSearchAtEnd();
    return;
  }
  const nextQuery = sidebarTypeSearchNextQuery(searchQuery.value, event);
  if (nextQuery == null) return;
  event.preventDefault();
  searchQuery.value = nextQuery;
  focusSearchAtEnd();
}

function sidebarShortcutTargetIsActive(target: EventTarget | null): boolean {
  const root = rootRef.value;
  if (!root) return false;
  if (target instanceof Node && root.contains(target)) return true;
  const active = document.activeElement;
  return pointerInsideTree.value && (!active || active === document.body || root.contains(active));
}

function sidebarShortcutTargetAllowsAppShortcut(target: EventTarget | null): boolean {
  if (sidebarDialogOpen()) return false;
  if (!(target instanceof HTMLElement)) return true;
  if (target.closest('[role="dialog"], [role="alertdialog"]')) return false;
  return !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable || !!target.closest("[contenteditable='true'], [role='textbox']"));
}

function selectedSidebarNodesInVisibleOrder(): TreeNode[] {
  const selectedIds = new Set(store.selectedTreeNodeIds);
  return visibleNodes.value.filter((node) => selectedIds.has(node.id));
}

function isEditConnectionShortcut(event: KeyboardEvent): boolean {
  return isEditSidebarConnectionShortcut(event, settingsStore.editorSettings.shortcuts);
}

function isDisconnectConnectionShortcut(event: KeyboardEvent): boolean {
  return isDisconnectSidebarConnectionShortcut(event, settingsStore.editorSettings.shortcuts);
}

function requestSelectedConnectionEdit(): boolean {
  const selectedNodeId = store.selectedTreeNodeId;
  const currentNode = selectedNodeId ? flatTreeIndex.value.nodeById.get(selectedNodeId) : null;
  if (!currentNode) return false;
  const editTarget = selectedConnectionEditTarget(currentNode, selectedSidebarNodesInVisibleOrder());
  if (!editTarget) return false;
  store.startEditing(editTarget.connectionId);
  return true;
}

function requestSelectedConnectionDisconnect(): boolean {
  const selectedNodeId = store.selectedTreeNodeId;
  const currentNode = selectedNodeId ? flatTreeIndex.value.nodeById.get(selectedNodeId) : null;
  if (!currentNode) return false;
  const targets = selectedConnectionDisconnectTargets(currentNode, selectedSidebarNodesInVisibleOrder());
  const connectedTargets = targets.filter((target) => store.connectedIds.has(target.connectionId));
  if (connectedTargets.length > 0) {
    const connectionIds = connectedTargets.map((target) => target.connectionId);
    void disconnectSidebarConnections(connectionIds, (connectionId) => store.disconnect(connectionId)).then((result) => {
      if (result.succeeded > 0 && result.failed === 0) {
        toast(connectionIds.length > 1 ? t("connection.disconnectedSelected", { count: connectionIds.length }) : t("connection.disconnected"), 2000);
      } else if (result.failed > 0) {
        toast(t("connection.disconnectSelectedPartial", { succeeded: result.succeeded, failed: result.failed }), 5000);
      }
    });
    return true;
  }
  return false;
}

function copySelectedSidebarNames(): boolean {
  const nodes = selectedSidebarNodesInVisibleOrder();
  if (nodes.length === 0) return false;
  const copiedCount = copySelectedConnectionsToClipboards(nodes, (connectionIds) => store.copyConnectionsToTreeClipboard(connectionIds), copyToClipboard);
  if (copiedCount > 0) {
    toast(t("connection.copied"), 2000);
    return true;
  }
  const tableNodes = nodes.filter((node) => node.type === "table" && !!node.connectionId && !!node.database);
  store.treeClipboard =
    tableNodes.length > 0
      ? {
          kind: "table-copy",
          tables: tableNodes.map((node) => ({
            connectionId: node.connectionId!,
            database: node.database!,
            schema: connectionObjectTreeNodeSchema(store.getConfig(node.connectionId!), node.database!, node.schema),
            tableName: node.label,
            tableComment: node.comment,
          })),
        }
      : null;
  const activeNodeId = store.selectedTreeNodeId;
  const activeNode = activeNodeId ? (flatTreeIndex.value.nodeById.get(activeNodeId) ?? nodes[0]!) : nodes[0]!;
  const config = activeNode.connectionId ? store.getConfig(activeNode.connectionId) : undefined;
  const copyText = formatSidebarTableCopyText(activeNode, nodes, {
    separator: settingsStore.editorSettings.sidebarCopyTableNameSeparator,
    includeSchema: settingsStore.editorSettings.sidebarCopyTableNameIncludeSchema,
    databaseType: activeNode.connectionId ? effectiveDatabaseTypeForConnection(config) : undefined,
    driverProfile: config?.driver_profile,
    identifierQuote: activeNode.connectionId ? store.connectionIdentifierQuote?.(activeNode.connectionId) : undefined,
  });
  copyToClipboard(copyText)
    .then(() => toast(t("connection.copied"), 2000))
    .catch((e: any) => toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000));
  return true;
}

function requestSelectedSidebarPaste(): boolean {
  const clipboard = store.treeClipboard;
  const selectedNodeId = store.selectedTreeNodeId;
  if (clipboard?.kind === "connection-copy") {
    const selectedNode = selectedNodeId ? flatTreeIndex.value.nodeById.get(selectedNodeId) : null;
    const targetGroupId = connectionPasteTargetGroupId(selectedNode, (connectionId) => store.groupIdForConnection(connectionId));
    void store
      .pasteConnectionClipboard(targetGroupId)
      .then((count) => {
        if (count > 0) toast(count > 1 ? t("connection.duplicatedSelected", { count }) : t("connection.duplicated"), 2000);
      })
      .catch((e: any) => toast(t("connection.saveFailed", { message: e?.message || String(e) }), 5000));
    return true;
  }
  if (clipboard?.kind !== "table-copy" || clipboard.tables.length === 0 || !selectedNodeId) return false;

  return pasteHandlerRegistry.request(selectedNodeId);
}

onMounted(() => {
  sidebarLayoutMonitor.start();
  window.addEventListener("keydown", onWindowKeydown);
});

onUnmounted(() => {
  store.sidebarSearchQuery = "";
  sidebarLayoutMonitor.dispose();
  sidebarTreeRuntime.dispose();
  sidebarActionGeneration += 1;
  sidebarContextMenuTarget.value = null;
  sidebarContextMenuItems.value = [];
  sidebarDdlTarget.value = null;
  sidebarElasticsearchIndexMetadataTarget.value = null;
  sidebarObjectSourceTarget.value = null;
  sidebarProcedureTarget.value = null;
  sidebarVisibleDatabasesTarget.value = null;
  sidebarVisibleSchemasTarget.value = null;
  sidebarVisibleNacosNamespacesTarget.value = null;
  sidebarTreeItemDialogController.value = null;
  resetSidebarTreeDialogState();
  window.removeEventListener("keydown", onWindowKeydown);
  cancelPendingSidebarDataOpen();
  remoteTableSearchDebouncer.cancelAll();
  localTableSearchDebouncer.cancelAll();
  localTableSearchRequestRevisions.clear();
  pendingInvalidatedTableSearchScopes.clear();
  tableSearchFocusRestoreTokens.clear();
  latestTableSearchInteractionParentId = null;
  latestTableSearchInteractionId = 0;
  stopSidebarScrollbarDrag();
  stopSidebarHorizontalScrollbarDrag();
  sidebarScrollbarResizeObserver?.disconnect();
  window.cancelAnimationFrame(sidebarScrollbarAnimationFrame);
  window.clearTimeout(sidebarScrollingTimer);
  if (sidebarCommentMeasureFrame) window.cancelAnimationFrame(sidebarCommentMeasureFrame);
  if (sidebarTreeContentMeasureFrame) window.cancelAnimationFrame(sidebarTreeContentMeasureFrame);
});

defineExpose({
  focusSearch,
  createNewGroup,
  collapseAllTreeNodes,
  locateTabInSidebar,
  disconnectAllActiveConnections,
  focusSelectedNode,
  openTableStructureForSelection: openSidebarTableStructureForSelection,
  refreshSidebar: requestSelectedSidebarRefresh,
});
</script>

<template>
  <div ref="rootRef" class="h-full min-h-0 flex flex-col select-none" :style="sidebarRootStyle" @pointerenter="pointerInsideTree = true" @pointerleave="pointerInsideTree = false">
    <SidebarTreeRuntimeHost
      :ref="bindSidebarTreeRuntimeHost"
      :node="sidebarTreeRuntimeInitialNode"
      :depth="0"
      @search-toggle="onSearchToggle"
      @node-toggled="onNodeToggled"
      @open-ddl="openSidebarDdl"
      @open-elasticsearch-index-metadata="openSidebarElasticsearchIndexMetadata"
      @open-object-source="openSidebarObjectSource"
      @open-procedure="openSidebarProcedure"
      @open-settings="openSidebarSettings"
      @open-connection-settings="(connectionId) => emit('open-connection-settings', connectionId)"
      @open-data="openSidebarData"
      @open-visible-databases="openSidebarVisibleDatabases"
      @open-visible-schemas="openSidebarVisibleSchemas"
      @open-visible-nacos-namespaces="openSidebarVisibleNacosNamespaces"
      @open-table-name-filters="openSidebarTableNameFilters"
      @add-to-ai="(nodes) => emit('add-to-ai', nodes)"
      @request-connection-rename="startRenamingConnectionNode"
      @request-group-rename="startRenamingCreatedGroup"
      @request-saved-sql-rename="startRenamingSavedSqlNode"
      @open-danger-dialog="openSidebarDangerDialog"
      @open-dialog-controller="updateSidebarTreeItemDialogController"
      @open-install-extension="openSidebarInstallExtension"
      @open-extension-details="openSidebarExtensionDetails"
      @open-event-trigger-details="openSidebarEventTriggerDetails"
    />
    <div class="connection-tree-search sticky top-0 z-10 bg-background px-2 py-1">
      <div class="relative flex items-center gap-1">
        <div class="relative min-w-0 flex-1">
          <Loader2 v-if="isSidebarSearchLoading" class="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin text-muted-foreground" />
          <Search v-else class="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            class="w-full h-6 pl-7 pr-[4.75rem] text-xs rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            :class="regexMode && compileSearchRegex(searchQuery).invalid ? 'border-destructive focus:ring-destructive' : 'border-border'"
            :aria-invalid="regexMode && compileSearchRegex(searchQuery).invalid ? 'true' : 'false'"
            :placeholder="t('grid.search')"
            @keydown="onSearchKeydown"
          />
          <div class="absolute inset-y-0 right-0.5 flex items-center">
            <button v-if="searchQuery" type="button" class="flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground" :aria-label="t('common.clear')" @click="searchQuery = ''">
              <X class="h-3 w-3" />
            </button>
            <LightTooltip :text="t('sidebar.regexSearchTooltip')" side="top" :delay="300">
              <SidebarRegexToggleButton :label="t('sidebar.regexSearch')" :pressed="regexMode" :invalid="regexMode && compileSearchRegex(searchQuery).invalid" @toggle="regexMode = !regexMode" />
            </LightTooltip>
            <LightTooltip :text="t('sidebar.globalLocalSearchTooltip')" side="top" :delay="300">
              <Switch size="sm" :model-value="settingsStore.editorSettings.sidebarGlobalSearchLocal" :disabled="regexMode" :aria-label="t('sidebar.globalLocalSearch')" @update:model-value="settingsStore.updateEditorSettings({ sidebarGlobalSearchLocal: Boolean($event) })" />
            </LightTooltip>
          </div>
        </div>
        <LightTooltip :text="t('sidebar.locateActiveTab')" side="top" :delay="300" nowrap>
          <SidebarLocateButton :label="t('sidebar.locateActiveTab')" @locate="locateActiveTabInSidebar" />
        </LightTooltip>
        <LightTooltip :text="sidebarListOptionsLabel" side="top" :delay="300" nowrap>
          <span class="inline-flex">
            <LightDropdown
              model-value=""
              :items="sidebarListOptionItems"
              :selected-values="selectedSidebarListOptions"
              :aria-label="sidebarListOptionsLabel"
              :trigger-class="['shrink-0 h-6 w-6 flex items-center justify-center rounded border border-border hover:bg-accent', hasCustomSidebarListOptions ? 'text-primary bg-primary/10 border-primary/30' : 'text-muted-foreground'].join(' ')"
              item-icon-class="h-3.5 w-3.5"
              content-class="w-max min-w-0"
              selected-item-class="bg-primary/10 text-primary"
              selected-check-class="text-primary"
              :show-trigger-label="false"
              :show-chevron="false"
              :close-on-select="false"
              align="end"
              @update:model-value="selectSidebarListOption"
            >
              <template #trigger-icon="{ open }">
                <SidebarListOptionsIcon :filtered="hasSearchScopeFilter" :open="open" />
              </template>
            </LightDropdown>
          </span>
        </LightTooltip>
        <ActiveConnectionFilterButton :active-connection-count="store.connectedIds.size" :pressed="showConnectedConnectionsOnly" @toggle="showConnectedConnectionsOnly = !showConnectedConnectionsOnly" />
      </div>
    </div>
    <CustomContextMenu ref="sidebarContextMenuRef" :items="sidebarContextMenuItems" v-slot="contextMenuSlot">
      <div v-if="flatNodes.length > 0 && useVirtualTree" ref="treeScrollShellRef" class="connection-tree-scroll-shell relative min-h-0 flex-1" :class="{ 'connection-tree-scroll-shell--horizontal-overflow': hasSidebarHorizontalOverflow }">
        <!-- NOTE: flow-mode is intentionally NOT used here. vue-virtual-scroller
             v3.0.4's flow-mode view-pool bookkeeping produces an internally
             inconsistent DOM in this app (window/spacers updated but pool views
             never materialized -> blank band). Tree rows are fixed 28px (labels
             truncate), so the standard absolute-positioning mode is safe and
             keeps the materialized window in sync with the viewport. -->
        <RecycleScroller
          ref="treeScrollerRef"
          class="sidebar-tree connection-tree-scroller h-full overflow-y-auto"
          :class="sidebarTreeOverflowClass"
          :style="sidebarTreeScrollerStyle"
          @click="clearSidebarSelection"
          @wheel="onTreeWheel"
          :items="flatNodes"
          :item-size="sidebarTreeRowHeight"
          :buffer="SIDEBAR_TREE_SCROLL_BUFFER"
          :prerender="SIDEBAR_TREE_PRERENDER_COUNT"
          :skip-hover="true"
          key-field="renderKey"
          type-field="poolType"
          list-class="connection-tree-content"
        >
          <template #default="{ item }">
            <TreeItem
              :node="item.node"
              :depth="item.depth"
              :reorder-disabled="isRootListPartial"
              :move-to-group-only="isConnectionListAlphabeticallySorted"
              :pending-rename="pendingRenameNodeId === item.node.id"
              :highlighted="highlightedNodeId === item.node.id"
              :comment-label-width="sidebarCommentLabelWidths.get(item.node.id)"
              @context-menu="(event, node) => openSidebarContextMenu(event, node, contextMenuSlot.onContextMenu)"
              @rename-started="pendingRenameNodeId = null"
              @group-created="startRenamingCreatedGroup"
            />
          </template>
        </RecycleScroller>
        <div v-if="stickyNode" class="sticky-database-header pointer-events-auto absolute inset-x-0 top-0 z-[5]" :style="stickyHeaderStyle">
          <div ref="stickyRowRef">
            <TreeItem
              :node="stickyNode.node"
              :depth="stickyNode.depth"
              :reorder-disabled="true"
              :reference-drag-disabled="true"
              :comment-label-width="sidebarCommentLabelWidths.get(stickyNode.node.id)"
              :is-sticky-context="stickyProductionContext"
              @context-menu="(event, node) => openSidebarContextMenu(event, node, contextMenuSlot.onContextMenu)"
            />
          </div>
          <TreeItem v-if="stickyTableSearchNode" :key="stickyTableSearchNode.renderKey" :node="stickyTableSearchNode.node" :depth="stickyTableSearchNode.depth" :reorder-disabled="true" :reference-drag-disabled="true" />
        </div>
        <div v-if="stickyProductionContext" class="sidebar-sticky-production" :style="{ height: `${sidebarTreeRowHeight}px` }">
          <ProductionContextBadge compact />
        </div>
        <div
          v-if="hasSidebarVerticalOverflow"
          ref="sidebarScrollbarTrackRef"
          class="sidebar-tree-scrollbar"
          :class="{ 'sidebar-tree-scrollbar--scrolling': isScrollingSidebar, 'sidebar-tree-scrollbar--dragging': isDraggingSidebarScrollbar, 'sidebar-tree-scrollbar--with-horizontal': hasSidebarHorizontalOverflow }"
          @pointerdown="onSidebarScrollbarTrackPointerDown"
        >
          <div class="sidebar-tree-scrollbar__thumb" :style="sidebarScrollbarThumbStyle" @pointerdown.stop="onSidebarScrollbarThumbPointerDown" />
        </div>
        <div
          v-if="hasSidebarHorizontalOverflow"
          ref="sidebarHorizontalScrollbarTrackRef"
          class="sidebar-tree-horizontal-scrollbar"
          :class="{ 'sidebar-tree-horizontal-scrollbar--with-vertical': hasSidebarVerticalOverflow, 'sidebar-tree-horizontal-scrollbar--dragging': isDraggingSidebarHorizontalScrollbar }"
          @pointerdown="onSidebarHorizontalScrollbarTrackPointerDown"
        >
          <div class="sidebar-tree-horizontal-scrollbar__thumb" :style="sidebarHorizontalScrollbarThumbStyle" @pointerdown.stop="onSidebarHorizontalScrollbarThumbPointerDown" />
        </div>
      </div>
      <div v-else-if="flatNodes.length > 0" ref="treeScrollShellRef" class="connection-tree-scroll-shell relative min-h-0 flex-1" :class="{ 'connection-tree-scroll-shell--horizontal-overflow': hasSidebarHorizontalOverflow }">
        <div ref="plainTreeScrollerRef" class="sidebar-tree connection-tree-scroller h-full overflow-y-auto" :class="sidebarTreeOverflowClass" :style="sidebarTreeScrollerStyle" @click="clearSidebarSelection" @wheel="onTreeWheel" @scroll.passive="onTreeScroll">
          <div class="connection-tree-content">
            <TreeItem
              v-for="item in flatNodes"
              :key="item.renderKey"
              :node="item.node"
              :depth="item.depth"
              :reorder-disabled="isRootListPartial"
              :move-to-group-only="isConnectionListAlphabeticallySorted"
              :pending-rename="pendingRenameNodeId === item.node.id"
              :highlighted="highlightedNodeId === item.id"
              :comment-label-width="sidebarCommentLabelWidths.get(item.node.id)"
              @context-menu="(event, node) => openSidebarContextMenu(event, node, contextMenuSlot.onContextMenu)"
              @rename-started="pendingRenameNodeId = null"
              @group-created="startRenamingCreatedGroup"
            />
          </div>
        </div>
        <div v-if="stickyNode" class="sticky-database-header pointer-events-auto absolute inset-x-0 top-0 z-[5]" :style="stickyHeaderStyle">
          <div ref="stickyRowRef">
            <TreeItem
              :node="stickyNode.node"
              :depth="stickyNode.depth"
              :reorder-disabled="true"
              :reference-drag-disabled="true"
              :comment-label-width="sidebarCommentLabelWidths.get(stickyNode.node.id)"
              :is-sticky-context="stickyProductionContext"
              @context-menu="(event, node) => openSidebarContextMenu(event, node, contextMenuSlot.onContextMenu)"
            />
          </div>
          <TreeItem v-if="stickyTableSearchNode" :key="stickyTableSearchNode.renderKey" :node="stickyTableSearchNode.node" :depth="stickyTableSearchNode.depth" :reorder-disabled="true" :reference-drag-disabled="true" />
        </div>
        <div v-if="stickyProductionContext" class="sidebar-sticky-production" :style="{ height: `${sidebarTreeRowHeight}px` }">
          <ProductionContextBadge compact />
        </div>
        <div
          v-if="hasSidebarVerticalOverflow"
          ref="sidebarScrollbarTrackRef"
          class="sidebar-tree-scrollbar"
          :class="{ 'sidebar-tree-scrollbar--scrolling': isScrollingSidebar, 'sidebar-tree-scrollbar--dragging': isDraggingSidebarScrollbar, 'sidebar-tree-scrollbar--with-horizontal': hasSidebarHorizontalOverflow }"
          @pointerdown="onSidebarScrollbarTrackPointerDown"
        >
          <div class="sidebar-tree-scrollbar__thumb" :style="sidebarScrollbarThumbStyle" @pointerdown.stop="onSidebarScrollbarThumbPointerDown" />
        </div>
        <div
          v-if="hasSidebarHorizontalOverflow"
          ref="sidebarHorizontalScrollbarTrackRef"
          class="sidebar-tree-horizontal-scrollbar"
          :class="{ 'sidebar-tree-horizontal-scrollbar--with-vertical': hasSidebarVerticalOverflow, 'sidebar-tree-horizontal-scrollbar--dragging': isDraggingSidebarHorizontalScrollbar }"
          @pointerdown="onSidebarHorizontalScrollbarTrackPointerDown"
        >
          <div class="sidebar-tree-horizontal-scrollbar__thumb" :style="sidebarHorizontalScrollbarThumbStyle" @pointerdown.stop="onSidebarHorizontalScrollbarThumbPointerDown" />
        </div>
      </div>
    </CustomContextMenu>

    <SidebarMenuPreferencesDialog v-if="sidebarMenuPreferences" v-model:open="sidebarMenuPreferencesOpen" :scope="sidebarMenuPreferences.scope" :items="sidebarMenuPreferences.items" />
    <div v-if="showConnectedConnectionsOnly && store.connectedIds.size > 0" class="shrink-0 border-t border-border bg-background px-2 py-2">
      <Button type="button" variant="outline" size="sm" class="h-7 w-full justify-center gap-1.5 text-xs" :disabled="isDisconnectingAllActiveConnections" @click="disconnectAllActiveConnections">
        <Loader2 v-if="isDisconnectingAllActiveConnections" class="h-3.5 w-3.5 animate-spin" />
        <Unplug v-else class="h-3.5 w-3.5" />
        {{ t("sidebar.disconnectAllActiveConnections") }}
      </Button>
    </div>
    <SidebarDdlViewDialog
      v-if="sidebarDdlTarget"
      v-model:open="sidebarDdlOpen"
      :connection-id="sidebarDdlTarget.connectionId!"
      :database="sidebarDdlTarget.database!"
      :catalog="sidebarDdlTarget.catalog"
      :schema="sidebarDdlTarget.schema"
      :table-name="sidebarDdlTarget.label"
      :object-type="tableDdlObjectTypeForSidebarNode(sidebarDdlTarget.type)"
      :database-type="sidebarDdlDatabaseType"
      :dialect="codeMirrorSqlDialect(sidebarDdlDatabaseType)"
      :format-dialect="sqlFormatDialectForDbType(sidebarDdlDatabaseType)"
    />

    <SidebarElasticsearchIndexMetadataDialog
      v-if="sidebarElasticsearchIndexMetadataTarget"
      v-model:open="sidebarElasticsearchIndexMetadataOpen"
      :connection-id="sidebarElasticsearchIndexMetadataTarget.node.connectionId!"
      :index="sidebarElasticsearchIndexMetadataTarget.node.label"
      :kind="sidebarElasticsearchIndexMetadataTarget.kind"
    />

    <SidebarObjectSourceDialog
      v-if="sidebarObjectSourceTarget && sidebarObjectSourceType"
      v-model:open="sidebarObjectSourceOpen"
      :connection-id="sidebarObjectSourceTarget.node.connectionId!"
      :database="sidebarObjectSourceTarget.node.database!"
      :catalog="sidebarObjectSourceTarget.node.catalog"
      :schema="sidebarObjectSourceResolvedTarget?.schema"
      :name="sidebarObjectSourceResolvedTarget!.name"
      :relation-name="sidebarObjectSourceTarget.node.tableName"
      :signature="sidebarObjectSourceResolvedTarget?.signature"
      :object-type="sidebarObjectSourceType"
      :database-type="sidebarObjectSourceDatabaseType"
      :dialect="sidebarObjectSourceDialect"
      :format-dialect="sidebarObjectSourceFormatDialect"
      :initial-editing="sidebarObjectSourceTarget.initialEditing"
      :initial-section="sidebarObjectSourceTarget.initialSection"
      :create-trigger="sidebarObjectSourceTarget.createTrigger?.payload"
      :execution-schema="sidebarObjectSourceTarget.node.schema || sidebarObjectSourceTarget.node.database"
      :trigger-identity-mode="exactOracleTriggerNodeMetadata(sidebarObjectSourceTarget.node) ? 'exact' : undefined"
      @open-object="(context: ObjectDependencyTarget, target: SqlObjectNavigationTarget) => emit('open-dependency-object', context, target)"
      @saved="refreshSidebarActionTarget"
    />

    <SidebarProcedureExecutionDialog
      v-if="sidebarProcedureTarget?.connectionId && sidebarProcedureTarget.database"
      v-model:open="sidebarProcedureOpen"
      :connection-id="sidebarProcedureTarget.connectionId"
      :database="sidebarProcedureTarget.database"
      :database-type="effectiveDatabaseTypeForConnection(store.getConfig(sidebarProcedureTarget.connectionId))"
      :schema="sidebarProcedureTarget.schema"
      :routine-name="sidebarProcedureTarget.label"
      @open-sql="openSidebarProcedureSql"
      @execute="executeSidebarProcedureSql"
    />

    <SidebarVisibleDatabasesDialog v-if="sidebarVisibleDatabasesTarget?.connectionId" v-model:open="sidebarVisibleDatabasesOpen" :connection-id="sidebarVisibleDatabasesTarget.connectionId" :connection-name="sidebarVisibleDatabasesTarget.label" />

    <SidebarVisibleSchemasDialog
      v-if="sidebarVisibleSchemasTarget?.connectionId && sidebarVisibleSchemasTarget.database != null"
      v-model:open="sidebarVisibleSchemasOpen"
      :connection-id="sidebarVisibleSchemasTarget.connectionId"
      :connection-name="sidebarVisibleSchemasTarget.label === DEFAULT_DATABASE_TREE_LABEL ? t(DEFAULT_DATABASE_TREE_LABEL) : sidebarVisibleSchemasTarget.label"
      :database="sidebarVisibleSchemasTarget.database"
    />

    <SidebarVisibleNacosNamespacesDialog v-if="sidebarVisibleNacosNamespacesTarget?.connectionId" v-model:open="sidebarVisibleNacosNamespacesOpen" :connection-id="sidebarVisibleNacosNamespacesTarget.connectionId" :connection-name="sidebarVisibleNacosNamespacesTarget.label" />
    <Dialog v-model:open="sidebarTableNameFilterOpen">
      <DialogContent class="max-w-xl">
        <DialogHeader class="space-y-2">
          <DialogTitle>{{ t("contextMenu.tableNameFilters") }}</DialogTitle>
          <DialogDescription>
            {{ t("contextMenu.tableNameFiltersDescription") }}
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-5 py-1">
          <div class="rounded-lg border bg-muted/20 p-3.5">
            <label class="mb-2.5 block text-sm font-medium leading-none">{{ t("contextMenu.tableNameFilterInclude") }}</label>
            <textarea
              v-model="tableNameFilterIncludeDraft"
              class="min-h-32 w-full resize-y rounded-md border bg-background px-3 py-2.5 font-mono text-xs leading-relaxed shadow-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
              :placeholder="t('contextMenu.tableNameFilterIncludePlaceholder')"
            ></textarea>
          </div>
          <div class="rounded-lg border bg-muted/20 p-3.5">
            <label class="mb-2.5 block text-sm font-medium leading-none">{{ t("contextMenu.tableNameFilterExclude") }}</label>
            <textarea
              v-model="tableNameFilterExcludeDraft"
              class="min-h-32 w-full resize-y rounded-md border bg-background px-3 py-2.5 font-mono text-xs leading-relaxed shadow-sm focus:outline-none focus:ring-2 focus:ring-ring/40"
              :placeholder="t('contextMenu.tableNameFilterExcludePlaceholder')"
            ></textarea>
          </div>
          <p class="rounded-md bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">{{ t("contextMenu.tableNameFilterLikeHint") }}</p>
        </div>
        <DialogFooter class="gap-2 sm:justify-between">
          <Button variant="ghost" @click="clearSidebarTableNameFilters">{{ t("common.clear") }}</Button>
          <div class="flex gap-2">
            <Button variant="outline" @click="sidebarTableNameFilterOpen = false">{{ t("dangerDialog.cancel") }}</Button>
            <Button @click="saveSidebarTableNameFilters">{{ t("common.save") }}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <SidebarTreeItemDialogs v-if="sidebarTreeItemDialogController" :key="sidebarTreeItemDialogController.node?.id" :controller="sidebarTreeItemDialogController" @closed="sidebarTreeItemDialogController = null" />
    <SidebarTableVGroupDialog @created="focusCreatedTableVGroup" />
    <InstallExtensionDialog v-if="sidebarInstallExtensionTarget" ref="sidebarInstallExtensionDialogRef" :node="sidebarInstallExtensionTarget" @close="refreshSidebarActionTarget" @changed="refreshSidebarActionTarget" />
    <ExtensionDetailsDialog v-if="sidebarExtensionDetailsTarget" ref="sidebarExtensionDetailsDialogRef" :node="sidebarExtensionDetailsTarget" />
    <EventTriggerDetailsDialog v-if="sidebarEventTriggerDetailsTarget" ref="sidebarEventTriggerDetailsDialogRef" :node="sidebarEventTriggerDetailsTarget" />
    <div v-if="store.treeNodes.length === 0" class="px-3 py-8 text-center text-muted-foreground text-xs">
      {{ t("sidebar.noConnections") }}
    </div>
  </div>
</template>

<style scoped>
.sidebar-sticky-production {
  pointer-events: none;
  position: absolute;
  top: 0;
  right: 8px;
  z-index: 6;
  display: flex;
  align-items: center;
}

.sticky-database-header {
  background-color: var(--sidebar);
  container-type: inline-size;
  overflow: clip;
}

.connection-tree-scroller {
  will-change: scroll-position;
  contain: content;
  scrollbar-width: none;
  -ms-overflow-style: none;
  overflow-anchor: none;
  /* Lets TreeItem's full-bleed row/search-box backgrounds (see
     tree-item-connection-tint / tree-table-search-control in TreeItem.vue)
     size themselves off this scroller's own width via cqw instead of a
     fixed -9999px offset, so they can't inflate this element's own
     scrollWidth when sidebarAllowHorizontalScroll turns on overflow-x. */
  container-type: inline-size;
  container-name: sidebar-tree;
}

.connection-tree-scroller::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.connection-tree-scroller :deep(.vue-recycle-scroller__item-view) {
  min-width: 100%;
  contain: style;
  /* The virtual renderer positions rows at fixed item-size offsets (see
     getSidebarTreeRowHeight). TreeItem rows only guarantee min-h, so rename
     inputs or larger sidebar fonts could grow a row beyond the row height and
     overlap the next row. Pin every materialized row to the fixed height and clip
     any overflow instead of letting the layout drift. */
  height: var(--sidebar-tree-row-height, 28px);
  overflow: clip;
}

.connection-tree-scroller.sidebar-tree-horizontal-scroll :deep(.vue-recycle-scroller__item-view) {
  width: max-content;
  /* Viewport-sized controls move within this row when scrolling horizontally.
     Keep the clipping wrapper as wide as the content so it cannot cut them
     off, and let ordinary row backgrounds cover the full scrollable width. */
  min-width: max(100%, var(--sidebar-tree-content-width));
}

.connection-tree-scroller.sidebar-tree-horizontal-scroll :deep(.connection-tree-content),
.connection-tree-scroller.sidebar-tree-horizontal-scroll > .connection-tree-content {
  min-width: max(100%, var(--sidebar-tree-content-width));
}

.connection-tree-scroller.sidebar-tree-horizontal-scroll :deep(.tree-table-search-control),
.connection-tree-scroller.sidebar-tree-horizontal-scroll :deep(.tree-row-viewport) {
  /* These rows may scroll with the tree, but their connection tint must span
     the entire horizontal content range so no white strip appears at the
     right edge after scrolling. */
  width: max(100%, var(--sidebar-tree-content-width));
}

.connection-tree-scroller.sidebar-tree-horizontal-scroll :deep(.tree-table-search-control__content) {
  width: 100cqw;
  min-width: 100cqw;
}

.connection-tree-scroll-shell--horizontal-overflow .connection-tree-scroller {
  height: calc(100% - 10px);
}

.sidebar-tree-scrollbar {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
  width: 12px;
  cursor: default;
  opacity: 0;
  transition: opacity 120ms ease;
}

.sidebar-tree-scrollbar--with-horizontal {
  bottom: 10px;
}

.sidebar-tree-scrollbar--scrolling,
.sidebar-tree-scrollbar:hover,
.sidebar-tree-scrollbar--dragging {
  opacity: 1;
}

.sidebar-tree-scrollbar__thumb {
  position: absolute;
  right: 2px;
  width: 6px;
  min-height: 24px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--foreground) 30%, transparent);
  transition:
    background-color 120ms ease,
    width 120ms ease,
    right 120ms ease;
}

.sidebar-tree-scrollbar:hover .sidebar-tree-scrollbar__thumb,
.sidebar-tree-scrollbar--dragging .sidebar-tree-scrollbar__thumb {
  right: 1px;
  width: 8px;
  background: color-mix(in oklch, var(--foreground) 48%, transparent);
}

html.dbx-legacy-webview .sidebar-tree-scrollbar {
  opacity: 0.9;
}

html.dbx-legacy-webview .sidebar-tree-scrollbar__thumb {
  background: rgba(82, 82, 82, 0.42);
}

html.dbx-legacy-webview.dark .sidebar-tree-scrollbar__thumb {
  background: rgba(212, 212, 216, 0.42);
}

html.dbx-legacy-webview .sidebar-tree-scrollbar:hover .sidebar-tree-scrollbar__thumb,
html.dbx-legacy-webview .sidebar-tree-scrollbar--dragging .sidebar-tree-scrollbar__thumb {
  background: rgba(82, 82, 82, 0.62);
}

html.dbx-legacy-webview.dark .sidebar-tree-scrollbar:hover .sidebar-tree-scrollbar__thumb,
html.dbx-legacy-webview.dark .sidebar-tree-scrollbar--dragging .sidebar-tree-scrollbar__thumb {
  background: rgba(212, 212, 216, 0.62);
}

.sidebar-tree-horizontal-scrollbar {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 10;
  height: 10px;
  cursor: default;
  background: color-mix(in oklch, var(--muted) 45%, transparent);
}

.sidebar-tree-horizontal-scrollbar--with-vertical {
  right: 10px;
}

.sidebar-tree-horizontal-scrollbar__thumb {
  position: absolute;
  bottom: 2px;
  left: 0;
  height: 6px;
  min-width: 24px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--foreground) 34%, transparent);
  transition:
    background-color 120ms ease,
    height 120ms ease,
    bottom 120ms ease;
}

.sidebar-tree-horizontal-scrollbar:hover .sidebar-tree-horizontal-scrollbar__thumb,
.sidebar-tree-horizontal-scrollbar--dragging .sidebar-tree-horizontal-scrollbar__thumb {
  bottom: 1px;
  height: 8px;
  background: color-mix(in oklch, var(--foreground) 50%, transparent);
}
</style>

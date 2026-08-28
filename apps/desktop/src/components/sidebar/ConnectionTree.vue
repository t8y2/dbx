<script setup lang="ts">
import { ref, shallowRef, computed, nextTick, watch, provide, onMounted, onUnmounted, type Component, type ComponentPublicInstance, type CSSProperties } from "vue";
import { useI18n } from "vue-i18n";
import { Search, X, SlidersHorizontal, ListOrdered, ArrowDownAZ, ArrowUpZA, LocateFixed, Server, Database, FolderTree, Table2, Eye, RotateCcw, Loader2, Unplug } from "@lucide/vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import type { ObjectSourceKind, QueryTab, TableInfo, TableNameFilter, TreeNode, TreeNodeType } from "@/types/database";
import {
  createSidebarSearchSubtreePreserver,
  filterSidebarSearchRootsByConnectionState,
  filterSidebarTree,
  filterSidebarTreeToConnectedConnections,
  findNodePathByIdentity,
  mergeSidebarRegexIndexScopes,
  resolveSidebarFilterGuards,
  resolveSidebarObjectSearchFilter,
  reuseLiveSidebarTreeNodes,
  type SidebarRegexIndexScope,
  type SidebarRegexScopeIdentity,
} from "@/lib/sidebar/sidebarSearchTree";
import { createSidebarLabelMatcher, matchSidebarLabel } from "@/lib/sidebar/sidebarSearch";
import { collectSidebarRegexIndexScopes, resolveSidebarRemoteSearchQuery, resolveSidebarSearchDispatchMode } from "@/lib/sidebar/sidebarRegexSearchIndex";
import { createSidebarSearchExpansionState } from "@/lib/sidebar/sidebarSearchExpansionState";
import { createSidebarSearchLoadingTracker } from "@/lib/sidebar/sidebarSearchLoadingTracker";
import { buildTableTreeNodes } from "@/lib/table/tableTree";
import { isCancelSearchShortcut, isCopySidebarSelectionShortcut, isEditSidebarConnectionShortcut, isPasteSidebarSelectionShortcut, isViewTableDdlShortcut } from "@/lib/editor/keyboardShortcuts";
import { sidebarNodeSupportsDdlView } from "@/lib/sidebar/sidebarTreeDdlShortcut";
import { copyNameForTreeNode, objectSourceTargetForTreeNode } from "@/lib/sidebar/treeNodeClick";
import { supportsTypeObjectSource } from "@/lib/database/databaseObjectCapabilities";
import { copyToClipboard } from "@/lib/common/clipboard";
import { connectionPasteTargetGroupId, copySelectedConnectionsToClipboards, selectedConnectionEditTarget } from "@/lib/sidebar/sidebarConnectionSelection";
import { pruneTreeSelectionToVisibleNodeIds } from "@/lib/sidebar/sidebarTreeSelection";
import { isEditableSidebarTypeSearchTarget, sidebarTypeSearchNextQuery } from "@/lib/sidebar/sidebarTypeSearch";
import { isInternalDorisCatalog, usesTreeSchemaMode } from "@/lib/database/databaseFeatureSupport";
import { connectionObjectTreeNodeSchema, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import {
  activeTabSidebarTarget,
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
import { createFlatTreeIndex, flatTreeRowsChanged, SIDEBAR_TREE_ROW_HEIGHT, SIDEBAR_TREE_PRERENDER_COUNT, SIDEBAR_TREE_SCROLL_BUFFER, SIDEBAR_TREE_VIRTUALIZE_HYSTERESIS, SIDEBAR_TREE_VIRTUALIZE_THRESHOLD, flattenTree, shouldVirtualizeFlatTree, type FlatTreeNode } from "@/composables/useFlatTree";
import { sidebarTreeContextKey } from "@/lib/sidebar/sidebarTreeContext";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHostInstance } from "@/lib/sidebar/sidebarTreeRuntime";
import { createSidebarPasteHandlerRegistry } from "@/lib/sidebar/sidebarPasteHandlerRegistry";
import { insertSidebarTableSearchControls, isSidebarTableSearchControlNode } from "@/lib/sidebar/sidebarTableSearchControl";
import { createSidebarTableSearchDebouncer, invalidateSidebarTableSearchBuild, loadOrBuildSidebarTableSearchIndex, scheduleExclusiveSidebarTableSearchDebounce } from "@/lib/sidebar/sidebarTableSearchIndex";
import TreeItem from "./TreeItem.vue";
import ActiveConnectionFilterButton from "./ActiveConnectionFilterButton.vue";
import SidebarTreeRuntimeHost from "./SidebarTreeRuntimeHost.vue";
import SidebarTreeItemDialogs from "./SidebarTreeItemDialogs.vue";
import InstallExtensionDialog from "@/components/objects/InstallExtensionDialog.vue";
import ExtensionDetailsDialog from "@/components/objects/ExtensionDetailsDialog.vue";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import LightDropdown from "@/components/ui/LightDropdown.vue";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { Switch } from "@/components/ui/switch";
import { cancelPendingSidebarDataOpen, runSidebarDataOpenImmediately, type SidebarDataOpenRequest } from "@/lib/sidebar/sidebarDataOpenCoordinator";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { codeMirrorSqlDialect } from "@/lib/database/jdbcDialect";
import { sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";
import { createSidebarActionTarget, findSidebarActionTarget, matchesSidebarActionTarget, type SidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";
import { syncSidebarTreeNodeExpansion } from "@/lib/sidebar/sidebarTreeExpansion";
import type { SidebarDangerDialogOption, SidebarDangerDialogRequest } from "@/lib/sidebar/sidebarDangerDialog";
import { resetSidebarTreeDialogState, sidebarDangerRunningExecutionId } from "./sidebarTreeDialogState";
import { SidebarDangerConfirmDialog, SidebarDdlViewDialog, SidebarObjectSourceDialog, SidebarProcedureExecutionDialog, SidebarVisibleDatabasesDialog, SidebarVisibleNacosNamespacesDialog, SidebarVisibleSchemasDialog } from "./sidebarAsyncDialogs";
import { sortConnectionListForDisplay } from "@/lib/sidebar/connectionListSort";
import { sidebarDisplayTableName } from "@/lib/sidebar/sidebarTableNameDisplay";
import { alignedSidebarCommentLabelWidths, isSidebarCommentAlignableNode, sidebarTreeNaturalContentWidth, sidebarTreeNodeComment, usesFullWidthTreeLabel } from "@/lib/sidebar/sidebarTreeItemLayout";
import { formatSidebarObjectStorage, sidebarTableStorageScopes, supportsSidebarTableStorage } from "@/lib/sidebar/sidebarDatabaseStorage";
import { sidebarScrollbarGeometry as calculateSidebarScrollbarGeometry } from "@/lib/sidebar/sidebarScrollbar";
import { createSidebarLayoutMonitor, type SidebarExpandedConnectionInfo } from "@/lib/sidebar/sidebarLayoutMonitor";
import { disconnectSidebarConnections } from "@/lib/sidebar/sidebarConnectionDisconnect";
import { compileSearchRegex } from "@/lib/common/searchPattern";

const { t } = useI18n();
const store = useConnectionStore();
const queryStore = useQueryStore();
const savedSqlStore = useSavedSqlStore();
const settingsStore = useSettingsStore();
const { toast } = useToast();
const searchQuery = ref("");
const deferredSearchQuery = ref("");
const regexMode = ref(false);
const sidebarSearchLoadingTracker = createSidebarSearchLoadingTracker();
const isSidebarSearchLoading = ref(false);
const showConnectedConnectionsOnly = ref(false);
const isDisconnectingAllActiveConnections = ref(false);
const searchInputRef = ref<HTMLInputElement>();
const rootRef = ref<HTMLElement>();
const sidebarRootStyle = computed<Record<string, string>>(() => ({ fontSize: `${settingsStore.editorSettings.sidebarFontSize}px` }));
const pointerInsideTree = ref(false);
const treeScrollerRef = ref<InstanceType<typeof RecycleScroller> | null>(null);
const plainTreeScrollerRef = ref<HTMLElement | null>(null);
const treeScrollShellRef = ref<HTMLElement | null>(null);
const sidebarScrollbarTrackRef = ref<HTMLElement | null>(null);
const sidebarHorizontalScrollbarTrackRef = ref<HTMLElement | null>(null);
const sidebarContextMenuRef = ref<{ close: () => void } | null>(null);
const sidebarContextMenuItems = ref<ContextMenuItem[]>([]);
const emit = defineEmits<{
  "open-settings": [initialTab: string];
  "add-to-ai": [node: TreeNode];
}>();

const sidebarContextMenuTarget = ref<SidebarActionTarget | null>(null);
const sidebarDangerDialogRequest = ref<SidebarDangerDialogRequest | null>(null);
const sidebarDangerDialogOpen = ref(false);
const sidebarDangerDialogConfirming = ref(false);
const sidebarDangerDialogCancelling = ref(false);
const sidebarTreeItemDialogController = ref<Record<string, any> | null>(null);
const sidebarInstallExtensionTarget = ref<TreeNode | null>(null);
const sidebarInstallExtensionDialogRef = ref<InstanceType<typeof InstallExtensionDialog> | null>(null);
const sidebarExtensionDetailsTarget = ref<TreeNode | null>(null);
const sidebarExtensionDetailsDialogRef = ref<InstanceType<typeof ExtensionDetailsDialog> | null>(null);
const sidebarTreeRuntimeHostRef = ref<SidebarTreeRuntimeHostInstance | null>(null);
const sidebarTreeRuntime = createSidebarTreeRuntime();
const sidebarTreeRuntimeInitialNode: TreeNode = { id: "__sidebar-runtime__", label: "", type: "connection-group" };
const sidebarDdlTarget = ref<TreeNode | null>(null);
const sidebarDdlOpen = ref(false);
const sidebarObjectSourceTarget = ref<{ node: TreeNode; initialEditing: boolean } | null>(null);
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
const searchExpansionState = createSidebarSearchExpansionState();
const searchRefreshedNodeIds = searchExpansionState.filteredNodeIds;
// Group nodes that search force-expanded on the user's behalf (they were
// collapsed before the query started). Cleared alongside searchRefreshedNodeIds
// so clearing the search box collapses them back instead of leaving every
// touched group open and reloading it again.
const searchAutoExpandedNodeIds = searchExpansionState.autoExpandedNodeIds;
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

function refreshActiveSidebarTableSearches() {
  if (isTreeSearchFiltering.value) return;
  for (const parentNodeId of Object.keys(store.sidebarTableSearchQueries)) {
    scheduleSidebarTableSearchRefresh(parentNodeId);
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

watch([deferredSearchQuery, regexMode], ([newQuery, isRegexMode], [oldQuery, wasRegexMode]) => {
  if (!isRegexMode || !newQuery) regexTableSearchScopes.value = [];
  // The regex source is a client-side projection; the remote tree-loading
  // search state must never carry it, or explicit node expansion would leak
  // the expression as a remote searchFilter.
  store.sidebarSearchQuery = resolveSidebarRemoteSearchQuery(isRegexMode, newQuery);
  const dispatchMode = resolveSidebarSearchDispatchMode({ query: newQuery, regexMode: isRegexMode, wasRegexMode }, { localSearchEnabled: settingsStore.editorSettings.sidebarGlobalSearchLocal });
  if (dispatchMode === "regex") {
    // Regex search is a read-only projection over live nodes and the local
    // table index. It must never trigger ensureConnected/listTables.
    const restoreTasks = restoreTrackedSearchTargets();
    const searchGeneration = sidebarSearchLoadingTracker.begin();
    isSidebarSearchLoading.value = true;
    void Promise.allSettled([loadRegexTableSearchIndexes(), ...restoreTasks])
      .then(() => {
        if (restoreTasks.length > 0) refreshActiveSidebarTableSearches();
      })
      .finally(() => {
        if (sidebarSearchLoadingTracker.end(searchGeneration)) isSidebarSearchLoading.value = false;
      });
    return;
  }
  if (dispatchMode === "none") {
    sidebarSearchLoadingTracker.cancel();
    isSidebarSearchLoading.value = false;
    const restoreTasks = restoreTrackedSearchTargets();
    if (restoreTasks.length > 0) {
      void Promise.all(restoreTasks)
        .then(() => refreshActiveSidebarTableSearches())
        .catch(() => {});
    }
    return;
  }
  const tasks: Promise<void>[] = [];
  const preservesSearchSubtree = newQuery ? createSidebarSearchSubtreePreserver(newQuery, searchableNodeTypes.value) : undefined;
  for (const root of store.treeNodes) {
    collectExpandedObjectSearchTargets(root, tasks, newQuery ? searchRefreshedNodeIds : undefined, preservesSearchSubtree);
  }
  if (!newQuery && oldQuery) {
    searchExpansionState.clear();
  }
  let searchGeneration = -1;
  if (newQuery && tasks.length > 0) {
    searchGeneration = sidebarSearchLoadingTracker.begin();
    isSidebarSearchLoading.value = true;
  } else {
    sidebarSearchLoadingTracker.cancel();
    isSidebarSearchLoading.value = false;
  }
  void Promise.allSettled(tasks)
    .then(() => {
      if (!newQuery && oldQuery) refreshActiveSidebarTableSearches();
    })
    .finally(() => {
      if (searchGeneration >= 0 && sidebarSearchLoadingTracker.end(searchGeneration)) isSidebarSearchLoading.value = false;
    });
});

const searchableObjectGroupTypes = new Set<TreeNodeType>(["group-tables", "group-dolt-system-tables", "group-views", "group-materialized-views", "group-procedures", "group-functions", "group-triggers", "group-events", "group-sequences", "group-synonyms", "group-packages", "group-types"]);
const simpleObjectParentTypes = new Set<TreeNodeType>(["database", "schema", "linked-server-schema"]);
const simpleObjectChildTypes = new Set<TreeNodeType>(["table", "view", "materialized_view", "procedure", "function", "trigger", "event", "sequence", "synonym", "package", "package-body", "type", "type-body", "load-more"]);

function isSimpleObjectSearchParent(node: TreeNode): boolean {
  return settingsStore.editorSettings.sidebarObjectDisplay === "simple" && simpleObjectParentTypes.has(node.type) && node.isExpanded === true && (!!node.children?.some((child) => simpleObjectChildTypes.has(child.type)) || !!store.sidebarTableSearchQueries[node.id]?.trim());
}

function collectExpandedObjectSearchTargets(node: TreeNode, tasks: Promise<void>[], refreshedNodeIds?: Set<string>, preservesNodeSubtree?: (node: TreeNode) => boolean, ancestorPreservesSearchSubtree = false) {
  const preservesSearchSubtree = ancestorPreservesSearchSubtree || (!!refreshedNodeIds && !!preservesNodeSubtree?.(node));
  if (refreshedNodeIds && node.type === "connection" && node.connectionId) {
    if (store.connectedIds.has(node.connectionId)) {
      tasks.push(store.loadConnectedConnectionRootForSidebarSearch(node.connectionId));
    }
    if (node.connectionId !== store.activeConnectionId) return;
  }
  if (refreshedNodeIds && isSimpleObjectSearchParent(node)) {
    if (preservesSearchSubtree) {
      if (refreshedNodeIds.delete(node.id)) {
        tasks.push(store.loadTreeNodeChildren(node, { force: true, searchFilter: "", allowGlobalSearchMismatch: true, expectedSidebarSearchQuery: store.sidebarSearchQuery }));
      }
    } else {
      refreshedNodeIds.add(node.id);
      tasks.push(store.refreshTreeNode(node));
    }
    return;
  }
  if (refreshedNodeIds && node.isExpanded && node.children) {
    for (const child of node.children) {
      if (child.connectionId && searchableObjectGroupTypes.has(child.type)) {
        if (preservesSearchSubtree) {
          if (searchExpansionState.markUnfiltered(child.id)) {
            tasks.push(store.loadObjectGroupChildren(child, { force: true, searchFilter: "", allowGlobalSearchMismatch: true, expectedSidebarSearchQuery: store.sidebarSearchQuery }));
          }
        } else {
          searchExpansionState.markFiltered(child.id, !child.isExpanded);
          tasks.push(store.loadObjectGroupChildren(child, { force: true }));
        }
      }
    }
  } else if (!refreshedNodeIds && searchExpansionState.shouldRestore(node.id)) {
    if (searchableObjectGroupTypes.has(node.type)) {
      if (searchAutoExpandedNodeIds.has(node.id)) {
        // Search opened this group on the user's behalf to check for matches;
        // once the query is gone there is nothing to show, so collapse it back
        // instead of reloading and leaving it open.
        node.isExpanded = false;
      } else {
        tasks.push(store.loadObjectGroupChildren(node, { force: true }));
      }
    } else if (simpleObjectParentTypes.has(node.type)) {
      tasks.push(store.refreshTreeNode(node));
    }
  }
  if (node.children) {
    for (const child of node.children) {
      collectExpandedObjectSearchTargets(child, tasks, refreshedNodeIds, preservesNodeSubtree, preservesSearchSubtree);
    }
  }
}

function restoreTrackedSearchTargets(): Promise<void>[] {
  if (!searchExpansionState.hasTrackedNodes()) return [];
  const tasks: Promise<void>[] = [];
  for (const root of store.treeNodes) {
    collectExpandedObjectSearchTargets(root, tasks);
  }
  searchExpansionState.clear();
  return tasks;
}

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
const sidebarListOptionsLabel = computed(() => `${t("sidebar.sortConnections")} / ${t("sidebar.filterByType")}`);
const sidebarListOptionItems = computed(() => [
  ...connectionListSortMenuItems.value.map((item, index) => ({
    ...item,
    value: `sort:${item.value}`,
    groupLabel: index === 0 ? t("sidebar.sortConnections") : undefined,
  })),
  ...searchScopeOptions.value.map((item, index) => ({
    value: `scope:${item.scope}`,
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
const selectedSidebarListOptions = computed(() => [`sort:${settingsStore.editorSettings.sidebarConnectionSortMode}`, ...selectedSearchScopes.value.map((scope) => `scope:${scope}`)]);
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
  void nextTick(() => {
    if (!isCurrentTableSearchInteraction(focusRestore) || !focusRestore.shouldRestoreFocus) return;
    const root = rootRef.value;
    if (!root) return;
    const input = Array.from(root.querySelectorAll<HTMLInputElement>("[data-sidebar-table-search-parent-id]")).find((item) => item.dataset.sidebarTableSearchParentId === focusRestore.parentNodeId);
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

const displayedTreeNodes = computed(() => sortConnectionListForDisplay(store.treeNodes, settingsStore.editorSettings.sidebarConnectionSortMode));
const localTableSearchResults = ref<Record<string, TableInfo[] | null>>({});
const localTableSearchRequestRevisions = new Map<string, number>();
type InvalidatedTableSearchScope = SidebarRegexScopeIdentity & { parentNodeId: string };
const pendingInvalidatedTableSearchScopes = new Map<string, InvalidatedTableSearchScope>();
const regexTableSearchScopes = shallowRef<SidebarRegexIndexScope[]>([]);

const localTableSearchParentTypes = new Set<TreeNodeType>(["database", "schema", "linked-server-schema", "group-tables"]);
const localTableSearchChildTypes = new Set<TreeNodeType>(["table", "view", "materialized_view"]);

function filterLocallySearchedTables(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    const children = node.children ? filterLocallySearchedTables(node.children) : undefined;
    const query = settingsStore.editorSettings.sidebarTableSearchLocal && localTableSearchParentTypes.has(node.type) ? store.sidebarTableSearchQueries[node.id]?.trim() : "";
    if (!query || !children) return children === node.children ? node : { ...node, children };

    const indexed = localTableSearchResults.value[node.id];
    // matchSidebarLabel compares case-insensitively internally and needs the
    // ORIGINAL label (and entry name) so camelCase boundaries stay detectable.
    const matchingChildren =
      indexed === null
        ? children.filter((child) => localTableSearchChildTypes.has(child.type) && !!matchSidebarLabel(child.label, query))
        : indexed
          ? reuseLiveSidebarTreeNodes(buildTableTreeNodes({ nodeId: node.id, connectionId: node.connectionId || "", database: node.database || "", schema: node.schema, catalog: node.catalog, tables: indexed.filter((entry) => !!matchSidebarLabel(entry.name, query)) }), children)
          : children.filter((child) => localTableSearchChildTypes.has(child.type) && !!matchSidebarLabel(child.label, query));
    return { ...node, children: matchingChildren };
  });
}

async function loadRegexTableSearchIndexes() {
  if (!regexMode.value || !deferredSearchQuery.value) return;
  const loadedScopes = await collectSidebarRegexIndexScopes(
    {
      loadSidebarTableSearchIndexScopes: () => store.loadSidebarTableSearchIndexScopes(),
      loadSidebarTableSearchIndex: (parent) => store.loadSidebarTableSearchIndex(parent.parentNodeId, parent),
    },
    store.treeNodes,
    () => !regexMode.value || deferredSearchQuery.value === "",
  );
  if (regexMode.value) {
    regexTableSearchScopes.value = loadedScopes;
  }
}

function filterGloballyIndexedRegexTables(nodes: TreeNode[]): TreeNode[] {
  if (!regexMode.value || !deferredSearchQuery.value) return nodes;
  const matcher = createSidebarLabelMatcher(deferredSearchQuery.value, { regexMode: true });
  const matchingScopes = regexTableSearchScopes.value.map((scope) => ({ ...scope, entries: scope.entries.filter((entry) => !!matcher(entry.name) || !!matcher(entry.comment || "")) })).filter((scope) => scope.entries.length > 0);
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
    // A missing persisted index (null) means this scope was never indexed, so
    // only the currently loaded first page of children is searchable. That
    // silently misses alphabetically-late tables (e.g. "T_Erp_Nc_SuPlan_List"
    // for "erpncs") until an explicit index refresh happens. Build the index
    // on the first search so results always cover the complete table set,
    // matching the behavior of an explicit refresh. The scope key deduplicates
    // concurrent full builds, and an empty (cleared) query never builds.
    const query = store.sidebarTableSearchQueries[parentNodeId]?.trim() ?? "";
    const entries = await loadOrBuildSidebarTableSearchIndex(
      parentNodeId,
      query,
      () => store.loadSidebarTableSearchIndex(parentNodeId, identity),
      () => store.refreshSidebarTableSearchIndex(parentNodeId, identity),
      refresh,
    );
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
      invalidateSidebarTableSearchBuild(scope.parentNodeId);
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

  nodes = filterLocallySearchedTables(nodes);
  nodes = filterGloballyIndexedRegexTables(nodes);

  const q = deferredSearchQuery.value;
  nodes = filterSidebarTree(nodes, q, searchCollapsedIds.value, searchableNodeTypes.value, {
    regexMode: regexMode.value,
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

// The plain (non-virtualized) renderer uses the same container selection as the
// virtual sticky overlay: database containers take precedence, while schema
// containers stick only in trees without a database-level container.
function isPlainStickyContainerNode(index: number): boolean {
  // Mirror the virtual branch's sticky overlay: both suppress sticky headers
  // while a search filter is active so filtered rows don't pin at the top.
  if (isTreeSearchFiltering.value) return false;
  return flatTreeIndex.value.stickyContainerIndexByIndex[index] === index;
}

const sidebarLayoutMonitor = createSidebarLayoutMonitor({
  readContext: () => ({
    flatNodeCount: flatNodes.value.length,
    useVirtualTree: useVirtualTree.value,
    virtualItemSize: SIDEBAR_TREE_ROW_HEIGHT,
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
  const label = sidebarTableNameDisplayTypes.has(node.type) ? sidebarDisplayTableName(node.label, settingsStore.editorSettings.sidebarHiddenTablePrefixes) : node.label;
  return node.valid === false ? `${label} · INVALID` : label;
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
  context.font = style.font || `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  sidebarCommentLabelWidths.value = alignedSidebarCommentLabelWidths(
    flatNodes.value.map(({ id, depth, node }) => ({
      id,
      depth,
      alignable: isSidebarCommentAlignableNode(node),
      hasComment: !!sidebarTreeNodeComment(node, settingsStore.editorSettings.sidebarShowConnectionNotes),
      labelWidth: context.measureText(sidebarCommentLabel(node)).width,
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

function sidebarNodeHasTrailingMetadata(node: TreeNode): boolean {
  const mode = settingsStore.editorSettings.sidebarObjectInfoMode;
  if (mode.startsWith("comment-") && sidebarTreeNodeComment(node, settingsStore.editorSettings.sidebarShowConnectionNotes)) return true;
  return mode === "size" && sidebarStorageDisplayTypes.has(node.type) && !!formatSidebarObjectStorage(node.sizeBytes);
}

const sidebarTreeNaturalWidthItems = computed(() =>
  flatNodes.value.map(({ depth, node }) => ({
    depth,
    label: sidebarCommentLabel(node),
    usesNaturalWidth: usesFullWidthTreeLabel(node.type, settingsStore.editorSettings.sidebarAllowHorizontalScroll, sidebarNodeHasTrailingMetadata(node)),
    trailingWidth: node.pinned || store.isTreeNodePinned(node) ? 20 : 0,
  })),
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
  sidebarTreeContentWidth.value = sidebarTreeNaturalContentWidth(sidebarTreeNaturalWidthItems.value, (text) => context.measureText(text).width, settingsStore.editorSettings.sidebarIndent);
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
    flatNodes,
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

watch([sidebarTreeNaturalWidthItems, () => settingsStore.editorSettings.uiFontFamily, () => settingsStore.editorSettings.uiScale, () => settingsStore.editorSettings.sidebarIndent, () => settingsStore.editorSettings.sidebarFontSize], scheduleSidebarTreeContentWidthMeasure, {
  flush: "post",
  immediate: true,
});

const visibleSidebarTableStorageScopes = computed(() => {
  if (settingsStore.editorSettings.sidebarObjectInfoMode !== "size") return [];
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
// RecycleScroller positions each row absolutely, so CSS `position: sticky` on
// a database row can't work. Instead we overlay a pinned row from this parent
// component, tracking scroll offset to find the topmost visible database-level
// ancestor. The overlay reuses <TreeItem>, so collapse/expand comes for free.
const stickyScrollTop = ref(0);
const sidebarScrollMetrics = ref({ scrollTop: 0, scrollLeft: 0, clientHeight: 0, clientWidth: 0, scrollHeight: 0, scrollWidth: 0 });
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
    return;
  }

  if (useVirtualTree.value) stickyScrollTop.value = scroller.scrollTop;
  sidebarScrollMetrics.value = {
    scrollTop: scroller.scrollTop,
    scrollLeft: scroller.scrollLeft,
    clientHeight: scroller.clientHeight,
    clientWidth: scroller.clientWidth,
    scrollHeight: scroller.scrollHeight,
    scrollWidth: Math.max(scroller.scrollWidth, sidebarTreeContentWidth.value),
  };
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

const stickyNode = computed<FlatTreeNode | null>(() => {
  if (!useVirtualTree.value || isTreeSearchFiltering.value) return null;
  const nodes = flatNodes.value;
  const len = nodes.length;
  if (len === 0) return null;

  const topIndex = Math.min(Math.floor(stickyScrollTop.value / SIDEBAR_TREE_ROW_HEIGHT), len - 1);
  const containerIndex = flatTreeIndex.value.stickyContainerIndexByIndex[topIndex] ?? -1;
  if (containerIndex < 0) return null;
  return stickyScrollTop.value > containerIndex * SIDEBAR_TREE_ROW_HEIGHT ? nodes[containerIndex] : null;
});

const stickyHeaderStyle = computed<CSSProperties>(() => {
  const node = stickyNode.value;
  if (!node) return {};
  const currentIndex = flatTreeIndex.value.flatNodeIndexById.get(node.id) ?? -1;
  if (currentIndex < 0) return {};
  // The next peer index is precomputed with the flat-tree snapshot so scrolling
  // never scans the remaining tree. Connection boundaries reset the lookup.
  const nextDatabaseIndex = SCHEMA_LEVEL_TYPES.has(node.type) ? flatTreeIndex.value.nextSchemaContainerIndexByIndex[currentIndex] : flatTreeIndex.value.nextDatabaseContainerIndexByIndex[currentIndex];
  if (nextDatabaseIndex < 0) return {};
  const distanceToNext = nextDatabaseIndex * SIDEBAR_TREE_ROW_HEIGHT - stickyScrollTop.value;
  if (distanceToNext >= SIDEBAR_TREE_ROW_HEIGHT) return {};
  return {
    transform: `translateY(${Math.min(0, distanceToNext - SIDEBAR_TREE_ROW_HEIGHT)}px)`,
  };
});

// Reset tracking when the tree rebuilds (connect/disconnect/collapse) so a
// stale scrollTop doesn't keep the overlay mounted after a structural change.
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
  stickyScrollTop.value = 0;
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
  getProjectedConnectionIds: () => projectedConnectionIds.value,
  // Cover both sides of the input debounce: the immediate query prevents a
  // collapse while a projection is about to start, and the deferred query
  // keeps the currently rendered projection alive while clearing settles.
  isSearchProjectionActive: () => isTreeSearchFiltering.value || !!deferredSearchQuery.value,
  getTreeLoadSearchOptions: (node) => {
    const query = deferredSearchQuery.value;
    if (regexMode.value) {
      // Explicit expansion stays allowed and may connect, but must never send
      // the regex expression as a remote search filter.
      return { searchFilter: "", allowGlobalSearchMismatch: true, expectedSidebarSearchQuery: "" };
    }
    if (!query) return undefined;
    const searchFilter = resolveSidebarObjectSearchFilter(store.treeNodes, node.id, query, searchableNodeTypes.value);
    return searchFilter ? undefined : { searchFilter: "", allowGlobalSearchMismatch: true, expectedSidebarSearchQuery: query };
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
  refreshTableSearchIndex: (parentNodeId) => void loadLocalTableSearchResults(parentNodeId, true),
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
  if (!useVirtualTree.value || !sticky || sticky.id === nodeId) return 0;
  return SIDEBAR_TREE_ROW_HEIGHT;
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
    topOcclusionHeight: topOcclusionHeightForSidebarNode(nodeId),
    ...(options?.align ? { align: options.align } : {}),
  });
  if (nextScrollTop !== scroller.scrollTop) {
    scroller.scrollTop = nextScrollTop;
  }
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

async function locateActiveTabInSidebar() {
  await locateTabInSidebar(activeTab.value, "smart");
}

async function locateTabInSidebar(tab: QueryTab | undefined | null, align: SidebarNodeScrollAlign = "center") {
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
  const fallbackTarget = locatesSavedSql ? tabTarget : (queryContextTargetFromCandidate(tab, cursorCandidate) ?? tabTarget);
  const initialTarget = cursorCandidate ? tableTargetFromCandidate(cursorCandidate) : fallbackTarget;
  if (!initialTarget) return;

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
  await ensureTreeLoadedForTarget(treeLoadTarget);

  // Clear any active search filter so the node is visible
  if (isRootListPartial.value) {
    searchQuery.value = "";
    deferredSearchQuery.value = "";
    showConnectedConnectionsOnly.value = false;
    clearSearchScopeFilter();
  }

  let target = resolveLoadedLocateTarget(initialTarget, cursorCandidate);
  let nodePath = target ? findNodePathForTarget(target, store.treeNodes) : null;
  if (!nodePath && !locatesSavedSql) {
    // The first load may have served a stale schema cache whose async refresh
    // replaced the database node before its tables finished loading, so the
    // table isn't in the tree yet. Force a synchronous reload and retry once so
    // locate reaches the table, not just the database (issue #715).
    await ensureTreeLoadedForTarget(treeLoadTarget, { force: true });
    target = resolveLoadedLocateTarget(initialTarget, cursorCandidate);
    nodePath = target ? findNodePathForTarget(target, store.treeNodes) : null;
  }

  if (!nodePath && cursorCandidate) {
    await store.loadTableForLocate(cursorCandidate);
    target = resolveLoadedLocateTarget(initialTarget, cursorCandidate);
    nodePath = target ? findNodePathForTarget(target, store.treeNodes) : null;
  }

  if (!nodePath && cursorCandidate && fallbackTarget) {
    await ensureTreeLoadedForTarget(fallbackTarget);
    target = fallbackTarget;
    nodePath = findNodePathForTarget(fallbackTarget, store.treeNodes);
  }

  if (!nodePath) return;

  for (const ancestor of nodePath) {
    // Only flip the arrow when this node's own children are already loaded
    // (e.g. by ensureTreeLoadedForTarget above). Forcing isExpanded on a
    // table/collection whose column/index groups were never fetched shows an
    // "expanded" arrow with no content underneath (issue #5850).
    if (!ancestor.isExpanded && store.canUseLoadedTreeNodeToggle(ancestor)) {
      ancestor.isExpanded = true;
    }
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

  await nextTick();

  const match = target ? findSidebarNodeForTarget(target, flatNodes.value) : null;
  if (!match) return;

  store.selectedTreeNodeId = match.id;
  store.selectedTreeNodeIds = [match.id];
  store.treeSelectionAnchorId = match.id;
  await nextTick();

  await scrollToSidebarNode(match.id, { align });
  await flashSidebarNode(match.id);
}

function tableTargetFromCandidate(candidate: QueryCursorTableCandidate): ActiveTabSidebarTarget {
  return {
    type: "table",
    connectionId: candidate.connectionId,
    database: candidate.database,
    schema: candidate.schema,
    tableName: candidate.tableName,
  };
}

function resolveLoadedLocateTarget(target: ActiveTabSidebarTarget, candidate: QueryCursorTableCandidate | null): ActiveTabSidebarTarget | null {
  if (!candidate) return target;
  return findLoadedTableTargetForCandidate(store.treeNodes, candidate);
}

async function ensureTreeLoadedForTarget(target: ActiveTabSidebarTarget, opts?: { force?: boolean }) {
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

  // Ensure databases are loaded under the connection
  const connNode = findSidebarConnectionNode(store.treeNodes, connId);
  if (connNode && (force || !connNode.children || connNode.children.length === 0)) {
    try {
      if (config.db_type === "redis") {
        await store.loadRedisDatabases(connId);
      } else if (config.db_type === "mongodb") {
        await store.loadMongoDatabases(connId);
      } else if (config.db_type === "dynamodb") {
        await store.loadDynamoDbTables(connId);
      } else if (config.db_type === "elasticsearch" || config.db_type === "easysearch" || config.db_type === "meilisearch") {
        await store.loadElasticsearchIndices(connId);
      } else if (config.db_type === "qdrant" || config.db_type === "milvus" || config.db_type === "weaviate" || config.db_type === "chromadb") {
        await store.loadVectorCollections(connId);
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

  const usesExactCatalogScope = target.type === "query-context";
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
  const dbNode = findDatabaseNode(store.treeNodes, connId, target.database, targetCatalog, usesExactCatalogScope);
  if (!dbNode) return;
  const targetSchema = "schema" in target ? target.schema : undefined;
  const databaseChildrenLoaded = !!dbNode.children && dbNode.children.length > 0;
  const effectiveDbType = effectiveDatabaseTypeForConnection(config);
  const usesSchemaTree = usesTreeSchemaMode(effectiveDbType) && !connectionUsesDatabaseObjectTreeMode(config);
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
  if (node.isExpanded) next.add(node.id);
  else next.delete(node.id);
  searchCollapsedIds.value = next;
}

function onNodeToggled(node: TreeNode, expanded: boolean) {
  if (isTreeSearchFiltering.value) return;
  sidebarLayoutMonitor.recordEvent({
    type: "expand-toggle",
    nodeId: node.id,
    label: node.label,
    nodeType: node.type,
    expanded,
  });
  syncSidebarTreeNodeExpansion(store.treeNodes, node, expanded);
}

function openSidebarContextMenu(event: MouseEvent, node: TreeNode, openContextMenu: (event: MouseEvent, itemsOverride?: ContextMenuItem[]) => void) {
  const items = sidebarTreeRuntime.buildContextMenu(node);
  sidebarContextMenuTarget.value = createSidebarActionTarget(node);
  sidebarContextMenuItems.value = items;
  // Pass the current row's resolved menu atomically. Waiting for the items prop
  // to flush would let the singleton menu briefly reuse the previous row menu.
  openContextMenu(event, items);
}

function openSidebarDangerDialog(request: SidebarDangerDialogRequest) {
  if (sidebarDangerRunningExecutionId.value) {
    toast(t("contextMenu.dangerOperationAlreadyRunning"), 4000);
    return;
  }
  sidebarDangerDialogRequest.value = request;
  sidebarDangerDialogConfirming.value = false;
  // Defense in depth: sidebarDangerDialogCancelling is a singleton shared
  // across every danger dialog. It should already settle on its own (see
  // confirmCancelWithRetryAndTimeout), but a fresh dialog must never inherit
  // a stuck "cancelling" state from a previous one.
  sidebarDangerDialogCancelling.value = false;
  sidebarDangerDialogOpen.value = true;
}

async function confirmSidebarDangerDialog() {
  const request = sidebarDangerDialogRequest.value;
  if (!request || sidebarDangerDialogConfirming.value) return;
  if (request.closeOnConfirm !== false) sidebarDangerDialogOpen.value = false;
  sidebarDangerDialogConfirming.value = true;
  let completed: void | boolean = undefined;
  try {
    completed = await request.confirm();
  } finally {
    // A danger operation that hit a client-observed timeout is kept alive
    // (still cancellable) rather than settled outright — sidebarDangerRunningExecutionId
    // stays populated in that case, so keep the dialog "loading" (Cancel
    // Query still live, manual dismiss blocked) instead of closing on a
    // stale timeout result. The watcher below finishes the job once the
    // execution actually settles.
    if (!sidebarDangerRunningExecutionId.value) {
      sidebarDangerDialogConfirming.value = false;
      if (completed !== false) sidebarDangerDialogOpen.value = false;
    }
  }
}

// Finishes closing a danger dialog left open past a client-observed timeout
// once the deferred execution is actually confirmed cancelled — see
// confirmSidebarDangerDialog above.
watch(sidebarDangerRunningExecutionId, (value) => {
  if (!value && sidebarDangerDialogConfirming.value) {
    sidebarDangerDialogConfirming.value = false;
    sidebarDangerDialogOpen.value = false;
  }
});

async function cancelSidebarDangerDialogRunning() {
  const request = sidebarDangerDialogRequest.value;
  if (!request?.cancelRunning || sidebarDangerDialogCancelling.value) return;
  sidebarDangerDialogCancelling.value = true;
  try {
    await request.cancelRunning();
  } catch (error: any) {
    // Current cancelRunning implementations already swallow their own
    // rejections; this is a defensive fallback so the user still gets
    // feedback if a future implementation throws instead.
    toast(t("contextMenu.tableOperationFailed", { message: error?.message || String(error) }), 5000);
  } finally {
    sidebarDangerDialogCancelling.value = false;
  }
}

function updateSidebarDangerDialogOption(event: Event, optionOverride?: SidebarDangerDialogOption) {
  const option = optionOverride ?? sidebarDangerDialogRequest.value?.option;
  if (!option) return;
  option.checked = (event.target as HTMLInputElement).checked;
  void option.onChange?.(option.checked);
}

function updateSidebarDangerDialogTextInput(value: string | number) {
  const input = sidebarDangerDialogRequest.value?.textInput;
  if (!input) return;
  input.value = String(value);
  void input.onInput?.(input.value);
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

function beginSidebarAction(): number {
  sidebarActionGeneration += 1;
  sidebarDdlOpen.value = false;
  sidebarObjectSourceOpen.value = false;
  sidebarProcedureOpen.value = false;
  sidebarVisibleDatabasesOpen.value = false;
  sidebarVisibleSchemasOpen.value = false;
  sidebarVisibleNacosNamespacesOpen.value = false;
  sidebarTableNameFilterOpen.value = false;
  sidebarDdlTarget.value = null;
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
  if (!node.connectionId || !node.database) return;
  beginSidebarAction();
  sidebarDdlTarget.value = createSidebarActionTarget(node);
  sidebarDdlOpen.value = true;
}

function openSidebarDdlForSelection(): boolean {
  const selectedNodeId = store.selectedTreeNodeId;
  const node = selectedNodeId ? flatTreeIndex.value.nodeById.get(selectedNodeId) : null;
  if (!node || !sidebarNodeSupportsDdlView(node)) return false;
  openSidebarDdl(node);
  return true;
}

function openSidebarObjectSource(node: TreeNode, initialEditing: boolean) {
  if (!node.connectionId || !node.database || !objectSourceTargetForTreeNode(node)) return;
  // TYPE/TYPE_BODY only have a source implementation on Xugu; PostgreSQL-family
  // connections list user-defined types without a CREATE TYPE getter this cycle.
  if ((node.type === "type" || node.type === "type-body") && !supportsTypeObjectSource(store.getConfig(node.connectionId)?.db_type)) return;
  const target = createSidebarActionTarget(node);
  const requestGeneration = beginSidebarAction();
  void store
    .ensureConnected(target.connectionId!)
    .then(() => {
      if (requestGeneration !== sidebarActionGeneration) return;
      store.activeConnectionId = target.connectionId!;
      sidebarObjectSourceTarget.value = { node: target, initialEditing };
      sidebarObjectSourceOpen.value = true;
    })
    .catch((error: any) => {
      if (requestGeneration === sidebarActionGeneration) toast(error?.message || String(error), 5000);
    });
}

function openSidebarSettings(initialTab: string) {
  emit("open-settings", initialTab);
}

function openSidebarProcedure(node: TreeNode) {
  if (node.type !== "procedure" || !node.connectionId || !node.database) return;
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
  if (!node.connectionId || !node.database) return null;
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
  const target = sidebarObjectSourceTarget.value?.node || sidebarDdlTarget.value || sidebarInstallExtensionTarget.value;
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

watch(sidebarObjectSourceOpen, (open) => {
  if (!open) sidebarObjectSourceTarget.value = null;
});

watch(sidebarProcedureOpen, (open) => {
  if (!open) sidebarProcedureTarget.value = null;
});

watch(sidebarVisibleDatabasesOpen, (open) => {
  if (!open) sidebarVisibleDatabasesTarget.value = null;
});

watch(sidebarVisibleSchemasOpen, (open) => {
  if (!open) sidebarVisibleSchemasTarget.value = null;
});

watch(sidebarVisibleNacosNamespacesOpen, (open) => {
  if (!open) sidebarVisibleNacosNamespacesTarget.value = null;
});

watch(sidebarTableNameFilterOpen, (open) => {
  if (!open) sidebarTableNameFilterTarget.value = null;
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
  const match = findSidebarNodeForActiveTab(activeTab.value, flatNodes.value);
  if (!match) return;

  store.selectedTreeNodeId = match.id;
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

function focusSearch(): boolean {
  const input = searchInputRef.value;
  if (!input) return false;
  input.focus();
  input.select();
  return true;
}

function onSearchKeydown(event: KeyboardEvent) {
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
  if (!(target instanceof HTMLElement)) return true;
  return !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable || !!target.closest("[contenteditable='true'], [role='textbox']"));
}

function selectedSidebarNodesInVisibleOrder(): TreeNode[] {
  const selectedIds = new Set(store.selectedTreeNodeIds);
  return visibleNodes.value.filter((node) => selectedIds.has(node.id));
}

function isEditConnectionShortcut(event: KeyboardEvent): boolean {
  return isEditSidebarConnectionShortcut(event, settingsStore.editorSettings.shortcuts);
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
  copyToClipboard(nodes.map(copyNameForTreeNode).join("\n"))
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
  sidebarLayoutMonitor.dispose();
  sidebarTreeRuntime.dispose();
  sidebarActionGeneration += 1;
  sidebarContextMenuTarget.value = null;
  sidebarContextMenuItems.value = [];
  sidebarDdlTarget.value = null;
  sidebarObjectSourceTarget.value = null;
  sidebarProcedureTarget.value = null;
  sidebarVisibleDatabasesTarget.value = null;
  sidebarVisibleSchemasTarget.value = null;
  sidebarVisibleNacosNamespacesTarget.value = null;
  sidebarTreeItemDialogController.value = null;
  sidebarDangerDialogRequest.value = null;
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

defineExpose({ focusSearch, createNewGroup, collapseAllTreeNodes, locateTabInSidebar });
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
      @open-object-source="openSidebarObjectSource"
      @open-procedure="openSidebarProcedure"
      @open-settings="openSidebarSettings"
      @open-data="openSidebarData"
      @open-visible-databases="openSidebarVisibleDatabases"
      @open-visible-schemas="openSidebarVisibleSchemas"
      @open-visible-nacos-namespaces="openSidebarVisibleNacosNamespaces"
      @open-table-name-filters="openSidebarTableNameFilters"
      @add-to-ai="(node) => emit('add-to-ai', node)"
      @request-connection-rename="startRenamingConnectionNode"
      @request-group-rename="startRenamingCreatedGroup"
      @request-saved-sql-rename="startRenamingSavedSqlNode"
      @open-danger-dialog="openSidebarDangerDialog"
      @open-dialog-controller="updateSidebarTreeItemDialogController"
      @open-install-extension="openSidebarInstallExtension"
      @open-extension-details="openSidebarExtensionDetails"
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
              <button
                type="button"
                class="flex h-5 min-w-5 items-center justify-center rounded-sm px-0.5 text-[10px] font-mono text-muted-foreground hover:bg-accent hover:text-foreground"
                :class="{ 'text-primary bg-primary/10': regexMode, 'text-destructive': regexMode && compileSearchRegex(searchQuery).invalid }"
                :aria-label="t('sidebar.regexSearch')"
                :aria-pressed="regexMode"
                @click="regexMode = !regexMode"
              >
                .*
              </button>
            </LightTooltip>
            <LightTooltip :text="t('sidebar.globalLocalSearchTooltip')" side="top" :delay="300">
              <Switch size="sm" :model-value="settingsStore.editorSettings.sidebarGlobalSearchLocal" :disabled="regexMode" :aria-label="t('sidebar.globalLocalSearch')" @update:model-value="settingsStore.updateEditorSettings({ sidebarGlobalSearchLocal: Boolean($event) })" />
            </LightTooltip>
          </div>
        </div>
        <LightTooltip :text="t('sidebar.locateActiveTab')" side="top" :delay="300" nowrap>
          <button type="button" class="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground" :aria-label="t('sidebar.locateActiveTab')" @click="locateActiveTabInSidebar">
            <LocateFixed class="h-3.5 w-3.5" />
          </button>
        </LightTooltip>
        <LightTooltip :text="sidebarListOptionsLabel" side="top" :delay="300" nowrap>
          <span class="inline-flex">
            <LightDropdown
              model-value=""
              :items="sidebarListOptionItems"
              :selected-values="selectedSidebarListOptions"
              :aria-label="sidebarListOptionsLabel"
              :trigger-icon="SlidersHorizontal"
              :trigger-class="['shrink-0 h-6 w-6 flex items-center justify-center rounded border border-border hover:bg-accent', hasCustomSidebarListOptions ? 'text-primary bg-primary/10 border-primary/30' : 'text-muted-foreground'].join(' ')"
              trigger-icon-class="h-3.5 w-3.5"
              item-icon-class="h-3.5 w-3.5"
              content-class="w-max min-w-0"
              selected-item-class="bg-primary/10 text-primary"
              selected-check-class="text-primary"
              :show-trigger-label="false"
              :show-chevron="false"
              :close-on-select="false"
              align="end"
              @update:model-value="selectSidebarListOption"
            />
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
          :items="flatNodes"
          :item-size="SIDEBAR_TREE_ROW_HEIGHT"
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
          <TreeItem
            :node="stickyNode.node"
            :depth="stickyNode.depth"
            :reorder-disabled="true"
            :reference-drag-disabled="true"
            :comment-label-width="sidebarCommentLabelWidths.get(stickyNode.node.id)"
            @context-menu="(event, node) => openSidebarContextMenu(event, node, contextMenuSlot.onContextMenu)"
          />
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
        <div ref="plainTreeScrollerRef" class="sidebar-tree connection-tree-scroller h-full overflow-y-auto" :class="sidebarTreeOverflowClass" :style="sidebarTreeScrollerStyle" @click="clearSidebarSelection" @scroll.passive="onTreeScroll">
          <div class="connection-tree-content">
            <TreeItem
              v-for="(item, index) in flatNodes"
              :key="item.renderKey"
              :node="item.node"
              :depth="item.depth"
              :reorder-disabled="isRootListPartial"
              :move-to-group-only="isConnectionListAlphabeticallySorted"
              :pending-rename="pendingRenameNodeId === item.node.id"
              :highlighted="highlightedNodeId === item.id"
              :comment-label-width="sidebarCommentLabelWidths.get(item.node.id)"
              :sticky-header="isPlainStickyContainerNode(index)"
              @context-menu="(event, node) => openSidebarContextMenu(event, node, contextMenuSlot.onContextMenu)"
              @rename-started="pendingRenameNodeId = null"
              @group-created="startRenamingCreatedGroup"
            />
          </div>
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

    <SidebarObjectSourceDialog
      v-if="sidebarObjectSourceTarget && sidebarObjectSourceType"
      v-model:open="sidebarObjectSourceOpen"
      :connection-id="sidebarObjectSourceTarget.node.connectionId!"
      :database="sidebarObjectSourceTarget.node.database!"
      :schema="sidebarObjectSourceResolvedTarget?.schema"
      :name="sidebarObjectSourceResolvedTarget!.name"
      :relation-name="sidebarObjectSourceTarget.node.tableName"
      :signature="sidebarObjectSourceResolvedTarget?.signature"
      :object-type="sidebarObjectSourceType"
      :database-type="sidebarObjectSourceDatabaseType"
      :dialect="sidebarObjectSourceDialect"
      :format-dialect="sidebarObjectSourceFormatDialect"
      :initial-editing="sidebarObjectSourceTarget.initialEditing"
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
      :connection-name="sidebarVisibleSchemasTarget.label"
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
    <SidebarDangerConfirmDialog
      v-if="sidebarDangerDialogRequest"
      v-model:open="sidebarDangerDialogOpen"
      :title="sidebarDangerDialogRequest.title"
      :message="sidebarDangerDialogRequest.message"
      :sql="sidebarDangerDialogRequest.sql"
      :details="sidebarDangerDialogRequest.details"
      :details-text="sidebarDangerDialogRequest.detailsText"
      :confirm-label="sidebarDangerDialogRequest.confirmLabel"
      :loading="sidebarDangerDialogConfirming || sidebarDangerDialogRequest.loading"
      :close-on-confirm="false"
      :cancelable="!!sidebarDangerDialogRequest.cancelRunning"
      :cancel-running-loading="sidebarDangerDialogCancelling"
      @confirm="confirmSidebarDangerDialog"
      @cancel-running="cancelSidebarDangerDialogRunning"
    >
      <template #options>
        <div v-if="sidebarDangerDialogConfirming && sidebarDangerDialogRequest.progress" class="mb-3 rounded-md border bg-muted/20 px-3 py-2.5">
          <div class="mb-1.5 flex items-center justify-between text-xs tabular-nums text-muted-foreground">
            <span>{{ sidebarDangerDialogRequest.progress.completed }} / {{ sidebarDangerDialogRequest.progress.total }}</span>
            <span>{{ Math.round((sidebarDangerDialogRequest.progress.completed / sidebarDangerDialogRequest.progress.total) * 100) }}%</span>
          </div>
          <div class="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" :aria-valuemin="0" :aria-valuemax="sidebarDangerDialogRequest.progress.total" :aria-valuenow="sidebarDangerDialogRequest.progress.completed">
            <div class="h-full bg-primary transition-[width] duration-200" :style="{ width: `${Math.round((sidebarDangerDialogRequest.progress.completed / sidebarDangerDialogRequest.progress.total) * 100)}%` }" />
          </div>
        </div>
        <div v-if="sidebarDangerDialogRequest.options?.length" class="mb-3 flex flex-wrap gap-2">
          <template v-for="(option, optionIndex) in sidebarDangerDialogRequest.options ?? []" :key="`danger-option-${optionIndex}`">
            <label class="flex items-start gap-2 rounded-md border px-3 py-2 text-sm" :class="[option.compact ? 'min-w-32 flex-1' : 'w-full', option.danger && option.checked ? 'border-destructive/50 bg-destructive/10' : 'bg-muted/20']" :title="option.compact ? option.hint : undefined">
              <input :checked="option.checked" :disabled="sidebarDangerDialogConfirming" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0" :class="option.danger ? 'accent-destructive' : 'accent-primary'" @change="updateSidebarDangerDialogOption($event, option)" />
              <span class="grid gap-0.5">
                <span class="font-medium" :class="option.danger && option.checked ? 'text-destructive' : 'text-foreground'">{{ option.label }}</span>
                <span v-if="!option.compact" class="text-xs leading-5 text-muted-foreground">{{ option.hint }}</span>
              </span>
            </label>
          </template>
        </div>
        <label v-if="sidebarDangerDialogRequest.option" class="mb-3 flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm">
          <input :checked="sidebarDangerDialogRequest.option.checked" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" @change="updateSidebarDangerDialogOption" />
          <span class="grid gap-0.5">
            <span class="font-medium text-foreground">{{ sidebarDangerDialogRequest.option.label }}</span>
            <span class="text-xs leading-5 text-muted-foreground">{{ sidebarDangerDialogRequest.option.hint }}</span>
          </span>
        </label>
        <label v-if="sidebarDangerDialogRequest.textInput" class="mb-3 grid gap-1.5 rounded-md border bg-muted/20 px-3 py-2 text-sm">
          <span class="font-medium text-foreground">{{ sidebarDangerDialogRequest.textInput.label }}</span>
          <Input :model-value="sidebarDangerDialogRequest.textInput.value" :inputmode="sidebarDangerDialogRequest.textInput.inputMode" :placeholder="sidebarDangerDialogRequest.textInput.placeholder" @update:model-value="updateSidebarDangerDialogTextInput" />
        </label>
      </template>
    </SidebarDangerConfirmDialog>
    <SidebarTreeItemDialogs v-if="sidebarTreeItemDialogController" :key="sidebarTreeItemDialogController.node?.id" :controller="sidebarTreeItemDialogController" @closed="sidebarTreeItemDialogController = null" />
    <InstallExtensionDialog v-if="sidebarInstallExtensionTarget" ref="sidebarInstallExtensionDialogRef" :node="sidebarInstallExtensionTarget" @close="refreshSidebarActionTarget" @changed="refreshSidebarActionTarget" />
    <ExtensionDetailsDialog v-if="sidebarExtensionDetailsTarget" ref="sidebarExtensionDetailsDialogRef" :node="sidebarExtensionDetailsTarget" />
    <div v-if="store.treeNodes.length === 0" class="px-3 py-8 text-center text-muted-foreground text-xs">
      {{ t("sidebar.noConnections") }}
    </div>
  </div>
</template>

<style scoped>
.sticky-database-header {
  background-color: var(--background);
}

.connection-tree-scroller {
  will-change: scroll-position;
  contain: content;
  scrollbar-width: none;
  -ms-overflow-style: none;
  overflow-anchor: none;
}

.connection-tree-scroller::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.connection-tree-scroller :deep(.vue-recycle-scroller__item-view) {
  min-width: 100%;
  contain: style;
  /* The virtual renderer positions rows at fixed item-size offsets (28px, see
     SIDEBAR_TREE_ROW_HEIGHT). TreeItem rows only guarantee min-h-7, so rename
     inputs or larger sidebar fonts could grow a row beyond 28px and overlap
     the next row. Pin every materialized row to the fixed height and clip any
     overflow instead of letting the layout drift. */
  height: 28px;
  overflow: hidden;
}

.connection-tree-scroller.sidebar-tree-horizontal-scroll :deep(.vue-recycle-scroller__item-view) {
  width: max-content;
}

.connection-tree-scroller.sidebar-tree-horizontal-scroll :deep(.connection-tree-content),
.connection-tree-scroller.sidebar-tree-horizontal-scroll > .connection-tree-content {
  min-width: max(100%, var(--sidebar-tree-content-width));
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

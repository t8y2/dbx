<script setup lang="ts">
import { ref, computed, nextTick, watch, provide, onMounted, onUnmounted, type Component, type ComponentPublicInstance, type CSSProperties } from "vue";
import { useI18n } from "vue-i18n";
import { Search, X, ListFilter, ListOrdered, ArrowDownAZ, ArrowUpZA, Crosshair, Server, Database, FolderTree, Table2, Eye, RotateCcw } from "@lucide/vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import type { ObjectSourceKind, TreeNode, TreeNodeType } from "@/types/database";
import { filterSidebarSearchRootsByConnectionState, filterSidebarTree } from "@/lib/sidebar/sidebarSearchTree";
import { isCancelSearchShortcut, isCopySidebarSelectionShortcut, isEditSidebarConnectionShortcut, isPasteSidebarSelectionShortcut } from "@/lib/editor/keyboardShortcuts";
import { copyNameForTreeNode, objectSourceKindForTreeNode } from "@/lib/sidebar/treeNodeClick";
import { copyToClipboard } from "@/lib/common/clipboard";
import { connectionPasteTargetGroupId, selectedConnectionClipboardNodes, selectedConnectionEditTarget } from "@/lib/sidebar/sidebarConnectionSelection";
import { isEditableSidebarTypeSearchTarget, sidebarTypeSearchNextQuery } from "@/lib/sidebar/sidebarTypeSearch";
import { usesTreeSchemaMode } from "@/lib/database/databaseFeatureSupport";
import { connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { activeTabSidebarTarget, findSidebarNodeForActiveTab, findSidebarNodeForTarget, findNodePathForTarget, scrollTopForSidebarNode, shouldScrollActiveSidebarSelection, type ActiveTabSidebarTarget, type SidebarNodeScrollAlign } from "@/lib/sidebar/sidebarActiveTabTarget";
import { findLoadedTableTargetForCandidate, queryContextTargetFromCandidate, queryCursorTableCandidate, type QueryCursorTableCandidate } from "@/lib/sql/queryCursorTableTarget";
import { createFlatTreeIndex, SIDEBAR_TREE_ROW_HEIGHT, SIDEBAR_TREE_PRERENDER_COUNT, SIDEBAR_TREE_SCROLL_BUFFER, flattenTree, shouldVirtualizeFlatTree, type FlatTreeNode } from "@/composables/useFlatTree";
import { sidebarTreeContextKey } from "@/lib/sidebar/sidebarTreeContext";
import { createSidebarTreeRuntime, sidebarTreeRuntimeKey, type SidebarTreeRuntimeHostInstance } from "@/lib/sidebar/sidebarTreeRuntime";
import { createSidebarPasteHandlerRegistry } from "@/lib/sidebar/sidebarPasteHandlerRegistry";
import { insertSidebarTableSearchControls, isSidebarTableSearchControlNode } from "@/lib/sidebar/sidebarTableSearchControl";
import TreeItem from "./TreeItem.vue";
import SidebarTreeRuntimeHost from "./SidebarTreeRuntimeHost.vue";
import SidebarTreeItemDialogs from "./SidebarTreeItemDialogs.vue";
import InstallExtensionDialog from "@/components/objects/InstallExtensionDialog.vue";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import LightDropdown from "@/components/ui/LightDropdown.vue";
import { cancelPendingSidebarDataOpen, runSidebarDataOpenImmediately, type SidebarDataOpenRequest } from "@/lib/sidebar/sidebarDataOpenCoordinator";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { codeMirrorSqlDialect } from "@/lib/database/jdbcDialect";
import { sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";
import { createSidebarActionTarget, findSidebarActionTarget, type SidebarActionTarget } from "@/lib/sidebar/sidebarActionTarget";
import type { SidebarDangerDialogRequest } from "@/lib/sidebar/sidebarDangerDialog";
import { resetSidebarTreeDialogState } from "./sidebarTreeDialogState";
import { SidebarDangerConfirmDialog, SidebarDdlViewDialog, SidebarObjectSourceDialog, SidebarProcedureExecutionDialog, SidebarVisibleDatabasesDialog, SidebarVisibleSchemasDialog } from "./sidebarAsyncDialogs";
import { sortConnectionListForDisplay } from "@/lib/sidebar/connectionListSort";

const { t } = useI18n();
const store = useConnectionStore();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const { toast } = useToast();
const searchQuery = ref("");
const deferredSearchQuery = ref("");
const searchInputRef = ref<HTMLInputElement>();
const rootRef = ref<HTMLElement>();
const pointerInsideTree = ref(false);
const treeScrollerRef = ref<InstanceType<typeof RecycleScroller> | null>(null);
const plainTreeScrollerRef = ref<HTMLElement | null>(null);
const sidebarScrollbarTrackRef = ref<HTMLElement | null>(null);
const sidebarContextMenuRef = ref<{ close: () => void } | null>(null);
const sidebarContextMenuItems = ref<ContextMenuItem[]>([]);
const sidebarContextMenuTarget = ref<SidebarActionTarget | null>(null);
const sidebarDangerDialogRequest = ref<SidebarDangerDialogRequest | null>(null);
const sidebarDangerDialogOpen = ref(false);
const sidebarDangerDialogConfirming = ref(false);
const sidebarTreeItemDialogController = ref<Record<string, any> | null>(null);
const sidebarInstallExtensionTarget = ref<TreeNode | null>(null);
const sidebarInstallExtensionDialogRef = ref<InstanceType<typeof InstallExtensionDialog> | null>(null);
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
let sidebarActionGeneration = 0;
const sidebarDdlDatabaseType = computed(() => {
  const connectionId = sidebarDdlTarget.value?.connectionId;
  return connectionId ? effectiveDatabaseTypeForConnection(store.getConfig(connectionId)) : undefined;
});
const sidebarObjectSourceType = computed(() => (sidebarObjectSourceTarget.value ? objectSourceKindForTreeNode(sidebarObjectSourceTarget.value.node.type) : null));
const sidebarObjectSourceDatabaseType = computed(() => {
  const connectionId = sidebarObjectSourceTarget.value?.node.connectionId;
  return connectionId ? effectiveDatabaseTypeForConnection(store.getConfig(connectionId)) : undefined;
});
const sidebarObjectSourceDialect = computed(() => codeMirrorSqlDialect(sidebarObjectSourceDatabaseType.value));
const sidebarObjectSourceFormatDialect = computed(() => sqlFormatDialectForDbType(sidebarObjectSourceDatabaseType.value));
type SearchScope = "connection" | "database" | "schema" | "table" | "view";
const selectedSearchScopes = ref<SearchScope[]>([]);
const searchCollapsedIds = ref<Set<string>>(new Set());
const searchRefreshedNodeIds = new Set<string>();
let searchTimer: number | undefined;
const tableSearchTimers = new Map<string, number>();
const tableSearchFocusRestoreTokens = new Map<string, number>();
let tableSearchFocusRestoreTokenSeq = 0;
let latestTableSearchInteractionParentId: string | null = null;

watch(
  searchQuery,
  (value) => {
    const normalized = value.trim().toLowerCase();
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

function refreshActiveSidebarTableSearches() {
  if (isFiltering.value) return;
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
      window.clearTimeout(tableSearchTimers.get(parentNodeId));
      tableSearchTimers.delete(parentNodeId);
      tableSearchFocusRestoreTokens.delete(parentNodeId);
      store.setSidebarTableSearchQuery(parentNodeId, "");
    }
    latestTableSearchInteractionParentId = null;
    void Promise.all(parentNodeIds.map((parentNodeId) => store.refreshSidebarTableSearch(parentNodeId))).catch(() => {});
  },
);

watch(deferredSearchQuery, (newQuery, oldQuery) => {
  store.sidebarSearchQuery = newQuery;
  const tasks: Promise<void>[] = [];
  for (const root of store.treeNodes) {
    collectExpandedObjectSearchTargets(root, tasks, newQuery ? searchRefreshedNodeIds : undefined);
  }
  if (!newQuery && oldQuery) {
    searchRefreshedNodeIds.clear();
  }
  Promise.all(tasks)
    .then(() => {
      if (!newQuery && oldQuery) refreshActiveSidebarTableSearches();
    })
    .catch(() => {});
});

const searchableObjectGroupTypes = new Set<TreeNodeType>(["group-tables", "group-views", "group-materialized-views", "group-procedures", "group-functions", "group-triggers", "group-sequences", "group-packages", "group-types"]);
const simpleObjectParentTypes = new Set<TreeNodeType>(["database", "schema", "linked-server-schema"]);
const simpleObjectChildTypes = new Set<TreeNodeType>(["table", "view", "materialized_view", "procedure", "function", "trigger", "sequence", "package", "package-body", "type", "type-body", "load-more"]);

function isSimpleObjectSearchParent(node: TreeNode): boolean {
  return settingsStore.editorSettings.sidebarObjectDisplay === "simple" && simpleObjectParentTypes.has(node.type) && node.isExpanded === true && (!!node.children?.some((child) => simpleObjectChildTypes.has(child.type)) || !!store.sidebarTableSearchQueries[node.id]?.trim());
}

function collectExpandedObjectSearchTargets(node: TreeNode, tasks: Promise<void>[], refreshedNodeIds?: Set<string>) {
  if (refreshedNodeIds && node.type === "connection" && node.connectionId) {
    if (store.connectedIds.has(node.connectionId)) {
      tasks.push(store.loadConnectedConnectionRootForSidebarSearch(node.connectionId));
    }
    if (node.connectionId !== store.activeConnectionId) return;
  }
  if (refreshedNodeIds && isSimpleObjectSearchParent(node)) {
    refreshedNodeIds.add(node.id);
    tasks.push(store.refreshTreeNode(node));
    return;
  }
  if (refreshedNodeIds && node.isExpanded && node.children) {
    for (const child of node.children) {
      if (child.connectionId && searchableObjectGroupTypes.has(child.type)) {
        refreshedNodeIds.add(child.id);
        tasks.push(store.loadObjectGroupChildren(child, { force: true }));
      }
    }
  } else if (!refreshedNodeIds && searchRefreshedNodeIds.has(node.id)) {
    if (searchableObjectGroupTypes.has(node.type)) {
      tasks.push(store.loadObjectGroupChildren(node, { force: true }));
    } else if (simpleObjectParentTypes.has(node.type)) {
      tasks.push(store.refreshTreeNode(node));
    }
  }
  if (node.children) {
    for (const child of node.children) {
      collectExpandedObjectSearchTargets(child, tasks, refreshedNodeIds);
    }
  }
}

const isSearching = computed(() => !!deferredSearchQuery.value);
const isFiltering = computed(() => !!searchQuery.value.trim() || hasSearchScopeFilter.value);

const SEARCH_SCOPE_TO_NODE_TYPES: Record<SearchScope, TreeNodeType[]> = {
  connection: ["connection"],
  database: ["database", "redis-db", "mq-tenant", "nacos-namespace", "mongo-db"],
  schema: ["schema"],
  table: ["table", "mongo-collection", "mongo-bucket", "vector-collection", "elasticsearch-index"],
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
const searchScopeMenuItems = computed(() => [
  ...searchScopeOptions.value.map((item) => ({
    value: item.scope,
    label: item.label,
    icon: item.icon,
  })),
  ...(hasSearchScopeFilter.value
    ? [
        {
          value: "__clear",
          label: t("sidebar.clearFilter"),
          icon: RotateCcw,
          separatorBefore: true,
        },
      ]
    : []),
]);

const connectionListSortMenuItems = computed(() => [
  { value: "manual", label: t("sidebar.sortConnectionsManual"), icon: ListOrdered },
  { value: "asc", label: t("sidebar.sortConnectionsAscending"), icon: ArrowDownAZ },
  { value: "desc", label: t("sidebar.sortConnectionsDescending"), icon: ArrowUpZA },
]);

const isConnectionListAlphabeticallySorted = computed(() => settingsStore.editorSettings.sidebarConnectionSortMode !== "manual");

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

function selectSearchScopeMenuItem(value: string) {
  if (value === "__clear") {
    clearSearchScopeFilter();
    return;
  }
  toggleSearchScope(value as SearchScope);
}

function clearSearchScopeFilter() {
  selectedSearchScopes.value = [];
}

function scheduleSidebarTableSearchRefresh(parentNodeId: string, options?: { restoreFocus?: boolean }) {
  window.clearTimeout(tableSearchTimers.get(parentNodeId));
  if (isFiltering.value) return;
  const restoreToken = options?.restoreFocus ? ++tableSearchFocusRestoreTokenSeq : 0;
  if (restoreToken) {
    tableSearchFocusRestoreTokens.clear();
    tableSearchFocusRestoreTokens.set(parentNodeId, restoreToken);
  }
  const timer = window.setTimeout(() => {
    tableSearchTimers.delete(parentNodeId);
    void store.refreshSidebarTableSearch(parentNodeId).then(() => {
      if (!restoreToken) return;
      if (tableSearchFocusRestoreTokens.get(parentNodeId) !== restoreToken) return;
      tableSearchFocusRestoreTokens.delete(parentNodeId);
      if (latestTableSearchInteractionParentId !== parentNodeId) return;
      if (document.activeElement === document.body || activeTableSearchParentId() === parentNodeId) {
        focusTableSearchInput(parentNodeId);
      }
    });
  }, 250);
  tableSearchTimers.set(parentNodeId, timer);
}

function activeTableSearchParentId(): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  return active.dataset.sidebarTableSearchParentId || null;
}

function focusTableSearchInput(parentNodeId: string) {
  void nextTick(() => {
    const root = rootRef.value;
    if (!root) return;
    const input = Array.from(root.querySelectorAll<HTMLInputElement>("[data-sidebar-table-search-parent-id]")).find((item) => item.dataset.sidebarTableSearchParentId === parentNodeId);
    if (!input) return;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });
}

const displayedTreeNodes = computed(() => sortConnectionListForDisplay(store.treeNodes, settingsStore.editorSettings.sidebarConnectionSortMode));

const filteredNodes = computed(() => {
  let nodes = displayedTreeNodes.value;

  const q = deferredSearchQuery.value;
  nodes = filterSidebarTree(nodes, q, searchCollapsedIds.value, searchableNodeTypes.value);
  if (q) {
    nodes = filterSidebarSearchRootsByConnectionState(nodes, store.connectedIds);
  }

  return nodes;
});

const flatNodes = computed<FlatTreeNode[]>(() =>
  insertSidebarTableSearchControls(flattenTree(filteredNodes.value), {
    enabled: settingsStore.editorSettings.sidebarTableSearchEnabled && !isFiltering.value,
    sidebarObjectDisplay: settingsStore.editorSettings.sidebarObjectDisplay,
    activeQueries: store.sidebarTableSearchQueries,
  }),
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
const useVirtualTree = computed(() => shouldVirtualizeFlatTree(flatNodes.value.length));
const activeTab = computed(() => queryStore.tabs.find((tab) => tab.id === queryStore.activeTabId));

// --- Sticky database header ---
// RecycleScroller positions each row absolutely, so CSS `position: sticky` on
// a database row can't work. Instead we overlay a pinned row from this parent
// component, tracking scroll offset to find the topmost visible database-level
// ancestor. The overlay reuses <TreeItem>, so collapse/expand comes for free.
const stickyScrollTop = ref(0);
const sidebarScrollMetrics = ref({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 });
const isScrollingSidebar = ref(false);
const isDraggingSidebarScrollbar = ref(false);
let sidebarScrollbarResizeObserver: ResizeObserver | null = null;
let sidebarScrollbarAnimationFrame = 0;
let sidebarScrollbarDragOffset = 0;
let sidebarScrollingTimer = 0;

function updateSidebarScrollMetrics() {
  const scroller = currentTreeScroller();
  if (!scroller) {
    sidebarScrollMetrics.value = { scrollTop: 0, clientHeight: 0, scrollHeight: 0 };
    return;
  }

  if (useVirtualTree.value) stickyScrollTop.value = scroller.scrollTop;
  sidebarScrollMetrics.value = {
    scrollTop: scroller.scrollTop,
    clientHeight: scroller.clientHeight,
    scrollHeight: scroller.scrollHeight,
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
    scheduleSidebarScrollMetricsUpdate();

    onCleanup(() => {
      sidebarScrollbarResizeObserver?.disconnect();
      sidebarScrollbarResizeObserver = null;
    });
  },
  { flush: "post" },
);

const stickyNode = computed<FlatTreeNode | null>(() => {
  if (!useVirtualTree.value || isFiltering.value) return null;
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
watch(flatNodes, () => {
  // Menu actions originate from a rendered row instance. Close the singleton
  // before a structural update can recycle that row onto another node.
  sidebarContextMenuRef.value?.close();
  sidebarContextMenuItems.value = [];
  sidebarContextMenuTarget.value = null;
  stickyScrollTop.value = 0;
  void nextTick(scheduleSidebarScrollMetricsUpdate);
});

const sidebarTreeOverflowClass = computed(() => (settingsStore.editorSettings.sidebarAllowHorizontalScroll ? "overflow-x-auto sidebar-tree-horizontal-scroll" : "overflow-x-hidden"));

const hasSidebarVerticalOverflow = computed(() => sidebarScrollMetrics.value.scrollHeight > sidebarScrollMetrics.value.clientHeight + 1);

function sidebarScrollbarGeometry() {
  const { scrollTop, clientHeight, scrollHeight } = sidebarScrollMetrics.value;
  const trackHeight = sidebarScrollbarTrackRef.value?.clientHeight ?? Math.max(0, clientHeight - 8);
  if (trackHeight <= 0 || scrollHeight <= clientHeight) {
    return { thumbTop: 0, thumbHeight: 0, maxThumbTop: 0, maxScrollTop: 0 };
  }

  const thumbHeight = Math.max(24, Math.min(trackHeight, (clientHeight / scrollHeight) * trackHeight));
  const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
  const maxScrollTop = Math.max(1, scrollHeight - clientHeight);
  const thumbTop = Math.min(maxThumbTop, Math.max(0, (scrollTop / maxScrollTop) * maxThumbTop));
  return { thumbTop, thumbHeight, maxThumbTop, maxScrollTop };
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

const pasteHandlerRegistry = createSidebarPasteHandlerRegistry();

provide(sidebarTreeContextKey, {
  getVisibleNodes: () => selectableVisibleNodes.value,
  getVisibleNodeIndex: (id: string) => selectableVisibleNodeIndexById.value.get(id) ?? -1,
  setTableSearchQuery: (parentNodeId, query) => {
    latestTableSearchInteractionParentId = parentNodeId;
    store.setSidebarTableSearchQuery(parentNodeId, query);
    scheduleSidebarTableSearchRefresh(parentNodeId, { restoreFocus: true });
  },
  registerPasteHandler: pasteHandlerRegistry.register,
});
provide(sidebarTreeRuntimeKey, sidebarTreeRuntime);

function bindSidebarTreeRuntimeHost(host: Element | ComponentPublicInstance | null) {
  const runtimeHost = host as SidebarTreeRuntimeHostInstance | null;
  sidebarTreeRuntimeHostRef.value = runtimeHost;
  sidebarTreeRuntime.bindHost(runtimeHost);
}

const pendingRenameGroupId = ref<string | null>(null);
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
  pendingRenameGroupId.value = groupId;
  store.selectedTreeNodeId = groupId;
  if (isFiltering.value) {
    searchQuery.value = "";
    deferredSearchQuery.value = "";
    clearSearchScopeFilter();
  }

  await scrollToSidebarNode(groupId);
  store.selectedTreeNodeId = groupId;
}

async function locateActiveTabInSidebar() {
  const tab = activeTab.value;
  if (!tab) return;

  const connId = tab.connectionId;

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
  const cursorCandidate = queryCursorTableCandidate(tab, effectiveDatabaseTypeForConnection(config));
  const fallbackTarget = queryContextTargetFromCandidate(tab, cursorCandidate) ?? activeTabSidebarTarget(tab);
  const initialTarget = cursorCandidate ? tableTargetFromCandidate(cursorCandidate) : fallbackTarget;
  if (!initialTarget) return;

  // Ensure the tree is loaded deep enough to contain the preferred target.
  await ensureTreeLoadedForTarget(initialTarget);

  // Clear any active search filter so the node is visible
  if (isFiltering.value) {
    searchQuery.value = "";
    deferredSearchQuery.value = "";
    clearSearchScopeFilter();
  }

  let target = resolveLoadedLocateTarget(initialTarget, cursorCandidate);
  let nodePath = target ? findNodePathForTarget(target, store.treeNodes) : null;
  if (!nodePath) {
    // The first load may have served a stale schema cache whose async refresh
    // replaced the database node before its tables finished loading, so the
    // table isn't in the tree yet. Force a synchronous reload and retry once so
    // locate reaches the table, not just the database (issue #715).
    await ensureTreeLoadedForTarget(initialTarget, { force: true });
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
    if (!ancestor.isExpanded) {
      ancestor.isExpanded = true;
    }
  }

  await nextTick();

  const match = target ? findSidebarNodeForTarget(target, flatNodes.value) : null;
  if (!match) return;

  store.selectedTreeNodeId = match.id;
  store.selectedTreeNodeIds = [match.id];
  store.treeSelectionAnchorId = match.id;
  await nextTick();

  await scrollToSidebarNode(match.id, { align: "smart" });
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
  if (target.type === "saved-sql-file" || target.type === "etcd-root" || target.type === "zookeeper-root") return;
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
  const connNode = store.treeNodes.find((n) => n.id === connId);
  if (connNode && (force || !connNode.children || connNode.children.length === 0)) {
    try {
      if (config.db_type === "redis") {
        await store.loadRedisDatabases(connId);
      } else if (config.db_type === "mongodb") {
        await store.loadMongoDatabases(connId);
      } else if (config.db_type === "elasticsearch") {
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

  if (config.db_type === "mq" || config.db_type === "nacos") return;
  if (!("database" in target) || !target.database) return;

  // Find the database node
  const dbNode = findDatabaseNode(store.treeNodes, connId, target.database);
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
    if ((node.type === "group-tables" || node.type === "group-views" || node.type === "group-materialized-views") && node.connectionId === target.connectionId && sameTreeName(node.database, target.database) && (!target.schema || sameTreeName(node.schema, target.schema))) {
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

function findDatabaseNode(nodes: TreeNode[], connId: string, database: string): TreeNode | null {
  for (const node of nodes) {
    if (node.type === "database" && node.connectionId === connId && sameTreeName(node.database, database)) {
      return node;
    }
    if (node.children) {
      const found = findDatabaseNode(node.children, connId, database);
      if (found) return found;
    }
  }
  return null;
}

function findSchemaNode(nodes: TreeNode[], connId: string, database: string, schema: string): TreeNode | null {
  for (const node of nodes) {
    if (node.type === "schema" && node.connectionId === connId && sameTreeName(node.database, database) && sameTreeName(node.label, schema)) {
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
  if (!isSearching.value || !node.children) return;
  const next = new Set(searchCollapsedIds.value);
  if (node.isExpanded) next.add(node.id);
  else next.delete(node.id);
  searchCollapsedIds.value = next;
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
  sidebarDangerDialogRequest.value = request;
  sidebarDangerDialogConfirming.value = false;
  sidebarDangerDialogOpen.value = true;
}

async function confirmSidebarDangerDialog() {
  const request = sidebarDangerDialogRequest.value;
  if (!request || sidebarDangerDialogConfirming.value) return;
  if (request.closeOnConfirm !== false) sidebarDangerDialogOpen.value = false;
  sidebarDangerDialogConfirming.value = true;
  try {
    await request.confirm();
    sidebarDangerDialogOpen.value = false;
  } finally {
    sidebarDangerDialogConfirming.value = false;
  }
}

function updateSidebarDangerDialogOption(event: Event) {
  const option = sidebarDangerDialogRequest.value?.option;
  if (!option) return;
  option.checked = (event.target as HTMLInputElement).checked;
  void option.onChange?.(option.checked);
}

function updateSidebarTreeItemDialogController(controller: Record<string, any> | null) {
  sidebarTreeItemDialogController.value = controller;
}

async function openSidebarInstallExtension(node: TreeNode) {
  sidebarInstallExtensionTarget.value = createSidebarActionTarget(node);
  await nextTick();
  sidebarInstallExtensionDialogRef.value?.show();
}

function beginSidebarAction(): number {
  sidebarActionGeneration += 1;
  sidebarDdlOpen.value = false;
  sidebarObjectSourceOpen.value = false;
  sidebarProcedureOpen.value = false;
  sidebarVisibleDatabasesOpen.value = false;
  sidebarVisibleSchemasOpen.value = false;
  sidebarDdlTarget.value = null;
  sidebarObjectSourceTarget.value = null;
  sidebarProcedureTarget.value = null;
  sidebarVisibleDatabasesTarget.value = null;
  sidebarVisibleSchemasTarget.value = null;
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

function openSidebarObjectSource(node: TreeNode, initialEditing: boolean) {
  if (!node.connectionId || !node.database || !objectSourceKindForTreeNode(node.type)) return;
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

function openSidebarProcedureSql(sql: string) {
  const target = sidebarProcedureTarget.value;
  if (!target?.connectionId || !target.database || !sql) return;
  const tabId = queryStore.createTab(target.connectionId, target.database, `Execute - ${target.label}`, "query", target.schema);
  queryStore.updateSql(tabId, sql);
}

async function executeSidebarProcedureSql(sql: string) {
  const target = sidebarProcedureTarget.value;
  if (!target?.connectionId || !target.database || !sql) return;
  const tabId = queryStore.createTab(target.connectionId, target.database, `Execute - ${target.label}`, "query", target.schema);
  queryStore.updateSql(tabId, sql);
  await queryStore.executeTabSql(tabId, sql);
}

async function refreshSidebarActionTarget() {
  const target = sidebarObjectSourceTarget.value?.node || sidebarDdlTarget.value;
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

function collapseAllTreeNodes() {
  store.collapseAllTreeNodes();
  if (isSearching.value) {
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
  const connectionNodes = selectedConnectionClipboardNodes(nodes);
  if (connectionNodes.length > 0) {
    const copiedCount = store.copyConnectionsToTreeClipboard(connectionNodes.map((node) => node.connectionId));
    if (copiedCount > 0) toast(t("connection.copied"), 2000);
    return copiedCount > 0;
  }
  const tableNodes = nodes.filter((node) => node.type === "table" && !!node.connectionId && !!node.database);
  store.treeClipboard =
    tableNodes.length > 0
      ? {
          kind: "table-copy",
          tables: tableNodes.map((node) => ({
            connectionId: node.connectionId!,
            database: node.database!,
            schema: node.schema,
            tableName: node.label,
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
  window.addEventListener("keydown", onWindowKeydown);
});

onUnmounted(() => {
  sidebarTreeRuntime.dispose();
  sidebarActionGeneration += 1;
  sidebarContextMenuTarget.value = null;
  sidebarContextMenuItems.value = [];
  sidebarDdlTarget.value = null;
  sidebarObjectSourceTarget.value = null;
  sidebarProcedureTarget.value = null;
  sidebarVisibleDatabasesTarget.value = null;
  sidebarVisibleSchemasTarget.value = null;
  sidebarTreeItemDialogController.value = null;
  sidebarDangerDialogRequest.value = null;
  resetSidebarTreeDialogState();
  window.removeEventListener("keydown", onWindowKeydown);
  cancelPendingSidebarDataOpen();
  for (const timer of tableSearchTimers.values()) {
    window.clearTimeout(timer);
  }
  tableSearchTimers.clear();
  tableSearchFocusRestoreTokens.clear();
  latestTableSearchInteractionParentId = null;
  stopSidebarScrollbarDrag();
  sidebarScrollbarResizeObserver?.disconnect();
  window.cancelAnimationFrame(sidebarScrollbarAnimationFrame);
  window.clearTimeout(sidebarScrollingTimer);
});

defineExpose({ focusSearch, createNewGroup, collapseAllTreeNodes });
</script>

<template>
  <div ref="rootRef" class="h-full min-h-0 flex flex-col text-sm select-none" @pointerenter="pointerInsideTree = true" @pointerleave="pointerInsideTree = false">
    <SidebarTreeRuntimeHost
      :ref="bindSidebarTreeRuntimeHost"
      :node="sidebarTreeRuntimeInitialNode"
      :depth="0"
      @search-toggle="onSearchToggle"
      @open-ddl="openSidebarDdl"
      @open-object-source="openSidebarObjectSource"
      @open-procedure="openSidebarProcedure"
      @open-data="openSidebarData"
      @open-visible-databases="openSidebarVisibleDatabases"
      @open-visible-schemas="openSidebarVisibleSchemas"
      @request-group-rename="startRenamingCreatedGroup"
      @open-danger-dialog="openSidebarDangerDialog"
      @open-dialog-controller="updateSidebarTreeItemDialogController"
      @open-install-extension="openSidebarInstallExtension"
    />
    <div class="connection-tree-search sticky top-0 z-10 bg-background px-2 py-1">
      <div class="relative flex items-center gap-1">
        <div class="relative flex-1">
          <Search class="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            ref="searchInputRef"
            v-model="searchQuery"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            class="w-full h-6 pl-7 pr-6 text-xs rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            :placeholder="t('grid.search')"
            @keydown="onSearchKeydown"
          />
          <button v-if="searchQuery" class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" @click="searchQuery = ''">
            <X class="h-3 w-3" />
          </button>
        </div>
        <button class="shrink-0 h-6 w-6 flex items-center justify-center rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground" :title="t('sidebar.locateActiveTab')" @click="locateActiveTabInSidebar">
          <Crosshair class="h-3.5 w-3.5" />
        </button>
        <LightDropdown
          :model-value="settingsStore.editorSettings.sidebarConnectionSortMode"
          :items="connectionListSortMenuItems"
          :aria-label="t('sidebar.sortConnections')"
          :label="t('sidebar.sortConnections')"
          :trigger-title="t('sidebar.sortConnections')"
          :trigger-class="['shrink-0 h-6 w-6 flex items-center justify-center rounded border border-border hover:bg-accent', isConnectionListAlphabeticallySorted ? 'text-primary bg-primary/10 border-primary/30' : 'text-muted-foreground'].join(' ')"
          trigger-icon-class="h-3.5 w-3.5"
          item-icon-class="h-3.5 w-3.5"
          content-class="w-max min-w-0"
          selected-item-class="bg-primary/10 text-primary"
          selected-check-class="text-primary"
          :show-trigger-label="false"
          :show-chevron="false"
          align="end"
          @update:model-value="updateConnectionListSortMode"
        />
        <LightDropdown
          v-if="searchScopeOptions.length > 0"
          model-value=""
          :items="searchScopeMenuItems"
          :selected-values="selectedSearchScopes"
          :aria-label="t('sidebar.filterByType')"
          :label="t('sidebar.filterByType')"
          :trigger-title="t('sidebar.filterByType')"
          :trigger-icon="ListFilter"
          :trigger-class="['shrink-0 h-6 w-6 flex items-center justify-center rounded border border-border hover:bg-accent', hasSearchScopeFilter ? 'text-primary bg-primary/10 border-primary/30' : 'text-muted-foreground'].join(' ')"
          trigger-icon-class="h-3.5 w-3.5"
          item-icon-class="h-3.5 w-3.5"
          content-class="w-max min-w-0"
          selected-item-class="bg-primary/10 text-primary"
          selected-check-class="text-primary"
          :show-trigger-label="false"
          :show-chevron="false"
          :close-on-select="false"
          align="end"
          @update:model-value="selectSearchScopeMenuItem"
        />
      </div>
    </div>
    <CustomContextMenu ref="sidebarContextMenuRef" :items="sidebarContextMenuItems" v-slot="contextMenuSlot">
      <div v-if="flatNodes.length > 0 && useVirtualTree" class="connection-tree-scroll-shell relative min-h-0 flex-1">
        <RecycleScroller
          ref="treeScrollerRef"
          class="sidebar-tree connection-tree-scroller h-full overflow-y-auto"
          :class="sidebarTreeOverflowClass"
          @click="clearSidebarSelection"
          :items="flatNodes"
          :item-size="SIDEBAR_TREE_ROW_HEIGHT"
          :buffer="SIDEBAR_TREE_SCROLL_BUFFER"
          :prerender="SIDEBAR_TREE_PRERENDER_COUNT"
          :skip-hover="true"
          key-field="id"
          type-field="poolType"
          flow-mode
        >
          <template #default="{ item }">
            <TreeItem
              :node="item.node"
              :depth="item.depth"
              :drag-disabled="isFiltering || isConnectionListAlphabeticallySorted"
              :pending-rename="pendingRenameGroupId === item.node.id"
              :highlighted="highlightedNodeId === item.node.id"
              @context-menu="(event, node) => openSidebarContextMenu(event, node, contextMenuSlot.onContextMenu)"
              @rename-started="pendingRenameGroupId = null"
              @group-created="startRenamingCreatedGroup"
            />
          </template>
        </RecycleScroller>
        <div v-if="stickyNode" class="sticky-database-header pointer-events-auto absolute inset-x-0 top-0 z-[5] border-b border-border/60" :style="stickyHeaderStyle">
          <TreeItem :node="stickyNode.node" :depth="stickyNode.depth" :drag-disabled="true" @context-menu="(event, node) => openSidebarContextMenu(event, node, contextMenuSlot.onContextMenu)" />
        </div>
        <div v-if="hasSidebarVerticalOverflow" ref="sidebarScrollbarTrackRef" class="sidebar-tree-scrollbar" :class="{ 'sidebar-tree-scrollbar--scrolling': isScrollingSidebar, 'sidebar-tree-scrollbar--dragging': isDraggingSidebarScrollbar }" @pointerdown="onSidebarScrollbarTrackPointerDown">
          <div class="sidebar-tree-scrollbar__thumb" :style="sidebarScrollbarThumbStyle" @pointerdown.stop="onSidebarScrollbarThumbPointerDown" />
        </div>
      </div>
      <div v-else-if="flatNodes.length > 0" class="connection-tree-scroll-shell relative min-h-0 flex-1">
        <div ref="plainTreeScrollerRef" class="sidebar-tree connection-tree-scroller h-full overflow-y-auto" :class="sidebarTreeOverflowClass" @click="clearSidebarSelection" @scroll.passive="onTreeScroll">
          <TreeItem
            v-for="item in flatNodes"
            :key="item.id"
            :node="item.node"
            :depth="item.depth"
            :drag-disabled="isFiltering || isConnectionListAlphabeticallySorted"
            :pending-rename="pendingRenameGroupId === item.node.id"
            :highlighted="highlightedNodeId === item.id"
            @context-menu="(event, node) => openSidebarContextMenu(event, node, contextMenuSlot.onContextMenu)"
            @rename-started="pendingRenameGroupId = null"
            @group-created="startRenamingCreatedGroup"
          />
        </div>
        <div v-if="hasSidebarVerticalOverflow" ref="sidebarScrollbarTrackRef" class="sidebar-tree-scrollbar" :class="{ 'sidebar-tree-scrollbar--scrolling': isScrollingSidebar, 'sidebar-tree-scrollbar--dragging': isDraggingSidebarScrollbar }" @pointerdown="onSidebarScrollbarTrackPointerDown">
          <div class="sidebar-tree-scrollbar__thumb" :style="sidebarScrollbarThumbStyle" @pointerdown.stop="onSidebarScrollbarThumbPointerDown" />
        </div>
      </div>
    </CustomContextMenu>
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
      :schema="sidebarObjectSourceTarget.node.schema"
      :name="sidebarObjectSourceTarget.node.objectName || sidebarObjectSourceTarget.node.label"
      :signature="sidebarObjectSourceTarget.node.signature"
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
      @confirm="confirmSidebarDangerDialog"
    >
      <template v-if="sidebarDangerDialogRequest.option" #options>
        <label class="mb-3 flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2 text-sm">
          <input :checked="sidebarDangerDialogRequest.option.checked" type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" @change="updateSidebarDangerDialogOption" />
          <span class="grid gap-0.5">
            <span class="font-medium text-foreground">{{ sidebarDangerDialogRequest.option.label }}</span>
            <span class="text-xs leading-5 text-muted-foreground">{{ sidebarDangerDialogRequest.option.hint }}</span>
          </span>
        </label>
      </template>
    </SidebarDangerConfirmDialog>
    <SidebarTreeItemDialogs v-if="sidebarTreeItemDialogController" :key="sidebarTreeItemDialogController.node?.id" :controller="sidebarTreeItemDialogController" @closed="sidebarTreeItemDialogController = null" />
    <InstallExtensionDialog v-if="sidebarInstallExtensionTarget" ref="sidebarInstallExtensionDialogRef" :node="sidebarInstallExtensionTarget" @close="refreshSidebarActionTarget" />
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
}

.connection-tree-scroller::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.connection-tree-scroller :deep(.vue-recycle-scroller__item-view) {
  min-width: 100%;
  contain: style;
}

.connection-tree-scroller.sidebar-tree-horizontal-scroll :deep(.vue-recycle-scroller__item-view) {
  width: max-content;
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
</style>

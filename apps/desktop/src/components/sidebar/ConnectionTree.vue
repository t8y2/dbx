<script setup lang="ts">
import { ref, computed, nextTick, watch, provide, onMounted, onUnmounted, type Component } from "vue";
import { useI18n } from "vue-i18n";
import { Search, X, ListFilter, Crosshair, Server, Database, FolderTree, Table2, Eye, RotateCcw } from "@lucide/vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { TreeNode, TreeNodeType } from "@/types/database";
import { filterSidebarSearchRootsByConnectionState, filterSidebarTree } from "@/lib/sidebarSearchTree";
import { isCancelSearchShortcut } from "@/lib/keyboardShortcuts";
import { isEditableSidebarTypeSearchTarget, sidebarTypeSearchNextQuery } from "@/lib/sidebarTypeSearch";
import { usesTreeSchemaMode } from "@/lib/databaseFeatureSupport";
import { connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection } from "@/lib/jdbcDialect";
import { activeTabSidebarTarget, findSidebarNodeForActiveTab, findSidebarNodeForTarget, findNodePathForTarget, scrollTopForSidebarNode, shouldScrollActiveSidebarSelection, type ActiveTabSidebarTarget } from "@/lib/sidebarActiveTabTarget";
import { findLoadedTableTargetForCandidate, queryContextTargetFromCandidate, queryCursorTableCandidate, type QueryCursorTableCandidate } from "@/lib/queryCursorTableTarget";
import { SIDEBAR_TREE_ROW_HEIGHT, SIDEBAR_TREE_PRERENDER_COUNT, SIDEBAR_TREE_SCROLL_BUFFER, flattenTree, scrollTopForExpandedTreeNode, shouldAutoScrollExpandedTreeNode, shouldVirtualizeFlatTree, type FlatTreeNode } from "@/composables/useFlatTree";
import { sidebarTreeContextKey } from "@/lib/sidebarTreeContext";
import TreeItem from "./TreeItem.vue";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import LightDropdown from "@/components/ui/LightDropdown.vue";

const { t } = useI18n();
const store = useConnectionStore();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const searchQuery = ref("");
const deferredSearchQuery = ref("");
const searchInputRef = ref<HTMLInputElement>();
const pointerInsideTree = ref(false);
const treeScrollerRef = ref<InstanceType<typeof RecycleScroller> | null>(null);
const plainTreeScrollerRef = ref<HTMLElement | null>(null);
type SearchScope = "connection" | "database" | "schema" | "table" | "view";
const selectedSearchScopes = ref<SearchScope[]>([]);
const searchCollapsedIds = ref<Set<string>>(new Set());
let searchTimer: number | undefined;

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

watch(deferredSearchQuery, (newQuery) => {
  store.sidebarSearchQuery = newQuery;
  const tasks: Promise<void>[] = [];
  for (const root of store.treeNodes) {
    findExpandedTableParents(root, tasks);
  }
  Promise.all(tasks).catch(() => {});
});

function findExpandedTableParents(node: TreeNode, tasks: Promise<void>[]) {
  if (node.isExpanded && node.connectionId && (node.type === "database" || node.type === "schema")) {
    const groupTypes = new Set(["group-tables", "group-views", "group-procedures", "group-functions", "group-sequences", "group-packages"]);
    if (node.children?.some((child) => groupTypes.has(child.type))) {
      tasks.push(store.loadObjectGroupChildren(node, { force: true }));
    }
  }
  if (node.children) {
    for (const child of node.children) {
      findExpandedTableParents(child, tasks);
    }
  }
}

const isSearching = computed(() => !!deferredSearchQuery.value);
const isFiltering = computed(() => !!searchQuery.value.trim() || hasSearchScopeFilter.value);

const SEARCH_SCOPE_TO_NODE_TYPES: Record<SearchScope, TreeNodeType[]> = {
  connection: ["connection"],
  database: ["database", "redis-db", "mq-tenant", "nacos-namespace", "mongo-db"],
  schema: ["schema"],
  table: ["table", "mongo-collection", "vector-collection", "elasticsearch-index"],
  view: ["view"],
};

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

const filteredNodes = computed(() => {
  let nodes = store.treeNodes;

  const q = deferredSearchQuery.value;
  if (q) {
    nodes = filterSidebarTree(nodes, q, searchCollapsedIds.value, searchableNodeTypes.value);
    nodes = filterSidebarSearchRootsByConnectionState(nodes, store.connectedIds);
  }

  return nodes;
});

const flatNodes = computed<FlatTreeNode[]>(() => flattenTree(filteredNodes.value));
const visibleNodes = computed<TreeNode[]>(() => flatNodes.value.map((item) => item.node));
const visibleNodeIndexById = computed(() => {
  const next = new Map<string, number>();
  visibleNodes.value.forEach((node, index) => next.set(node.id, index));
  return next;
});
const useVirtualTree = computed(() => shouldVirtualizeFlatTree(flatNodes.value.length));
const activeTab = computed(() => queryStore.tabs.find((tab) => tab.id === queryStore.activeTabId));
const sidebarTreeOverflowClass = computed(() => (settingsStore.editorSettings.sidebarAllowHorizontalScroll ? "overflow-x-auto sidebar-tree-horizontal-scroll" : "overflow-x-hidden"));

provide(sidebarTreeContextKey, {
  getVisibleNodes: () => visibleNodes.value,
  getVisibleNodeIndex: (id: string) => visibleNodeIndexById.value.get(id) ?? -1,
});

const pendingRenameGroupId = ref<string | null>(null);
const highlightedNodeId = ref<string | null>(null);
let highlightTimer: number | undefined;

async function scrollToSidebarNode(nodeId: string) {
  await nextTick();

  const index = flatNodes.value.findIndex((item) => item.id === nodeId);
  const scroller = currentTreeScroller();
  if (!scroller || index < 0) return;

  const nextScrollTop = scrollTopForSidebarNode({
    index,
    currentScrollTop: scroller.scrollTop,
    viewportHeight: scroller.clientHeight,
  });
  if (nextScrollTop !== scroller.scrollTop) {
    scroller.scrollTop = nextScrollTop;
  }
}

function clearSidebarSelection() {
  // Clicking the blank area of the tree clears the current selection. Row
  // clicks call event.stopPropagation(), so this only fires for blank clicks
  // (issue #681 — selection wasn't cleared in double-click activation mode).
  store.selectedTreeNodeId = null;
  store.selectedTreeNodeIds = [];
  store.treeSelectionAnchorId = null;
}

async function createNewGroup() {
  const groupId = store.createConnectionGroup(t("connectionGroup.newGroupDefault"));
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
  await nextTick();

  window.clearTimeout(highlightTimer);
  highlightedNodeId.value = match.id;
  highlightTimer = window.setTimeout(() => {
    highlightedNodeId.value = null;
  }, 1800);

  await scrollToSidebarNode(match.id);
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
  if (target.type === "saved-sql-file" || target.type === "etcd-root") return;
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
      } else if (config.db_type === "qdrant" || config.db_type === "milvus") {
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

async function onNodeToggled(node: TreeNode, wasExpanded: boolean) {
  if (wasExpanded || !node.isExpanded) return;
  if (!shouldAutoScrollExpandedTreeNode(node.type)) return;

  await nextTick();

  const expandedIndex = flatNodes.value.findIndex((item) => item.id === node.id);
  const insertedRowCount = flattenTree([node]).length - 1;
  const scroller = treeScrollerRef.value?.$el as HTMLElement | undefined;
  if (!scroller || expandedIndex < 0 || insertedRowCount <= 0) return;

  const nextScrollTop = scrollTopForExpandedTreeNode({
    expandedIndex,
    insertedRowCount,
    currentScrollTop: scroller.scrollTop,
    viewportHeight: scroller.clientHeight,
  });

  if (nextScrollTop !== scroller.scrollTop) {
    scroller.scrollTop = nextScrollTop;
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

  const index = flatNodes.value.findIndex((item) => item.id === match.id);
  const scroller = currentTreeScroller();
  if (!scroller || index < 0) return;

  const nextScrollTop = scrollTopForSidebarNode({
    index,
    currentScrollTop: scroller.scrollTop,
    viewportHeight: scroller.clientHeight,
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
  if (!pointerInsideTree.value || event.defaultPrevented || isEditableSidebarTypeSearchTarget(event.target)) return;
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

onMounted(() => {
  window.addEventListener("keydown", onWindowKeydown);
});

onUnmounted(() => {
  window.removeEventListener("keydown", onWindowKeydown);
});

defineExpose({ focusSearch, createNewGroup });
</script>

<template>
  <div class="h-full min-h-0 flex flex-col text-sm select-none" @pointerenter="pointerInsideTree = true" @pointerleave="pointerInsideTree = false">
    <div class="sticky top-0 z-10 bg-background px-2 py-1">
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
    <RecycleScroller
      v-if="flatNodes.length > 0 && useVirtualTree"
      ref="treeScrollerRef"
      class="sidebar-tree connection-tree-scroller min-h-0 flex-1 overflow-y-auto"
      :class="sidebarTreeOverflowClass"
      @click="clearSidebarSelection"
      :items="flatNodes"
      :item-size="SIDEBAR_TREE_ROW_HEIGHT"
      :buffer="SIDEBAR_TREE_SCROLL_BUFFER"
      :prerender="SIDEBAR_TREE_PRERENDER_COUNT"
      :skip-hover="true"
      key-field="id"
      type-field="type"
      flow-mode
    >
      <template #default="{ item }">
        <TreeItem
          :node="item.node"
          :depth="item.depth"
          :drag-disabled="isFiltering"
          :pending-rename="pendingRenameGroupId === item.node.id"
          :highlighted="highlightedNodeId === item.node.id"
          @node-toggled="onNodeToggled"
          @search-toggle="onSearchToggle"
          @rename-started="pendingRenameGroupId = null"
        />
      </template>
    </RecycleScroller>
    <div v-else-if="flatNodes.length > 0" ref="plainTreeScrollerRef" class="sidebar-tree min-h-0 flex-1 overflow-y-auto" :class="sidebarTreeOverflowClass" @click="clearSidebarSelection">
      <TreeItem
        v-for="item in flatNodes"
        :key="item.id"
        :node="item.node"
        :depth="item.depth"
        :drag-disabled="isFiltering"
        :pending-rename="pendingRenameGroupId === item.node.id"
        :highlighted="highlightedNodeId === item.id"
        @node-toggled="onNodeToggled"
        @search-toggle="onSearchToggle"
        @rename-started="pendingRenameGroupId = null"
      />
    </div>
    <div v-if="store.treeNodes.length === 0" class="px-3 py-8 text-center text-muted-foreground text-xs">
      {{ t("sidebar.noConnections") }}
    </div>
  </div>
</template>

<style scoped>
.connection-tree-scroller {
  will-change: scroll-position;
  contain: content;
}

.connection-tree-scroller :deep(.vue-recycle-scroller__item-view) {
  min-width: 100%;
  contain: style;
}

.connection-tree-scroller.sidebar-tree-horizontal-scroll :deep(.vue-recycle-scroller__item-view) {
  width: max-content;
}
</style>

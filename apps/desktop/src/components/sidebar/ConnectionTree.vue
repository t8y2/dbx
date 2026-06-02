<script setup lang="ts">
import { ref, computed, nextTick, watch, type Component } from "vue";
import { useI18n } from "vue-i18n";
import {
  Search,
  X,
  ListFilter,
  Crosshair,
  Server,
  Database,
  FolderTree,
  Table2,
  Eye,
  RotateCcw,
} from "lucide-vue-next";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { QueryTab, TreeNode, TreeNodeType } from "@/types/database";
import { filterSidebarTree } from "@/lib/sidebarSearchTree";
import { isCancelSearchShortcut } from "@/lib/keyboardShortcuts";
import { usesTreeSchemaMode } from "@/lib/databaseFeatureSupport";
import {
  findSidebarNodeForActiveTab,
  findNodePathForActiveTab,
  scrollTopForSidebarNode,
  shouldScrollActiveSidebarSelection,
} from "@/lib/sidebarActiveTabTarget";
import {
  SIDEBAR_TREE_ROW_HEIGHT,
  SIDEBAR_TREE_PRERENDER_COUNT,
  SIDEBAR_TREE_SCROLL_BUFFER,
  flattenTree,
  scrollTopForExpandedTreeNode,
  shouldAutoScrollExpandedTreeNode,
  shouldVirtualizeFlatTree,
  type FlatTreeNode,
} from "@/composables/useFlatTree";
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
    }, 120);
  },
  { flush: "sync" },
);

const isSearching = computed(() => !!deferredSearchQuery.value);
const isFiltering = computed(() => !!searchQuery.value.trim() || hasSearchScopeFilter.value);

const SEARCH_SCOPE_TO_NODE_TYPES: Record<SearchScope, TreeNodeType[]> = {
  connection: ["connection"],
  database: ["database", "redis-db", "mongo-db"],
  schema: ["schema"],
  table: ["table", "mongo-collection"],
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
    nodes = nodes.filter((node) => {
      if (node.type === "connection-group") return true;
      return node.connectionId ? store.connectedIds.has(node.connectionId) : true;
    });
  }

  return nodes;
});

const flatNodes = computed<FlatTreeNode[]>(() => flattenTree(filteredNodes.value));
const visibleNodes = computed<TreeNode[]>(() => flatNodes.value.map((item) => item.node));
const useVirtualTree = computed(() => shouldVirtualizeFlatTree(flatNodes.value.length));
const activeTab = computed(() => queryStore.tabs.find((tab) => tab.id === queryStore.activeTabId));
const sidebarTreeOverflowClass = computed(() =>
  settingsStore.editorSettings.sidebarAllowHorizontalScroll
    ? "overflow-x-auto sidebar-tree-horizontal-scroll"
    : "overflow-x-hidden",
);

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

  // Ensure the tree is loaded deep enough to contain the target node
  await ensureTreeLoadedForTab(tab);

  // Clear any active search filter so the node is visible
  if (isFiltering.value) {
    searchQuery.value = "";
    deferredSearchQuery.value = "";
    clearSearchScopeFilter();
  }

  const nodePath = findNodePathForActiveTab(tab, store.treeNodes);
  if (!nodePath) return;

  for (const ancestor of nodePath) {
    if (!ancestor.isExpanded) {
      ancestor.isExpanded = true;
    }
  }

  await nextTick();

  const match = findSidebarNodeForActiveTab(tab, flatNodes.value);
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

async function ensureTreeLoadedForTab(tab: QueryTab) {
  const connId = tab.connectionId;
  if (!connId) return;

  const config = store.getConfig(connId);
  if (!config) return;

  // Ensure databases are loaded under the connection
  const connNode = store.treeNodes.find((n) => n.id === connId);
  if (connNode && (!connNode.children || connNode.children.length === 0)) {
    try {
      if (config.db_type === "redis") {
        await store.loadRedisDatabases(connId);
      } else if (config.db_type === "mongodb" || config.db_type === "elasticsearch") {
        await store.loadMongoDatabases(connId);
      } else {
        await store.loadDatabases(connId);
      }
    } catch {
      return;
    }
  }

  if (!tab.database) return;

  // Find the database node
  const dbNode = findDatabaseNode(store.treeNodes, connId, tab.database);
  if (!dbNode || (dbNode.children && dbNode.children.length > 0)) return;

  // Load database contents
  try {
    if (config.db_type === "sqlserver") {
      await store.loadSqlServerDatabaseObjects(connId, tab.database);
    } else if (usesTreeSchemaMode(config.db_type)) {
      await store.loadSchemas(connId, tab.database);
      // If we have a schema, also load tables under that schema
      if (tab.schema) {
        const schemaNode = findSchemaNode(store.treeNodes, connId, tab.database, tab.schema);
        if (schemaNode && (!schemaNode.children || schemaNode.children.length === 0)) {
          await store.loadTables(connId, tab.database, tab.schema);
        }
      }
    } else {
      await store.loadTables(connId, tab.database);
    }
  } catch {
    // Node just won't have children loaded
  }
}

function findDatabaseNode(nodes: TreeNode[], connId: string, database: string): TreeNode | null {
  for (const node of nodes) {
    if (node.type === "database" && node.connectionId === connId && node.database === database) {
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
    if (node.type === "schema" && node.connectionId === connId && node.database === database && node.label === schema) {
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
  return (
    ((useVirtualTree.value ? treeScrollerRef.value?.$el : plainTreeScrollerRef.value) as HTMLElement | undefined) ??
    null
  );
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

defineExpose({ focusSearch, createNewGroup });
</script>

<template>
  <div class="h-full min-h-0 flex flex-col text-sm select-none">
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
          <button
            v-if="searchQuery"
            class="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            @click="searchQuery = ''"
          >
            <X class="h-3 w-3" />
          </button>
        </div>
        <button
          class="shrink-0 h-6 w-6 flex items-center justify-center rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground"
          :title="t('sidebar.locateActiveTab')"
          @click="locateActiveTabInSidebar"
        >
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
          :trigger-class="
            [
              'shrink-0 h-6 w-6 flex items-center justify-center rounded border border-border hover:bg-accent',
              hasSearchScopeFilter ? 'text-primary bg-primary/10 border-primary/30' : 'text-muted-foreground',
            ].join(' ')
          "
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
          :visible-nodes="visibleNodes"
          @node-toggled="onNodeToggled"
          @search-toggle="onSearchToggle"
          @rename-started="pendingRenameGroupId = null"
        />
      </template>
    </RecycleScroller>
    <div
      v-else-if="flatNodes.length > 0"
      ref="plainTreeScrollerRef"
      class="sidebar-tree min-h-0 flex-1 overflow-y-auto"
      :class="sidebarTreeOverflowClass"
    >
      <TreeItem
        v-for="item in flatNodes"
        :key="item.id"
        :node="item.node"
        :depth="item.depth"
        :drag-disabled="isFiltering"
        :pending-rename="pendingRenameGroupId === item.node.id"
        :highlighted="highlightedNodeId === item.id"
        :visible-nodes="visibleNodes"
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

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Search, X, ListFilter, Check, FolderPlus } from "lucide-vue-next";
import { useConnectionStore } from "@/stores/connectionStore";
import type { TreeNode } from "@/types/database";
import { matchSidebarLabel } from "@/lib/sidebarSearch";
import {
  SIDEBAR_TREE_ROW_HEIGHT,
  SIDEBAR_TREE_PRERENDER_COUNT,
  SIDEBAR_TREE_SCROLL_BUFFER,
  flattenTree,
  shouldVirtualizeFlatTree,
  type FlatTreeNode,
} from "@/composables/useFlatTree";
import TreeItem from "./TreeItem.vue";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";

const { t } = useI18n();
const store = useConnectionStore();
const searchQuery = ref("");
const deferredSearchQuery = ref("");
const selectedTypes = ref<string[]>([]);
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
const isFiltering = computed(() => !!searchQuery.value.trim() || hasTypeFilter.value);

const typeStats = computed(() => {
  const map = new Map<string, { profile: string; label: string; count: number }>();
  for (const c of store.connections) {
    const profile = c.driver_profile || c.db_type;
    const existing = map.get(profile);
    if (existing) {
      existing.count++;
    } else {
      map.set(profile, { profile, label: c.driver_label || profile, count: 1 });
    }
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
});

const hasTypeFilter = computed(() => selectedTypes.value.length > 0);

function isTypeSelected(profile: string) {
  return selectedTypes.value.includes(profile);
}

function toggleType(profile: string) {
  const idx = selectedTypes.value.indexOf(profile);
  if (idx >= 0) {
    selectedTypes.value.splice(idx, 1);
  } else {
    selectedTypes.value.push(profile);
  }
}

function clearTypeFilter() {
  selectedTypes.value = [];
}

const normalizedLabelCache = new WeakMap<TreeNode, { label: string; normalized: string }>();

function normalizedLabel(node: TreeNode): string {
  const cached = normalizedLabelCache.get(node);
  if (cached?.label === node.label) return cached.normalized;

  const normalized = node.label.toLowerCase();
  normalizedLabelCache.set(node, { label: node.label, normalized });
  return normalized;
}

function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  const filteredNodes: TreeNode[] = [];

  for (const node of nodes) {
    if (node.type === "object-browser" && node.hiddenChildren) {
      const matches = node.hiddenChildren.filter((child) => matchSidebarLabel(normalizedLabel(child), q));
      if (matches.length > 0) filteredNodes.push(...matches);
      continue;
    }

    const label = normalizedLabel(node);
    const selfMatches = !!matchSidebarLabel(label, q);
    const filteredChildren = node.children ? filterTree(node.children, q) : undefined;

    if (selfMatches || (filteredChildren && filteredChildren.length > 0)) {
      if (!node.children) {
        filteredNodes.push(node);
      } else {
        const children = filteredChildren ?? [];
        filteredNodes.push({
          ...node,
          children,
          isExpanded: children.length > 0 && !searchCollapsedIds.value.has(node.id),
        });
      }
    }
  }

  return filteredNodes;
}

function matchesType(node: TreeNode): boolean {
  if (node.type === "connection-group") {
    return node.children?.some(matchesType) ?? false;
  }
  if (node.type !== "connection" || !node.connectionId) return true;
  const config = store.getConfig(node.connectionId);
  if (!config) return true;
  const profile = config.driver_profile || config.db_type;
  return selectedTypes.value.includes(profile);
}

const filteredNodes = computed(() => {
  let nodes = store.treeNodes;

  if (hasTypeFilter.value) {
    nodes = nodes.filter(matchesType).map((node) => {
      if (node.type === "connection-group" && node.children) {
        return { ...node, children: node.children.filter(matchesType) };
      }
      return node;
    });
  }

  const q = deferredSearchQuery.value;
  if (q) {
    nodes = filterTree(nodes, q);
  }

  return nodes;
});

const flatNodes = computed<FlatTreeNode[]>(() => flattenTree(filteredNodes.value));
const useVirtualTree = computed(() => shouldVirtualizeFlatTree(flatNodes.value.length));

const pendingRenameGroupId = ref<string | null>(null);

function createNewGroup() {
  const groupId = store.createConnectionGroup(t("connectionGroup.newGroupDefault"));
  pendingRenameGroupId.value = groupId;
}

function onSearchToggle(node: TreeNode) {
  if (!isSearching.value || !node.children) return;
  const next = new Set(searchCollapsedIds.value);
  if (node.isExpanded) next.add(node.id);
  else next.delete(node.id);
  searchCollapsedIds.value = next;
}
</script>

<template>
  <div class="h-full min-h-0 flex flex-col text-sm select-none">
    <div v-if="store.treeNodes.length > 0" class="sticky top-0 z-10 bg-background px-2 py-1">
      <div class="relative flex items-center gap-1">
        <div class="relative flex-1">
          <Search class="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            v-model="searchQuery"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            class="w-full h-6 pl-7 pr-6 text-xs rounded border border-border bg-background focus:outline-none focus:ring-1 focus:ring-ring"
            :placeholder="t('grid.search')"
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
          :title="t('connectionGroup.createGroup')"
          @click="createNewGroup"
        >
          <FolderPlus class="h-3.5 w-3.5" />
        </button>
        <DropdownMenu v-if="typeStats.length > 1">
          <DropdownMenuTrigger as-child>
            <button
              class="shrink-0 h-6 w-6 flex items-center justify-center rounded border border-border hover:bg-accent"
              :class="hasTypeFilter ? 'text-primary bg-primary/10 border-primary/30' : 'text-muted-foreground'"
              :title="t('sidebar.filterByType')"
            >
              <ListFilter class="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-48">
            <DropdownMenuLabel class="text-xs">{{ t("sidebar.filterByType") }}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              v-for="item in typeStats"
              :key="item.profile"
              class="gap-2"
              :class="isTypeSelected(item.profile) ? 'bg-primary/10 text-primary' : ''"
              @select.prevent="toggleType(item.profile)"
            >
              <Check v-if="isTypeSelected(item.profile)" class="h-3.5 w-3.5 shrink-0 text-primary" />
              <span v-else class="h-3.5 w-3.5 shrink-0" />
              <DatabaseIcon :db-type="item.profile" class="h-4 w-4 shrink-0" />
              <span class="flex-1 truncate">{{ item.label }}</span>
              <span class="text-muted-foreground text-xs">{{ item.count }}</span>
            </DropdownMenuItem>
            <template v-if="hasTypeFilter">
              <DropdownMenuSeparator />
              <DropdownMenuItem @select.prevent="clearTypeFilter">
                <span class="text-xs text-muted-foreground">{{ t("sidebar.clearFilter") }}</span>
              </DropdownMenuItem>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
    <RecycleScroller
      v-if="flatNodes.length > 0 && useVirtualTree"
      class="min-h-0 flex-1 overflow-y-auto"
      :items="flatNodes"
      :item-size="SIDEBAR_TREE_ROW_HEIGHT"
      :buffer="SIDEBAR_TREE_SCROLL_BUFFER"
      :prerender="SIDEBAR_TREE_PRERENDER_COUNT"
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
          @search-toggle="onSearchToggle"
          @rename-started="pendingRenameGroupId = null"
        />
      </template>
    </RecycleScroller>
    <div v-else-if="flatNodes.length > 0" class="min-h-0 flex-1 overflow-y-auto">
      <TreeItem
        v-for="item in flatNodes"
        :key="item.id"
        :node="item.node"
        :depth="item.depth"
        :drag-disabled="isFiltering"
        :pending-rename="pendingRenameGroupId === item.node.id"
        @search-toggle="onSearchToggle"
        @rename-started="pendingRenameGroupId = null"
      />
    </div>
    <div v-if="store.treeNodes.length === 0" class="px-3 py-8 text-center text-muted-foreground text-xs">
      {{ t("sidebar.noConnections") }}
    </div>
  </div>
</template>

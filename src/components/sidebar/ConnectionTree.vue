<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { Search, X, ListFilter, Check, FolderPlus } from "lucide-vue-next";
import { useConnectionStore } from "@/stores/connectionStore";
import type { TreeNode } from "@/types/database";
import TreeItem from "./TreeItem.vue";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
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
const selectedTypes = ref<string[]>([]);

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

function matchesQuery(node: TreeNode, q: string): boolean {
  if (node.label.toLowerCase().includes(q)) return true;
  return node.children?.some((child) => matchesQuery(child, q)) ?? false;
}

function filterTree(nodes: TreeNode[], q: string): TreeNode[] {
  return nodes
    .filter((node) => matchesQuery(node, q))
    .map((node) => {
      if (!node.children) return node;
      const filtered = filterTree(node.children, q);
      return { ...node, children: filtered, isExpanded: filtered.length > 0 };
    });
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

  const q = searchQuery.value.trim().toLowerCase();
  if (q) {
    nodes = filterTree(nodes, q);
  }

  return nodes;
});

const pendingRenameGroupId = ref<string | null>(null);

function createNewGroup() {
  const groupId = store.createConnectionGroup(t("connectionGroup.newGroupDefault"));
  pendingRenameGroupId.value = groupId;
}
</script>

<template>
  <div class="text-sm select-none">
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
            <DropdownMenuLabel class="text-xs">{{ t('sidebar.filterByType') }}</DropdownMenuLabel>
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
                <span class="text-xs text-muted-foreground">{{ t('sidebar.clearFilter') }}</span>
              </DropdownMenuItem>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
    <TreeItem
      v-for="node in filteredNodes"
      :key="node.id"
      :node="node"
      :depth="0"
      :drag-disabled="isFiltering"
      :pending-rename="pendingRenameGroupId === node.id"
      @rename-started="pendingRenameGroupId = null"
    />
    <div v-if="store.treeNodes.length === 0" class="px-3 py-8 text-center text-muted-foreground text-xs">
      {{ t('sidebar.noConnections') }}
    </div>
  </div>
</template>

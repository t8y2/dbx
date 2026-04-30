<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { Search, X } from "lucide-vue-next";
import { useConnectionStore } from "@/stores/connectionStore";
import type { TreeNode } from "@/types/database";
import TreeItem from "./TreeItem.vue";

const { t } = useI18n();
const store = useConnectionStore();
const searchQuery = ref("");

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

const filteredNodes = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return store.treeNodes;
  return filterTree(store.treeNodes, q);
});
</script>

<template>
  <div class="text-sm select-none">
    <div v-if="store.treeNodes.length > 0" class="sticky top-0 z-10 bg-background px-2 py-1">
      <div class="relative">
        <Search class="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
        <input
          v-model="searchQuery"
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
    </div>
    <TreeItem v-for="node in filteredNodes" :key="node.id" :node="node" :depth="0" />
    <div v-if="store.treeNodes.length === 0" class="px-3 py-8 text-center text-muted-foreground text-xs">
      {{ t('sidebar.noConnections') }}
    </div>
  </div>
</template>

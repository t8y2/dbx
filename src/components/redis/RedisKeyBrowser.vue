<script setup lang="ts">
import { computed, ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Search, RefreshCw, Key, Loader2, ChevronRight, ChevronDown, FolderClosed, FolderOpen } from "lucide-vue-next";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import RedisValueViewer from "./RedisValueViewer.vue";
import * as api from "@/lib/api";
import type { RedisKeyInfo } from "@/lib/api";
import {
  buildRedisKeyTree,
  collectExpandedGroupIds,
  flattenVisibleRedisKeyTree,
  type RedisKeyTreeNode,
} from "@/lib/redisKeyTree";

const { t } = useI18n();

const props = defineProps<{
  connectionId: string;
  db: number;
}>();

const flatKeys = ref<RedisKeyInfo[]>([]);
const treeKeys = ref<RedisKeyTreeNode[]>([]);
const loading = ref(false);
const searchPattern = ref("*");
const selectedKeyRaw = ref<string | null>(null);
const cursor = ref(0);
const hasMore = ref(false);
const expandedGroupIds = ref<Set<string>>(new Set());

const PAGE_SIZE = 200;

const effectivePattern = computed(() => searchPattern.value.trim() || "*");
const isSearchMode = computed(() => effectivePattern.value !== "*");
const selectedKey = computed(() => flatKeys.value.find((key) => key.key_raw === selectedKeyRaw.value) ?? null);
const visibleRows = computed(() => flattenVisibleRedisKeyTree(treeKeys.value, expandedGroupIds.value));

function rebuildTree(expandAll = false) {
  const nextTree = buildRedisKeyTree(flatKeys.value, props.db);
  treeKeys.value = nextTree;

  const nextExpanded = new Set<string>();
  const availableExpanded = collectExpandedGroupIds(nextTree);
  if (expandAll) {
    for (const id of availableExpanded) nextExpanded.add(id);
  } else {
    for (const id of expandedGroupIds.value) {
      if (availableExpanded.has(id)) nextExpanded.add(id);
    }
  }
  expandedGroupIds.value = nextExpanded;

  if (selectedKeyRaw.value && !flatKeys.value.some((key) => key.key_raw === selectedKeyRaw.value)) {
    selectedKeyRaw.value = null;
  }
}

async function loadKeys() {
  loading.value = true;
  try {
    const result = await api.redisScanKeys(props.connectionId, props.db, 0, effectivePattern.value, PAGE_SIZE);
    flatKeys.value = result.keys;
    cursor.value = result.cursor;
    hasMore.value = result.cursor !== 0;
    selectedKeyRaw.value = null;
    rebuildTree(isSearchMode.value);
  } finally {
    loading.value = false;
  }
}

async function loadMoreKeys() {
  if (loading.value || !hasMore.value) return;

  loading.value = true;
  try {
    const result = await api.redisScanKeys(
      props.connectionId,
      props.db,
      cursor.value,
      effectivePattern.value,
      PAGE_SIZE,
    );
    const existingKeys = new Set(flatKeys.value.map((key) => key.key_raw));
    flatKeys.value = [...flatKeys.value, ...result.keys.filter((key) => !existingKeys.has(key.key_raw))];
    cursor.value = result.cursor;
    hasMore.value = result.cursor !== 0;
    rebuildTree(isSearchMode.value);
  } finally {
    loading.value = false;
  }
}

function toggleGroup(groupId: string) {
  const next = new Set(expandedGroupIds.value);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  expandedGroupIds.value = next;
}

function onRowClick(node: RedisKeyTreeNode) {
  if (node.kind === "group") {
    toggleGroup(node.id);
    return;
  }

  selectedKeyRaw.value = node.keyRaw;
}

function onKeyDeleted() {
  if (!selectedKeyRaw.value) return;
  flatKeys.value = flatKeys.value.filter((key) => key.key_raw !== selectedKeyRaw.value);
  selectedKeyRaw.value = null;
  rebuildTree(false);
}

function typeColor(type: string): string {
  switch (type) {
    case "string":
      return "text-green-500";
    case "list":
      return "text-blue-500";
    case "set":
      return "text-purple-500";
    case "zset":
      return "text-amber-500";
    case "hash":
      return "text-orange-500";
    case "stream":
      return "text-teal-500";
    default:
      return "text-muted-foreground";
  }
}

onMounted(loadKeys);
</script>

<template>
  <Splitpanes class="h-full">
    <!-- Key list (left) -->
    <Pane :size="30" :min-size="15" :max-size="50">
      <div class="h-full flex flex-col overflow-hidden">
        <!-- Search bar -->
        <div class="h-9 flex items-center gap-1 px-2 border-b shrink-0">
          <Search class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <Input
            v-model="searchPattern"
            class="h-6 text-xs border-0 shadow-none focus-visible:ring-0"
            :placeholder="t('redis.pattern')"
            @keydown.enter="loadKeys"
          />
          <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" @click="loadKeys">
            <Loader2 v-if="loading" class="h-3 w-3 animate-spin" />
            <RefreshCw v-else class="h-3 w-3" />
          </Button>
        </div>

        <!-- Key count -->
        <div class="h-9 flex items-center px-3 text-xs text-muted-foreground border-b shrink-0">
          {{ loading && flatKeys.length === 0 ? t("redis.loadingKeys") : t("redis.keys", { count: flatKeys.length }) }}
        </div>

        <!-- Key tree -->
        <div class="flex-1 overflow-y-auto">
          <div
            v-for="row in visibleRows"
            :key="row.node.id"
            class="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-accent/50 border-b border-border/50"
            :class="{ 'bg-accent': row.node.kind === 'leaf' && selectedKeyRaw === row.node.keyRaw }"
            :style="{ paddingLeft: `${12 + row.depth * 18}px` }"
            :title="row.node.kind === 'leaf' ? row.node.fullKeyDisplay : row.node.pathSegments.join(':')"
            @click="onRowClick(row.node)"
          >
            <template v-if="row.node.kind === 'group'">
              <component
                :is="expandedGroupIds.has(row.node.id) ? ChevronDown : ChevronRight"
                class="w-3 h-3 shrink-0 text-muted-foreground"
              />
              <component
                :is="expandedGroupIds.has(row.node.id) ? FolderOpen : FolderClosed"
                class="w-3 h-3 shrink-0 text-amber-500"
              />
              <span class="truncate flex-1 font-mono">{{ row.node.label }}</span>
            </template>
            <template v-else>
              <span class="w-3 h-3 shrink-0" />
              <Key class="w-3 h-3 shrink-0" :class="typeColor(row.node.keyType)" />
              <span class="truncate font-mono">{{ row.node.label || row.node.fullKeyDisplay }}</span>
              <span
                v-if="row.node.label !== row.node.fullKeyDisplay"
                class="truncate flex-1 text-[10px] text-muted-foreground font-mono"
              >
                {{ row.node.fullKeyDisplay }}
              </span>
              <span v-else class="flex-1" />
              <Badge variant="outline" class="text-[10px] px-1 py-0 shrink-0">{{ row.node.keyType }}</Badge>
            </template>
          </div>
          <div v-if="flatKeys.length === 0 && !loading" class="px-3 py-8 text-center text-muted-foreground text-xs">
            {{ t("redis.noKeys") }}
          </div>
          <div
            v-if="loading && flatKeys.length === 0"
            class="px-3 py-8 flex items-center justify-center gap-2 text-muted-foreground text-xs"
          >
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
            <span>{{ t("redis.loadingKeys") }}</span>
          </div>
          <div v-if="hasMore || (loading && flatKeys.length > 0)" class="p-2">
            <Button variant="outline" size="sm" class="w-full h-7 text-xs" :disabled="loading" @click="loadMoreKeys">
              <Loader2 v-if="loading" class="w-3 h-3 mr-1.5 animate-spin" />
              {{ t("redis.loadMoreKeys") }}
            </Button>
          </div>
        </div>
      </div>
    </Pane>

    <!-- Value viewer (right) -->
    <Pane :size="70">
      <div class="h-full min-w-0">
        <RedisValueViewer
          v-if="selectedKey"
          :key="selectedKey.key_raw"
          :connection-id="connectionId"
          :db="db"
          :key-display="selectedKey.key_display"
          :key-raw="selectedKey.key_raw"
          @deleted="onKeyDeleted"
        />
        <div v-else class="h-full flex items-center justify-center text-muted-foreground text-sm">
          {{ t("redis.selectKey") }}
        </div>
      </div>
    </Pane>
  </Splitpanes>
</template>

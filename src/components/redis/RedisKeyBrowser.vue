<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Search, RefreshCw, Key, Loader2 } from "lucide-vue-next";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import RedisValueViewer from "./RedisValueViewer.vue";
import * as api from "@/lib/api";
import type { RedisKeyInfo } from "@/lib/api";

const { t } = useI18n();

const props = defineProps<{
  connectionId: string;
  db: number;
}>();

const keys = ref<RedisKeyInfo[]>([]);
const loading = ref(false);
const searchPattern = ref("*");
const selectedKey = ref<string | null>(null);
const cursor = ref(0);
const hasMore = ref(false);

const PAGE_SIZE = 200;

async function loadKeys() {
  loading.value = true;
  try {
    const result = await api.redisScanKeys(props.connectionId, props.db, 0, searchPattern.value, PAGE_SIZE);
    keys.value = result.keys;
    cursor.value = result.cursor;
    hasMore.value = result.cursor !== 0;
    selectedKey.value = null;
  } finally {
    loading.value = false;
  }
}

async function loadMoreKeys() {
  if (loading.value || !hasMore.value) return;

  loading.value = true;
  try {
    const result = await api.redisScanKeys(props.connectionId, props.db, cursor.value, searchPattern.value, PAGE_SIZE);
    const existingKeys = new Set(keys.value.map((k) => k.key));
    keys.value = [...keys.value, ...result.keys.filter((k) => !existingKeys.has(k.key))];
    cursor.value = result.cursor;
    hasMore.value = result.cursor !== 0;
  } finally {
    loading.value = false;
  }
}

function selectKey(key: string) {
  selectedKey.value = key;
}

function onKeyDeleted() {
  if (selectedKey.value) {
    keys.value = keys.value.filter((k) => k.key !== selectedKey.value);
    selectedKey.value = null;
  }
}

function typeColor(type: string): string {
  switch (type) {
    case "string": return "text-green-500";
    case "list": return "text-blue-500";
    case "set": return "text-purple-500";
    case "zset": return "text-amber-500";
    case "hash": return "text-orange-500";
    case "stream": return "text-teal-500";
    default: return "text-muted-foreground";
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
        {{ loading && keys.length === 0 ? t('redis.loadingKeys') : t('redis.keys', { count: keys.length }) }}
      </div>

      <!-- Key list -->
      <div class="flex-1 overflow-y-auto">
        <div
          v-for="k in keys"
          :key="k.key"
          class="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-accent/50 border-b border-border/50"
          :class="{ 'bg-accent': selectedKey === k.key }"
          @click="selectKey(k.key)"
        >
          <Key class="w-3 h-3 shrink-0" :class="typeColor(k.key_type)" />
          <span class="truncate flex-1 font-mono">{{ k.key }}</span>
          <Badge variant="outline" class="text-[10px] px-1 py-0 shrink-0">{{ k.key_type }}</Badge>
        </div>
        <div v-if="keys.length === 0 && !loading" class="px-3 py-8 text-center text-muted-foreground text-xs">
          {{ t('redis.noKeys') }}
        </div>
        <div v-if="loading && keys.length === 0" class="px-3 py-8 flex items-center justify-center gap-2 text-muted-foreground text-xs">
          <Loader2 class="w-3.5 h-3.5 animate-spin" />
          <span>{{ t('redis.loadingKeys') }}</span>
        </div>
        <div v-if="hasMore || (loading && keys.length > 0)" class="p-2">
          <Button variant="outline" size="sm" class="w-full h-7 text-xs" :disabled="loading" @click="loadMoreKeys">
            <Loader2 v-if="loading" class="w-3 h-3 mr-1.5 animate-spin" />
            {{ t('redis.loadMoreKeys') }}
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
        :key="selectedKey"
        :connection-id="connectionId"
        :key-name="selectedKey"
        @deleted="onKeyDeleted"
      />
      <div v-else class="h-full flex items-center justify-center text-muted-foreground text-sm">
        {{ t('redis.selectKey') }}
      </div>
    </div>
    </Pane>
  </Splitpanes>
</template>

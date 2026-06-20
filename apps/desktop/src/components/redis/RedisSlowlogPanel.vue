<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2, Search } from "@lucide/vue";
import { RecycleScroller } from "vue-virtual-scroller";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as api from "@/lib/api";
import type { RedisSlowlogEntry, RedisNodeEndpoint } from "@/lib/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";

const props = defineProps<{
  connectionId: string;
  db: number;
}>();

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();

// --- State ---
const count = ref(100);
const nodes = ref<RedisNodeEndpoint[]>([]);
const selectedNodeIndex = ref(-1);
const entries = ref<RedisSlowlogEntry[]>([]);
const sortField = ref<keyof RedisSlowlogEntry>("id");
const sortOrder = ref<"asc" | "desc">("asc");
const loading = ref(false);
const showDetailDialog = ref(false);
const selectedEntry = ref<RedisSlowlogEntry | null>(null);

// --- Connection mode ---
const connectionMode = computed(() => {
  return connectionStore.getConfig(props.connectionId)?.redis_connection_mode;
});

const showNodeSelector = computed(() => {
  // Cluster mode needs node selection; sentinel connections use Direct path (no selector needed)
  return connectionMode.value === "cluster";
});

const nodeOptions = computed(() => {
  return nodes.value.map((n) => `${n.host}:${n.port}`);
});

const selectedEndpoint = computed(() => {
  if (selectedNodeIndex.value < 0) return null;
  return nodes.value[selectedNodeIndex.value] ?? null;
});

const showClientColumns = computed(() => {
  return entries.value.some((e) => e.client_addr != null || e.client_name != null);
});

// --- Load cluster nodes on mount ---
onMounted(async () => {
  if (connectionMode.value === "cluster") {
    try {
      nodes.value = await api.redisClusterMasterNodes(props.connectionId);
    } catch {
      // Silently fail — nodes list is best-effort
    }
  }
});

// --- Sorted entries ---
const sortedEntries = computed(() => {
  const field = sortField.value;
  const order = sortOrder.value === "asc" ? 1 : -1;
  return [...entries.value].sort((a, b) => {
    const aVal = a[field];
    const bVal = b[field];
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return 1;
    if (bVal == null) return -1;
    if (typeof aVal === "string" && typeof bVal === "string") {
      return aVal.localeCompare(bVal) * order;
    }
    return (aVal < bVal ? -1 : aVal > bVal ? 1 : 0) * order;
  });
});

// --- Methods ---
function sortBy(field: keyof RedisSlowlogEntry) {
  if (sortField.value === field) {
    sortOrder.value = sortOrder.value === "asc" ? "desc" : "asc";
  } else {
    sortField.value = field;
    sortOrder.value = "asc";
  }
}

function sortIndicator(field: keyof RedisSlowlogEntry): string {
  if (sortField.value !== field) return "";
  return sortOrder.value === "asc" ? " ↑" : " ↓";
}

function formatTimestamp(ts: number): string {
  if (ts <= 0) return "NIL";
  const d = new Date(ts * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function displayValue(val: string | null): string {
  return val ?? "NIL";
}

async function querySlowlog() {
  if (showNodeSelector.value && selectedNodeIndex.value < 0) {
    toast(t("redis.slowlogNodeRequired"), 3000);
    return;
  }

  loading.value = true;
  try {
    let result: RedisSlowlogEntry[];
    if (showNodeSelector.value && selectedEndpoint.value) {
      result = await api.redisSlowlogGet(props.connectionId, count.value, selectedEndpoint.value.host, selectedEndpoint.value.port);
    } else {
      result = await api.redisSlowlogGet(props.connectionId, count.value);
    }
    entries.value = result;
    // Default sort by id ascending
    sortField.value = "id";
    sortOrder.value = "asc";
  } catch (e) {
    toast(t("redis.slowlogFetchFailed", { error: e instanceof Error ? e.message : String(e) }), 5000);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Top bar: count input, node dropdown, query button -->
    <div class="flex items-center gap-2 px-3 py-1.5 border-b bg-muted/30 min-h-0 shrink-0">
      <label class="text-xs font-medium whitespace-nowrap shrink-0">{{ t("redis.slowlogCount") }}</label>
      <Input v-model.number="count" type="number" min="1" max="10000" class="h-7 w-20 text-xs" :placeholder="t('redis.slowlogCount')" />
      <template v-if="showNodeSelector">
        <label class="text-xs font-medium whitespace-nowrap shrink-0 ml-1">{{ t("redis.slowlogNode") }}</label>
        <Select v-model="selectedNodeIndex">
          <SelectTrigger class="h-7 w-auto min-w-[140px] text-xs">
            <SelectValue :placeholder="t('redis.slowlogSelectNode')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="(node, idx) in nodeOptions" :key="idx" :value="idx" class="text-xs">
              {{ node }}
            </SelectItem>
          </SelectContent>
        </Select>
      </template>
      <span class="flex-1"></span>
      <Button size="sm" class="h-7 text-xs gap-1" :disabled="loading" @click="querySlowlog">
        <Loader2 v-if="loading" class="size-3.5 animate-spin" />
        <Search v-else class="size-3.5" />
        {{ t("redis.slowlogQuery") }}
      </Button>
    </div>

    <!-- Results table -->
    <div class="flex-1 flex flex-col min-h-0 relative">
      <!-- Empty state -->
      <div v-if="entries.length === 0 && !loading" class="flex-1 flex items-center justify-center text-xs text-muted-foreground">
        {{ t("redis.slowlogEmpty") }}
      </div>

      <!-- Table header -->
      <div v-if="entries.length > 0" class="flex items-center gap-2 px-3 py-1 border-b shrink-0 bg-background">
        <span class="text-xs font-medium">{{ t("redis.slowlog") }}</span>
        <span class="text-xs text-muted-foreground">({{ t("redis.slowlogTotal", { count: entries.length }) }})</span>
      </div>

      <!-- Sortable column headers -->
      <div v-if="entries.length > 0" class="flex items-center border-b px-3 shrink-0 bg-muted/20 text-xs font-medium text-muted-foreground select-none" style="height: 28px">
        <button class="w-16 shrink-0 text-left hover:text-foreground transition-colors text-xs font-medium" @click="sortBy('id')">{{ t("redis.slowlogColumnId") }}<span v-html="sortIndicator('id')"></span></button>
        <button class="w-40 shrink-0 text-left hover:text-foreground transition-colors text-xs font-medium" @click="sortBy('timestamp')">{{ t("redis.slowlogColumnTimestamp") }}<span v-html="sortIndicator('timestamp')"></span></button>
        <button class="w-24 shrink-0 text-left hover:text-foreground transition-colors text-xs font-medium" @click="sortBy('duration_micros')">{{ t("redis.slowlogColumnDuration") }}<span v-html="sortIndicator('duration_micros')"></span></button>
        <button class="flex-1 min-w-0 text-left hover:text-foreground transition-colors text-xs font-medium" @click="sortBy('command')">{{ t("redis.slowlogColumnCommand") }}<span v-html="sortIndicator('command')"></span></button>
        <button v-if="showClientColumns" class="w-32 shrink-0 text-left hover:text-foreground transition-colors text-xs font-medium" @click="sortBy('client_addr')">{{ t("redis.slowlogColumnClientAddr") }}<span v-html="sortIndicator('client_addr')"></span></button>
        <button v-if="showClientColumns" class="w-32 shrink-0 text-left hover:text-foreground transition-colors text-xs font-medium" @click="sortBy('client_name')">{{ t("redis.slowlogColumnClientName") }}<span v-html="sortIndicator('client_name')"></span></button>
      </div>

      <!-- Table with virtual scrolling -->
      <div v-if="entries.length > 0" class="flex-1 overflow-hidden">
        <RecycleScroller class="h-full" :items="sortedEntries" :item-size="32" :buffer="400" key-field="id" v-slot="{ item }: { item: RedisSlowlogEntry }">
          <div
            class="flex items-center border-b border-dashed border-border/50 px-3 text-xs hover:bg-muted/30 cursor-pointer"
            style="height: 32px"
            @click="
              selectedEntry = item;
              showDetailDialog = true;
            "
          >
            <span class="w-16 shrink-0 text-muted-foreground tabular-nums">{{ item.id }}</span>
            <span class="w-40 shrink-0 font-mono tabular-nums">{{ formatTimestamp(item.timestamp) }}</span>
            <span class="w-24 shrink-0 font-mono tabular-nums text-muted-foreground">{{ item.duration_micros }}</span>
            <span class="flex-1 min-w-0 truncate font-mono" :title="item.command">{{ item.command }}</span>
            <span v-if="showClientColumns" class="w-32 shrink-0 text-muted-foreground truncate" :title="displayValue(item.client_addr)">{{ displayValue(item.client_addr) }}</span>
            <span v-if="showClientColumns" class="w-32 shrink-0 text-muted-foreground truncate" :title="displayValue(item.client_name)">{{ displayValue(item.client_name) }}</span>
          </div>
        </RecycleScroller>
      </div>

      <!-- Loading overlay -->
      <div v-if="loading" class="absolute inset-0 flex items-center justify-center bg-background/60 z-10">
        <Loader2 class="size-5 animate-spin text-muted-foreground" />
      </div>
    </div>

    <!-- Detail dialog -->
    <Dialog v-model:open="showDetailDialog">
      <DialogContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle class="text-sm">{{ t("redis.slowlogDetailTitle", { id: selectedEntry?.id ?? "" }) }}</DialogTitle>
        </DialogHeader>
        <div v-if="selectedEntry" class="grid gap-3 text-xs">
          <div class="grid grid-cols-[80px_1fr] gap-x-3 gap-y-2">
            <span class="font-medium text-muted-foreground">{{ t("redis.slowlogColumnId") }}</span>
            <span class="font-mono">{{ selectedEntry.id }}</span>

            <span class="font-medium text-muted-foreground">{{ t("redis.slowlogColumnTimestamp") }}</span>
            <span class="font-mono">{{ formatTimestamp(selectedEntry.timestamp) }}</span>

            <span class="font-medium text-muted-foreground">{{ t("redis.slowlogColumnDuration") }}</span>
            <span class="font-mono">{{ selectedEntry.duration_micros }} μs</span>

            <span class="font-medium text-muted-foreground">{{ t("redis.slowlogColumnCommand") }}</span>
            <pre class="font-mono whitespace-pre-wrap break-words bg-muted rounded p-2 m-0 max-h-48 overflow-auto">{{ selectedEntry.command }}</pre>

            <span class="font-medium text-muted-foreground">{{ t("redis.slowlogColumnClientAddr") }}</span>
            <span class="font-mono">{{ displayValue(selectedEntry.client_addr) }}</span>

            <span class="font-medium text-muted-foreground">{{ t("redis.slowlogColumnClientName") }}</span>
            <span class="font-mono">{{ displayValue(selectedEntry.client_name) }}</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw, Loader2, Search, ChevronDown, ChevronRight, Clock, Info, HardDrive, Activity, Target, Database, Users, Terminal, AlertCircle } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import * as api from "@/lib/backend/api";
import type { RedisNodeEndpoint, RedisCommandResult } from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface InfoEntry {
  key: string;
  value: string;
}

interface InfoSection {
  name: string;
  entries: InfoEntry[];
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
const props = defineProps<{
  connectionId: string;
}>();

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const loading = ref(true);
const fetching = ref(false);
const error = ref<string | null>(null);
const rawSections = ref<InfoSection[]>([]);
const masterNodes = ref<RedisNodeEndpoint[]>([]);
const selectedNodeIndex = ref("0"); // string for Select compatibility
const searchQuery = ref("");
const collapsedSections = ref<Set<string>>(new Set());
const autoRefreshInterval = ref<number>(0); // 0 = off, 5, 10, 30, 60 (seconds)

const infoSectionI18nKeys: Record<string, string> = {
  Server: "redis.dashboard.sections.server",
  Clients: "redis.dashboard.sections.clients",
  Memory: "redis.dashboard.sections.memory",
  Persistence: "redis.dashboard.sections.persistence",
  Stats: "redis.dashboard.sections.stats",
  Replication: "redis.dashboard.sections.replication",
  CPU: "redis.dashboard.sections.cpu",
  Modules: "redis.dashboard.sections.modules",
  Commandstats: "redis.dashboard.sections.commandstats",
  Errorstats: "redis.dashboard.sections.errorstats",
  Latencystats: "redis.dashboard.sections.latencystats",
  Cluster: "redis.dashboard.sections.cluster",
  Keyspace: "redis.dashboard.sections.keyspace",
};

let refreshTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Connection mode
// ---------------------------------------------------------------------------
const connectionMode = computed(() => {
  return connectionStore.getConfig(props.connectionId)?.redis_connection_mode;
});

const isClusterMode = computed(() => connectionMode.value === "cluster");
const showNodeSelector = computed(() => isClusterMode.value);

const nodeOptions = computed(() => {
  return masterNodes.value.map((n) => `${n.host}:${n.port}`);
});

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------
function parseInfoText(text: string): InfoSection[] {
  const sections: InfoSection[] = [];
  let current: InfoSection | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("# ")) {
      current = { name: line.slice(2).trim(), entries: [] };
      sections.push(current);
    } else if (current && line.includes(":")) {
      const idx = line.indexOf(":");
      current.entries.push({ key: line.slice(0, idx), value: line.slice(idx + 1).replace(/\r$/, "") });
    }
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------
async function fetchInfo() {
  if (fetching.value) return;
  fetching.value = true;
  loading.value = true;
  error.value = null;
  try {
    const result: RedisCommandResult = await api.redisExecuteCommand(props.connectionId, 0, "INFO ALL");

    let infoText = "";

    if (isClusterMode.value && Array.isArray(result.value)) {
      // Cluster mode: result is [[addr, infoText], ...]
      const pairs: [string, string][] = result.value.map((item: any) => {
        if (Array.isArray(item) && item.length >= 2) return [String(item[0]), String(item[1])];
        return ["", ""];
      });
      // Populate masterNodes from INFO response on first load if fetchClusterNodes failed
      if (masterNodes.value.length === 0) {
        masterNodes.value = pairs.map(([addr]) => {
          const [host, portStr] = addr.split(":");
          return { host, port: parseInt(portStr, 10) || 6379 };
        });
      }
      // Match selected node by address, fall back to first node
      const selectedAddr = nodeOptions.value[Number(selectedNodeIndex.value)];
      const found = pairs.find(([addr]) => addr === selectedAddr);
      if (found) {
        infoText = found[1];
      } else if (pairs.length > 0) {
        infoText = pairs[0][1];
      }
    } else if (typeof result.value === "string") {
      infoText = result.value;
    }

    rawSections.value = parseInfoText(infoText);
    // Default all sections to collapsed (only on first load to preserve user interactions)
    if (collapsedSections.value.size === 0) {
      collapsedSections.value = new Set(rawSections.value.map((s) => s.name));
    }
  } catch (e: any) {
    error.value = e?.message || String(e);
    rawSections.value = [];
  } finally {
    loading.value = false;
    fetching.value = false;
  }
}

async function fetchClusterNodes() {
  if (!isClusterMode.value) return;
  try {
    masterNodes.value = await api.redisClusterMasterNodes(props.connectionId);
  } catch (e: any) {
    // Nodes will be populated from the INFO response instead
    console.warn("Failed to fetch cluster master nodes:", e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// Stat card helpers
// ---------------------------------------------------------------------------
function findValue(sectionName: string, key: string): string | undefined {
  for (const sec of rawSections.value) {
    if (sec.name === sectionName) {
      for (const entry of sec.entries) {
        if (entry.key === key) return entry.value;
      }
    }
  }
  return undefined;
}

const totalMemory = computed(() => {
  return findValue("Memory", "total_system_memory_human") || findValue("Memory", "maxmemory_human") || "N/A";
});

const usedMemory = computed(() => {
  return findValue("Memory", "used_memory_human") || "N/A";
});

const operation = computed(() => {
  const val = findValue("Stats", "total_commands_processed");
  if (val === undefined) return "N/A";
  const num = parseInt(val, 10);
  if (isNaN(num)) return val;
  return num.toLocaleString();
});

const hitRatio = computed(() => {
  const hits = findValue("Stats", "keyspace_hits");
  const misses = findValue("Stats", "keyspace_misses");
  if (hits === undefined || misses === undefined) return "N/A";
  const h = parseInt(hits, 10);
  const m = parseInt(misses, 10);
  if (isNaN(h) || isNaN(m) || h + m === 0) return "N/A";
  return `${((h / (h + m)) * 100).toFixed(2)}%`;
});

const keyCount = computed(() => {
  const keyspaceSec = rawSections.value.find((s) => s.name === "Keyspace");
  if (!keyspaceSec) return "N/A";
  let total = 0;
  for (const entry of keyspaceSec.entries) {
    const match = entry.value.match(/keys=(\d+)/);
    if (match) total += parseInt(match[1], 10);
  }
  return total.toLocaleString();
});

const connectedClients = computed(() => {
  const val = findValue("Clients", "connected_clients");
  if (val === undefined) return "N/A";
  const num = parseInt(val, 10);
  if (isNaN(num)) return val;
  return num.toLocaleString();
});

// ---------------------------------------------------------------------------
// Search / filter
// ---------------------------------------------------------------------------
const filteredSections = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return rawSections.value;
  return rawSections.value
    .map((sec) => ({
      ...sec,
      entries: sec.entries.filter((e) => e.key.toLowerCase().includes(q)),
    }))
    .filter((sec) => sec.entries.length > 0);
});

function toggleSection(name: string) {
  const next = new Set(collapsedSections.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  collapsedSections.value = next;
}

function isCollapsed(name: string): boolean {
  return collapsedSections.value.has(name);
}

function infoSectionTitle(name: string): string {
  const key = infoSectionI18nKeys[name];
  return key ? t(key) : name;
}

// ---------------------------------------------------------------------------
// Auto-refresh
// ---------------------------------------------------------------------------
function startAutoRefresh() {
  stopAutoRefresh();
  if (autoRefreshInterval.value > 0) {
    refreshTimer = setInterval(() => {
      fetchInfo();
    }, autoRefreshInterval.value * 1000);
  }
}

function stopAutoRefresh() {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

watch(autoRefreshInterval, () => {
  startAutoRefresh();
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
onMounted(async () => {
  try {
    await connectionStore.ensureConnected(props.connectionId);
  } catch (e) {
    console.warn("[DBX] ensureConnected failed for", props.connectionId, e);
  }
  await fetchClusterNodes();
  await fetchInfo();
});

onUnmounted(() => {
  stopAutoRefresh();
});

// ---------------------------------------------------------------------------
// Refresh button
// ---------------------------------------------------------------------------
async function handleRefresh() {
  // Re-fetch cluster nodes only if in cluster mode
  if (isClusterMode.value) {
    await fetchClusterNodes();
  }
  await fetchInfo();
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------
function copyToClipboard(text: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      toast(t("redis.copied"), 1500);
    })
    .catch(() => {
      // Fallback for environments without clipboard API
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    });
}

function copyEntryKey(entry: InfoEntry) {
  copyToClipboard(entry.key);
}

function copyEntryValue(entry: InfoEntry) {
  copyToClipboard(entry.value);
}
</script>

<template>
  <div class="h-full flex flex-col bg-background">
    <!-- Header toolbar -->
    <div class="shrink-0 border-b bg-muted/20 px-4 py-2">
      <!-- Top row: node selector (cluster only) + refresh controls -->
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <div v-if="showNodeSelector && nodeOptions.length > 0" class="flex items-center gap-2">
            <span class="text-xs text-muted-foreground whitespace-nowrap">{{ t("redis.dashboard.node") }}:</span>
            <Select v-model="selectedNodeIndex" @update:model-value="fetchInfo">
              <SelectTrigger class="h-7 w-auto min-w-[140px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="(node, i) in nodeOptions" :key="i" :value="String(i)" class="text-xs">
                  {{ node }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <!-- Auto-refresh select -->
          <Select v-model="autoRefreshInterval">
            <SelectTrigger class="h-7 w-auto min-w-[80px] text-xs">
              <Clock class="mr-1 h-3 w-3" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem :value="0" class="text-xs">{{ t("redis.dashboard.off") }}</SelectItem>
              <SelectItem :value="1" class="text-xs">1s</SelectItem>
              <SelectItem :value="5" class="text-xs">5s</SelectItem>
              <SelectItem :value="15" class="text-xs">15s</SelectItem>
              <SelectItem :value="30" class="text-xs">30s</SelectItem>
            </SelectContent>
          </Select>
          <!-- Refresh button -->
          <Tooltip>
            <TooltipTrigger as-child>
              <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" :disabled="loading" @click="handleRefresh">
                <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
                <RefreshCw v-else class="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ t("redis.dashboard.refresh") }}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>

    <!-- Error banner -->
    <div v-if="error" class="shrink-0 mx-4 mt-2 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      <AlertCircle class="h-3.5 w-3.5 shrink-0" />
      <span>{{ error }}</span>
    </div>

    <!-- Scrollable content -->
    <div class="flex-1 min-h-0 overflow-auto">
      <!-- Stat cards -->
      <div class="grid grid-cols-6 gap-3 px-4 pt-3 pb-2">
        <!-- Total Memory -->
        <div class="rounded-lg border bg-card text-card-foreground p-3">
          <div class="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
            <HardDrive class="h-3.5 w-3.5" />
            <span>{{ t("redis.dashboard.totalMemory") }}</span>
          </div>
          <div class="text-xl font-semibold tabular-nums dbx-editor-font-family truncate" :title="totalMemory">
            {{ totalMemory }}
          </div>
        </div>
        <!-- Used Memory -->
        <div class="rounded-lg border bg-card text-card-foreground p-3">
          <div class="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
            <Activity class="h-3.5 w-3.5" />
            <span>{{ t("redis.dashboard.usedMemory") }}</span>
          </div>
          <div class="text-xl font-semibold tabular-nums dbx-editor-font-family truncate" :title="usedMemory">
            {{ usedMemory }}
          </div>
        </div>
        <!-- Operation -->
        <div class="rounded-lg border bg-card text-card-foreground p-3">
          <div class="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
            <Terminal class="h-3.5 w-3.5" />
            <span>{{ t("redis.dashboard.operations") }}</span>
          </div>
          <div class="text-xl font-semibold tabular-nums dbx-editor-font-family truncate" :title="operation">
            {{ operation }}
          </div>
        </div>
        <!-- Hit Ratio -->
        <div class="rounded-lg border bg-card text-card-foreground p-3">
          <div class="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
            <Target class="h-3.5 w-3.5" />
            <span>{{ t("redis.dashboard.hitRatio") }}</span>
          </div>
          <div class="text-xl font-semibold tabular-nums dbx-editor-font-family truncate" :title="hitRatio">
            {{ hitRatio }}
          </div>
        </div>
        <!-- Key Count -->
        <div class="rounded-lg border bg-card text-card-foreground p-3">
          <div class="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
            <Database class="h-3.5 w-3.5" />
            <span>{{ t("redis.dashboard.keyCount") }}</span>
          </div>
          <div class="text-xl font-semibold tabular-nums dbx-editor-font-family truncate" :title="keyCount">
            {{ keyCount }}
          </div>
        </div>
        <!-- Clients -->
        <div class="rounded-lg border bg-card text-card-foreground p-3">
          <div class="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
            <Users class="h-3.5 w-3.5" />
            <span>{{ t("redis.dashboard.clients") }}</span>
          </div>
          <div class="text-xl font-semibold tabular-nums dbx-editor-font-family truncate" :title="connectedClients">
            {{ connectedClients }}
          </div>
        </div>
      </div>

      <!-- Search bar -->
      <div class="px-4 pb-2">
        <div class="relative">
          <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input v-model="searchQuery" class="h-8 pl-7 text-xs" :placeholder="t('redis.dashboard.searchIndicators')" />
        </div>
      </div>

      <!-- Loading state -->
      <div v-if="loading && rawSections.length === 0" class="flex items-center justify-center py-12 text-xs text-muted-foreground">
        <Loader2 class="mr-2 h-4 w-4 animate-spin" />
        {{ t("common.loading") }}
      </div>

      <!-- Info sections -->
      <div v-else-if="filteredSections.length > 0" class="px-4 pb-4 space-y-1">
        <div v-for="section in filteredSections" :key="section.name" class="rounded-lg border overflow-hidden" :class="[!isCollapsed(section.name) ? 'bg-muted/60' : '']">
          <!-- Section header (clickable) -->
          <button class="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/50 transition-colors text-left" @click="toggleSection(section.name)">
            <component :is="isCollapsed(section.name) ? ChevronRight : ChevronDown" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>{{ infoSectionTitle(section.name) }}</span>
            <span class="ml-auto text-muted-foreground font-normal">{{ section.entries.length }}</span>
          </button>
          <!-- Section body -->
          <div v-if="!isCollapsed(section.name)" class="border-t">
            <table class="w-full text-xs border-collapse">
              <tbody>
                <tr v-for="(entry, ei) in section.entries" :key="ei" class="hover:bg-muted/20">
                  <td class="w-1/2 border-r border-b px-3 py-1.5 text-muted-foreground select-text break-all cursor-context-menu" :title="t('common.copy') || 'Copy'" @contextmenu.prevent="copyEntryKey(entry)">{{ entry.key }}</td>
                  <td class="w-1/2 border-b px-3 py-1.5 dbx-editor-font-family tabular-nums select-text break-all cursor-context-menu" :title="t('common.copy') || 'Copy'" @contextmenu.prevent="copyEntryValue(entry)">{{ entry.value }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Empty / no data -->
      <div v-else-if="!loading" class="flex flex-col items-center justify-center py-12 text-xs text-muted-foreground">
        <Info class="mb-2 h-5 w-5" />
        <span v-if="searchQuery">{{ t("redis.dashboard.noMatchingIndicators") }}</span>
        <span v-else>{{ t("redis.dashboard.noDataAvailable") }}</span>
      </div>
    </div>
  </div>
</template>

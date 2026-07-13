<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Activity, ArrowDownUp, ChevronRight, Database, Gauge, Loader2, RefreshCcw, Search, Timer, TriangleAlert, Users } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import MetricCard from "@/components/common/MetricCard.vue";
import MetricLineChart from "@/components/chart/MetricLineChart.vue";
import * as api from "@/lib/backend/api";
import { computeQps, computeRate, formatBytes, formatBytesPerSec, formatNumber, formatUptime, GLOBAL_STATUS_SQL, GLOBAL_VARIABLES_SQL, innodbBufferHitRatio, MAX_SAMPLES, parseStatusResult, statusEntries, statusNumber, type StatusSample } from "@/lib/database/mysqlServerStatus";

const props = defineProps<{
  connectionId: string;
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();

const loading = ref(false);
const fetching = ref(false);
const error = ref("");
const variables = ref<Record<string, string>>({});
const samples = ref<StatusSample[]>([]);
const autoRefreshInterval = ref(5);
const statusSearch = ref("");
const showStatusTable = ref(true);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const connectionName = computed(() => connectionStore.getConfig(props.connectionId)?.name ?? "");
const latest = computed(() => samples.value[samples.value.length - 1]);
const previous = computed(() => (samples.value.length >= 2 ? samples.value[samples.value.length - 2] : undefined));

function rate(key: string): number {
  const prev = previous.value;
  const curr = latest.value;
  return prev && curr ? computeRate(prev, curr, key) : 0;
}

const qps = computed(() => {
  const prev = previous.value;
  const curr = latest.value;
  return prev && curr ? computeQps(prev, curr) : 0;
});

const maxConnections = computed(() => statusNumber(variables.value, "max_connections"));
const serverVersion = computed(() => variables.value.version ?? "");
const threadsConnected = computed(() => (latest.value ? statusNumber(latest.value.status, "Threads_connected") : 0));
const threadsRunning = computed(() => (latest.value ? statusNumber(latest.value.status, "Threads_running") : 0));
const slowQueries = computed(() => (latest.value ? statusNumber(latest.value.status, "Slow_queries") : 0));
const uptimeSeconds = computed(() => (latest.value ? statusNumber(latest.value.status, "Uptime") : 0));
const innodbHit = computed(() => (latest.value ? innodbBufferHitRatio(latest.value.status) : null));

// Rate series are computed between consecutive samples, so labels/data start at
// the second sample.
const chartLabels = computed(() => samples.value.slice(1).map((s) => formatClock(s.at)));

function rateSeries(key: string): number[] {
  const out: number[] = [];
  for (let i = 1; i < samples.value.length; i++) {
    out.push(computeRate(samples.value[i - 1], samples.value[i], key));
  }
  return out;
}

const qpsSeries = computed(() => {
  const out: number[] = [];
  for (let i = 1; i < samples.value.length; i++) out.push(computeQps(samples.value[i - 1], samples.value[i]));
  return [{ name: "QPS", data: out, color: "#3b82f6" }];
});

const trafficSeries = computed(() => [
  { name: t("serverDashboard.in"), data: rateSeries("Bytes_received"), color: "#3b82f6" },
  { name: t("serverDashboard.out"), data: rateSeries("Bytes_sent"), color: "#8b5cf6" },
]);

const commandSeries = computed(() => [
  { name: "SELECT", data: rateSeries("Com_select"), color: "#3b82f6" },
  { name: "INSERT", data: rateSeries("Com_insert"), color: "#22c55e" },
  { name: "UPDATE", data: rateSeries("Com_update"), color: "#f59e0b" },
  { name: "DELETE", data: rateSeries("Com_delete"), color: "#ef4444" },
]);

// New sessions per second — the `Connections` status var is the cumulative count
// of connection attempts, so its rate is the sessions-established-per-second.
const sessionsSeries = computed(() => [{ name: t("serverDashboard.sessions"), data: rateSeries("Connections"), color: "#14b8a6" }]);

const statusRows = computed(() => {
  if (!latest.value) return [];
  const query = statusSearch.value.trim().toLowerCase();
  const rows = statusEntries(latest.value.status);
  if (!query) return rows;
  return rows.filter((row) => row.name.toLowerCase().includes(query) || row.value.toLowerCase().includes(query));
});

function formatClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function fetchVariables() {
  try {
    const result = await api.executeQuery(props.connectionId, "", GLOBAL_VARIABLES_SQL, undefined, undefined, { maxRows: 2000 });
    variables.value = parseStatusResult(result);
  } catch {
    // Non-fatal: cards that depend on variables (max_connections/version) degrade.
  }
}

async function fetchStatus(options: { silent?: boolean } = {}) {
  if (fetching.value) return;
  fetching.value = true;
  if (!options.silent) loading.value = true;
  error.value = "";
  try {
    await connectionStore.ensureConnected(props.connectionId);
    const result = await api.executeQuery(props.connectionId, "", GLOBAL_STATUS_SQL, undefined, undefined, { maxRows: 2000 });
    const sample: StatusSample = { at: Date.now(), status: parseStatusResult(result) };
    const next = [...samples.value, sample];
    samples.value = next.length > MAX_SAMPLES ? next.slice(next.length - MAX_SAMPLES) : next;
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
    fetching.value = false;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (autoRefreshInterval.value <= 0) return;
  refreshTimer = setInterval(() => {
    if (document.hidden) return;
    void fetchStatus({ silent: true });
  }, autoRefreshInterval.value * 1000);
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function onIntervalChange(value: unknown) {
  autoRefreshInterval.value = Number(value);
  startAutoRefresh();
}

async function handleRefresh() {
  await fetchStatus();
}

onMounted(async () => {
  await fetchStatus();
  if (!error.value) await fetchVariables();
  startAutoRefresh();
});

onUnmounted(stopAutoRefresh);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex h-11 shrink-0 items-center gap-2 border-b bg-muted/20 px-3">
      <Gauge class="h-4 w-4 text-primary" />
      <div class="truncate text-sm font-semibold">{{ t("serverDashboard.title") }}</div>
      <Badge variant="outline" class="h-5 rounded-md px-1.5 text-[11px]">{{ connectionName }}</Badge>
      <Badge v-if="serverVersion" variant="secondary" class="h-5 rounded-md px-1.5 text-[11px]">{{ serverVersion }}</Badge>
      <div class="ml-auto flex items-center gap-2">
        <span class="text-xs text-muted-foreground">{{ t("serverDashboard.autoRefresh") }}</span>
        <Select :model-value="String(autoRefreshInterval)" @update:model-value="onIntervalChange">
          <SelectTrigger class="h-7 w-24 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0">{{ t("serverDashboard.off") }}</SelectItem>
            <SelectItem value="1">1s</SelectItem>
            <SelectItem value="2">2s</SelectItem>
            <SelectItem value="5">5s</SelectItem>
            <SelectItem value="10">10s</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" :disabled="loading" @click="handleRefresh">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCcw v-else class="h-3.5 w-3.5" />
          {{ t("grid.refresh") }}
        </Button>
      </div>
    </div>

    <div v-if="error" class="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">{{ error }}</div>

    <div class="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <div class="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard :label="t('serverDashboard.qps')" :value="formatNumber(qps)" :icon="Gauge" />
        <MetricCard :label="t('serverDashboard.connections')" :value="`${formatNumber(threadsConnected)}${maxConnections ? ' / ' + formatNumber(maxConnections) : ''}`" :icon="Users" />
        <MetricCard :label="t('serverDashboard.running')" :value="formatNumber(threadsRunning)" :icon="Activity" />
        <MetricCard :label="t('serverDashboard.trafficIn')" :value="formatBytesPerSec(rate('Bytes_received'))" :icon="ArrowDownUp" />
        <MetricCard :label="t('serverDashboard.trafficOut')" :value="formatBytesPerSec(rate('Bytes_sent'))" :icon="ArrowDownUp" />
        <MetricCard :label="t('serverDashboard.slowQueries')" :value="formatNumber(slowQueries)" :icon="TriangleAlert" />
        <MetricCard :label="t('serverDashboard.uptime')" :value="formatUptime(uptimeSeconds)" :icon="Timer" />
        <MetricCard :label="t('serverDashboard.innodbHit')" :value="innodbHit === null ? '—' : innodbHit.toFixed(2) + '%'" :icon="Database" />
      </div>

      <div class="grid shrink-0 grid-cols-1 gap-3 xl:grid-cols-2">
        <MetricLineChart :title="t('serverDashboard.qpsChart')" :labels="chartLabels" :series="qpsSeries" :value-formatter="formatNumber" />
        <MetricLineChart :title="t('serverDashboard.sessionsChart')" :labels="chartLabels" :series="sessionsSeries" :value-formatter="formatNumber" />
        <MetricLineChart :title="t('serverDashboard.trafficChart')" :labels="chartLabels" :series="trafficSeries" :value-formatter="formatBytes" />
        <MetricLineChart :title="t('serverDashboard.commandChart')" :labels="chartLabels" :series="commandSeries" :value-formatter="formatNumber" />
      </div>

      <div class="flex flex-col rounded-lg border bg-card" :class="showStatusTable ? 'min-h-0 flex-1' : 'shrink-0'">
        <button type="button" class="flex w-full shrink-0 items-center gap-2 px-3 py-2 text-left text-xs font-medium hover:bg-accent/40" @click="showStatusTable = !showStatusTable">
          <ChevronRight class="h-3.5 w-3.5 transition-transform" :class="{ 'rotate-90': showStatusTable }" />
          {{ t("serverDashboard.rawStatus") }}
          <Badge variant="secondary" class="ml-1 h-4 rounded px-1 text-[10px]">{{ statusRows.length }}</Badge>
        </button>
        <div v-if="showStatusTable" class="flex min-h-0 flex-1 flex-col border-t">
          <div class="flex h-9 shrink-0 items-center gap-1.5 border-b px-3">
            <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input v-model="statusSearch" class="h-full w-full min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground" :placeholder="t('serverDashboard.filterStatus')" />
          </div>
          <div class="min-h-0 flex-1 overflow-auto">
            <table class="w-full border-collapse text-xs">
              <tbody>
                <tr v-for="row in statusRows" :key="row.name" class="border-b last:border-0 hover:bg-accent/40">
                  <td class="whitespace-nowrap px-3 py-1 font-mono text-muted-foreground">{{ row.name }}</td>
                  <td class="px-3 py-1 font-mono tabular-nums">{{ row.value }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

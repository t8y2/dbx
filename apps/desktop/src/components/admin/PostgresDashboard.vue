<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Activity, ArrowDownUp, Database, Gauge, Loader2, RefreshCcw, Timer, TriangleAlert, Users } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import MetricCard from "@/components/common/MetricCard.vue";
import MetricLineChart from "@/components/chart/MetricLineChart.vue";
import * as api from "@/lib/backend/api";
import {
  computePgTps,
  computeRate,
  formatBytesPerSec,
  formatNumber,
  formatRate,
  formatUptime,
  isPgStatusCompatibilityError,
  MAX_SAMPLES,
  parsePgStatusRow,
  pgCacheHitRatio,
  PG_STATUS_LEGACY_SQL,
  PG_STATUS_SQL,
  PG_VARIABLES_SQL,
  statusNumber,
  type StatusSample,
} from "@/lib/database/postgresServerStatus";
import { useVerticalOverlayScrollbar } from "@/composables/useVerticalOverlayScrollbar";

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
const scrollerRef = ref<HTMLElement | null>(null);
const scrollerContentRef = ref<HTMLElement | null>(null);
const scrollbarTrackRef = ref<HTMLElement | null>(null);
const {
  hasOverflow: hasScrollbarOverflow,
  isScrolling: isScrollbarScrolling,
  isDragging: isScrollbarDragging,
  thumbStyle: scrollbarThumbStyle,
  onScroll: onScrollerScroll,
  onTrackPointerDown: onScrollbarTrackPointerDown,
  onThumbPointerDown: onScrollbarThumbPointerDown,
} = useVerticalOverlayScrollbar(scrollerRef, scrollerContentRef, scrollbarTrackRef);
// Set once a pre-PG10 server rejects the primary WAL functions, so subsequent
// polls go straight to the legacy query instead of erroring every time.
const fallbackStatusSql = ref<string | null>(null);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const connectionName = computed(() => connectionStore.getConfig(props.connectionId)?.name ?? "");
const latest = computed(() => samples.value[samples.value.length - 1]);
const previous = computed(() => (samples.value.length >= 2 ? samples.value[samples.value.length - 2] : undefined));

function rate(key: string): number {
  const prev = previous.value;
  const curr = latest.value;
  return prev && curr ? computeRate(prev, curr, key) : 0;
}

const tps = computed(() => {
  const prev = previous.value;
  const curr = latest.value;
  return prev && curr ? computePgTps(prev, curr) : 0;
});

const maxConnections = computed(() => statusNumber(variables.value, "max_connections"));
const serverVersion = computed(() => variables.value.version ?? "");
const totalConnections = computed(() => (latest.value ? statusNumber(latest.value.status, "connections") : 0));
const activeConnections = computed(() => (latest.value ? statusNumber(latest.value.status, "active_connections") : 0));
const deadlocks = computed(() => (latest.value ? statusNumber(latest.value.status, "deadlocks") : 0));
const tempFiles = computed(() => (latest.value ? statusNumber(latest.value.status, "temp_files") : 0));
const uptimeSeconds = computed(() => (latest.value ? statusNumber(latest.value.status, "uptime_seconds") : 0));
const cacheHit = computed(() => (latest.value ? pgCacheHitRatio(latest.value.status) : null));

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

function sumSeries(a: number[], b: number[]): number[] {
  return a.map((value, i) => value + (b[i] ?? 0));
}

const sessionsSeries = computed(() => [
  { name: t("serverDashboard.total"), data: samples.value.slice(1).map((s) => statusNumber(s.status, "connections")), color: "#3b82f6" },
  { name: t("serverDashboard.active"), data: samples.value.slice(1).map((s) => statusNumber(s.status, "active_connections")), color: "#a3e635" },
  { name: t("serverDashboard.idle"), data: samples.value.slice(1).map((s) => statusNumber(s.status, "idle_connections")), color: "#ef4444" },
]);

const transactionsSeries = computed(() => {
  const commit = rateSeries("xact_commit");
  const rollback = rateSeries("xact_rollback");
  return [
    { name: t("serverDashboard.total"), data: sumSeries(commit, rollback), color: "#3b82f6" },
    { name: t("serverDashboard.commit"), data: commit, color: "#a3e635" },
    { name: t("serverDashboard.rollback"), data: rollback, color: "#ef4444" },
  ];
});

const tuplesInSeries = computed(() => [
  { name: "INSERT", data: rateSeries("tup_inserted"), color: "#3b82f6" },
  { name: "UPDATE", data: rateSeries("tup_updated"), color: "#a3e635" },
  { name: "DELETE", data: rateSeries("tup_deleted"), color: "#ef4444" },
]);

const tuplesOutSeries = computed(() => [
  { name: t("serverDashboard.fetched"), data: rateSeries("tup_fetched"), color: "#3b82f6" },
  { name: t("serverDashboard.returned"), data: rateSeries("tup_returned"), color: "#a3e635" },
]);

const blockIoSeries = computed(() => [
  { name: t("serverDashboard.read"), data: rateSeries("blks_read"), color: "#3b82f6" },
  { name: t("serverDashboard.hits"), data: rateSeries("blks_hit"), color: "#a3e635" },
]);

function formatClock(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function fetchVariables() {
  try {
    const result = await api.executeQuery(props.connectionId, "", PG_VARIABLES_SQL, undefined, undefined, { maxRows: 2000 });
    variables.value = parsePgStatusRow(result);
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
    const sql = fallbackStatusSql.value ?? PG_STATUS_SQL;
    let result;
    try {
      result = await api.executeQuery(props.connectionId, "", sql, undefined, undefined, { maxRows: 2000 });
    } catch (queryError) {
      if (fallbackStatusSql.value || !isPgStatusCompatibilityError(queryError)) throw queryError;
      result = await api.executeQuery(props.connectionId, "", PG_STATUS_LEGACY_SQL, undefined, undefined, { maxRows: 2000 });
      fallbackStatusSql.value = PG_STATUS_LEGACY_SQL;
    }
    const sample: StatusSample = { at: Date.now(), status: parsePgStatusRow(result) };
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

    <div class="relative min-h-0 flex-1">
      <div ref="scrollerRef" class="pg-dashboard-scroller h-full min-h-0 overflow-y-auto" @scroll.passive="onScrollerScroll">
        <div ref="scrollerContentRef" class="flex flex-col gap-3 p-3">
          <div class="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4">
            <MetricCard :label="t('serverDashboard.tps')" :value="formatRate(tps)" :icon="Gauge" />
            <MetricCard :label="t('serverDashboard.connections')" :value="`${formatNumber(totalConnections)}${maxConnections ? ' / ' + formatNumber(maxConnections) : ''}`" :icon="Users" />
            <MetricCard :label="t('serverDashboard.activeQueries')" :value="formatNumber(activeConnections)" :icon="Activity" />
            <MetricCard :label="t('serverDashboard.cacheHit')" :value="cacheHit === null ? '—' : cacheHit.toFixed(2) + '%'" :icon="Database" />
            <MetricCard :label="t('serverDashboard.deadlocks')" :value="formatNumber(deadlocks)" :icon="TriangleAlert" />
            <MetricCard :label="t('serverDashboard.tempFiles')" :value="formatNumber(tempFiles)" :icon="ArrowDownUp" />
            <MetricCard :label="t('serverDashboard.uptime')" :value="formatUptime(uptimeSeconds)" :icon="Timer" />
            <MetricCard :label="t('serverDashboard.walRate')" :value="formatBytesPerSec(rate('wal_bytes'))" :icon="ArrowDownUp" />
          </div>

          <div class="grid shrink-0 grid-cols-1 gap-3 xl:grid-cols-2">
            <MetricLineChart :title="t('serverDashboard.serverSessionsChart')" :labels="chartLabels" :series="sessionsSeries" :value-formatter="formatNumber" />
            <MetricLineChart :title="t('serverDashboard.blockIoChart')" :labels="chartLabels" :series="blockIoSeries" :value-formatter="formatRate" />
            <MetricLineChart :title="t('serverDashboard.tuplesInChart')" :labels="chartLabels" :series="tuplesInSeries" :value-formatter="formatRate" />
            <MetricLineChart :title="t('serverDashboard.tuplesOutChart')" :labels="chartLabels" :series="tuplesOutSeries" :value-formatter="formatRate" />
            <MetricLineChart class="xl:col-span-2" :title="t('serverDashboard.transactionsChart')" :labels="chartLabels" :series="transactionsSeries" :value-formatter="formatRate" />
          </div>
        </div>
      </div>

      <div v-if="hasScrollbarOverflow" ref="scrollbarTrackRef" class="pg-dashboard-scrollbar" :class="{ 'pg-dashboard-scrollbar--scrolling': isScrollbarScrolling, 'pg-dashboard-scrollbar--dragging': isScrollbarDragging }" @pointerdown="onScrollbarTrackPointerDown">
        <div class="pg-dashboard-scrollbar__thumb" :style="scrollbarThumbStyle" @pointerdown.stop="onScrollbarThumbPointerDown" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.pg-dashboard-scroller {
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.pg-dashboard-scroller::-webkit-scrollbar {
  width: 0;
  height: 0;
}

.pg-dashboard-scrollbar {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
  width: 12px;
  cursor: default;
  opacity: 0;
  transition: opacity 120ms ease;
}

.pg-dashboard-scrollbar--scrolling,
.pg-dashboard-scrollbar:hover,
.pg-dashboard-scrollbar--dragging {
  opacity: 1;
}

.pg-dashboard-scrollbar__thumb {
  position: absolute;
  right: 2px;
  width: 6px;
  min-height: 24px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--foreground) 30%, transparent);
  transition:
    background-color 120ms ease,
    width 120ms ease,
    right 120ms ease;
}

.pg-dashboard-scrollbar:hover .pg-dashboard-scrollbar__thumb,
.pg-dashboard-scrollbar--dragging .pg-dashboard-scrollbar__thumb {
  right: 1px;
  width: 8px;
  background: color-mix(in oklch, var(--foreground) 48%, transparent);
}
</style>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { Activity, Boxes, Braces, Cpu, Gauge, HardDrive, Layers3, Loader2, Network, RefreshCw, Server, Users } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import MetricCard from "@/components/common/MetricCard.vue";
import MetricLineChart from "@/components/chart/MetricLineChart.vue";
import * as api from "@/lib/backend/api";
import { formatBytes, formatNumber, formatRate } from "@/lib/database/serverMetrics";
import { useConnectionStore } from "@/stores/connectionStore";
import {
  appendDashboardSample,
  averageDurationMsSeries,
  counterRateSeries,
  dashboardMetric,
  dashboardNamespaceLabel,
  dashboardSeries,
  errorRateSeries,
  formatDashboardPercent,
  gaugeSeries,
  isHealthyNacosNode,
  ratioPercent,
  type NacosDashboardSample,
  type NullableMetric,
} from "@/lib/nacos/nacosDashboard";

const props = defineProps<{
  connectionId: string;
  namespace?: string;
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const loading = ref(false);
const fetching = ref(false);
const error = ref("");
const samples = ref<NacosDashboardSample[]>([]);
const autoRefreshInterval = ref(10);
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let activeRequestKey = "";
let latestRequestId = 0;

const latest = computed(() => samples.value[samples.value.length - 1]);
const snapshot = computed(() => latest.value?.snapshot);
const metrics = computed(() => snapshot.value?.metrics);
const prometheus = computed(() => snapshot.value?.prometheus);
const namespaceLabel = computed(() => dashboardNamespaceLabel(snapshot.value?.namespace, props.namespace));
const healthyNodes = computed(() => snapshot.value?.nodes.filter(isHealthyNacosNode).length ?? 0);
const chartLabels = computed(() => samples.value.map((sample) => formatClock(sample.at)));
const lastUpdated = computed(() => (latest.value ? formatClock(latest.value.at) : "—"));
type ChartSeries = { name: string; data: NullableMetric[]; color?: string };

function hasSeries(series: readonly ChartSeries[]): boolean {
  return series.some((item) => item.data.some((value) => value !== null));
}

const countSeries = computed(() => {
  const series = [
    {
      name: t("nacos.dashboardServices"),
      data: samples.value.map((sample) => sample.snapshot.serviceCount ?? dashboardMetric(sample, "serviceCount")),
      color: "#3b82f6",
    },
  ];
  if (samples.value.some((sample) => typeof sample.snapshot.metrics?.instanceCount === "number")) {
    series.push({ name: t("nacos.dashboardInstances"), data: dashboardSeries(samples.value, "instanceCount"), color: "#22c55e" });
  }
  if (samples.value.some((sample) => typeof sample.snapshot.metrics?.clientCount === "number")) {
    series.push({ name: t("nacos.dashboardClients"), data: dashboardSeries(samples.value, "clientCount"), color: "#8b5cf6" });
  }
  return series;
});

const resourceSeries = computed(() => [
  {
    name: t("nacos.dashboardCpu"),
    data: samples.value.map((sample) => ratioPercent(sample.snapshot.prometheus?.resource.cpuRatio ?? sample.snapshot.metrics?.cpu)),
    color: "#f59e0b",
  },
  {
    name: t("nacos.dashboardMemory"),
    data: samples.value.map((sample) => ratioPercent(sample.snapshot.prometheus?.resource.memoryRatio ?? sample.snapshot.metrics?.mem)),
    color: "#ef4444",
  },
]);
const hasResourceMetrics = computed(() => hasSeries(resourceSeries.value));

const trafficSeries = computed<ChartSeries[]>(() => [
  {
    name: t("nacos.dashboardHttpQps"),
    data: counterRateSeries(samples.value, (sample) => sample.snapshot.prometheus?.traffic.httpRequestsTotal),
    color: "#3b82f6",
  },
  {
    name: t("nacos.dashboardGrpcQps"),
    data: counterRateSeries(samples.value, (sample) => sample.snapshot.prometheus?.traffic.grpcRequestsTotal),
    color: "#8b5cf6",
  },
]);
const latencySeries = computed<ChartSeries[]>(() => [
  {
    name: t("nacos.dashboardHttpAverage"),
    data: averageDurationMsSeries(
      samples.value,
      (sample) => sample.snapshot.prometheus?.traffic.httpDurationSecondsTotal,
      (sample) => sample.snapshot.prometheus?.traffic.httpDurationCount,
    ),
    color: "#3b82f6",
  },
  {
    name: t("nacos.dashboardHttpP50"),
    data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.traffic.httpP50Ms),
    color: "#0ea5e9",
  },
  {
    name: t("nacos.dashboardHttpP95"),
    data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.traffic.httpP95Ms),
    color: "#06b6d4",
  },
  {
    name: t("nacos.dashboardHttpP99"),
    data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.traffic.httpP99Ms),
    color: "#14b8a6",
  },
  {
    name: t("nacos.dashboardGrpcAverage"),
    data: averageDurationMsSeries(
      samples.value,
      (sample) => sample.snapshot.prometheus?.traffic.grpcDurationSecondsTotal,
      (sample) => sample.snapshot.prometheus?.traffic.grpcDurationCount,
    ),
    color: "#8b5cf6",
  },
  {
    name: t("nacos.dashboardGrpcP50"),
    data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.traffic.grpcP50Ms),
    color: "#a855f7",
  },
  {
    name: t("nacos.dashboardGrpcP95"),
    data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.traffic.grpcP95Ms),
    color: "#d946ef",
  },
  {
    name: t("nacos.dashboardGrpcP99"),
    data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.traffic.grpcP99Ms),
    color: "#ec4899",
  },
]);
const errorRateChartSeries = computed<ChartSeries[]>(() => [
  {
    name: t("nacos.dashboardHttpErrors"),
    data: errorRateSeries(
      samples.value,
      (sample) => sample.snapshot.prometheus?.traffic.httpErrorsTotal,
      (sample) => sample.snapshot.prometheus?.traffic.httpRequestsTotal,
    ),
    color: "#ef4444",
  },
  {
    name: t("nacos.dashboardGrpcErrors"),
    data: errorRateSeries(
      samples.value,
      (sample) => sample.snapshot.prometheus?.traffic.grpcErrorsTotal,
      (sample) => sample.snapshot.prometheus?.traffic.grpcRequestsTotal,
    ),
    color: "#f97316",
  },
]);
const executorSeries = computed<ChartSeries[]>(() => [
  {
    name: t("nacos.dashboardExecutorPool"),
    data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.traffic.executorPoolSize),
    color: "#3b82f6",
  },
  {
    name: t("nacos.dashboardExecutorActive"),
    data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.traffic.executorActiveCount),
    color: "#22c55e",
  },
  {
    name: t("nacos.dashboardExecutorQueue"),
    data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.traffic.executorQueuedTasks),
    color: "#ef4444",
  },
]);
const configRateSeries = computed<ChartSeries[]>(() => [
  {
    name: t("nacos.dashboardConfigGets"),
    data: counterRateSeries(samples.value, (sample) => sample.snapshot.prometheus?.config.getConfigTotal),
    color: "#3b82f6",
  },
  {
    name: t("nacos.dashboardConfigPublishes"),
    data: counterRateSeries(samples.value, (sample) => sample.snapshot.prometheus?.config.publishTotal),
    color: "#22c55e",
  },
]);
const configStateSeries = computed<ChartSeries[]>(() => [
  { name: t("nacos.dashboardLongPolling"), data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.config.longPolling), color: "#8b5cf6" },
  { name: t("nacos.dashboardListenerClients"), data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.config.listenerClients), color: "#06b6d4" },
  { name: t("nacos.dashboardListenerKeys"), data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.config.listenerKeys), color: "#3b82f6" },
  { name: t("nacos.dashboardNotifyTasks"), data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.config.notifyTasks), color: "#f59e0b" },
  { name: t("nacos.dashboardNotifyClientTasks"), data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.config.notifyClientTasks), color: "#ef4444" },
  { name: t("nacos.dashboardDumpTasks"), data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.config.dumpTasks), color: "#64748b" },
]);
const namingStateSeries = computed<ChartSeries[]>(() => [
  { name: t("nacos.dashboardServices"), data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.naming.serviceCount), color: "#3b82f6" },
  { name: t("nacos.dashboardInstances"), data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.naming.instanceCount), color: "#22c55e" },
  { name: t("nacos.dashboardSubscribers"), data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.naming.subscriberCount), color: "#8b5cf6" },
  { name: t("nacos.dashboardClients"), data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.naming.connectionCount), color: "#06b6d4" },
]);
const pushRateSeries = computed<ChartSeries[]>(() => [
  { name: t("nacos.dashboardPushes"), data: counterRateSeries(samples.value, (sample) => sample.snapshot.prometheus?.naming.totalPush), color: "#3b82f6" },
  { name: t("nacos.dashboardFailedPushes"), data: counterRateSeries(samples.value, (sample) => sample.snapshot.prometheus?.naming.failedPush), color: "#ef4444" },
  { name: t("nacos.dashboardEmptyPushes"), data: counterRateSeries(samples.value, (sample) => sample.snapshot.prometheus?.naming.emptyPush), color: "#f59e0b" },
]);
const pushDetailSeries = computed<ChartSeries[]>(() => [
  { name: t("nacos.dashboardPushAverage"), data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.naming.avgPushCostMs), color: "#3b82f6" },
  { name: t("nacos.dashboardPushMaximum"), data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.naming.maxPushCostMs), color: "#8b5cf6" },
  { name: t("nacos.dashboardPushPending"), data: gaugeSeries(samples.value, (sample) => sample.snapshot.prometheus?.naming.pushPendingTasks), color: "#ef4444" },
]);

const hasTraffic = computed(() => hasSeries(trafficSeries.value));
const hasLatency = computed(() => hasSeries(latencySeries.value));
const hasReliability = computed(() => hasSeries(errorRateChartSeries.value) || hasSeries(executorSeries.value));
const hasConfigPrometheus = computed(() => hasSeries(configRateSeries.value) || hasSeries(configStateSeries.value));
const hasNamingPrometheus = computed(() => hasSeries(namingStateSeries.value) || hasSeries(pushRateSeries.value) || hasSeries(pushDetailSeries.value));

function formatClock(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function optionalCount(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? formatNumber(value) : "—";
}

function optionalMetric(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? formatRate(value) : "—";
}

function optionalBytes(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? formatBytes(value) : "—";
}

function nodeLastRefresh(value: string | undefined): string {
  if (!value) return "—";
  const timestamp = Number(value);
  if (Number.isFinite(timestamp) && timestamp > 1_000_000_000_000) return new Date(timestamp).toLocaleString();
  return value;
}

function nodeState(node: { alive?: boolean; state?: string }): string {
  if (node.state?.trim()) return node.state;
  if (node.alive === true) return t("nacos.healthy");
  if (node.alive === false) return t("nacos.unhealthy");
  return "—";
}

async function fetchSnapshot(options: { silent?: boolean } = {}) {
  const connectionId = props.connectionId;
  const namespace = props.namespace || undefined;
  const requestKey = `${connectionId}\u0000${namespace ?? ""}`;
  if (fetching.value && activeRequestKey === requestKey) return;
  const requestId = ++latestRequestId;
  activeRequestKey = requestKey;
  fetching.value = true;
  if (!options.silent) loading.value = true;
  error.value = "";
  try {
    await connectionStore.ensureConnected(connectionId);
    const value = await api.nacosGetDashboard(connectionId, { namespace });
    if (requestId !== latestRequestId) return;
    samples.value = appendDashboardSample(samples.value, { at: Date.now(), snapshot: value });
  } catch (cause: unknown) {
    if (requestId !== latestRequestId) return;
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (requestId === latestRequestId) {
      loading.value = false;
      fetching.value = false;
    }
  }
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (autoRefreshInterval.value <= 0) return;
  refreshTimer = setInterval(() => {
    if (document.hidden) return;
    void fetchSnapshot({ silent: true });
  }, autoRefreshInterval.value * 1000);
}

function onIntervalChange(value: unknown) {
  autoRefreshInterval.value = Number(value);
  startAutoRefresh();
}

watch(
  () => [props.connectionId, props.namespace] as const,
  async () => {
    samples.value = [];
    await fetchSnapshot();
  },
);

onMounted(async () => {
  await fetchSnapshot();
  startAutoRefresh();
});

onUnmounted(() => {
  latestRequestId += 1;
  stopAutoRefresh();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex h-10 shrink-0 items-center gap-2 border-b px-3">
      <Gauge class="h-4 w-4 text-primary" />
      <span class="text-xs font-medium">{{ t("nacos.dashboardTitle") }}</span>
      <Badge variant="outline" class="h-5 rounded-md px-1.5 text-[11px]">{{ namespaceLabel }}</Badge>
      <Badge v-if="metrics?.status" :variant="metrics.status.toUpperCase() === 'UP' ? 'secondary' : 'destructive'" class="h-5 rounded-md px-1.5 text-[11px]">
        {{ metrics.status }}
      </Badge>
      <Badge variant="outline" class="h-5 max-w-48 truncate rounded-md px-1.5 text-[11px]" :title="prometheus?.source.endpoint">
        {{ prometheus ? "OpenAPI + Prometheus" : "OpenAPI" }}
      </Badge>
      <span class="ml-auto text-[11px] text-muted-foreground">{{ t("nacos.dashboardUpdatedAt", { time: lastUpdated }) }}</span>
      <span class="text-xs text-muted-foreground">{{ t("nacos.dashboardAutoRefresh") }}</span>
      <Select :model-value="String(autoRefreshInterval)" @update:model-value="onIntervalChange">
        <SelectTrigger class="h-7 w-24 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="0">{{ t("nacos.dashboardOff") }}</SelectItem>
          <SelectItem value="5">5s</SelectItem>
          <SelectItem value="10">10s</SelectItem>
          <SelectItem value="30">30s</SelectItem>
          <SelectItem value="60">60s</SelectItem>
        </SelectContent>
      </Select>
      <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" :disabled="loading" @click="fetchSnapshot()">
        <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCw v-else class="h-3.5 w-3.5" />
        {{ t("nacos.refresh") }}
      </Button>
    </div>

    <div v-if="error" class="shrink-0 border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">{{ error }}</div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="flex flex-col gap-3 p-3">
        <div class="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard :label="t('nacos.dashboardNamespaces')" :value="optionalCount(snapshot?.namespaceCount)" :icon="Layers3" />
          <MetricCard :label="t('nacos.dashboardConfigs')" :value="optionalCount(snapshot?.configCount)" :sub="namespaceLabel" :icon="Braces" />
          <MetricCard :label="t('nacos.dashboardServices')" :value="optionalCount(snapshot?.serviceCount)" :sub="namespaceLabel" :icon="Boxes" />
          <MetricCard :label="t('nacos.dashboardInstances')" :value="optionalCount(metrics?.instanceCount)" :icon="Network" />
          <MetricCard :label="t('nacos.dashboardClients')" :value="optionalCount(metrics?.clientCount)" :sub="t('nacos.dashboardConnections', { count: optionalCount(metrics?.connectionBasedClientCount) })" :icon="Users" />
          <MetricCard :label="t('nacos.dashboardNodes')" :value="snapshot?.nodes.length ? `${healthyNodes} / ${snapshot.nodes.length}` : '—'" :icon="Server" />
          <MetricCard :label="t('nacos.dashboardCpu')" :value="formatDashboardPercent(metrics?.cpu)" :icon="Cpu" />
          <MetricCard :label="t('nacos.dashboardMemory')" :value="formatDashboardPercent(metrics?.mem)" :sub="t('nacos.dashboardLoad', { value: optionalMetric(metrics?.load) })" :icon="HardDrive" />
        </div>

        <div v-if="prometheus" class="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard v-if="prometheus.resource.memoryUsedBytes !== undefined" :label="t('nacos.dashboardMemoryUsed')" :value="optionalBytes(prometheus.resource.memoryUsedBytes)" :sub="t('nacos.dashboardMemoryMax', { value: optionalBytes(prometheus.resource.memoryMaxBytes) })" :icon="HardDrive" />
          <MetricCard v-if="prometheus.resource.rssBytes !== undefined" :label="t('nacos.dashboardRss')" :value="optionalBytes(prometheus.resource.rssBytes)" :sub="t('nacos.dashboardVms', { value: optionalBytes(prometheus.resource.vmsBytes) })" :icon="HardDrive" />
          <MetricCard v-if="prometheus.resource.jvmDaemonThreads !== undefined" :label="t('nacos.dashboardJvmThreads')" :value="optionalCount(prometheus.resource.jvmDaemonThreads)" :icon="Activity" />
          <MetricCard v-if="prometheus.resource.gcPauseCount !== undefined" :label="t('nacos.dashboardGcPauses')" :value="optionalCount(prometheus.resource.gcPauseCount)" :icon="Activity" />
        </div>

        <div class="grid shrink-0 grid-cols-1 gap-3 xl:grid-cols-2">
          <MetricLineChart :class="{ 'xl:col-span-2': !hasResourceMetrics }" :title="t('nacos.dashboardCountsChart')" :labels="chartLabels" :series="countSeries" :value-formatter="formatNumber" />
          <MetricLineChart v-if="hasResourceMetrics" :title="t('nacos.dashboardResourcesChart')" :labels="chartLabels" :series="resourceSeries" :value-formatter="(value) => `${value.toFixed(1)}%`" />
        </div>

        <template v-if="hasTraffic || hasLatency">
          <div class="text-xs font-semibold text-foreground">{{ t("nacos.dashboardTrafficSection") }}</div>
          <div class="grid shrink-0 grid-cols-1 gap-3 xl:grid-cols-2">
            <MetricLineChart v-if="hasTraffic" :title="t('nacos.dashboardRequestRateChart')" :labels="chartLabels" :series="trafficSeries" :value-formatter="formatRate" />
            <MetricLineChart v-if="hasLatency" :class="{ 'xl:col-span-2': !hasTraffic }" :title="t('nacos.dashboardLatencyChart')" :labels="chartLabels" :series="latencySeries" :value-formatter="(value) => `${formatRate(value)} ms`" />
          </div>
        </template>

        <template v-if="hasReliability">
          <div class="text-xs font-semibold text-foreground">{{ t("nacos.dashboardReliabilitySection") }}</div>
          <div class="grid shrink-0 grid-cols-1 gap-3 xl:grid-cols-2">
            <MetricLineChart v-if="hasSeries(errorRateChartSeries)" :title="t('nacos.dashboardErrorRateChart')" :labels="chartLabels" :series="errorRateChartSeries" :value-formatter="(value) => `${value.toFixed(2)}%`" />
            <MetricLineChart v-if="hasSeries(executorSeries)" :class="{ 'xl:col-span-2': !hasSeries(errorRateChartSeries) }" :title="t('nacos.dashboardExecutorChart')" :labels="chartLabels" :series="executorSeries" :value-formatter="formatNumber" />
          </div>
        </template>

        <template v-if="hasConfigPrometheus">
          <div class="text-xs font-semibold text-foreground">{{ t("nacos.dashboardConfigSection") }}</div>
          <div class="grid shrink-0 grid-cols-1 gap-3 xl:grid-cols-2">
            <MetricLineChart v-if="hasSeries(configRateSeries)" :title="t('nacos.dashboardConfigRateChart')" :labels="chartLabels" :series="configRateSeries" :value-formatter="formatRate" />
            <MetricLineChart v-if="hasSeries(configStateSeries)" :class="{ 'xl:col-span-2': !hasSeries(configRateSeries) }" :title="t('nacos.dashboardConfigStateChart')" :labels="chartLabels" :series="configStateSeries" :value-formatter="formatNumber" />
          </div>
        </template>

        <template v-if="hasNamingPrometheus">
          <div class="text-xs font-semibold text-foreground">{{ t("nacos.dashboardNamingSection") }}</div>
          <div class="grid shrink-0 grid-cols-1 gap-3 xl:grid-cols-2">
            <MetricLineChart v-if="hasSeries(namingStateSeries)" :title="t('nacos.dashboardNamingStateChart')" :labels="chartLabels" :series="namingStateSeries" :value-formatter="formatNumber" />
            <MetricLineChart v-if="hasSeries(pushRateSeries)" :class="{ 'xl:col-span-2': !hasSeries(namingStateSeries) }" :title="t('nacos.dashboardPushRateChart')" :labels="chartLabels" :series="pushRateSeries" :value-formatter="formatRate" />
            <MetricLineChart v-if="hasSeries(pushDetailSeries)" class="xl:col-span-2" :title="t('nacos.dashboardPushDetailChart')" :labels="chartLabels" :series="pushDetailSeries" :value-formatter="formatRate" />
          </div>
        </template>

        <div class="shrink-0 overflow-hidden rounded-lg border bg-card">
          <div class="flex items-center gap-2 border-b px-3 py-2 text-xs font-medium">
            <Activity class="h-3.5 w-3.5 text-muted-foreground" />
            {{ t("nacos.dashboardClusterNodes") }}
            <Badge variant="secondary" class="h-4 rounded px-1 text-[10px]">{{ snapshot?.nodes.length ?? 0 }}</Badge>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full border-collapse text-xs">
              <thead class="bg-muted/50 text-left text-muted-foreground">
                <tr>
                  <th class="px-3 py-2 font-medium">{{ t("nacos.address") }}</th>
                  <th class="px-3 py-2 font-medium">{{ t("nacos.state") }}</th>
                  <th class="px-3 py-2 font-medium">{{ t("nacos.dashboardSite") }}</th>
                  <th class="px-3 py-2 font-medium">{{ t("nacos.weight") }}</th>
                  <th class="px-3 py-2 font-medium">{{ t("nacos.dashboardLastRefresh") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="node in snapshot?.nodes ?? []" :key="node.address" class="border-t hover:bg-accent/40">
                  <td class="px-3 py-2 font-mono">{{ node.address }}</td>
                  <td class="px-3 py-2">
                    <Badge :variant="isHealthyNacosNode(node) ? 'secondary' : 'destructive'" class="h-5 rounded-md px-1.5 text-[10px]">{{ nodeState(node) }}</Badge>
                  </td>
                  <td class="px-3 py-2 text-muted-foreground">{{ node.site || "—" }}</td>
                  <td class="px-3 py-2 tabular-nums text-muted-foreground">{{ node.weight ?? "—" }}</td>
                  <td class="px-3 py-2 text-muted-foreground">{{ nodeLastRefresh(node.lastRefreshTime) }}</td>
                </tr>
                <tr v-if="!snapshot?.nodes.length">
                  <td colspan="5" class="px-3 py-8 text-center text-muted-foreground">{{ t("nacos.dashboardNoNodes") }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <details v-if="snapshot?.warnings.length" class="shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
          <summary class="cursor-pointer font-medium text-amber-700 dark:text-amber-300">{{ t("nacos.dashboardPartial", { count: snapshot.warnings.length }) }}</summary>
          <ul class="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
            <li v-for="warning in snapshot.warnings" :key="warning">{{ warning }}</li>
          </ul>
        </details>
      </div>
    </div>
  </div>
</template>

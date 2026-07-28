<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Activity, AlertTriangle, CheckCircle2, Clock3, Cpu, Database, Eye, Gauge, HardDrive, KeyRound, Loader2, Network, Radio, RefreshCw, Server } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import * as api from "@/lib/backend/api";
import { classifyEtcdDashboardError } from "@/lib/kv/etcdDashboardError";
import { counterMapRates, counterRate, histogramAverageMilliseconds, histogramMapAverageMilliseconds, ratePercentage } from "@/lib/kv/etcdDashboardMetrics";

const props = defineProps<{ connectionId: string }>();
const { t } = useI18n();
const status = ref<api.KvStatusResponse | null>(null);
const previousMetrics = ref<api.KvPrometheusMetrics | null>(null);
const loading = ref(false);
const error = ref("");
const unsupported = ref(false);
const refreshSeconds = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;
let loadGeneration = 0;
let loadingConnectionId: string | null = null;

const reachable = computed(() => status.value?.members.filter((member) => member.reachable).length ?? 0);
const totalDbSize = computed(() => status.value?.members.reduce((sum, member) => sum + Number(member.dbSize || 0), 0) ?? 0);
const totalDbSizeInUse = computed(() => status.value?.members.reduce((sum, member) => sum + Number(member.dbSizeInUse || 0), 0) ?? 0);
const fragmentation = computed(() => (totalDbSize.value > 0 ? Math.max(0, 1 - totalDbSizeInUse.value / totalDbSize.value) : 0));
const metrics = computed(() => status.value?.metrics ?? null);
const requestRate = computed(() => counterRate(metrics.value, previousMetrics.value, "grpcRequestsTotal"));
const requestFailureRate = computed(() => counterRate(metrics.value, previousMetrics.value, "grpcFailuresTotal"));
const requestFailurePercent = computed(() => ratePercentage(requestFailureRate.value, requestRate.value));
const proposalFailureRate = computed(() => counterRate(metrics.value, previousMetrics.value, "proposalsFailedTotal"));
const clientReceivedRate = computed(() => counterRate(metrics.value, previousMetrics.value, "clientReceivedBytesTotal"));
const clientSentRate = computed(() => counterRate(metrics.value, previousMetrics.value, "clientSentBytesTotal"));
const peerReceivedRate = computed(() => counterRate(metrics.value, previousMetrics.value, "peerReceivedBytesTotal"));
const peerSentRate = computed(() => counterRate(metrics.value, previousMetrics.value, "peerSentBytesTotal"));
const processReceivedRate = computed(() => counterRate(metrics.value, previousMetrics.value, "processReceivedBytesTotal"));
const processTransmittedRate = computed(() => counterRate(metrics.value, previousMetrics.value, "processTransmittedBytesTotal"));
const walWriteRate = computed(() => counterRate(metrics.value, previousMetrics.value, "walWriteBytesTotal"));
const mvccRangeRate = computed(() => counterRate(metrics.value, previousMetrics.value, "mvccRangeTotal"));
const mvccPutRate = computed(() => counterRate(metrics.value, previousMetrics.value, "mvccPutTotal"));
const mvccDeleteRate = computed(() => counterRate(metrics.value, previousMetrics.value, "mvccDeleteTotal"));
const mvccTxnRate = computed(() => counterRate(metrics.value, previousMetrics.value, "mvccTxnTotal"));
const mvccEventRate = computed(() => counterRate(metrics.value, previousMetrics.value, "mvccEventsTotal"));
const leaseGrantedRate = computed(() => counterRate(metrics.value, previousMetrics.value, "leaseGrantedTotal"));
const leaseRenewedRate = computed(() => counterRate(metrics.value, previousMetrics.value, "leaseRenewedTotal"));
const leaseRevokedRate = computed(() => counterRate(metrics.value, previousMetrics.value, "leaseRevokedTotal"));
const leaseExpiredRate = computed(() => counterRate(metrics.value, previousMetrics.value, "leaseExpiredTotal"));
const cpuPercent = computed(() => {
  const rate = counterRate(metrics.value, previousMetrics.value, "cpuSecondsTotal");
  return rate == null ? null : rate * 100;
});
const walFsyncMs = computed(() => histogramAverageMilliseconds(metrics.value, previousMetrics.value, "walFsyncDurationSecondsSum", "walFsyncDurationSecondsCount"));
const backendCommitMs = computed(() => histogramAverageMilliseconds(metrics.value, previousMetrics.value, "backendCommitDurationSecondsSum", "backendCommitDurationSecondsCount"));
const walWriteMs = computed(() => histogramAverageMilliseconds(metrics.value, previousMetrics.value, "walWriteDurationSecondsSum", "walWriteDurationSecondsCount"));
const backendSnapshotMs = computed(() => histogramAverageMilliseconds(metrics.value, previousMetrics.value, "backendSnapshotDurationSecondsSum", "backendSnapshotDurationSecondsCount"));
const backendDefragMs = computed(() => histogramAverageMilliseconds(metrics.value, previousMetrics.value, "backendDefragDurationSecondsSum", "backendDefragDurationSecondsCount"));
const goGcMs = computed(() => histogramAverageMilliseconds(metrics.value, previousMetrics.value, "goGcDurationSecondsSum", "goGcDurationSecondsCount"));
const proposalLag = computed(() => {
  const committed = metrics.value?.proposalsCommittedTotal;
  const applied = metrics.value?.proposalsAppliedTotal;
  return typeof committed === "number" && typeof applied === "number" ? Math.max(0, committed - applied) : null;
});
const fdPercent = computed(() => {
  const open = metrics.value?.openFds;
  const max = metrics.value?.maxFds;
  return typeof open === "number" && typeof max === "number" && max > 0 ? (open / max) * 100 : null;
});
const quotaPercent = computed(() => {
  const used = metrics.value?.dbSizeMetricBytes;
  const quota = metrics.value?.quotaBackendBytes;
  return typeof used === "number" && typeof quota === "number" && quota > 0 ? (used / quota) * 100 : null;
});
const averageLeaseTtl = computed(() => {
  const sum = metrics.value?.leaseTtlSecondsSum;
  const count = metrics.value?.leaseTtlSecondsCount;
  return typeof sum === "number" && typeof count === "number" && count > 0 ? sum / count : null;
});
const uptimeSeconds = computed(() => {
  const startedAt = metrics.value?.processStartTimeSeconds;
  return typeof startedAt === "number" ? Math.max(0, Date.now() / 1000 - startedAt) : null;
});
const grpcMethodRates = computed(() => counterMapRates(metrics.value, previousMetrics.value, "grpcMethodRequestsTotal"));
const grpcMethodFailureRates = computed(() => counterMapRates(metrics.value, previousMetrics.value, "grpcMethodFailuresTotal"));
const requestLatencyByType = computed(() => histogramMapAverageMilliseconds(metrics.value, previousMetrics.value, "requestDurationSecondsSumByType", "requestDurationSecondsCountByType"));
const grpcMethodRows = computed(() =>
  Object.entries(metrics.value?.grpcMethodRequestsTotal ?? {})
    .map(([method, total]) => ({
      method,
      total,
      rate: grpcMethodRates.value[method] ?? null,
      failures: metrics.value?.grpcMethodFailuresTotal?.[method] ?? 0,
      failureRate: grpcMethodFailureRates.value[method] ?? null,
      latencyMs: requestLatencyByType.value[method] ?? null,
    }))
    .sort((left, right) => (right.rate ?? -1) - (left.rate ?? -1) || right.total - left.total)
    .slice(0, 12),
);
const health = computed(() => {
  if (!status.value) return "unknown";
  if (status.value.alarms.length > 0 || reachable.value === 0 || metrics.value?.hasLeader === 0) return "critical";
  if (reachable.value < status.value.members.length || status.value.members.some((member) => member.errors.length > 0) || (metrics.value?.proposalsPending ?? 0) > 0 || (proposalFailureRate.value ?? 0) > 0) return "warning";
  return "healthy";
});

function formatBytes(value: number) {
  if (!Number.isFinite(value)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatRate(value: number | null, suffix = "/s") {
  if (value == null || !Number.isFinite(value)) return "-";
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${suffix}`;
}

function formatByteRate(value: number | null) {
  return value == null || !Number.isFinite(value) ? "-" : `${formatBytes(value)}/s`;
}

function formatMilliseconds(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${value.toFixed(value >= 10 ? 1 : 2)} ms`;
}

function formatPercent(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "-";
  return `${value.toFixed(1)}%`;
}

function formatCount(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "-";
}

function formatDuration(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return "-";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatCollectedAt(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toLocaleTimeString() : "-";
}

async function load() {
  const connectionId = props.connectionId;
  if (loading.value && loadingConnectionId === connectionId) return;
  const generation = ++loadGeneration;
  loadingConnectionId = connectionId;
  loading.value = true;
  error.value = "";
  unsupported.value = false;
  try {
    const next = await api.etcdStatus(connectionId);
    if (generation !== loadGeneration || props.connectionId !== connectionId) return;
    previousMetrics.value = status.value?.metrics?.available ? status.value.metrics : null;
    status.value = next;
  } catch (caught) {
    if (generation !== loadGeneration || props.connectionId !== connectionId) return;
    const classified = classifyEtcdDashboardError(caught);
    if (classified.kind === "unsupported") {
      unsupported.value = true;
      status.value = null;
      refreshSeconds.value = 0;
    } else {
      error.value = classified.message;
    }
  } finally {
    if (generation === loadGeneration) {
      loading.value = false;
      loadingConnectionId = null;
    }
  }
}

function resetTimer() {
  if (timer) clearInterval(timer);
  timer = refreshSeconds.value > 0 ? setInterval(() => void load(), refreshSeconds.value * 1000) : null;
}

function refresh(): boolean {
  void load();
  return true;
}

watch(
  () => props.connectionId,
  () => {
    loadGeneration++;
    loading.value = false;
    loadingConnectionId = null;
    status.value = null;
    previousMetrics.value = null;
    unsupported.value = false;
    void load();
  },
);
watch(refreshSeconds, resetTimer);
onMounted(() => void load());
onBeforeUnmount(() => {
  loadGeneration++;
  if (timer) clearInterval(timer);
});

defineExpose({ refresh });
</script>

<template>
  <div class="h-full overflow-auto bg-background p-4">
    <div class="mb-4 flex items-start justify-between gap-4">
      <div>
        <h2 class="text-lg font-semibold">{{ t("etcd.dashboard.title") }}</h2>
        <p class="mt-1 text-xs text-muted-foreground">{{ t("etcd.dashboard.description") }}</p>
      </div>
      <div class="flex items-center gap-2">
        <select v-model.number="refreshSeconds" class="h-8 rounded-md border bg-background px-2 text-xs">
          <option :value="0">{{ t("etcd.dashboard.autoRefreshOff") }}</option>
          <option :value="5">5s</option>
          <option :value="10">10s</option>
          <option :value="30">30s</option>
          <option :value="60">60s</option>
        </select>
        <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="loading" @click="load">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCw v-else class="h-3.5 w-3.5" />
          {{ t("etcd.dashboard.refresh") }}
        </Button>
      </div>
    </div>

    <div v-if="unsupported" class="mx-auto mt-[12vh] max-w-2xl rounded-xl border bg-muted/20 p-6 shadow-sm">
      <div class="flex items-start gap-4">
        <div class="rounded-full bg-amber-500/10 p-2.5 text-amber-600 dark:text-amber-400">
          <AlertTriangle class="h-5 w-5" />
        </div>
        <div class="min-w-0 flex-1">
          <h3 class="font-semibold">{{ t("etcd.dashboard.agentUpgradeTitle") }}</h3>
          <p class="mt-2 text-sm leading-6 text-muted-foreground">{{ t("etcd.dashboard.agentUpgradeDescription") }}</p>
          <div class="mt-4 rounded-md border bg-background px-3 py-2.5 text-xs leading-5 text-muted-foreground">
            {{ t("etcd.dashboard.agentUpgradeSteps") }}
          </div>
          <Button class="mt-4" size="sm" variant="outline" :disabled="loading" @click="load">
            <Loader2 v-if="loading" class="mr-2 h-3.5 w-3.5 animate-spin" />
            <RefreshCw v-else class="mr-2 h-3.5 w-3.5" />
            {{ t("etcd.dashboard.retry") }}
          </Button>
        </div>
      </div>
    </div>
    <div v-else-if="error" class="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
      <div class="flex items-start gap-3">
        <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div class="min-w-0">
          <div class="text-sm font-medium text-destructive">{{ t("etcd.dashboard.loadFailed") }}</div>
          <div class="mt-1 break-words text-xs leading-5 text-muted-foreground">{{ error }}</div>
        </div>
      </div>
    </div>
    <div v-if="status" class="grid gap-3">
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div class="rounded-lg border p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><Gauge class="h-4 w-4" /> {{ t("etcd.dashboard.observedHealth") }}</div>
          <div class="mt-3 flex items-center gap-2 text-xl font-semibold">
            <CheckCircle2 v-if="health === 'healthy'" class="h-5 w-5 text-emerald-500" />
            <AlertTriangle v-else class="h-5 w-5 text-amber-500" />
            {{ t(`etcd.dashboard.health.${health}`) }}
          </div>
        </div>
        <div class="rounded-lg border p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><Server class="h-4 w-4" /> {{ t("etcd.dashboard.reachableMembers") }}</div>
          <div class="mt-3 text-xl font-semibold">{{ reachable }} / {{ status.members.length }}</div>
        </div>
        <div class="rounded-lg border p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><KeyRound class="h-4 w-4" /> {{ t("etcd.dashboard.keyCount") }}</div>
          <div class="mt-3 text-xl font-semibold">{{ status.keyCount ?? "-" }}</div>
        </div>
        <div class="rounded-lg border p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><Database class="h-4 w-4" /> {{ t("etcd.dashboard.backendSize") }}</div>
          <div class="mt-3 text-xl font-semibold">{{ formatBytes(totalDbSize) }}</div>
        </div>
        <div class="rounded-lg border p-4">
          <div class="text-xs text-muted-foreground">{{ t("etcd.dashboard.fragmentation") }}</div>
          <div class="mt-3 text-xl font-semibold">{{ (fragmentation * 100).toFixed(1) }}%</div>
        </div>
      </div>

      <div class="flex flex-wrap gap-2 rounded-lg border p-3 text-xs">
        <Badge variant="outline">{{ t("etcd.dashboard.cluster") }} {{ status.clusterId ?? "-" }}</Badge>
        <Badge variant="outline">{{ t("etcd.dashboard.revision") }} {{ status.revision ?? "-" }}</Badge>
        <Badge variant="outline">{{ t("etcd.dashboard.leader") }} {{ status.leaderId ?? "-" }}</Badge>
        <Badge v-for="alarm in status.alarms" :key="alarm" variant="destructive">{{ alarm }}</Badge>
        <Badge v-if="status.alarms.length === 0" variant="secondary">{{ t("etcd.dashboard.noAlarms") }}</Badge>
      </div>

      <section v-if="metrics?.available" class="rounded-lg border">
        <div class="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
          <div>
            <div class="flex items-center gap-2 text-sm font-medium">
              <Activity class="h-4 w-4 text-emerald-500" />
              {{ t("etcd.dashboard.prometheusMetrics") }}
            </div>
            <p class="mt-1 text-xs text-muted-foreground">{{ t("etcd.dashboard.prometheusDescription") }}</p>
          </div>
          <div class="min-w-0 text-right text-xs text-muted-foreground">
            <div class="max-w-[420px] truncate font-mono">{{ metrics.sourceUrl }}</div>
            <div>{{ t("etcd.dashboard.collectedAt") }} {{ formatCollectedAt(metrics.collectedAtMs) }}</div>
          </div>
        </div>

        <div class="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
          <div class="bg-background p-4">
            <div class="flex items-center gap-2 text-xs text-muted-foreground"><Activity class="h-4 w-4" /> {{ t("etcd.dashboard.requests") }}</div>
            <div class="mt-2 text-xl font-semibold">{{ formatRate(requestRate) }}</div>
            <div class="mt-1 text-xs text-muted-foreground">{{ t("etcd.dashboard.requestFailureRate") }} {{ formatPercent(requestFailurePercent) }}</div>
          </div>
          <div class="bg-background p-4">
            <div class="flex items-center gap-2 text-xs text-muted-foreground"><Gauge class="h-4 w-4" /> {{ t("etcd.dashboard.proposals") }}</div>
            <div class="mt-2 text-xl font-semibold">{{ proposalLag ?? "-" }}</div>
            <div class="mt-1 text-xs text-muted-foreground">{{ t("etcd.dashboard.proposalLag") }} · {{ t("etcd.dashboard.pending") }} {{ formatCount(metrics.proposalsPending) }}</div>
          </div>
          <div class="bg-background p-4">
            <div class="flex items-center gap-2 text-xs text-muted-foreground"><Database class="h-4 w-4" /> {{ t("etcd.dashboard.storageQuota") }}</div>
            <div class="mt-2 text-xl font-semibold">{{ formatPercent(quotaPercent) }}</div>
            <div class="mt-1 text-xs text-muted-foreground">{{ formatBytes(metrics.dbSizeMetricBytes ?? Number.NaN) }} / {{ formatBytes(metrics.quotaBackendBytes ?? Number.NaN) }}</div>
          </div>
          <div class="bg-background p-4">
            <div class="flex items-center gap-2 text-xs text-muted-foreground"><Clock3 class="h-4 w-4" /> {{ t("etcd.dashboard.uptime") }}</div>
            <div class="mt-2 text-xl font-semibold">{{ formatDuration(uptimeSeconds) }}</div>
            <div class="mt-1 text-xs text-muted-foreground">etcd {{ metrics.serverVersion ?? "-" }} · {{ metrics.goVersion ?? "-" }}</div>
          </div>
        </div>

        <div class="border-t px-4 py-3">
          <div class="flex items-center gap-2 text-sm font-medium"><Gauge class="h-4 w-4 text-sky-500" /> {{ t("etcd.dashboard.consensusReliability") }}</div>
          <div class="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div class="rounded-md border bg-muted/10 p-3">
              <div class="text-xs text-muted-foreground">{{ t("etcd.dashboard.leadership") }}</div>
              <div class="mt-2 text-base font-semibold">{{ metrics.isLeader === 1 ? t("etcd.dashboard.leader") : t("etcd.dashboard.follower") }}</div>
              <div class="mt-1 text-xs text-muted-foreground">{{ t("etcd.dashboard.leaderChanges") }} {{ formatCount(metrics.leaderChangesTotal) }} · {{ t("etcd.dashboard.knownPeers") }} {{ formatCount(metrics.knownPeers) }}</div>
            </div>
            <div class="rounded-md border bg-muted/10 p-3">
              <div class="text-xs text-muted-foreground">{{ t("etcd.dashboard.proposalState") }}</div>
              <div class="mt-2 text-base font-semibold">{{ t("etcd.dashboard.pending") }} {{ formatCount(metrics.proposalsPending) }} · Lag {{ proposalLag ?? "-" }}</div>
              <div class="mt-1 text-xs text-muted-foreground">{{ t("etcd.dashboard.failedProposals") }} {{ formatCount(metrics.proposalsFailedTotal) }} · {{ formatRate(proposalFailureRate) }}</div>
            </div>
            <div class="rounded-md border bg-muted/10 p-3">
              <div class="text-xs text-muted-foreground">{{ t("etcd.dashboard.raftFailures") }}</div>
              <div class="mt-2 text-base font-semibold">Heartbeat {{ formatCount(metrics.heartbeatSendFailuresTotal) }}</div>
              <div class="mt-1 text-xs text-muted-foreground">Read index {{ formatCount(metrics.readIndexesFailedTotal) }} · Slow {{ formatCount(metrics.slowReadIndexesTotal) }}</div>
            </div>
            <div class="rounded-md border bg-muted/10 p-3">
              <div class="text-xs text-muted-foreground">{{ t("etcd.dashboard.revisionState") }}</div>
              <div class="mt-2 text-base font-semibold">{{ formatCount(metrics.mvccCurrentRevision) }}</div>
              <div class="mt-1 text-xs text-muted-foreground">{{ t("etcd.dashboard.compactRevision") }} {{ formatCount(metrics.mvccCompactRevision) }} · Slow apply {{ formatCount(metrics.slowApplyTotal) }}</div>
            </div>
          </div>
        </div>

        <div class="border-t px-4 py-3">
          <div class="flex items-center gap-2 text-sm font-medium"><Activity class="h-4 w-4 text-violet-500" /> {{ t("etcd.dashboard.requestLoad") }}</div>
          <div class="mt-3 grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
            <div class="overflow-auto rounded-md border">
              <table class="w-full min-w-[620px] text-left text-xs">
                <thead class="bg-muted/60 text-muted-foreground">
                  <tr>
                    <th class="px-3 py-2">{{ t("etcd.dashboard.grpcMethod") }}</th>
                    <th class="px-3 py-2">{{ t("etcd.dashboard.total") }}</th>
                    <th class="px-3 py-2">{{ t("etcd.dashboard.rate") }}</th>
                    <th class="px-3 py-2">{{ t("etcd.dashboard.failures") }}</th>
                    <th class="px-3 py-2">{{ t("etcd.dashboard.avgLatency") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in grpcMethodRows" :key="row.method" class="border-t">
                    <td class="px-3 py-2 font-medium">{{ row.method }}</td>
                    <td class="px-3 py-2 tabular-nums">{{ formatCount(row.total) }}</td>
                    <td class="px-3 py-2 tabular-nums">{{ formatRate(row.rate) }}</td>
                    <td class="px-3 py-2 tabular-nums">
                      {{ formatCount(row.failures) }} <span v-if="row.failureRate != null" class="text-muted-foreground">({{ formatRate(row.failureRate) }})</span>
                    </td>
                    <td class="px-3 py-2 tabular-nums">{{ formatMilliseconds(row.latencyMs) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="rounded-md border p-3">
                <div class="text-xs text-muted-foreground">Range</div>
                <div class="mt-1 font-semibold">{{ formatRate(mvccRangeRate) }}</div>
                <div class="text-xs text-muted-foreground">{{ formatCount(metrics.mvccRangeTotal) }}</div>
              </div>
              <div class="rounded-md border p-3">
                <div class="text-xs text-muted-foreground">Put</div>
                <div class="mt-1 font-semibold">{{ formatRate(mvccPutRate) }}</div>
                <div class="text-xs text-muted-foreground">{{ formatCount(metrics.mvccPutTotal) }}</div>
              </div>
              <div class="rounded-md border p-3">
                <div class="text-xs text-muted-foreground">Delete</div>
                <div class="mt-1 font-semibold">{{ formatRate(mvccDeleteRate) }}</div>
                <div class="text-xs text-muted-foreground">{{ formatCount(metrics.mvccDeleteTotal) }}</div>
              </div>
              <div class="rounded-md border p-3">
                <div class="text-xs text-muted-foreground">Txn</div>
                <div class="mt-1 font-semibold">{{ formatRate(mvccTxnRate) }}</div>
                <div class="text-xs text-muted-foreground">{{ formatCount(metrics.mvccTxnTotal) }}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="border-t px-4 py-3">
          <div class="flex items-center gap-2 text-sm font-medium"><HardDrive class="h-4 w-4 text-amber-500" /> {{ t("etcd.dashboard.storageDisk") }}</div>
          <div class="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div class="rounded-md border p-3">
              <div class="text-xs text-muted-foreground">{{ t("etcd.dashboard.diskLatency") }}</div>
              <div class="mt-2 font-semibold">WAL fsync {{ formatMilliseconds(walFsyncMs) }}</div>
              <div class="mt-1 text-xs text-muted-foreground">WAL write {{ formatMilliseconds(walWriteMs) }} · {{ formatByteRate(walWriteRate) }}</div>
            </div>
            <div class="rounded-md border p-3">
              <div class="text-xs text-muted-foreground">Backend</div>
              <div class="mt-2 font-semibold">Commit {{ formatMilliseconds(backendCommitMs) }}</div>
              <div class="mt-1 text-xs text-muted-foreground">Snapshot {{ formatMilliseconds(backendSnapshotMs) }} · Defrag {{ formatMilliseconds(backendDefragMs) }}</div>
            </div>
            <div class="rounded-md border p-3">
              <div class="text-xs text-muted-foreground">{{ t("etcd.dashboard.databaseState") }}</div>
              <div class="mt-2 font-semibold">{{ formatBytes(metrics.dbSizeInUseMetricBytes ?? Number.NaN) }} {{ t("etcd.dashboard.inUse") }}</div>
              <div class="mt-1 text-xs text-muted-foreground">{{ t("etcd.dashboard.openReadTransactions") }} {{ formatCount(metrics.openReadTransactions) }} · Put bytes {{ formatBytes(metrics.mvccTotalPutSizeBytes ?? Number.NaN) }}</div>
            </div>
            <div class="rounded-md border p-3">
              <div class="text-xs text-muted-foreground">{{ t("etcd.dashboard.backgroundTasks") }}</div>
              <div class="mt-2 font-semibold">Defrag {{ formatCount(metrics.diskDefragInflight) }}</div>
              <div class="mt-1 text-xs text-muted-foreground">Snapshot apply {{ formatCount(metrics.snapshotApplyInProgress) }}</div>
            </div>
          </div>
        </div>

        <div class="grid border-t xl:grid-cols-2 xl:divide-x">
          <div class="px-4 py-3">
            <div class="flex items-center gap-2 text-sm font-medium"><Eye class="h-4 w-4 text-cyan-500" /> {{ t("etcd.dashboard.watchState") }}</div>
            <div class="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <div>
                <div class="text-muted-foreground">{{ t("etcd.dashboard.watchers") }}</div>
                <div class="mt-1 text-base font-semibold">{{ formatCount(metrics.mvccWatcherTotal) }}</div>
              </div>
              <div>
                <div class="text-muted-foreground">{{ t("etcd.dashboard.watchStreams") }}</div>
                <div class="mt-1 text-base font-semibold">{{ formatCount(metrics.mvccWatchStreamTotal) }}</div>
              </div>
              <div>
                <div class="text-muted-foreground">{{ t("etcd.dashboard.events") }}</div>
                <div class="mt-1 text-base font-semibold">{{ formatRate(mvccEventRate) }}</div>
              </div>
              <div>
                <div class="text-muted-foreground">{{ t("etcd.dashboard.slowPending") }}</div>
                <div class="mt-1 text-base font-semibold">{{ formatCount(metrics.mvccSlowWatcherTotal) }} / {{ formatCount(metrics.mvccPendingEventsTotal) }}</div>
              </div>
            </div>
          </div>
          <div class="border-t px-4 py-3 xl:border-t-0">
            <div class="flex items-center gap-2 text-sm font-medium"><Radio class="h-4 w-4 text-emerald-500" /> {{ t("etcd.dashboard.leaseState") }}</div>
            <div class="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <div>
                <div class="text-muted-foreground">{{ t("etcd.dashboard.granted") }}</div>
                <div class="mt-1 text-base font-semibold">{{ formatRate(leaseGrantedRate) }}</div>
              </div>
              <div>
                <div class="text-muted-foreground">{{ t("etcd.dashboard.renewed") }}</div>
                <div class="mt-1 text-base font-semibold">{{ formatRate(leaseRenewedRate) }}</div>
              </div>
              <div>
                <div class="text-muted-foreground">{{ t("etcd.dashboard.revokedExpired") }}</div>
                <div class="mt-1 text-base font-semibold">{{ formatRate(leaseRevokedRate) }} / {{ formatRate(leaseExpiredRate) }}</div>
              </div>
              <div>
                <div class="text-muted-foreground">{{ t("etcd.dashboard.averageTtl") }}</div>
                <div class="mt-1 text-base font-semibold">{{ averageLeaseTtl == null ? "-" : `${averageLeaseTtl.toFixed(1)}s` }}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="border-t px-4 py-3">
          <div class="flex items-center gap-2 text-sm font-medium"><Cpu class="h-4 w-4 text-rose-500" /> {{ t("etcd.dashboard.runtimeResources") }}</div>
          <div class="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <div class="rounded-md border p-3">
              <div class="text-xs text-muted-foreground">{{ t("etcd.dashboard.memory") }}</div>
              <div class="mt-2 font-semibold">RSS {{ formatBytes(metrics.residentMemoryBytes ?? Number.NaN) }}</div>
              <div class="mt-1 text-xs text-muted-foreground">Heap {{ formatBytes(metrics.goHeapAllocBytes ?? Number.NaN) }} / {{ formatBytes(metrics.goHeapSysBytes ?? Number.NaN) }}</div>
            </div>
            <div class="rounded-md border p-3">
              <div class="text-xs text-muted-foreground">{{ t("etcd.dashboard.runtime") }}</div>
              <div class="mt-2 font-semibold">{{ formatCount(metrics.goroutines) }} goroutines</div>
              <div class="mt-1 text-xs text-muted-foreground">{{ formatCount(metrics.goThreads) }} threads · GOMAXPROCS {{ formatCount(metrics.goMaxProcs) }}</div>
            </div>
            <div class="rounded-md border p-3">
              <div class="text-xs text-muted-foreground">{{ t("etcd.dashboard.processResources") }}</div>
              <div class="mt-2 font-semibold">CPU {{ formatPercent(cpuPercent) }}</div>
              <div class="mt-1 text-xs text-muted-foreground">FD {{ formatCount(metrics.openFds) }} / {{ formatCount(metrics.maxFds) }} · {{ formatPercent(fdPercent) }}</div>
            </div>
            <div class="rounded-md border p-3">
              <div class="flex items-center gap-1.5 text-xs text-muted-foreground"><Network class="h-3.5 w-3.5" /> {{ t("etcd.dashboard.networkTraffic") }}</div>
              <div class="mt-2 font-semibold">↓ {{ formatByteRate(clientReceivedRate) }} · ↑ {{ formatByteRate(clientSentRate) }}</div>
              <div class="mt-1 text-xs text-muted-foreground">Peer ↓ {{ formatByteRate(peerReceivedRate) }} · ↑ {{ formatByteRate(peerSentRate) }}</div>
            </div>
            <div class="rounded-md border p-3">
              <div class="text-xs text-muted-foreground">{{ t("etcd.dashboard.processNetworkGc") }}</div>
              <div class="mt-2 font-semibold">↓ {{ formatByteRate(processReceivedRate) }} · ↑ {{ formatByteRate(processTransmittedRate) }}</div>
              <div class="mt-1 text-xs text-muted-foreground">GC {{ formatMilliseconds(goGcMs) }} · {{ formatCount(metrics.goHeapObjects) }} objects</div>
            </div>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 border-t px-4 py-3 text-xs">
          <Badge variant="outline">etcd {{ metrics.serverVersion ?? "-" }}</Badge>
          <Badge variant="outline">Cluster {{ metrics.clusterVersion ?? "-" }}</Badge>
          <Badge variant="outline">Auth revision {{ formatCount(metrics.authRevision) }}</Badge>
          <Badge variant="outline">Keys {{ formatCount(metrics.mvccKeysTotal) }}</Badge>
          <Badge variant="outline">Health {{ formatCount(metrics.healthSuccessTotal) }} / {{ formatCount(metrics.healthFailuresTotal) }}</Badge>
          <span v-if="requestRate == null" class="text-muted-foreground">{{ t("etcd.dashboard.rateNeedsRefresh") }}</span>
        </div>
      </section>
      <section v-else-if="metrics && !metrics.available" class="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
        <div class="flex items-start gap-3">
          <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div class="min-w-0">
            <div class="text-sm font-medium">{{ t("etcd.dashboard.metricsUnavailable") }}</div>
            <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ t("etcd.dashboard.metricsUnavailableHint") }}</p>
            <p v-if="metrics.error" class="mt-2 break-words font-mono text-xs text-muted-foreground">{{ metrics.error }}</p>
          </div>
        </div>
      </section>

      <div class="overflow-auto rounded-lg border">
        <table class="w-full min-w-[1050px] text-left text-sm">
          <thead class="bg-muted/70 text-xs text-muted-foreground">
            <tr>
              <th class="px-3 py-2">{{ t("etcd.dashboard.endpointMember") }}</th>
              <th class="px-3 py-2">{{ t("etcd.dashboard.role") }}</th>
              <th class="px-3 py-2">{{ t("etcd.dashboard.version") }}</th>
              <th class="px-3 py-2">{{ t("etcd.dashboard.revision") }}</th>
              <th class="px-3 py-2">{{ t("etcd.dashboard.raftTermApplied") }}</th>
              <th class="px-3 py-2">{{ t("etcd.dashboard.dbSizeInUse") }}</th>
              <th class="px-3 py-2">{{ t("etcd.dashboard.latency") }}</th>
              <th class="px-3 py-2">{{ t("etcd.dashboard.status") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="member in status.members" :key="member.endpoint" class="border-t">
              <td class="px-3 py-2">
                <div class="font-medium">{{ member.name || member.endpoint }}</div>
                <div class="max-w-72 truncate font-mono text-xs text-muted-foreground">{{ member.endpoint }} · {{ member.memberId || "-" }}</div>
              </td>
              <td class="px-3 py-2">{{ member.learner ? t("etcd.dashboard.learner") : member.memberId === status.leaderId ? t("etcd.dashboard.leader") : t("etcd.dashboard.follower") }}</td>
              <td class="px-3 py-2">{{ member.version || "-" }}</td>
              <td class="px-3 py-2 font-mono text-xs">{{ member.revision || "-" }}</td>
              <td class="px-3 py-2 font-mono text-xs">{{ member.raftTerm || "-" }} / {{ member.raftAppliedIndex || "-" }}</td>
              <td class="px-3 py-2">{{ formatBytes(Number(member.dbSize || 0)) }} / {{ formatBytes(Number(member.dbSizeInUse || 0)) }}</td>
              <td class="px-3 py-2">{{ member.latencyMs == null ? "-" : `${member.latencyMs} ms` }}</td>
              <td class="px-3 py-2">
                <Badge :variant="member.reachable && member.errors.length === 0 ? 'secondary' : 'destructive'">
                  {{ member.reachable ? member.errors[0] || t("etcd.dashboard.reachable") : member.errors[0] || t("etcd.dashboard.unreachable") }}
                </Badge>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
    <div v-else-if="loading" class="flex h-64 items-center justify-center text-sm text-muted-foreground">
      <Loader2 class="mr-2 h-4 w-4 animate-spin" />
      {{ t("etcd.dashboard.loading") }}
    </div>
  </div>
</template>

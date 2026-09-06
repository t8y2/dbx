<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import { Activity, AlertTriangle, Database, Gauge, HardDrive, Loader2, RefreshCcw, Server, Users } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/backend/api";
import {
  XUGU_ACTIVE_SESSION_SQL,
  XUGU_CLUSTER_NODES_SQL,
  XUGU_LOCK_MODE_SUMMARY_SQL,
  XUGU_LOCK_WAITS_SQL,
  XUGU_MEMORY_STATUS_SQL,
  XUGU_RUN_INFO_SQL,
  XUGU_SESSION_SUMMARY_SQL,
  XUGU_SESSION_STATUS_SUMMARY_SQL,
  XUGU_TABLESPACE_SUMMARY_SQL,
  XUGU_TRANSACTION_SUMMARY_SQL,
  XUGU_VERSION_SQL,
  connectionSupportsXuguServerDashboard,
  xuguClusterNodeStateLabel,
  xuguClusterNodeTypeLabels,
  xuguClusterNodesFromResult,
  xuguLockModeSummaryFromResult,
  xuguMemoryStatusFromResult,
  xuguRunInfoFromResult,
  xuguScalarFromResult,
  xuguSessionSummaryFromResult,
  xuguSessionStatusSummaryFromResult,
  xuguTablespaceSummaryFromResult,
  xuguTransactionSummaryFromResult,
  xuguVersionFromResult,
  type XuguClusterNode,
  type XuguLockModeSummary,
  type XuguMemoryStatus,
  type XuguRunInfo,
  type XuguSessionSummary,
  type XuguSessionStatusSummary,
  type XuguTablespaceSummary,
  type XuguTransactionSummary,
} from "@/lib/database/xuguServerStatus";

const props = defineProps<{ connectionId: string }>();
const { t } = useI18n();
const connectionStore = useConnectionStore();

const loading = ref(false);
const error = ref("");
const partialErrors = ref<string[]>([]);
const version = ref("");
const nodes = ref<XuguClusterNode[]>([]);
const runInfo = ref<XuguRunInfo[]>([]);
const sessions = ref<XuguSessionSummary[]>([]);
const transactions = ref<XuguTransactionSummary[]>([]);
const memory = ref<XuguMemoryStatus[]>([]);
const sessionStatuses = ref<XuguSessionStatusSummary[]>([]);
const lockModes = ref<XuguLockModeSummary[]>([]);
const tablespaces = ref<XuguTablespaceSummary[]>([]);
const lockWaits = ref("");
const lockOwners = ref("");
const availability = reactive({
  version: false,
  nodes: false,
  runInfo: false,
  sessions: false,
  activeSessions: false,
  transactions: false,
  lockWaits: false,
  memory: false,
  sessionStatuses: false,
  lockModes: false,
  tablespaces: false,
});
const refreshSeconds = ref(5);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const connection = computed(() => connectionStore.getConfig(props.connectionId));
const connectionName = computed(() => connection.value?.name ?? "");
const supported = computed(() => connectionSupportsXuguServerDashboard(connection.value));
const runInfoByNode = computed(() => new Map(runInfo.value.map((entry) => [entry.nodeId, entry])));
const sessionsByNode = computed(() => new Map(sessions.value.map((entry) => [entry.nodeId, entry])));
const transactionsByNode = computed(() => new Map(transactions.value.map((entry) => [entry.nodeId, entry])));
const onlineNodes = computed<number | null>(() => (availability.nodes ? nodes.value.filter((node) => xuguClusterNodeStateLabel(node.state) === "running").length : null));
const totalSessions = computed<number | null>(() => (availability.sessions ? sessions.value.reduce((sum, row) => sum + numeric(row.sessions), 0) : null));
const activeSessions = computed<number | null>(() => (availability.activeSessions ? sessions.value.reduce((sum, row) => sum + numeric(row.activeSessions), 0) : null));
const activeTransactions = computed<number | null>(() => {
  if (!availability.transactions && !availability.runInfo) return null;
  const values = transactions.value.length > 0 ? transactions.value.map((row) => row.activeTransactions) : runInfo.value.map((row) => row.activeTransactions);
  return values.reduce((sum, value) => sum + numeric(value), 0);
});
const bufferTotalBytes = computed(() => (availability.memory ? sum(memory.value, "bufferTotalBytes") : null));
const bufferFreeBytes = computed(() => (availability.memory ? sum(memory.value, "bufferFreeBytes") : null));
const bufferDirtyBytes = computed(() => (availability.memory ? sum(memory.value, "bufferDirtyBytes") : null));
const sgaTotalBytes = computed(() => (availability.memory ? sum(memory.value, "sgaTotalBytes") : null));
const sgaFreeBytes = computed(() => (availability.memory ? sum(memory.value, "sgaFreeBytes") : null));
const swapTotalBytes = computed(() => (availability.memory ? sum(memory.value, "swapTotalBytes") : null));
const swapFreeBytes = computed(() => (availability.memory ? sum(memory.value, "swapFreeBytes") : null));
const diskReadBytes = computed(() => (availability.runInfo ? sum(runInfo.value, "diskReadBytes") : null));
const diskWriteBytes = computed(() => (availability.runInfo ? sum(runInfo.value, "diskWriteBytes") : null));
const freeStores = computed(() => (availability.runInfo ? sum(runInfo.value, "freeStores") : null));
const transactionSpan = computed<number | null>(() => (availability.runInfo ? runInfo.value.reduce((total, entry) => total + Math.max(0, numeric(entry.maxTransactionId) - numeric(entry.minTransactionId)), 0) : null));
const walBacklog = computed<number | null>(() => (availability.runInfo ? runInfo.value.reduce((total, entry) => total + Math.max(0, numeric(entry.xlogWritePosition) - numeric(entry.xlogCheckpointPosition)), 0) : null));
const totalDatafiles = computed(() => (availability.tablespaces ? sum(tablespaces.value, "datafiles") : null));
const mediaErrors = computed<number | null>(() => (availability.tablespaces ? tablespaces.value.filter((entry) => ["1", "TRUE", "Y"].includes(entry.mediaError.trim().toUpperCase())).length : null));
const dataOrTempFreeBytes = computed<number | null>(() => (availability.tablespaces ? tablespaces.value.filter((entry) => /DATA|TEMP/i.test(entry.spaceType)).reduce((total, entry) => total + numeric(entry.freeBytes), 0) : null));

function numeric(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sum<T extends Record<string, string>>(entries: T[], key: keyof T): number {
  return entries.reduce((total, entry) => total + numeric(entry[key]), 0);
}

function percentage(total: number | null, available: number | null): number {
  if (total === null || available === null) return 0;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, ((total - available) / total) * 100));
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / 1024 ** index;
  return `${scaled >= 100 || index === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
}

function sessionStatusCount(status: "idle" | "executing"): number | null {
  if (!availability.sessionStatuses) return null;
  return sessionStatuses.value
    .filter((entry) => {
      const normalized = Math.abs(numeric(entry.status)) % 1000;
      return status === "idle" ? normalized === 112 : normalized === 114;
    })
    .reduce((total, entry) => total + numeric(entry.sessions), 0);
}

function otherSessionCount(): number | null {
  if (totalSessions.value === null || !availability.sessionStatuses) return null;
  const idle = sessionStatusCount("idle");
  const executing = sessionStatusCount("executing");
  if (idle === null || executing === null) return null;
  return Math.max(0, totalSessions.value - idle - executing);
}

function lockModeCount(lockMode: string): number | null {
  if (!availability.lockModes) return null;
  return lockModes.value.filter((entry) => entry.lockMode.toUpperCase() === lockMode).reduce((total, entry) => total + numeric(entry.locks), 0);
}

function nodeStateClass(node: XuguClusterNode): string {
  const state = xuguClusterNodeStateLabel(node.state);
  if (state === "running") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (state === "error" || state === "offline") return "border-destructive/30 bg-destructive/10 text-destructive";
  return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
}

function nodeStateText(node: XuguClusterNode): string {
  return t(`xuguServerDashboard.nodeState.${xuguClusterNodeStateLabel(node.state)}`);
}

function nodeTypeText(node: XuguClusterNode): string {
  const labels = xuguClusterNodeTypeLabels(node.nodeType);
  return labels.length > 0 ? labels.map((role) => t(`xuguServerDashboard.nodeType.${role}`)).join(" / ") : t("xuguServerDashboard.nodeType.unknown");
}

function valueFor<T extends Record<string, string>>(map: Map<string, T>, nodeId: string, key: keyof T): string {
  return map.get(nodeId)?.[key] || "—";
}

async function query(sql: string, maxRows: number) {
  return api.executeQuery(props.connectionId, "", sql, undefined, undefined, { maxRows });
}

async function load() {
  if (!supported.value) return;
  loading.value = true;
  error.value = "";
  partialErrors.value = [];
  try {
    await connectionStore.ensureConnected(props.connectionId);
    const requests = [
      ["version", XUGU_VERSION_SQL, 1],
      ["nodes", XUGU_CLUSTER_NODES_SQL, 500],
      ["runInfo", XUGU_RUN_INFO_SQL, 500],
      ["sessions", XUGU_SESSION_SUMMARY_SQL, 500],
      ["activeSessions", XUGU_ACTIVE_SESSION_SQL, 500],
      ["transactions", XUGU_TRANSACTION_SUMMARY_SQL, 500],
      ["lockWaits", XUGU_LOCK_WAITS_SQL, 1],
      ["memory", XUGU_MEMORY_STATUS_SQL, 500],
      ["sessionStatuses", XUGU_SESSION_STATUS_SUMMARY_SQL, 500],
      ["lockModes", XUGU_LOCK_MODE_SUMMARY_SQL, 500],
      ["tablespaces", XUGU_TABLESPACE_SUMMARY_SQL, 500],
    ] as const;
    const results = await Promise.allSettled(requests.map(([, sql, maxRows]) => query(sql, maxRows)));
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    partialErrors.value = failed.map((result) => result.reason?.message || String(result.reason));
    const coreFailed = results.slice(0, 3).every((result) => result.status === "rejected");
    if (coreFailed) {
      throw failed[0]?.reason ?? new Error(t("xuguServerDashboard.loadFailed"));
    }

    const [versionResult, nodeResult, runInfoResult, sessionResult, activeSessionResult, transactionResult, lockResult, memoryResult, sessionStatusResult, lockModeResult, tablespaceResult] = results;
    availability.version = versionResult.status === "fulfilled";
    availability.nodes = nodeResult.status === "fulfilled";
    availability.runInfo = runInfoResult.status === "fulfilled";
    availability.sessions = sessionResult.status === "fulfilled";
    availability.activeSessions = activeSessionResult.status === "fulfilled";
    availability.transactions = transactionResult.status === "fulfilled";
    availability.lockWaits = lockResult.status === "fulfilled";
    availability.memory = memoryResult.status === "fulfilled";
    availability.sessionStatuses = sessionStatusResult.status === "fulfilled";
    availability.lockModes = lockModeResult.status === "fulfilled";
    availability.tablespaces = tablespaceResult.status === "fulfilled";
    if (versionResult.status === "fulfilled") version.value = xuguVersionFromResult(versionResult.value);
    else version.value = "";
    if (nodeResult.status === "fulfilled") nodes.value = xuguClusterNodesFromResult(nodeResult.value);
    else nodes.value = [];
    if (runInfoResult.status === "fulfilled") runInfo.value = xuguRunInfoFromResult(runInfoResult.value);
    else runInfo.value = [];
    const activeByNode = activeSessionResult.status === "fulfilled" ? new Map(xuguSessionSummaryFromResult(activeSessionResult.value).map((row) => [row.nodeId, row])) : new Map();
    // 活跃会话查询整体失败时不能把缺失显示成硬 0，那会读成"无活跃会话"
    const activeSessionsUnavailable = activeSessionResult.status !== "fulfilled";
    sessions.value =
      sessionResult.status === "fulfilled"
        ? xuguSessionSummaryFromResult(sessionResult.value).map((row) => {
            const active = activeByNode.get(row.nodeId);
            return { ...row, activeSessions: active?.activeSessions ?? (activeSessionsUnavailable ? "—" : "0"), oldestStatement: active?.oldestStatement ?? "" };
          })
        : [];
    if (transactionResult.status === "fulfilled") transactions.value = xuguTransactionSummaryFromResult(transactionResult.value);
    else transactions.value = [];
    if (lockResult.status === "fulfilled") {
      lockWaits.value = xuguScalarFromResult(lockResult.value, "LOCK_WAITS");
      lockOwners.value = xuguScalarFromResult(lockResult.value, "LOCK_OWNERS");
    } else {
      lockWaits.value = "";
      lockOwners.value = "";
    }
    if (memoryResult.status === "fulfilled") memory.value = xuguMemoryStatusFromResult(memoryResult.value);
    else memory.value = [];
    if (sessionStatusResult.status === "fulfilled") sessionStatuses.value = xuguSessionStatusSummaryFromResult(sessionStatusResult.value);
    else sessionStatuses.value = [];
    if (lockModeResult.status === "fulfilled") lockModes.value = xuguLockModeSummaryFromResult(lockModeResult.value);
    else lockModes.value = [];
    if (tablespaceResult.status === "fulfilled") tablespaces.value = xuguTablespaceSummaryFromResult(tablespaceResult.value);
    else tablespaces.value = [];
  } catch (cause: any) {
    error.value = cause?.message || String(cause);
  } finally {
    loading.value = false;
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
  if (refreshSeconds.value <= 0) return;
  refreshTimer = setInterval(() => {
    if (!document.hidden) void load();
  }, refreshSeconds.value * 1000);
}

function changeRefresh(value: string) {
  refreshSeconds.value = Number(value);
  startAutoRefresh();
}

onMounted(async () => {
  await load();
  startAutoRefresh();
});

onUnmounted(stopAutoRefresh);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex h-11 shrink-0 items-center gap-2 border-b bg-muted/20 px-3">
      <Gauge class="h-4 w-4 text-primary" />
      <div class="truncate text-sm font-semibold">{{ t("xuguServerDashboard.title") }}</div>
      <Badge variant="outline" class="h-5 max-w-56 truncate rounded-md px-1.5 text-[11px]" :title="connectionName">{{ connectionName }}</Badge>
      <div class="ml-auto flex items-center gap-2">
        <span class="hidden text-xs text-muted-foreground sm:inline">{{ version || "—" }}</span>
        <select :value="String(refreshSeconds)" class="h-7 rounded-md border bg-background px-2 text-xs" @change="changeRefresh(($event.target as HTMLSelectElement).value)">
          <option value="0">{{ t("xuguServerDashboard.off") }}</option>
          <option value="5">5s</option>
          <option value="10">10s</option>
          <option value="30">30s</option>
        </select>
        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" :disabled="loading" @click="load">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCcw v-else class="h-3.5 w-3.5" />
          {{ t("grid.refresh") }}
        </Button>
      </div>
    </div>

    <div v-if="!supported" class="flex flex-1 items-center justify-center text-sm text-muted-foreground">{{ t("xuguServerDashboard.unsupported") }}</div>
    <div v-else-if="error" class="flex flex-1 items-center justify-center gap-2 px-6 text-center text-sm text-destructive">
      <AlertTriangle class="h-4 w-4 shrink-0" />
      {{ error }}
    </div>
    <div v-else class="min-h-0 flex-1 overflow-auto p-4">
      <div v-if="partialErrors.length > 0" class="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
        <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{{ t("xuguServerDashboard.partialData") }}</span>
      </div>

      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <div class="rounded-lg border bg-card p-3">
          <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.version") }}</div>
          <div class="mt-2 truncate text-sm font-semibold">{{ version || "—" }}</div>
        </div>
        <div class="rounded-lg border bg-card p-3">
          <div class="flex items-center gap-1.5 text-xs text-muted-foreground"><Server class="h-3.5 w-3.5" />{{ t("xuguServerDashboard.onlineNodes") }}</div>
          <div class="mt-2 text-xl font-semibold">
            {{ onlineNodes === null ? "—" : onlineNodes }}<span v-if="onlineNodes !== null" class="ml-1 text-xs font-normal text-muted-foreground">/ {{ nodes.length }}</span>
          </div>
        </div>
        <div class="rounded-lg border bg-card p-3">
          <div class="flex items-center gap-1.5 text-xs text-muted-foreground"><Users class="h-3.5 w-3.5" />{{ t("xuguServerDashboard.sessions") }}</div>
          <div class="mt-2 text-xl font-semibold">
            {{ totalSessions === null ? "—" : totalSessions }}<span class="ml-1 text-xs font-normal text-muted-foreground">{{ activeSessions === null ? "—" : t("xuguServerDashboard.activeCount", { count: activeSessions }) }}</span>
          </div>
        </div>
        <div class="rounded-lg border bg-card p-3">
          <div class="flex items-center gap-1.5 text-xs text-muted-foreground"><Activity class="h-3.5 w-3.5" />{{ t("xuguServerDashboard.transactions") }}</div>
          <div class="mt-2 text-xl font-semibold">{{ activeTransactions === null ? "—" : activeTransactions }}</div>
        </div>
        <div class="rounded-lg border bg-card p-3">
          <div class="flex items-center gap-1.5 text-xs text-muted-foreground"><Database class="h-3.5 w-3.5" />{{ t("xuguServerDashboard.lockWaits") }}</div>
          <div class="mt-2 text-xl font-semibold">{{ lockWaits || "—" }}</div>
        </div>
      </div>

      <div class="mt-4 grid gap-4 xl:grid-cols-2">
        <section class="overflow-hidden rounded-lg border bg-card">
          <div class="flex items-center justify-between border-b px-3 py-2.5">
            <div class="flex items-center gap-1.5 text-sm font-semibold"><Database class="h-4 w-4 text-primary" />{{ t("xuguServerDashboard.memoryAndCache") }}</div>
            <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.memoryHint") }}</div>
          </div>
          <div class="space-y-4 p-3">
            <div>
              <div class="mb-1.5 flex items-center justify-between text-xs">
                <span>{{ t("xuguServerDashboard.bufferPool") }}</span
                ><span class="text-muted-foreground">{{ bufferTotalBytes === null || bufferFreeBytes === null ? "—" : `${formatBytes(bufferTotalBytes - bufferFreeBytes)} / ${formatBytes(bufferTotalBytes)}` }}</span>
              </div>
              <div class="h-2 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-primary" :style="{ width: `${percentage(bufferTotalBytes, bufferFreeBytes)}%` }" /></div>
              <div class="mt-1.5 flex justify-between text-[11px] text-muted-foreground">
                <span>{{ bufferTotalBytes === null || bufferFreeBytes === null ? "—" : t("xuguServerDashboard.usedPercent", { percent: percentage(bufferTotalBytes, bufferFreeBytes).toFixed(1) }) }}</span
                ><span>{{ bufferDirtyBytes === null ? "—" : t("xuguServerDashboard.dirtyPages", { value: formatBytes(bufferDirtyBytes) }) }}</span>
              </div>
            </div>
            <div>
              <div class="mb-1.5 flex items-center justify-between text-xs">
                <span>{{ t("xuguServerDashboard.sga") }}</span
                ><span class="text-muted-foreground">{{ sgaTotalBytes === null || sgaFreeBytes === null ? "—" : `${formatBytes(sgaTotalBytes - sgaFreeBytes)} / ${formatBytes(sgaTotalBytes)}` }}</span>
              </div>
              <div class="h-2 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-sky-500" :style="{ width: `${percentage(sgaTotalBytes, sgaFreeBytes)}%` }" /></div>
              <div class="mt-1.5 text-[11px] text-muted-foreground">{{ sgaTotalBytes === null || sgaFreeBytes === null ? "—" : t("xuguServerDashboard.usedPercent", { percent: percentage(sgaTotalBytes, sgaFreeBytes).toFixed(1) }) }}</div>
            </div>
            <div>
              <div class="mb-1.5 flex items-center justify-between text-xs">
                <span>{{ t("xuguServerDashboard.swap") }}</span
                ><span class="text-muted-foreground">{{ swapTotalBytes === null || swapFreeBytes === null ? "—" : `${formatBytes(swapTotalBytes - swapFreeBytes)} / ${formatBytes(swapTotalBytes)}` }}</span>
              </div>
              <div class="h-2 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-amber-500" :style="{ width: `${percentage(swapTotalBytes, swapFreeBytes)}%` }" /></div>
              <div class="mt-1.5 text-[11px] text-muted-foreground">{{ swapTotalBytes === null || swapFreeBytes === null ? "—" : t("xuguServerDashboard.usedPercent", { percent: percentage(swapTotalBytes, swapFreeBytes).toFixed(1) }) }}</div>
            </div>
          </div>
        </section>

        <section class="overflow-hidden rounded-lg border bg-card">
          <div class="flex items-center justify-between border-b px-3 py-2.5">
            <div class="flex items-center gap-1.5 text-sm font-semibold"><HardDrive class="h-4 w-4 text-primary" />{{ t("xuguServerDashboard.runtimeAndWrite") }}</div>
            <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.cumulativeHint") }}</div>
          </div>
          <div class="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
            <div class="bg-card p-3">
              <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.diskRead") }}</div>
              <div class="mt-1.5 text-lg font-semibold">{{ diskReadBytes === null ? "—" : formatBytes(diskReadBytes) }}</div>
            </div>
            <div class="bg-card p-3">
              <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.diskWrite") }}</div>
              <div class="mt-1.5 text-lg font-semibold">{{ diskWriteBytes === null ? "—" : formatBytes(diskWriteBytes) }}</div>
            </div>
            <div class="bg-card p-3">
              <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.walPending") }}</div>
              <div class="mt-1.5 text-lg font-semibold">{{ walBacklog === null ? "—" : formatBytes(walBacklog) }}</div>
            </div>
            <div class="bg-card p-3">
              <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.transactionSpan") }}</div>
              <div class="mt-1.5 text-lg font-semibold">{{ transactionSpan === null ? "—" : transactionSpan }}</div>
            </div>
            <div class="col-span-2 bg-card p-3">
              <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.freeStores") }}</div>
              <div class="mt-1.5 text-lg font-semibold">{{ freeStores === null ? "—" : freeStores }}</div>
            </div>
            <div class="col-span-2 bg-card p-3">
              <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.datafiles") }}</div>
              <div class="mt-1.5 text-lg font-semibold">{{ totalDatafiles === null ? "—" : totalDatafiles }}</div>
            </div>
          </div>
        </section>
      </div>

      <div class="mt-4 grid gap-4 xl:grid-cols-2">
        <section class="overflow-hidden rounded-lg border bg-card">
          <div class="flex items-center justify-between border-b px-3 py-2.5">
            <div class="flex items-center gap-1.5 text-sm font-semibold"><Users class="h-4 w-4 text-primary" />{{ t("xuguServerDashboard.sessionsAndTransactions") }}</div>
            <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.activeSessionHint") }}</div>
          </div>
          <div class="grid grid-cols-3 gap-px bg-border">
            <div class="bg-card p-3">
              <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.idleSessions") }}</div>
              <div class="mt-1.5 text-lg font-semibold">{{ sessionStatusCount("idle") ?? "—" }}</div>
            </div>
            <div class="bg-card p-3">
              <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.executingSessions") }}</div>
              <div class="mt-1.5 text-lg font-semibold">{{ sessionStatusCount("executing") ?? "—" }}</div>
            </div>
            <div class="bg-card p-3">
              <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.otherSessions") }}</div>
              <div class="mt-1.5 text-lg font-semibold">{{ otherSessionCount() ?? "—" }}</div>
            </div>
          </div>
          <div class="grid grid-cols-2 gap-3 p-3 text-xs">
            <div>
              <div class="text-muted-foreground">{{ t("xuguServerDashboard.oldestStatement") }}</div>
              <div class="mt-1 truncate font-medium" :title="sessions.find((entry) => entry.oldestStatement)?.oldestStatement">{{ sessions.find((entry) => entry.oldestStatement)?.oldestStatement || "—" }}</div>
            </div>
            <div>
              <div class="text-muted-foreground">{{ t("xuguServerDashboard.oldestTransaction") }}</div>
              <div class="mt-1 truncate font-medium" :title="transactions.find((entry) => entry.oldestTransaction)?.oldestTransaction">{{ transactions.find((entry) => entry.oldestTransaction)?.oldestTransaction || "—" }}</div>
            </div>
          </div>
        </section>

        <section class="overflow-hidden rounded-lg border bg-card">
          <div class="flex items-center justify-between border-b px-3 py-2.5">
            <div class="flex items-center gap-1.5 text-sm font-semibold"><Activity class="h-4 w-4 text-primary" />{{ t("xuguServerDashboard.locksAndCapacity") }}</div>
            <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.readOnlyHint") }}</div>
          </div>
          <div class="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
            <div class="bg-card p-3">
              <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.lockOwners") }}</div>
              <div class="mt-1.5 text-lg font-semibold">{{ lockOwners || "—" }}</div>
            </div>
            <div class="bg-card p-3">
              <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.lockWaits") }}</div>
              <div class="mt-1.5 text-lg font-semibold">{{ lockWaits || "—" }}</div>
            </div>
            <div class="bg-card p-3">
              <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.tablespaces") }}</div>
              <div class="mt-1.5 text-lg font-semibold">{{ availability.tablespaces ? tablespaces.length : "—" }}</div>
            </div>
            <div class="bg-card p-3">
              <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.mediaErrors") }}</div>
              <div class="mt-1.5 text-lg font-semibold" :class="mediaErrors !== null && mediaErrors > 0 ? 'text-destructive' : ''">{{ mediaErrors ?? "—" }}</div>
            </div>
          </div>
          <div class="border-t p-3">
            <div class="mb-2 flex items-center justify-between text-xs">
              <span class="text-muted-foreground">{{ t("xuguServerDashboard.lockModes") }}</span
              ><span class="text-muted-foreground">{{ dataOrTempFreeBytes === null ? "—" : t("xuguServerDashboard.dataTempFree", { value: formatBytes(dataOrTempFreeBytes) }) }}</span>
            </div>
            <div class="grid grid-cols-5 gap-2 text-center text-xs">
              <div v-for="mode in ['S', 'X', 'IS', 'IX', 'SIX']" :key="mode" class="rounded-md bg-muted/50 px-2 py-1.5">
                <div class="text-muted-foreground">{{ mode }}</div>
                <div class="mt-0.5 font-semibold">{{ lockModeCount(mode) ?? "—" }}</div>
              </div>
            </div>
            <div class="mt-2 text-[11px] text-muted-foreground">{{ t("xuguServerDashboard.rowLockLimit") }}</div>
          </div>
        </section>
      </div>

      <section class="mt-4 overflow-hidden rounded-lg border bg-card">
        <div class="flex items-center justify-between border-b px-3 py-2.5">
          <div class="text-sm font-semibold">{{ t("xuguServerDashboard.nodes") }}</div>
          <div class="text-xs text-muted-foreground">{{ t("xuguServerDashboard.readOnlyHint") }}</div>
        </div>
        <div class="overflow-auto">
          <table class="w-full min-w-[1180px] text-left text-xs">
            <thead class="bg-muted/40 text-muted-foreground">
              <tr>
                <th class="px-3 py-2 font-medium">{{ t("xuguServerDashboard.node") }}</th>
                <th class="px-3 py-2 font-medium">{{ t("xuguServerDashboard.type") }}</th>
                <th class="px-3 py-2 font-medium">{{ t("xuguServerDashboard.state") }}</th>
                <th class="px-3 py-2 font-medium">{{ t("xuguServerDashboard.cpuLoad") }}</th>
                <th class="px-3 py-2 font-medium">{{ t("xuguServerDashboard.sessions") }}</th>
                <th class="px-3 py-2 font-medium">{{ t("xuguServerDashboard.transactions") }}</th>
                <th class="px-3 py-2 font-medium">{{ t("xuguServerDashboard.diskRead") }}</th>
                <th class="px-3 py-2 font-medium">{{ t("xuguServerDashboard.diskWrite") }}</th>
                <th class="px-3 py-2 font-medium">{{ t("xuguServerDashboard.walPending") }}</th>
                <th class="px-3 py-2 font-medium">{{ t("xuguServerDashboard.freeStores") }}</th>
                <th class="px-3 py-2 font-medium">{{ t("xuguServerDashboard.bootTime") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="node in nodes" :key="node.nodeId" class="border-t hover:bg-muted/30">
                <td class="px-3 py-2">
                  <div class="font-medium">#{{ node.nodeId }} · {{ node.host || "—" }}</div>
                  <div class="mt-0.5 text-[11px] text-muted-foreground">{{ t("xuguServerDashboard.rack", { rack: node.rackNo || "—" }) }} · {{ t("xuguServerDashboard.stores", { count: node.storeCount || "0" }) }}</div>
                </td>
                <td class="px-3 py-2">{{ nodeTypeText(node) }}</td>
                <td class="px-3 py-2">
                  <Badge variant="outline" class="h-5 rounded-full px-2 text-[10px]" :class="nodeStateClass(node)">{{ nodeStateText(node) }}</Badge>
                </td>
                <td class="px-3 py-2">{{ node.cpuLoad || "—" }}</td>
                <td class="px-3 py-2">
                  {{ valueFor(sessionsByNode, node.nodeId, "sessions") }}<span class="ml-1 text-muted-foreground">/ {{ valueFor(sessionsByNode, node.nodeId, "activeSessions") }}</span>
                </td>
                <td class="px-3 py-2">{{ transactionsByNode.has(node.nodeId) ? valueFor(transactionsByNode, node.nodeId, "activeTransactions") : valueFor(runInfoByNode, node.nodeId, "activeTransactions") }}</td>
                <td class="px-3 py-2">{{ availability.runInfo ? formatBytes(numeric(valueFor(runInfoByNode, node.nodeId, "diskReadBytes"))) : "—" }}</td>
                <td class="px-3 py-2">{{ availability.runInfo ? formatBytes(numeric(valueFor(runInfoByNode, node.nodeId, "diskWriteBytes"))) : "—" }}</td>
                <td class="px-3 py-2">{{ availability.runInfo ? formatBytes(Math.max(0, numeric(valueFor(runInfoByNode, node.nodeId, "xlogWritePosition")) - numeric(valueFor(runInfoByNode, node.nodeId, "xlogCheckpointPosition")))) : "—" }}</td>
                <td class="px-3 py-2">{{ availability.runInfo ? valueFor(runInfoByNode, node.nodeId, "freeStores") : "—" }}</td>
                <td class="px-3 py-2 text-muted-foreground">{{ node.bootTime || "—" }}</td>
              </tr>
              <tr v-if="!loading && nodes.length === 0">
                <td colspan="11" class="px-3 py-10 text-center text-muted-foreground">{{ t("xuguServerDashboard.emptyNodes") }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>

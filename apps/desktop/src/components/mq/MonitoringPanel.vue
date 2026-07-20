<script setup lang="ts">
import { formatError } from "@/lib/backend/errorUtils";
import { computed, ref, watch, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import VChart from "vue-echarts";
import { Activity, AlertTriangle, BarChart3, Boxes, CheckCircle2, Database, Download, Gauge, Hash, HardDrive, Layers3, Loader2, Package, RadioTower, RefreshCw, Send, ShieldCheck, Table2, Upload, Users } from "@lucide/vue";
import type { MqSystemKind, TopicRef, TopicInfo, TopicStats, BacklogStats, PeekedMessage } from "@/types/mq";
import { mqGetTopicStats, mqGetBacklog, mqPeekMessages } from "@/lib/backend/api";

use([CanvasRenderer, LineChart, GridComponent, LegendComponent, TooltipComponent]);

interface Props {
  connectionId: string;
  topic?: TopicInfo;
  tenant?: string;
  namespace?: string;
  mqSystemKind?: MqSystemKind;
}

interface MetricPoint {
  time: string;
  msgRateIn: number;
  msgRateOut: number;
  backlogSize: number;
  msgBacklog: number;
  consumerLagMs: number;
}

interface PartitionStatsRow {
  name: string;
  shortName: string;
  msgRateIn: number;
  msgRateOut: number;
  msgThroughputIn: number;
  msgThroughputOut: number;
  backlogSize: number;
  msgBacklog: number;
  storageSize: number;
  producerCount: number;
  subscriptionCount: number;
  raw: Record<string, unknown>;
}

interface RocketMqPartitionStatsRow {
  partition: number;
  brokerName: string;
  beginOffset: number;
  endOffset: number;
  messageCount: number;
}

interface KafkaPartitionStatsRow {
  partition: number;
  beginOffset: number;
  endOffset: number;
  messageCount: number;
  leader: number;
  replicas: number[];
  isr: number[];
}

const props = defineProps<Props>();
const { t } = useI18n();

const stats = ref<TopicStats>();
const backlog = ref<BacklogStats>();
const loading = ref(false);
const error = ref<string>();
const autoRefresh = ref(true);
const refreshInterval = ref(5); // seconds
const selectedPartitionName = ref<string>();
const kafkaMessageSql = ref("");
const kafkaMessageLoading = ref(false);
const kafkaMessageError = ref<string>();
const kafkaMessages = ref<PeekedMessage[]>([]);

let refreshTimer: number | undefined;
const history = ref<MetricPoint[]>([]);
const MAX_HISTORY_POINTS = 60;

const partitionRows = computed(() => extractPartitionRows(stats.value?.raw));
const kafkaPartitionRows = computed(() => extractKafkaPartitionRows(stats.value?.raw));
const rocketMqPartitionRows = computed(() => extractRocketMqPartitionRows(stats.value?.raw));
const isRocketMqStats = computed(() => props.mqSystemKind === "rocketmq" && rocketMqPartitionRows.value.length > 0);
const isKafkaStats = computed(() => props.mqSystemKind === "kafka" && kafkaPartitionRows.value.length > 0);
const rocketMqOverview = computed(() => {
  const raw = objectRecord(stats.value?.raw);
  const rows = rocketMqPartitionRows.value;
  const totalMessages = numberField(raw.totalMessages) ?? rows.reduce((sum, row) => sum + row.messageCount, 0);
  return {
    queueCount: numberField(raw.partitions) ?? rows.length,
    totalMessages,
    brokerCount: new Set(rows.map((row) => row.brokerName).filter(Boolean)).size,
  };
});
const kafkaOverview = computed(() => {
  const raw = objectRecord(stats.value?.raw);
  const rows = kafkaPartitionRows.value;
  const totalMessages = numberField(raw.totalMessages) ?? rows.reduce((sum, row) => sum + row.messageCount, 0);
  const totalBeginOffset = rows.reduce((sum, row) => sum + row.beginOffset, 0);
  const totalEndOffset = rows.reduce((sum, row) => sum + row.endOffset, 0);
  const underReplicatedPartitions = rows.filter((row) => row.replicas.length > 0 && row.isr.length < row.replicas.length).length;
  const offlinePartitions = rows.filter((row) => row.leader < 0).length;
  const healthyPartitions = rows.filter((row) => row.leader >= 0 && (row.replicas.length === 0 || row.isr.length === row.replicas.length)).length;
  return {
    partitionCount: numberField(raw.partitions) ?? rows.length,
    replicationFactor: numberField(raw.replicationFactor) ?? Math.max(0, ...rows.map((row) => row.replicas.length)),
    totalMessages,
    totalBeginOffset,
    totalEndOffset,
    leaderCount: new Set(rows.map((row) => row.leader).filter((leader) => leader >= 0)).size,
    underReplicatedPartitions,
    offlinePartitions,
    healthyPartitions,
  };
});
const selectedPartition = computed(() => partitionRows.value.find((row) => row.name === selectedPartitionName.value) ?? partitionRows.value[0]);
const selectedPartitionPublishers = computed(() => arrayObjects(selectedPartition.value?.raw.publishers));
const selectedPartitionSubscriptions = computed(() => {
  const subscriptions = objectRecord(selectedPartition.value?.raw.subscriptions);
  return Object.entries(subscriptions).map(([name, value]) => {
    const body = objectRecord(value);
    return {
      name,
      type: stringField(body.type),
      msgBacklog: numberField(body.msgBacklog) ?? 0,
      msgRateOut: numberField(body.msgRateOut) ?? 0,
      consumerCount: arrayObjects(body.consumers).length,
    };
  });
});

const rateChartOption = computed(() => ({
  tooltip: { trigger: "axis" },
  legend: { top: 0, data: [t("mqMonitoring.chartLegendIn"), t("mqMonitoring.chartLegendOut")] },
  grid: { left: 48, right: 18, top: 36, bottom: 32 },
  xAxis: { type: "category", boundaryGap: false, data: history.value.map((point) => point.time) },
  yAxis: { type: "value", name: t("mqMonitoring.chartAxisMsgPerSec") },
  series: [
    { name: t("mqMonitoring.chartLegendIn"), type: "line", smooth: true, showSymbol: false, data: history.value.map((point) => point.msgRateIn) },
    { name: t("mqMonitoring.chartLegendOut"), type: "line", smooth: true, showSymbol: false, data: history.value.map((point) => point.msgRateOut) },
  ],
}));

const backlogChartOption = computed(() => ({
  tooltip: { trigger: "axis" },
  legend: { top: 0, data: [t("mqMonitoring.chartLegendMessages"), t("mqMonitoring.chartLegendBytes")] },
  grid: { left: 56, right: 54, top: 36, bottom: 32 },
  xAxis: { type: "category", boundaryGap: false, data: history.value.map((point) => point.time) },
  yAxis: [
    { type: "value", name: t("mqMonitoring.chartAxisMsg") },
    { type: "value", name: t("mqMonitoring.chartAxisBytes") },
  ],
  series: [
    { name: t("mqMonitoring.chartLegendMessages"), type: "line", smooth: true, showSymbol: false, data: history.value.map((point) => point.msgBacklog) },
    { name: t("mqMonitoring.chartLegendBytes"), type: "line", smooth: true, showSymbol: false, yAxisIndex: 1, data: history.value.map((point) => point.backlogSize) },
  ],
}));

const latencyChartOption = computed(() => ({
  tooltip: { trigger: "axis" },
  legend: { top: 0, data: [t("mqMonitoring.chartLegendConsumerLag")] },
  grid: { left: 56, right: 18, top: 36, bottom: 32 },
  xAxis: { type: "category", boundaryGap: false, data: history.value.map((point) => point.time) },
  yAxis: { type: "value", name: t("mqMonitoring.chartAxisMs") },
  series: [{ name: t("mqMonitoring.chartLegendConsumerLag"), type: "line", smooth: true, showSymbol: false, data: history.value.map((point) => point.consumerLagMs) }],
}));

function getTopicRef(): TopicRef | null {
  if (!props.topic || !props.tenant || !props.namespace) return null;
  return {
    tenant: props.tenant,
    namespace: props.namespace,
    topic: props.topic.shortName,
    persistent: props.topic.persistent,
    partitioned: props.topic.partitioned,
  };
}

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

async function loadStats(options: { skipWhenHidden?: boolean } = {}) {
  if (options.skipWhenHidden && isDocumentHidden()) return;
  const topicRef = getTopicRef();
  if (!topicRef) {
    stats.value = undefined;
    backlog.value = undefined;
    history.value = [];
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    const statsData = await mqGetTopicStats(props.connectionId, topicRef);

    if (props.mqSystemKind === "rocketmq" || (props.mqSystemKind === "kafka" && isKafkaStatsPayload(statsData.raw))) {
      stats.value = statsData;
      backlog.value = undefined;
      appendHistoryPoint(statsData);
      return;
    }

    const backlogData = await mqGetBacklog(props.connectionId, topicRef, undefined);
    stats.value = statsData;
    backlog.value = backlogData;
    appendHistoryPoint(statsData, backlogData);
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function refreshNow() {
  void loadStats();
}

function defaultKafkaMessageSql(): string {
  const topic = props.topic?.shortName;
  return topic ? `SELECT * FROM "${topic}" LIMIT 20` : "";
}

function parseKafkaMessageSql(sql: string): { topic: string; partition?: number; offset?: number; limit: number } {
  const match = sql.trim().match(/^\s*select\s+\*\s+from\s+(?:"([^"]+)"|`([^`]+)`|'([^']+)'|([^\s;]+))(?:\s+partition\s+(\d+))?(?:\s+offset\s+(\d+))?(?:\s+limit\s+(\d+))?\s*;?\s*$/i);
  if (!match) {
    throw new Error(t("mqMonitoring.sqlSyntaxError"));
  }
  const topic = match[1] || match[2] || match[3] || match[4] || "";
  const partition = match[5] != null ? Math.max(0, Number(match[5])) : undefined;
  const offset = match[6] != null ? Math.max(0, Number(match[6])) : undefined;
  const limit = Math.max(1, Math.min(100, Number(match[7] ?? 20)));
  return { topic, partition, offset, limit };
}

function flatMqMonitorGroupName(): string {
  if (props.mqSystemKind === "rocketmq") return "__dbx_rocketmq_monitor__";
  return "__dbx_kafka_monitor__";
}

async function runKafkaMessageSql() {
  if (!props.tenant || !props.namespace) return;
  kafkaMessageLoading.value = true;
  kafkaMessageError.value = undefined;
  try {
    const parsed = parseKafkaMessageSql(kafkaMessageSql.value);
    const selected = props.topic && parsed.topic === props.topic.shortName ? props.topic : undefined;
    const options: { partition?: number; offset?: number } = {};
    if (parsed.partition != null) options.partition = parsed.partition;
    if (parsed.offset != null) options.offset = parsed.offset;
    kafkaMessages.value = await mqPeekMessages(
      props.connectionId,
      {
        tenant: props.tenant,
        namespace: props.namespace,
        topic: parsed.topic,
        persistent: selected?.persistent ?? true,
        partitioned: selected?.partitioned,
      },
      flatMqMonitorGroupName(),
      parsed.limit,
      options,
    );
  } catch (e: unknown) {
    kafkaMessageError.value = formatError(e);
  } finally {
    kafkaMessageLoading.value = false;
  }
}

function kafkaMessagePayload(message: PeekedMessage): string {
  return message.payloadText ?? message.payloadBase64;
}

function formatKafkaMessageTimestamp(value?: string): string {
  if (!value) return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return new Date(numeric).toLocaleString();
}

function appendHistoryPoint(statsData: TopicStats, backlogData?: BacklogStats) {
  const point: MetricPoint = {
    time: new Date().toLocaleTimeString(),
    msgRateIn: statsData.msgRateIn,
    msgRateOut: statsData.msgRateOut,
    backlogSize: statsData.backlogSize,
    msgBacklog: backlogData?.msgBacklog ?? 0,
    consumerLagMs: extractConsumerLagMs(statsData.raw),
  };
  history.value = [...history.value.slice(-(MAX_HISTORY_POINTS - 1)), point];
}

function extractConsumerLagMs(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 0;
  const subscriptions = (raw as { subscriptions?: unknown }).subscriptions;
  if (!subscriptions || typeof subscriptions !== "object") return 0;
  const now = Date.now();
  let maxLag = 0;
  for (const subscription of Object.values(subscriptions as Record<string, unknown>)) {
    if (!subscription || typeof subscription !== "object") continue;
    const data = subscription as Record<string, unknown>;
    const timestamp = numberField(data.lastAckedTimestamp) ?? numberField(data.lastConsumedTimestamp) ?? numberField(data.lastMarkDeleteAdvancedTimestamp);
    if (timestamp && timestamp > 0 && timestamp <= now) {
      maxLag = Math.max(maxLag, now - timestamp);
    }
  }
  return maxLag;
}

function extractPartitionRows(raw: unknown): PartitionStatsRow[] {
  const root = objectRecord(raw);
  const partitions = objectRecord(root.partitions);
  return Object.entries(partitions).map(([name, value]) => {
    const body = objectRecord(value);
    return {
      name,
      shortName: partitionShortName(name),
      msgRateIn: numberField(body.msgRateIn) ?? 0,
      msgRateOut: numberField(body.msgRateOut) ?? 0,
      msgThroughputIn: numberField(body.msgThroughputIn) ?? 0,
      msgThroughputOut: numberField(body.msgThroughputOut) ?? 0,
      backlogSize: numberField(body.backlogSize) ?? 0,
      msgBacklog: partitionBacklogMessages(body),
      storageSize: numberField(body.storageSize) ?? 0,
      producerCount: arrayObjects(body.publishers).length,
      subscriptionCount: Object.keys(objectRecord(body.subscriptions)).length,
      raw: body,
    };
  });
}

function extractRocketMqPartitionRows(raw: unknown): RocketMqPartitionStatsRow[] {
  return arrayObjects(objectRecord(raw).partitionStats)
    .map((body) => ({
      partition: numberField(body.partition) ?? 0,
      brokerName: stringField(body.brokerName),
      beginOffset: numberField(body.beginOffset) ?? 0,
      endOffset: numberField(body.endOffset) ?? 0,
      messageCount: numberField(body.messageCount) ?? 0,
    }))
    .sort((a, b) => a.partition - b.partition || a.brokerName.localeCompare(b.brokerName));
}

function extractKafkaPartitionRows(raw: unknown): KafkaPartitionStatsRow[] {
  return arrayObjects(objectRecord(raw).partitionStats)
    .map((body) => ({
      partition: numberField(body.partition) ?? 0,
      beginOffset: numberField(body.beginOffset) ?? 0,
      endOffset: numberField(body.endOffset) ?? 0,
      messageCount: numberField(body.messageCount) ?? 0,
      leader: numberField(body.leader) ?? -1,
      replicas: numberArrayField(body.replicas),
      isr: numberArrayField(body.isr),
    }))
    .sort((a, b) => a.partition - b.partition);
}

function isKafkaStatsPayload(raw: unknown): boolean {
  if (props.mqSystemKind === "rocketmq") return false;
  const root = objectRecord(raw);
  return Array.isArray(root.partitionStats) || (numberField(root.partitions) !== undefined && numberField(root.replicationFactor) !== undefined && numberField(root.totalMessages) !== undefined);
}

function isKafkaPartitionHealthy(row: KafkaPartitionStatsRow): boolean {
  return row.leader >= 0 && (row.replicas.length === 0 || row.isr.length >= row.replicas.length);
}

function kafkaPartitionStatusLabel(row: KafkaPartitionStatsRow): string {
  if (row.leader < 0) return t("mqMonitoring.statusNoLeader");
  if (row.replicas.length > 0 && row.isr.length < row.replicas.length) return t("mqMonitoring.statusIsrIncomplete");
  return t("mqMonitoring.statusHealthy");
}

function partitionBacklogMessages(body: Record<string, unknown>): number {
  const direct = numberField(body.msgBacklog);
  if (direct !== undefined) return direct;
  return Object.values(objectRecord(body.subscriptions)).reduce<number>((sum, value) => {
    return sum + (numberField(objectRecord(value).msgBacklog) ?? 0);
  }, 0);
}

function partitionShortName(name: string): string {
  const path = name.includes("://") ? name.split("://", 2)[1] || name : name;
  return path.split("/").slice(-1)[0] || name;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberArrayField(value: unknown): number[] {
  return Array.isArray(value) ? value.map(numberField).filter((item): item is number => item !== undefined) : [];
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (autoRefresh.value && props.topic && !isDocumentHidden()) {
    refreshTimer = window.setInterval(() => {
      void loadStats({ skipWhenHidden: true });
    }, refreshInterval.value * 1000);
  }
}

function stopAutoRefresh() {
  if (refreshTimer !== undefined) {
    clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

function handleVisibilityChange() {
  if (isDocumentHidden()) {
    stopAutoRefresh();
    return;
  }
  startAutoRefresh();
  void loadStats();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

function formatNumber(num: number): string {
  return num.toLocaleString();
}

watch(
  () => props.topic,
  () => {
    history.value = [];
    selectedPartitionName.value = undefined;
    kafkaMessageSql.value = defaultKafkaMessageSql();
    kafkaMessageError.value = undefined;
    kafkaMessages.value = [];
    void loadStats();
    startAutoRefresh();
  },
  { immediate: true },
);

watch(partitionRows, (rows) => {
  if (!rows.length) {
    selectedPartitionName.value = undefined;
    return;
  }
  if (!selectedPartitionName.value || !rows.some((row) => row.name === selectedPartitionName.value)) {
    selectedPartitionName.value = rows[0].name;
  }
});

watch(autoRefresh, () => {
  startAutoRefresh();
});

watch(refreshInterval, () => {
  if (autoRefresh.value) {
    startAutoRefresh();
  }
});

onMounted(() => {
  document.addEventListener("visibilitychange", handleVisibilityChange);
  startAutoRefresh();
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  stopAutoRefresh();
});
</script>

<template>
  <div class="monitoring-panel">
    <div class="panel-toolbar">
      <h3>{{ t("mqMonitoring.title") }}</h3>
      <div class="toolbar-actions">
        <label class="checkbox-label">
          <input type="checkbox" v-model="autoRefresh" />
          <span>{{ t("mqMonitoring.autoRefresh") }}</span>
        </label>
        <select v-model.number="refreshInterval" :disabled="!autoRefresh" class="refresh-interval">
          <option :value="5">{{ t("mqMonitoring.refreshInterval5s") }}</option>
          <option :value="10">{{ t("mqMonitoring.refreshInterval10s") }}</option>
          <option :value="30">{{ t("mqMonitoring.refreshInterval30s") }}</option>
          <option :value="60">{{ t("mqMonitoring.refreshInterval60s") }}</option>
        </select>
        <button @click="refreshNow" :disabled="loading" class="btn-sm">
          <Loader2 v-if="loading" class="btn-icon spinning" :size="14" />
          <RefreshCw v-else class="btn-icon" :size="14" />
          <span>{{ loading ? t("mqMonitoring.refreshing") : t("mqMonitoring.refreshNow") }}</span>
        </button>
      </div>
    </div>

    <div v-if="!topic" class="panel-placeholder">
      <Table2 :size="24" />
      <span>{{ t("mqMonitoring.selectTopicFirst") }}</span>
    </div>

    <div v-else-if="error" class="panel-error">
      <AlertTriangle :size="18" />
      <span>{{ error }}</span>
    </div>

    <div v-else-if="loading && !stats" class="panel-loading">
      <Loader2 class="loading-icon spinning" :size="22" />
      <span>{{ t("mqMonitoring.loadingStats") }}</span>
      <div class="loading-skeleton-grid" aria-hidden="true">
        <div v-for="item in 4" :key="item" class="loading-skeleton-card"></div>
      </div>
    </div>

    <div v-else-if="stats && isRocketMqStats" class="stats-container">
      <div class="stats-section">
        <h4>{{ t("mqMonitoring.rocketmqTopicOverview") }}</h4>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon"><Layers3 :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.queueCount") }}</div>
              <div class="stat-value">{{ rocketMqOverview.queueCount }}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon"><Hash :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.messageCount") }}</div>
              <div class="stat-value">{{ formatNumber(rocketMqOverview.totalMessages) }}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon"><HardDrive :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.brokerCount") }}</div>
              <div class="stat-value">{{ rocketMqOverview.brokerCount }}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="stats-section">
        <h4>{{ t("mqMonitoring.rocketmqQueueDetails") }}</h4>
        <div v-if="rocketMqPartitionRows.length" class="partition-table-wrap">
          <table class="partition-table">
            <thead>
              <tr>
                <th>{{ t("mqMonitoring.tableQueue") }}</th>
                <th>{{ t("mqMonitoring.tableBroker") }}</th>
                <th>{{ t("mqMonitoring.tableBeginOffset") }}</th>
                <th>{{ t("mqMonitoring.tableLogEndOffset") }}</th>
                <th>{{ t("mqMonitoring.tableMessageCount") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rocketMqPartitionRows" :key="`${row.brokerName}-${row.partition}`">
                <td>{{ row.partition }}</td>
                <td>{{ row.brokerName || "-" }}</td>
                <td>{{ formatNumber(row.beginOffset) }}</td>
                <td>{{ formatNumber(row.endOffset) }}</td>
                <td>{{ formatNumber(row.messageCount) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty-state compact">{{ t("mqMonitoring.noRocketMqQueueMetrics") }}</div>
      </div>
    </div>

    <div v-else-if="stats && isKafkaStats" class="stats-container">
      <div class="stats-section">
        <h4>{{ t("mqMonitoring.kafkaTopicOverview") }}</h4>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon"><Layers3 :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.partitionCount") }}</div>
              <div class="stat-value">{{ kafkaOverview.partitionCount }}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon"><Boxes :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.replicationFactor") }}</div>
              <div class="stat-value">{{ kafkaOverview.replicationFactor }}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon"><Hash :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.messageCount") }}</div>
              <div class="stat-value">{{ formatNumber(kafkaOverview.totalMessages) }}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon"><BarChart3 :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.logEndOffset") }}</div>
              <div class="stat-value">{{ formatNumber(kafkaOverview.totalEndOffset) }}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="stats-section">
        <h4>{{ t("mqMonitoring.offsetAndReplicaStatus") }}</h4>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon"><Gauge :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.beginOffset") }}</div>
              <div class="stat-value">{{ formatNumber(kafkaOverview.totalBeginOffset) }}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon"><RadioTower :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.leaderCount") }}</div>
              <div class="stat-value">{{ kafkaOverview.leaderCount }}</div>
            </div>
          </div>
          <div class="stat-card" :class="{ warning: kafkaOverview.underReplicatedPartitions > 0 }">
            <div class="stat-icon"><ShieldCheck :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.isrHealthyPartitions") }}</div>
              <div class="stat-value">{{ kafkaOverview.healthyPartitions }} / {{ kafkaOverview.partitionCount }}</div>
            </div>
          </div>
          <div class="stat-card" :class="{ warning: kafkaOverview.offlinePartitions > 0 }">
            <div class="stat-icon"><AlertTriangle :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.noLeaderPartitions") }}</div>
              <div class="stat-value">{{ kafkaOverview.offlinePartitions }}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="stats-section">
        <h4>{{ t("mqMonitoring.kafkaPartitionDetails") }}</h4>
        <div v-if="kafkaPartitionRows.length" class="partition-layout">
          <div class="partition-table-wrap">
            <table class="partition-table">
              <thead>
                <tr>
                  <th>{{ t("mqMonitoring.tablePartition") }}</th>
                  <th>{{ t("mqMonitoring.tableBeginOffset") }}</th>
                  <th>{{ t("mqMonitoring.tableLogEndOffset") }}</th>
                  <th>{{ t("mqMonitoring.tableMessageCount") }}</th>
                  <th>{{ t("mqMonitoring.tableLeader") }}</th>
                  <th>{{ t("mqMonitoring.tableReplicas") }}</th>
                  <th>{{ t("mqMonitoring.tableIsr") }}</th>
                  <th>{{ t("mqMonitoring.tableStatus") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="partition in kafkaPartitionRows" :key="partition.partition" :class="{ warning: partition.leader < 0 || (partition.replicas.length > 0 && partition.isr.length < partition.replicas.length) }">
                  <td>{{ partition.partition }}</td>
                  <td>{{ formatNumber(partition.beginOffset) }}</td>
                  <td>{{ formatNumber(partition.endOffset) }}</td>
                  <td>{{ formatNumber(partition.messageCount) }}</td>
                  <td>{{ partition.leader >= 0 ? partition.leader : "-" }}</td>
                  <td>{{ partition.replicas.join(", ") || "-" }}</td>
                  <td>{{ partition.isr.join(", ") || "-" }}</td>
                  <td>
                    <span :class="['table-status', isKafkaPartitionHealthy(partition) ? 'healthy' : 'warning']">
                      {{ kafkaPartitionStatusLabel(partition) }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div v-else class="empty-state compact">{{ t("mqMonitoring.noKafkaPartitionMetrics") }}</div>
      </div>

      <div class="stats-section">
        <div class="section-title-row">
          <h4>{{ t("mqMonitoring.kafkaMessageQuery") }}</h4>
          <button type="button" class="btn-sm" :disabled="kafkaMessageLoading || !kafkaMessageSql.trim()" @click="runKafkaMessageSql">
            <Loader2 v-if="kafkaMessageLoading" class="btn-icon spinning" :size="14" />
            <span>{{ kafkaMessageLoading ? t("mqMonitoring.querying") : t("mqMonitoring.queryMessages") }}</span>
          </button>
        </div>
        <textarea v-model="kafkaMessageSql" class="kafka-sql-input" rows="2" spellcheck="false" />
        <div class="query-hint">{{ t("mqMonitoring.queryHint") }}</div>
        <div v-if="kafkaMessageError" class="panel-error inline-error">
          <AlertTriangle :size="16" />
          <span>{{ kafkaMessageError }}</span>
        </div>
        <div v-else-if="kafkaMessageLoading" class="empty-state compact">{{ t("mqMonitoring.messagesLoading") }}</div>
        <div v-else-if="!kafkaMessages.length" class="empty-state compact">{{ t("mqMonitoring.noMessages") }}</div>
        <div v-else class="kafka-message-list">
          <article v-for="message in kafkaMessages" :key="`${message.properties?.partition ?? 'p'}-${message.messageId || message.position}`" class="kafka-message-row">
            <div class="kafka-message-meta">
              <span>#{{ message.position }}</span>
              <span v-if="message.properties?.partition != null">{{ t("mqMonitoring.metaPartition", { partition: message.properties.partition }) }}</span>
              <span>{{ t("mqMonitoring.metaOffset", { offset: message.messageId || "-" }) }}</span>
              <span v-if="message.key">{{ t("mqMonitoring.metaKey", { key: message.key }) }}</span>
              <span>{{ formatKafkaMessageTimestamp(message.publishTime) }}</span>
            </div>
            <pre class="kafka-message-payload">{{ kafkaMessagePayload(message) }}</pre>
            <div v-if="Object.keys(message.headers || {}).length" class="kafka-message-headers">
              <span v-for="(value, key) in message.headers" :key="key">{{ key }}: {{ value }}</span>
            </div>
          </article>
        </div>
      </div>
    </div>

    <div v-else-if="stats" class="stats-container">
      <!-- Overview Section -->
      <div class="stats-section">
        <h4>{{ t("mqMonitoring.messageRate") }}</h4>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon"><Download :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.inboundRate") }}</div>
              <div class="stat-value">{{ stats.msgRateIn.toFixed(2) }} msg/s</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon"><Upload :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.outboundRate") }}</div>
              <div class="stat-value">{{ stats.msgRateOut.toFixed(2) }} msg/s</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon"><Activity :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.inboundThroughput") }}</div>
              <div class="stat-value">{{ formatBytes(stats.msgThroughputIn) }}/s</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon"><BarChart3 :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.outboundThroughput") }}</div>
              <div class="stat-value">{{ formatBytes(stats.msgThroughputOut) }}/s</div>
            </div>
          </div>
        </div>
      </div>

      <div class="charts-grid">
        <div class="chart-panel">
          <h4>{{ t("mqMonitoring.rateTrend") }}</h4>
          <VChart :option="rateChartOption" autoresize class="trend-chart" />
        </div>
        <div class="chart-panel">
          <h4>{{ t("mqMonitoring.backlogTrend") }}</h4>
          <VChart :option="backlogChartOption" autoresize class="trend-chart" />
        </div>
        <div class="chart-panel">
          <h4>{{ t("mqMonitoring.consumerLag") }}</h4>
          <VChart :option="latencyChartOption" autoresize class="trend-chart" />
        </div>
      </div>

      <!-- Storage Section -->
      <div class="stats-section">
        <h4>{{ t("mqMonitoring.storageAndBacklog") }}</h4>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon"><Database :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.storageSize") }}</div>
              <div class="stat-value">{{ formatBytes(stats.storageSize) }}</div>
            </div>
          </div>
          <div class="stat-card" :class="{ warning: stats.backlogSize > 10 * 1024 * 1024 }">
            <div class="stat-icon"><Package :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.backlogSize") }}</div>
              <div class="stat-value">{{ formatBytes(stats.backlogSize) }}</div>
            </div>
          </div>
          <div class="stat-card" v-if="backlog">
            <div class="stat-icon"><HardDrive :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.backlogMessageCount") }}</div>
              <div class="stat-value">{{ formatNumber(backlog.msgBacklog) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Counters Section -->
      <div class="stats-section">
        <h4>{{ t("mqMonitoring.messageCounters") }}</h4>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon"><Send :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.publishedMessages") }}</div>
              <div class="stat-value">{{ formatNumber(stats.msgInCounter) }}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon"><CheckCircle2 :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.consumedMessages") }}</div>
              <div class="stat-value">{{ formatNumber(stats.msgOutCounter) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Connections Section -->
      <div class="stats-section">
        <h4>{{ t("mqMonitoring.connectionStats") }}</h4>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon"><Users :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.subscriptionCount") }}</div>
              <div class="stat-value">{{ stats.subscriptionCount }}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon"><RadioTower :size="21" /></div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqMonitoring.producerCount") }}</div>
              <div class="stat-value">{{ stats.producerCount }}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="stats-section">
        <h4>{{ t("mqMonitoring.partitionDetails") }}</h4>
        <div v-if="partitionRows.length" class="partition-layout">
          <div class="partition-table-wrap">
            <table class="partition-table interactive-table">
              <thead>
                <tr>
                  <th>{{ t("mqMonitoring.tablePartition") }}</th>
                  <th>{{ t("mqMonitoring.tableInbound") }}</th>
                  <th>{{ t("mqMonitoring.tableOutbound") }}</th>
                  <th>{{ t("mqMonitoring.tableInboundThroughput") }}</th>
                  <th>{{ t("mqMonitoring.tableOutboundThroughput") }}</th>
                  <th>{{ t("mqMonitoring.tableBacklogMessages") }}</th>
                  <th>{{ t("mqMonitoring.tableBacklogSize") }}</th>
                  <th>{{ t("mqMonitoring.tableProducers") }}</th>
                  <th>{{ t("mqMonitoring.tableSubscriptions") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="partition in partitionRows" :key="partition.name" :class="{ selected: selectedPartition?.name === partition.name }" @click="selectedPartitionName = partition.name">
                  <td :title="partition.name">{{ partition.shortName }}</td>
                  <td>{{ partition.msgRateIn.toFixed(2) }} msg/s</td>
                  <td>{{ partition.msgRateOut.toFixed(2) }} msg/s</td>
                  <td>{{ formatBytes(partition.msgThroughputIn) }}/s</td>
                  <td>{{ formatBytes(partition.msgThroughputOut) }}/s</td>
                  <td>{{ formatNumber(partition.msgBacklog) }}</td>
                  <td>{{ formatBytes(partition.backlogSize) }}</td>
                  <td>{{ partition.producerCount }}</td>
                  <td>{{ partition.subscriptionCount }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div v-if="selectedPartition" class="partition-detail">
            <h5>{{ selectedPartition.shortName }}</h5>
            <div class="detail-grid">
              <div>
                <div class="detail-title">{{ t("mqMonitoring.producers") }}</div>
                <table v-if="selectedPartitionPublishers.length" class="detail-table">
                  <thead>
                    <tr>
                      <th>{{ t("mqMonitoring.tableName") }}</th>
                      <th>{{ t("mqMonitoring.tableRate") }}</th>
                      <th>{{ t("mqMonitoring.tableAddress") }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="publisher in selectedPartitionPublishers" :key="String(publisher.producerName ?? publisher.producerId ?? publisher.address)">
                      <td>{{ publisher.producerName || publisher.producerId || "-" }}</td>
                      <td>{{ (numberField(publisher.msgRateIn) ?? 0).toFixed(2) }} msg/s</td>
                      <td>{{ publisher.address || "-" }}</td>
                    </tr>
                  </tbody>
                </table>
                <div v-else class="empty-state compact">{{ t("mqMonitoring.noProducers") }}</div>
              </div>
              <div>
                <div class="detail-title">{{ t("mqMonitoring.subscriptions") }}</div>
                <table v-if="selectedPartitionSubscriptions.length" class="detail-table">
                  <thead>
                    <tr>
                      <th>{{ t("mqMonitoring.tableName") }}</th>
                      <th>{{ t("mqMonitoring.tableType") }}</th>
                      <th>{{ t("mqMonitoring.tableBacklog") }}</th>
                      <th>{{ t("mqMonitoring.tableConsumers") }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="subscription in selectedPartitionSubscriptions" :key="subscription.name">
                      <td>{{ subscription.name }}</td>
                      <td>{{ subscription.type || "-" }}</td>
                      <td>{{ formatNumber(subscription.msgBacklog) }}</td>
                      <td>{{ subscription.consumerCount }}</td>
                    </tr>
                  </tbody>
                </table>
                <div v-else class="empty-state compact">{{ t("mqMonitoring.noSubscriptions") }}</div>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="empty-state compact">
          {{ topic.partitioned ? t("mqMonitoring.noPartitionMetricsFromBroker") : t("mqMonitoring.nonPartitionedTopicNoDetails") }}
        </div>
      </div>

      <!-- Health Indicators -->
      <div class="stats-section">
        <h4>{{ t("mqMonitoring.healthIndicators") }}</h4>
        <div class="health-indicators">
          <div class="health-item">
            <span class="health-label">{{ t("mqMonitoring.messageFlow") }}:</span>
            <span :class="['health-badge', stats.msgRateIn > 0 || stats.msgRateOut > 0 ? 'healthy' : 'idle']">
              {{ stats.msgRateIn > 0 || stats.msgRateOut > 0 ? t("mqMonitoring.flowActive") : t("mqMonitoring.flowIdle") }}
            </span>
          </div>
          <div class="health-item">
            <span class="health-label">{{ t("mqMonitoring.backlogStatus") }}:</span>
            <span :class="['health-badge', stats.backlogSize < 10 * 1024 * 1024 ? 'healthy' : 'warning']">
              {{ stats.backlogSize < 10 * 1024 * 1024 ? t("mqMonitoring.backlogNormal") : t("mqMonitoring.backlogHigh") }}
            </span>
          </div>
          <div class="health-item">
            <span class="health-label">{{ t("mqMonitoring.producersLabel") }}:</span>
            <span :class="['health-badge', stats.producerCount > 0 ? 'healthy' : 'idle']">
              {{ stats.producerCount > 0 ? t("mqMonitoring.producerConnected") : t("mqMonitoring.producerDisconnected") }}
            </span>
          </div>
          <div class="health-item">
            <span class="health-label">{{ t("mqMonitoring.subscriptionsLabel") }}:</span>
            <span :class="['health-badge', stats.subscriptionCount > 0 ? 'healthy' : 'idle']">
              {{ stats.subscriptionCount > 0 ? t("mqMonitoring.subscriptionActive") : t("mqMonitoring.subscriptionNone") }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.monitoring-panel {
  --monitor-panel-bg: color-mix(in srgb, var(--color-background, #ffffff) 94%, var(--color-muted, #f5f5f5));
  --monitor-surface: var(--color-background-secondary, var(--color-card, #ffffff));
  --monitor-surface-raised: color-mix(in srgb, var(--monitor-surface) 96%, var(--monitor-accent) 4%);
  --monitor-border: color-mix(in srgb, var(--color-border, #e5e7eb) 76%, transparent);
  --monitor-border-strong: color-mix(in srgb, var(--color-border, #d4d4d8) 88%, var(--monitor-accent) 12%);
  --monitor-text: var(--color-text, var(--color-foreground, #18181b));
  --monitor-muted: var(--color-text-secondary, var(--color-muted-foreground, #64748b));
  --monitor-faint: var(--color-text-tertiary, color-mix(in srgb, var(--monitor-muted) 72%, transparent));
  --monitor-hover: color-mix(in srgb, var(--color-hover, var(--color-muted, #f4f4f5)) 72%, var(--monitor-accent) 7%);
  --monitor-accent: #0f766e;
  --monitor-accent-soft: rgb(15 118 110 / 0.1);
  --monitor-accent-border: rgb(15 118 110 / 0.22);
  --monitor-success: #15803d;
  --monitor-success-soft: rgb(21 128 61 / 0.1);
  --monitor-warning: #b45309;
  --monitor-warning-soft: rgb(180 83 9 / 0.12);
  --monitor-danger: #b91c1c;
  --monitor-danger-soft: rgb(185 28 28 / 0.1);
  --monitor-shadow: 0 18px 38px -28px rgb(15 23 42 / 0.42);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, color-mix(in srgb, var(--monitor-panel-bg) 88%, var(--monitor-accent-soft)) 0%, var(--monitor-panel-bg) 38%), var(--monitor-panel-bg);
  color: var(--monitor-text);
  font-family: var(--font-sans, "Geist Variable", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif);
}

:global(.dark) .monitoring-panel {
  --monitor-panel-bg: color-mix(in srgb, var(--color-background, #131416) 90%, #0f766e 4%);
  --monitor-surface: color-mix(in srgb, var(--color-card, #1b1b1e) 94%, #ffffff 2%);
  --monitor-surface-raised: color-mix(in srgb, var(--monitor-surface) 92%, #0f766e 8%);
  --monitor-border: color-mix(in srgb, var(--color-border, rgb(110 110 114 / 0.28)) 82%, transparent);
  --monitor-border-strong: color-mix(in srgb, var(--monitor-border) 76%, #2dd4bf 24%);
  --monitor-accent: #2dd4bf;
  --monitor-accent-soft: rgb(45 212 191 / 0.12);
  --monitor-accent-border: rgb(45 212 191 / 0.24);
  --monitor-success: #4ade80;
  --monitor-success-soft: rgb(74 222 128 / 0.12);
  --monitor-warning: #f59e0b;
  --monitor-warning-soft: rgb(245 158 11 / 0.14);
  --monitor-danger: #f87171;
  --monitor-danger-soft: rgb(248 113 113 / 0.12);
  --monitor-shadow: 0 18px 42px -28px rgb(0 0 0 / 0.72);
}

.panel-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--monitor-border);
  background: color-mix(in srgb, var(--monitor-surface) 92%, transparent);
  backdrop-filter: blur(10px);
  position: sticky;
  top: 0;
  z-index: 1;
}

.panel-toolbar h3 {
  margin: 0;
  font-size: 18px;
  line-height: 1.3;
  font-weight: 650;
  color: var(--monitor-text);
  text-wrap: balance;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  min-width: 0;
  flex-wrap: wrap;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 5px 9px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--monitor-muted);
  cursor: pointer;
  user-select: none;
  transition:
    background 0.2s ease,
    color 0.2s ease,
    border-color 0.2s ease;
}

.checkbox-label:hover {
  border-color: var(--monitor-border);
  background: var(--monitor-hover);
  color: var(--monitor-text);
}

.checkbox-label input {
  width: 14px;
  height: 14px;
  accent-color: var(--monitor-accent);
}

.refresh-interval {
  min-height: 34px;
  padding: 5px 30px 5px 10px;
  border: 1px solid var(--monitor-border);
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  background: var(--monitor-surface);
  color: var(--monitor-text);
  cursor: pointer;
  outline: none;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    background 0.2s ease;
}

.refresh-interval:hover:not(:disabled) {
  border-color: var(--monitor-border-strong);
}

.refresh-interval:focus-visible {
  border-color: var(--monitor-accent);
  box-shadow: 0 0 0 3px var(--monitor-accent-soft);
}

.refresh-interval:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-sm {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 34px;
  padding: 7px 12px;
  border: 1px solid var(--monitor-border);
  border-radius: 8px;
  background: var(--monitor-surface);
  color: var(--monitor-text);
  cursor: pointer;
  font-size: 13px;
  font-weight: 560;
  line-height: 1;
  white-space: nowrap;
  box-shadow: 0 1px 0 rgb(255 255 255 / 0.55) inset;
  transition:
    transform 0.16s ease,
    background 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}

.btn-sm:hover:not(:disabled) {
  border-color: var(--monitor-border-strong);
  background: var(--monitor-hover);
  box-shadow: var(--monitor-shadow);
  transform: translateY(-1px);
}

.btn-sm:active:not(:disabled) {
  transform: translateY(0) scale(0.98);
}

.btn-sm:focus-visible {
  outline: none;
  border-color: var(--monitor-accent);
  box-shadow: 0 0 0 3px var(--monitor-accent-soft);
}

.btn-sm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  box-shadow: none;
}

.btn-icon {
  flex: 0 0 auto;
  color: var(--monitor-accent);
}

.panel-placeholder,
.panel-error,
.panel-loading,
.empty-state {
  display: grid;
  place-items: center;
  gap: 10px;
  padding: 32px;
  text-align: center;
  color: var(--monitor-muted);
  line-height: 1.5;
}

.panel-error {
  display: flex;
  justify-content: center;
  color: var(--monitor-danger);
  background: var(--monitor-danger-soft);
  border-bottom: 1px solid color-mix(in srgb, var(--monitor-danger) 18%, transparent);
}

.panel-loading {
  align-content: start;
  padding-top: 48px;
}

.loading-icon {
  color: var(--monitor-accent);
}

.spinning {
  animation: monitor-spin 0.9s linear infinite;
}

.loading-skeleton-grid {
  width: min(100%, 920px);
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-top: 12px;
}

.loading-skeleton-card {
  height: 96px;
  border-radius: 8px;
  background: linear-gradient(90deg, transparent, rgb(255 255 255 / 0.45), transparent), var(--monitor-surface);
  background-size: 220% 100%;
  border: 1px solid var(--monitor-border);
  animation: monitor-skeleton 1.3s ease-in-out infinite;
}

.stats-container {
  flex: 1;
  overflow-y: auto;
  width: min(100%, 1480px);
  margin: 0 auto;
  padding: 22px 24px 32px;
  box-sizing: border-box;
}

.stats-section {
  margin-bottom: 28px;
}

.stats-section:last-child {
  margin-bottom: 0;
}

.stats-section h4 {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 0 14px;
  font-size: 14px;
  line-height: 1.35;
  font-weight: 680;
  color: var(--monitor-text);
}

.stats-section h4::before {
  content: "";
  width: 4px;
  height: 16px;
  border-radius: 2px;
  background: var(--monitor-accent);
  box-shadow: 0 0 0 4px var(--monitor-accent-soft);
}

.section-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.section-title-row h4 {
  margin-bottom: 0;
}

.kafka-sql-input {
  width: 100%;
  min-height: 54px;
  padding: 10px 12px;
  border: 1px solid var(--monitor-border);
  border-radius: 8px;
  background: var(--monitor-surface);
  color: var(--monitor-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  resize: vertical;
  box-sizing: border-box;
}

.kafka-sql-input:focus {
  outline: none;
  border-color: var(--monitor-accent);
  box-shadow: 0 0 0 3px var(--monitor-accent-soft);
}

.query-hint {
  margin-top: 6px;
  color: var(--monitor-faint);
  font-size: 12px;
}

.inline-error {
  justify-content: flex-start;
  margin-top: 10px;
  border: 1px solid color-mix(in srgb, var(--monitor-danger) 22%, transparent);
  border-radius: 8px;
  padding: 10px 12px;
}

.kafka-message-list {
  display: grid;
  gap: 10px;
  margin-top: 12px;
}

.kafka-message-row {
  border: 1px solid var(--monitor-border);
  border-radius: 8px;
  background: var(--monitor-surface);
  overflow: hidden;
}

.kafka-message-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--monitor-border);
  color: var(--monitor-muted);
  font-size: 12px;
}

.kafka-message-payload {
  max-height: 220px;
  margin: 0;
  overflow: auto;
  padding: 10px;
  color: var(--monitor-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.kafka-message-headers {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--monitor-border);
  color: var(--monitor-muted);
  font-size: 11px;
}

.charts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 14px;
  margin-bottom: 28px;
}

.chart-panel {
  min-height: 260px;
  padding: 14px;
  border: 1px solid var(--monitor-border);
  border-radius: 8px;
  background: var(--monitor-surface);
  box-shadow: var(--monitor-shadow);
}

.chart-panel h4 {
  margin: 0 0 8px 0;
  font-size: 13px;
  line-height: 1.35;
  font-weight: 650;
  color: var(--monitor-muted);
}

.trend-chart {
  width: 100%;
  height: 220px;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 14px;
}

.stat-card {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  display: flex;
  align-items: center;
  min-height: 96px;
  gap: 14px;
  padding: 17px 18px;
  background: var(--monitor-surface);
  border: 1px solid var(--monitor-border);
  border-radius: 8px;
  box-shadow: 0 1px 0 rgb(255 255 255 / 0.52) inset;
  transition:
    transform 0.22s cubic-bezier(0.16, 1, 0.3, 1),
    border-color 0.22s ease,
    box-shadow 0.22s ease,
    background 0.22s ease;
}

.stat-card::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--monitor-accent);
  opacity: 0.75;
  z-index: 0;
}

.stat-card::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, var(--monitor-accent-soft), transparent 42%);
  opacity: 0.45;
  pointer-events: none;
  z-index: 0;
}

.stat-card:hover {
  transform: translateY(-2px);
  border-color: var(--monitor-accent-border);
  background: var(--monitor-surface-raised);
  box-shadow: var(--monitor-shadow);
}

.stat-card.warning {
  border-color: color-mix(in srgb, var(--monitor-warning) 34%, transparent);
  background: color-mix(in srgb, var(--monitor-surface) 86%, var(--monitor-warning-soft));
}

.stat-card.warning::before {
  background: var(--monitor-warning);
}

.stat-card.warning .stat-icon {
  color: var(--monitor-warning);
  background: var(--monitor-warning-soft);
  border-color: color-mix(in srgb, var(--monitor-warning) 24%, transparent);
}

.stat-icon {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
  border: 1px solid var(--monitor-accent-border);
  border-radius: 8px;
  background: var(--monitor-accent-soft);
  color: var(--monitor-accent);
}

.stat-content {
  position: relative;
  z-index: 1;
  flex: 1;
  min-width: 0;
}

.stat-label {
  margin-bottom: 6px;
  font-size: 12px;
  line-height: 1.3;
  font-weight: 560;
  color: var(--monitor-muted);
  text-wrap: pretty;
}

.stat-value {
  font-family: "Geist Variable Tabular", var(--font-sans, system-ui, sans-serif);
  font-size: 23px;
  line-height: 1.1;
  font-weight: 720;
  color: var(--monitor-text);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0;
}

.health-indicators {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.partition-layout {
  display: grid;
  gap: 14px;
}

.partition-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--monitor-border);
  border-radius: 8px;
  background: var(--monitor-surface);
  box-shadow: var(--monitor-shadow);
}

.partition-table,
.detail-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
}

.partition-table {
  min-width: 860px;
}

.detail-table {
  min-width: 0;
}

.partition-table th,
.partition-table td,
.detail-table th,
.detail-table td {
  padding: 11px 14px;
  border-bottom: 1px solid var(--monitor-border);
  text-align: left;
  white-space: nowrap;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--monitor-text);
  font-variant-numeric: tabular-nums;
}

.partition-table th,
.detail-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: color-mix(in srgb, var(--monitor-surface) 86%, var(--monitor-panel-bg));
  color: var(--monitor-muted);
  font-size: 12px;
  font-weight: 680;
}

.partition-table tbody tr:last-child td,
.detail-table tbody tr:last-child td {
  border-bottom: none;
}

.partition-table tbody tr {
  transition:
    background 0.18s ease,
    color 0.18s ease;
}

.partition-table.interactive-table tbody tr {
  cursor: pointer;
}

.partition-table tbody tr:hover,
.partition-table tbody tr.selected {
  background: var(--monitor-hover);
}

.partition-table tbody tr:nth-child(even):not(.selected):not(.warning) {
  background: color-mix(in srgb, var(--monitor-surface) 90%, var(--monitor-panel-bg));
}

.partition-table tbody tr.warning {
  background: var(--monitor-warning-soft);
}

.table-status {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 3px 9px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 650;
  line-height: 1;
}

.table-status.healthy {
  color: var(--monitor-success);
  background: var(--monitor-success-soft);
}

.table-status.warning {
  color: var(--monitor-warning);
  background: var(--monitor-warning-soft);
}

.partition-detail {
  padding: 14px;
  border: 1px solid var(--monitor-border);
  border-radius: 8px;
  background: var(--monitor-surface);
  box-shadow: var(--monitor-shadow);
}

.partition-detail h5 {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.4;
  font-weight: 680;
  color: var(--monitor-text);
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}

.detail-title {
  margin-bottom: 8px;
  color: var(--monitor-muted);
  font-size: 12px;
  font-weight: 650;
}

.empty-state.compact {
  padding: 16px;
  border: 1px dashed var(--monitor-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--monitor-surface) 74%, transparent);
}

.health-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 13px 15px;
  background: var(--monitor-surface);
  border: 1px solid var(--monitor-border);
  border-radius: 8px;
  box-shadow: 0 1px 0 rgb(255 255 255 / 0.48) inset;
}

.health-label {
  font-size: 13px;
  line-height: 1.35;
  color: var(--monitor-muted);
  font-weight: 560;
}

.health-badge {
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 4px 10px;
  border-radius: 7px;
  font-size: 12px;
  font-weight: 650;
  white-space: nowrap;
}

.health-badge.healthy {
  background: var(--monitor-success-soft);
  color: var(--monitor-success);
}

.health-badge.warning {
  background: var(--monitor-warning-soft);
  color: var(--monitor-warning);
}

.health-badge.idle {
  background: color-mix(in srgb, var(--monitor-muted) 12%, transparent);
  color: var(--monitor-muted);
}

@keyframes monitor-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes monitor-skeleton {
  0% {
    background-position: 120% 0;
  }
  100% {
    background-position: -120% 0;
  }
}

@media (max-width: 900px) {
  .panel-toolbar {
    align-items: flex-start;
    flex-direction: column;
  }

  .toolbar-actions {
    justify-content: flex-start;
    width: 100%;
  }

  .stats-container {
    padding: 18px 16px 26px;
  }

  .loading-skeleton-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .stats-grid,
  .charts-grid,
  .health-indicators,
  .loading-skeleton-grid {
    grid-template-columns: 1fr;
  }

  .stat-card {
    min-height: 84px;
  }
}
</style>

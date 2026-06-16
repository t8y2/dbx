<script setup lang="ts">
import { formatError } from "@/lib/errorUtils";
import { computed, ref, watch, onMounted, onUnmounted } from "vue";
import { use } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import VChart from "vue-echarts";
import type { TopicRef, TopicInfo, TopicStats, BacklogStats } from "@/types/mq";
import { mqGetTopicStats, mqGetBacklog } from "@/lib/api";

use([CanvasRenderer, LineChart, GridComponent, LegendComponent, TooltipComponent]);

interface Props {
  connectionId: string;
  topic?: TopicInfo;
  tenant?: string;
  namespace?: string;
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

const props = defineProps<Props>();

const stats = ref<TopicStats>();
const backlog = ref<BacklogStats>();
const loading = ref(false);
const error = ref<string>();
const autoRefresh = ref(true);
const refreshInterval = ref(5); // seconds
const selectedPartitionName = ref<string>();

let refreshTimer: number | undefined;
const history = ref<MetricPoint[]>([]);
const MAX_HISTORY_POINTS = 60;

const partitionRows = computed(() => extractPartitionRows(stats.value?.raw));
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
  legend: { top: 0, data: ["In", "Out"] },
  grid: { left: 48, right: 18, top: 36, bottom: 32 },
  xAxis: { type: "category", boundaryGap: false, data: history.value.map((point) => point.time) },
  yAxis: { type: "value", name: "msg/s" },
  series: [
    { name: "In", type: "line", smooth: true, showSymbol: false, data: history.value.map((point) => point.msgRateIn) },
    { name: "Out", type: "line", smooth: true, showSymbol: false, data: history.value.map((point) => point.msgRateOut) },
  ],
}));

const backlogChartOption = computed(() => ({
  tooltip: { trigger: "axis" },
  legend: { top: 0, data: ["Messages", "Bytes"] },
  grid: { left: 56, right: 54, top: 36, bottom: 32 },
  xAxis: { type: "category", boundaryGap: false, data: history.value.map((point) => point.time) },
  yAxis: [
    { type: "value", name: "msg" },
    { type: "value", name: "bytes" },
  ],
  series: [
    { name: "Messages", type: "line", smooth: true, showSymbol: false, data: history.value.map((point) => point.msgBacklog) },
    { name: "Bytes", type: "line", smooth: true, showSymbol: false, yAxisIndex: 1, data: history.value.map((point) => point.backlogSize) },
  ],
}));

const latencyChartOption = computed(() => ({
  tooltip: { trigger: "axis" },
  legend: { top: 0, data: ["Consumer lag"] },
  grid: { left: 56, right: 18, top: 36, bottom: 32 },
  xAxis: { type: "category", boundaryGap: false, data: history.value.map((point) => point.time) },
  yAxis: { type: "value", name: "ms" },
  series: [{ name: "Consumer lag", type: "line", smooth: true, showSymbol: false, data: history.value.map((point) => point.consumerLagMs) }],
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
    const [statsData, backlogData] = await Promise.all([mqGetTopicStats(props.connectionId, topicRef), mqGetBacklog(props.connectionId, topicRef, undefined)]);
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

function appendHistoryPoint(statsData: TopicStats, backlogData: BacklogStats) {
  const point: MetricPoint = {
    time: new Date().toLocaleTimeString(),
    msgRateIn: statsData.msgRateIn,
    msgRateOut: statsData.msgRateOut,
    backlogSize: statsData.backlogSize,
    msgBacklog: backlogData.msgBacklog,
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
      <h3>监控统计</h3>
      <div class="toolbar-actions">
        <label class="checkbox-label">
          <input type="checkbox" v-model="autoRefresh" />
          自动刷新
        </label>
        <select v-model.number="refreshInterval" :disabled="!autoRefresh" class="refresh-interval">
          <option :value="5">5秒</option>
          <option :value="10">10秒</option>
          <option :value="30">30秒</option>
          <option :value="60">60秒</option>
        </select>
        <button @click="refreshNow" :disabled="loading" class="btn-sm">
          {{ loading ? "刷新中..." : "立即刷新" }}
        </button>
      </div>
    </div>

    <div v-if="!topic" class="panel-placeholder">请先选择一个主题</div>

    <div v-else-if="error" class="panel-error">{{ error }}</div>

    <div v-else-if="loading && !stats" class="panel-loading">加载中...</div>

    <div v-else-if="stats" class="stats-container">
      <!-- Overview Section -->
      <div class="stats-section">
        <h4>消息速率</h4>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon">📥</div>
            <div class="stat-content">
              <div class="stat-label">入站速率</div>
              <div class="stat-value">{{ stats.msgRateIn.toFixed(2) }} msg/s</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">📤</div>
            <div class="stat-content">
              <div class="stat-label">出站速率</div>
              <div class="stat-value">{{ stats.msgRateOut.toFixed(2) }} msg/s</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">⬇️</div>
            <div class="stat-content">
              <div class="stat-label">入站吞吐量</div>
              <div class="stat-value">{{ formatBytes(stats.msgThroughputIn) }}/s</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">⬆️</div>
            <div class="stat-content">
              <div class="stat-label">出站吞吐量</div>
              <div class="stat-value">{{ formatBytes(stats.msgThroughputOut) }}/s</div>
            </div>
          </div>
        </div>
      </div>

      <div class="charts-grid">
        <div class="chart-panel">
          <h4>速率趋势</h4>
          <VChart :option="rateChartOption" autoresize class="trend-chart" />
        </div>
        <div class="chart-panel">
          <h4>积压趋势</h4>
          <VChart :option="backlogChartOption" autoresize class="trend-chart" />
        </div>
        <div class="chart-panel">
          <h4>消费延迟</h4>
          <VChart :option="latencyChartOption" autoresize class="trend-chart" />
        </div>
      </div>

      <!-- Storage Section -->
      <div class="stats-section">
        <h4>存储与积压</h4>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon">💾</div>
            <div class="stat-content">
              <div class="stat-label">存储大小</div>
              <div class="stat-value">{{ formatBytes(stats.storageSize) }}</div>
            </div>
          </div>
          <div class="stat-card" :class="{ warning: stats.backlogSize > 10 * 1024 * 1024 }">
            <div class="stat-icon">📦</div>
            <div class="stat-content">
              <div class="stat-label">积压大小</div>
              <div class="stat-value">{{ formatBytes(stats.backlogSize) }}</div>
            </div>
          </div>
          <div class="stat-card" v-if="backlog">
            <div class="stat-icon">📊</div>
            <div class="stat-content">
              <div class="stat-label">积压消息数</div>
              <div class="stat-value">{{ formatNumber(backlog.msgBacklog) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Counters Section -->
      <div class="stats-section">
        <h4>消息计数器</h4>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon">📨</div>
            <div class="stat-content">
              <div class="stat-label">已发布消息</div>
              <div class="stat-value">{{ formatNumber(stats.msgInCounter) }}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">📬</div>
            <div class="stat-content">
              <div class="stat-label">已消费消息</div>
              <div class="stat-value">{{ formatNumber(stats.msgOutCounter) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Connections Section -->
      <div class="stats-section">
        <h4>连接统计</h4>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon">👥</div>
            <div class="stat-content">
              <div class="stat-label">订阅数量</div>
              <div class="stat-value">{{ stats.subscriptionCount }}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">🚀</div>
            <div class="stat-content">
              <div class="stat-label">生产者数量</div>
              <div class="stat-value">{{ stats.producerCount }}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="stats-section">
        <h4>分区明细</h4>
        <div v-if="partitionRows.length" class="partition-layout">
          <div class="partition-table-wrap">
            <table class="partition-table">
              <thead>
                <tr>
                  <th>分区</th>
                  <th>入站</th>
                  <th>出站</th>
                  <th>入站吞吐</th>
                  <th>出站吞吐</th>
                  <th>积压消息</th>
                  <th>积压大小</th>
                  <th>生产者</th>
                  <th>订阅</th>
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
                <div class="detail-title">生产者</div>
                <table v-if="selectedPartitionPublishers.length" class="detail-table">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>速率</th>
                      <th>地址</th>
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
                <div v-else class="empty-state compact">暂无生产者</div>
              </div>
              <div>
                <div class="detail-title">订阅</div>
                <table v-if="selectedPartitionSubscriptions.length" class="detail-table">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>类型</th>
                      <th>积压</th>
                      <th>消费者</th>
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
                <div v-else class="empty-state compact">暂无订阅</div>
              </div>
            </div>
          </div>
        </div>
        <div v-else class="empty-state compact">
          {{ topic.partitioned ? "当前 Broker 响应未返回分区指标" : "非分区主题没有分区明细" }}
        </div>
      </div>

      <!-- Health Indicators -->
      <div class="stats-section">
        <h4>健康指标</h4>
        <div class="health-indicators">
          <div class="health-item">
            <span class="health-label">消息流动:</span>
            <span :class="['health-badge', stats.msgRateIn > 0 || stats.msgRateOut > 0 ? 'healthy' : 'idle']">
              {{ stats.msgRateIn > 0 || stats.msgRateOut > 0 ? "活跃" : "空闲" }}
            </span>
          </div>
          <div class="health-item">
            <span class="health-label">积压状态:</span>
            <span :class="['health-badge', stats.backlogSize < 10 * 1024 * 1024 ? 'healthy' : 'warning']">
              {{ stats.backlogSize < 10 * 1024 * 1024 ? "正常" : "偏高" }}
            </span>
          </div>
          <div class="health-item">
            <span class="health-label">生产者:</span>
            <span :class="['health-badge', stats.producerCount > 0 ? 'healthy' : 'idle']">
              {{ stats.producerCount > 0 ? "已连接" : "无连接" }}
            </span>
          </div>
          <div class="health-item">
            <span class="health-label">订阅:</span>
            <span :class="['health-badge', stats.subscriptionCount > 0 ? 'healthy' : 'idle']">
              {{ stats.subscriptionCount > 0 ? "活跃" : "无订阅" }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.monitoring-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.panel-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
}

.panel-toolbar h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}

.refresh-interval {
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 13px;
  background: var(--color-background);
  cursor: pointer;
}

.refresh-interval:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-sm {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}

.btn-sm:hover:not(:disabled) {
  background: var(--color-hover);
}

.btn-sm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.panel-placeholder,
.panel-error,
.panel-loading,
.empty-state {
  padding: 24px;
  text-align: center;
  color: var(--color-text-secondary);
}

.panel-error {
  color: var(--color-error);
}

.stats-container {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.stats-section {
  margin-bottom: 24px;
}

.stats-section h4 {
  margin: 0 0 12px 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.charts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
  margin-bottom: 24px;
}

.chart-panel {
  min-height: 260px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-secondary);
}

.chart-panel h4 {
  margin: 0 0 8px 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.trend-chart {
  width: 100%;
  height: 220px;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: var(--color-background-secondary);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  transition: all 0.2s;
}

.stat-card:hover {
  border-color: var(--color-primary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.stat-card.warning {
  border-color: var(--color-warning);
  background: var(--color-warning-alpha);
}

.stat-icon {
  font-size: 32px;
  line-height: 1;
}

.stat-content {
  flex: 1;
}

.stat-label {
  font-size: 12px;
  color: var(--color-text-tertiary);
  margin-bottom: 4px;
}

.stat-value {
  font-size: 20px;
  font-weight: 600;
  color: var(--color-text);
}

.health-indicators {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}

.partition-layout {
  display: grid;
  gap: 12px;
}

.partition-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-secondary);
}

.partition-table,
.detail-table {
  width: 100%;
  border-collapse: collapse;
}

.partition-table th,
.partition-table td,
.detail-table th,
.detail-table td {
  padding: 9px 10px;
  border-bottom: 1px solid var(--color-border-light);
  text-align: left;
  white-space: nowrap;
  font-size: 12px;
}

.partition-table th,
.detail-table th {
  color: var(--color-text-secondary);
  font-weight: 600;
}

.partition-table tbody tr {
  cursor: pointer;
}

.partition-table tbody tr:hover,
.partition-table tbody tr.selected {
  background: var(--color-hover);
}

.partition-detail {
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-secondary);
}

.partition-detail h5 {
  margin: 0 0 12px;
  font-size: 13px;
  font-weight: 600;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
}

.detail-title {
  margin-bottom: 8px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.empty-state.compact {
  padding: 12px;
}

.health-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--color-background-secondary);
  border: 1px solid var(--color-border);
  border-radius: 6px;
}

.health-label {
  font-size: 13px;
  color: var(--color-text-secondary);
  font-weight: 500;
}

.health-badge {
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
}

.health-badge.healthy {
  background: var(--color-success-alpha);
  color: var(--color-success);
}

.health-badge.warning {
  background: var(--color-warning-alpha);
  color: var(--color-warning);
}

.health-badge.idle {
  background: var(--color-background-tertiary);
  color: var(--color-text-tertiary);
}
</style>

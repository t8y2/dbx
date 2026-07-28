<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { MqNodeInfo, MqOverviewInfo } from "@/types/mq";
import { mqGetOverview, mqListNodes } from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";

interface Props {
  connectionId: string;
}

const props = defineProps<Props>();
const { t } = useI18n();

const overview = ref<MqOverviewInfo>();
const nodes = ref<MqNodeInfo[]>([]);
const loading = ref(false);
const error = ref<string>();
const autoRefresh = ref(true);
const refreshInterval = ref(5); // seconds

let refreshTimer: number | undefined;

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

async function loadStats(options: { skipWhenHidden?: boolean } = {}) {
  if (options.skipWhenHidden && isDocumentHidden()) return;
  loading.value = true;
  error.value = undefined;
  try {
    const [overviewData, nodeData] = await Promise.all([mqGetOverview(props.connectionId), mqListNodes(props.connectionId)]);
    overview.value = overviewData;
    nodes.value = nodeData;
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function refreshNow() {
  void loadStats();
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (autoRefresh.value && !isDocumentHidden()) {
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

function formatNumber(value: number | undefined): string {
  return value === undefined ? "-" : value.toLocaleString();
}

function formatRate(value: number | undefined): string {
  return value === undefined ? "-" : `${value.toFixed(2)} msg/s`;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "-";
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + " " + sizes[i];
}

function formatUsage(used: number | undefined, total: number | undefined): string {
  if (used === undefined) return "-";
  return total === undefined ? formatNumber(used) : `${formatNumber(used)} / ${formatNumber(total)}`;
}

function formatMemory(node: MqNodeInfo): string {
  if (node.memUsed === undefined) return "-";
  if (node.memLimit === undefined || node.memLimit <= 0) return formatBytes(node.memUsed);
  const percent = Math.round((node.memUsed / node.memLimit) * 100);
  return `${formatBytes(node.memUsed)} / ${formatBytes(node.memLimit)} (${percent}%)`;
}

function formatUptime(uptimeMs: number | undefined): string {
  if (uptimeMs === undefined) return "-";
  const totalSeconds = Math.floor(uptimeMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

watch(autoRefresh, () => {
  startAutoRefresh();
});

watch(refreshInterval, () => {
  if (autoRefresh.value) {
    startAutoRefresh();
  }
});

watch(
  () => props.connectionId,
  () => {
    overview.value = undefined;
    nodes.value = [];
    void loadStats();
    startAutoRefresh();
  },
  { immediate: true },
);

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
  <div class="rabbitmq-monitoring-panel">
    <div class="panel-toolbar">
      <h3 class="section-title">{{ t("mqRabbitMqMonitoring.title") }}</h3>
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
        <button @click="refreshNow" :disabled="loading" class="btn-secondary">
          {{ loading ? t("mqMonitoring.refreshing") : t("mqMonitoring.refreshNow") }}
        </button>
      </div>
    </div>

    <div v-if="error" class="panel-error">{{ error }}</div>
    <div v-else-if="loading && !overview" class="panel-loading">{{ t("mqRabbitMqMonitoring.loading") }}</div>

    <template v-else>
      <!-- Overview cards -->
      <div class="panel-section">
        <h4 class="section-subtitle">{{ t("mqRabbitMqMonitoring.overviewTitle") }}</h4>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-label">{{ t("mqRabbitMqMonitoring.messagesReady") }}</div>
            <div class="stat-value">{{ formatNumber(overview?.messagesReady) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">{{ t("mqRabbitMqMonitoring.messagesUnacked") }}</div>
            <div class="stat-value">{{ formatNumber(overview?.messagesUnacked) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">{{ t("mqRabbitMqMonitoring.publishRate") }}</div>
            <div class="stat-value">{{ formatRate(overview?.publishRate) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">{{ t("mqRabbitMqMonitoring.deliverRate") }}</div>
            <div class="stat-value">{{ formatRate(overview?.deliverRate) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">{{ t("mqRabbitMqMonitoring.ackRate") }}</div>
            <div class="stat-value">{{ formatRate(overview?.ackRate) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">{{ t("mqRabbitMqMonitoring.totalQueues") }}</div>
            <div class="stat-value">{{ formatNumber(overview?.totalQueues) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">{{ t("mqRabbitMqMonitoring.totalExchanges") }}</div>
            <div class="stat-value">{{ formatNumber(overview?.totalExchanges) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">{{ t("mqRabbitMqMonitoring.totalConnections") }}</div>
            <div class="stat-value">{{ formatNumber(overview?.totalConnections) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">{{ t("mqRabbitMqMonitoring.totalChannels") }}</div>
            <div class="stat-value">{{ formatNumber(overview?.totalChannels) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">{{ t("mqRabbitMqMonitoring.totalConsumers") }}</div>
            <div class="stat-value">{{ formatNumber(overview?.totalConsumers) }}</div>
          </div>
        </div>
      </div>

      <!-- Node table -->
      <div class="panel-section">
        <h4 class="section-subtitle">{{ t("mqRabbitMqMonitoring.nodesTitle") }}</h4>
        <div v-if="!nodes.length" class="panel-placeholder">{{ t("mqRabbitMqMonitoring.noNodes") }}</div>
        <div v-else class="data-table">
          <table>
            <thead>
              <tr>
                <th>{{ t("mqRabbitMqMonitoring.nodeName") }}</th>
                <th>{{ t("mqRabbitMqMonitoring.status") }}</th>
                <th>{{ t("mqRabbitMqMonitoring.memory") }}</th>
                <th>{{ t("mqRabbitMqMonitoring.diskFree") }}</th>
                <th>{{ t("mqRabbitMqMonitoring.fileDescriptors") }}</th>
                <th>{{ t("mqRabbitMqMonitoring.sockets") }}</th>
                <th>{{ t("mqRabbitMqMonitoring.uptime") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="node in nodes" :key="node.name">
                <td class="node-name" :title="node.name">{{ node.name }}</td>
                <td>
                  <span :class="['status-badge', node.running ? 'running' : 'stopped']">
                    {{ node.running ? t("mqRabbitMqMonitoring.running") : t("mqRabbitMqMonitoring.stopped") }}
                  </span>
                </td>
                <td>{{ formatMemory(node) }}</td>
                <td>{{ formatBytes(node.diskFree) }}</td>
                <td>{{ formatUsage(node.fdUsed, node.fdTotal) }}</td>
                <td>{{ formatUsage(node.socketsUsed, node.socketsTotal) }}</td>
                <td>{{ formatUptime(node.uptimeMs) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.rabbitmq-monitoring-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 12px 16px;
  overflow: auto;
  height: 100%;
}

.section-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.section-subtitle {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}

.panel-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.panel-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.refresh-interval {
  padding: 4px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  background: var(--color-background);
  color: var(--color-text);
  font-size: 13px;
}

.panel-placeholder,
.panel-error,
.panel-loading {
  padding: 24px;
  text-align: center;
  color: var(--color-text-secondary);
}

.panel-error {
  color: var(--color-error);
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 12px;
}

.stat-card {
  padding: 12px 14px;
  background: var(--color-background);
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.stat-label {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.stat-value {
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
}

.data-table {
  overflow: auto;
  background: var(--color-background);
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
}

table {
  width: 100%;
  border-collapse: collapse;
}

th {
  padding: 10px 12px;
  text-align: left;
  font-weight: 600;
  font-size: 13px;
  color: var(--color-text-secondary);
  background: var(--color-background-secondary);
  border-bottom: 1px solid var(--color-border);
}

td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
  font-size: 13px;
}

.data-table tbody tr {
  transition: background 0.2s;
}

.data-table tbody tr:hover {
  background: var(--color-hover);
}

.node-name {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--dbx-radius-fixed-4);
  font-size: 11px;
  font-weight: 500;
}

.status-badge.running {
  background: var(--color-success-alpha);
  color: var(--color-success);
}

.status-badge.stopped {
  background: var(--color-error-alpha);
  color: var(--color-error);
}

.btn-secondary {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}

.btn-secondary:hover:not(:disabled) {
  background: var(--color-hover);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

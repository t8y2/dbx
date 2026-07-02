<script setup lang="ts">
import { formatError } from "@/lib/errorUtils";
import { ref, watch, onMounted, onUnmounted } from "vue";
import type { ClusterInfo } from "@/types/mq";
import { mqGetClusterInfo } from "@/lib/api";

interface Props {
  connectionId: string;
  readOnly?: boolean;
}

const props = defineProps<Props>();

const clusterInfo = ref<ClusterInfo>();
const loading = ref(false);
const error = ref<string>();
const autoRefresh = ref(true);
const refreshInterval = ref(10);

let refreshTimer: number | undefined;

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

async function loadClusterInfo(options: { skipWhenHidden?: boolean } = {}) {
  if (options.skipWhenHidden && isDocumentHidden()) return;
  loading.value = true;
  error.value = undefined;
  try {
    clusterInfo.value = await mqGetClusterInfo(props.connectionId);
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function refreshNow() {
  void loadClusterInfo();
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (autoRefresh.value && !isDocumentHidden()) {
    refreshTimer = window.setInterval(() => {
      void loadClusterInfo({ skipWhenHidden: true });
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
  void loadClusterInfo();
}

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
  void loadClusterInfo();
  startAutoRefresh();
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  stopAutoRefresh();
});
</script>

<template>
  <div class="broker-panel">
    <div class="panel-toolbar">
      <h3>Broker 集群</h3>
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

    <div v-if="error" class="panel-error">{{ error }}</div>

    <div v-else-if="loading && !clusterInfo" class="panel-loading">加载中...</div>

    <div v-else-if="clusterInfo" class="broker-content">
      <!-- 集群概览 -->
      <div class="stats-section">
        <h4>集群概览</h4>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon">🔗</div>
            <div class="stat-content">
              <div class="stat-label">集群 ID</div>
              <div class="stat-value stat-value-sm">{{ clusterInfo.clusterId || "未知" }}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">🖥️</div>
            <div class="stat-content">
              <div class="stat-label">Broker 数量</div>
              <div class="stat-value">{{ clusterInfo.brokerCount }}</div>
            </div>
          </div>
          <div class="stat-card">
            <div class="stat-icon">👑</div>
            <div class="stat-content">
              <div class="stat-label">Controller</div>
              <div class="stat-value stat-value-sm">
                <template v-if="clusterInfo.controllerHost"> Node {{ clusterInfo.controllerId ?? "?" }} · {{ clusterInfo.controllerHost }} </template>
                <template v-else>未知</template>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Broker 节点列表 -->
      <div class="stats-section">
        <h4>Broker 节点</h4>
        <div v-if="clusterInfo.brokers.length" class="broker-table-wrap">
          <table class="broker-table">
            <thead>
              <tr>
                <th>Node ID</th>
                <th>Host</th>
                <th>Port</th>
                <th>Rack</th>
                <th>角色</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="broker in clusterInfo.brokers" :key="broker.id" :class="{ 'is-controller': broker.id === clusterInfo.controllerId }">
                <td class="node-id">{{ broker.id }}</td>
                <td>{{ broker.host }}</td>
                <td>{{ broker.port }}</td>
                <td>{{ broker.rack || "-" }}</td>
                <td>
                  <span v-if="broker.id === clusterInfo.controllerId" class="role-badge controller">Controller</span>
                  <span v-else class="role-badge follower">Follower</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty-state">暂无 Broker 节点信息</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.broker-panel {
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

.broker-content {
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

.stat-icon {
  font-size: 32px;
  line-height: 1;
}

.stat-content {
  flex: 1;
  min-width: 0;
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

.stat-value-sm {
  font-size: 14px;
  font-weight: 500;
  word-break: break-all;
}

.broker-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-secondary);
}

.broker-table {
  width: 100%;
  border-collapse: collapse;
}

.broker-table th,
.broker-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border-light);
  text-align: left;
  font-size: 13px;
}

.broker-table th {
  color: var(--color-text-secondary);
  font-weight: 600;
}

.broker-table tbody tr:last-child td {
  border-bottom: none;
}

.broker-table tbody tr.is-controller {
  background: var(--color-primary-alpha);
}

.node-id {
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.role-badge {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
}

.role-badge.controller {
  background: var(--color-primary-alpha);
  color: var(--color-primary);
}

.role-badge.follower {
  background: var(--color-background-tertiary);
  color: var(--color-text-secondary);
}
</style>

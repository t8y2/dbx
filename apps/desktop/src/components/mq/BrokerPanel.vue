<script setup lang="ts">
import { formatError } from "@/lib/backend/errorUtils";
import { ref, watch, onMounted, onUnmounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ClusterInfo, MqAdminConfig, MqSystemKind } from "@/types/mq";
import { mqGetClusterInfo } from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";

interface Props {
  connectionId: string;
  readOnly?: boolean;
  mqSystemKind?: MqSystemKind;
}

const props = defineProps<Props>();
const { t } = useI18n();
const connectionStore = useConnectionStore();

const isRocketMqCluster = computed(() => props.mqSystemKind === "rocketmq");
const rocketmqNamesrvAddr = computed(() => {
  if (!isRocketMqCluster.value) return undefined;
  const config = connectionStore.getConfig(props.connectionId);
  const external = config?.external_config as Partial<MqAdminConfig> | undefined;
  const extra = external?.extra as Record<string, unknown> | undefined;
  const addr = extra?.namesrvAddr ?? extra?.namesrv_addr;
  return typeof addr === "string" && addr.trim() ? addr.trim() : undefined;
});

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
      <h3>{{ isRocketMqCluster ? t("mqBroker.clusterTitle") : t("mqBroker.title") }}</h3>
      <div class="toolbar-actions">
        <label class="checkbox-label">
          <input type="checkbox" v-model="autoRefresh" />
          {{ t("mqBroker.autoRefresh") }}
        </label>
        <select v-model.number="refreshInterval" :disabled="!autoRefresh" class="refresh-interval">
          <option :value="5">{{ t("mqBroker.refreshInterval5s") }}</option>
          <option :value="10">{{ t("mqBroker.refreshInterval10s") }}</option>
          <option :value="30">{{ t("mqBroker.refreshInterval30s") }}</option>
          <option :value="60">{{ t("mqBroker.refreshInterval60s") }}</option>
        </select>
        <button @click="refreshNow" :disabled="loading" class="btn-secondary">
          {{ loading ? t("mqBroker.refreshing") : t("mqBroker.refreshNow") }}
        </button>
      </div>
    </div>

    <div v-if="error" class="panel-error">{{ error }}</div>

    <div v-else-if="loading && !clusterInfo" class="panel-loading">{{ t("mqBroker.loading") }}</div>

    <div v-else-if="clusterInfo" class="broker-content">
      <div class="stats-section">
        <h4>{{ t("mqBroker.clusterOverview") }}</h4>
        <div class="stats-grid">
          <div class="stat-card">
            <div v-if="!isRocketMqCluster" class="stat-icon">🔗</div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqBroker.clusterId") }}</div>
              <div class="stat-value stat-value-sm">{{ clusterInfo.clusterId || t("mqBroker.unknown") }}</div>
            </div>
          </div>
          <div class="stat-card">
            <div v-if="!isRocketMqCluster" class="stat-icon">🖥️</div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqBroker.brokerCount") }}</div>
              <div class="stat-value">{{ clusterInfo.brokerCount }}</div>
            </div>
          </div>
          <div v-if="!isRocketMqCluster" class="stat-card">
            <div class="stat-icon">👑</div>
            <div class="stat-content">
              <div class="stat-label">{{ t("mqBroker.controller") }}</div>
              <div class="stat-value stat-value-sm">
                <template v-if="clusterInfo.controllerHost">
                  {{ t("mqBroker.controllerNode", { id: clusterInfo.controllerId ?? "?", host: clusterInfo.controllerHost }) }}
                </template>
                <template v-else>{{ t("mqBroker.unknown") }}</template>
              </div>
            </div>
          </div>
          <div v-else class="stat-card">
            <div class="stat-content">
              <div class="stat-label">{{ t("mqRocketmq.namesrvAddr") }}</div>
              <div class="stat-value stat-value-sm">{{ rocketmqNamesrvAddr || t("mqBroker.unknown") }}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="stats-section">
        <h4>{{ t("mqBroker.brokerNodes") }}</h4>
        <div v-if="clusterInfo.brokers.length" class="broker-table-wrap">
          <table class="broker-table">
            <thead>
              <tr>
                <th>{{ t("mqBroker.nodeId") }}</th>
                <th v-if="isRocketMqCluster">{{ t("mqBroker.brokerName") }}</th>
                <th>{{ t("mqBroker.host") }}</th>
                <th>{{ t("mqBroker.port") }}</th>
                <th v-if="!isRocketMqCluster">{{ t("mqBroker.rack") }}</th>
                <th>{{ t("mqBroker.role") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="broker in clusterInfo.brokers" :key="`${broker.id}-${broker.host}:${broker.port}`" :class="{ 'is-controller': !isRocketMqCluster && broker.id === clusterInfo.controllerId }">
                <td class="node-id">{{ broker.id }}</td>
                <td v-if="isRocketMqCluster">{{ broker.brokerName || "-" }}</td>
                <td>{{ broker.host }}</td>
                <td>{{ broker.port }}</td>
                <td v-if="!isRocketMqCluster">{{ broker.rack || "-" }}</td>
                <td>
                  <span v-if="isRocketMqCluster" class="role-badge" :class="broker.role === 'MASTER' ? 'controller' : 'follower'">
                    {{ broker.role === "MASTER" ? t("mqBroker.roleMaster") : broker.role === "SLAVE" ? t("mqBroker.roleSlave") : t("mqBroker.unknown") }}
                  </span>
                  <span v-else-if="broker.id === clusterInfo.controllerId" class="role-badge controller">{{ t("mqBroker.roleController") }}</span>
                  <span v-else class="role-badge follower">{{ t("mqBroker.roleFollower") }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty-state">{{ t("mqBroker.noBrokerNodes") }}</div>
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

.btn-secondary {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;
}

.btn-secondary:hover:not(:disabled) {
  background: var(--color-hover);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

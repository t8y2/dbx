<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { MqChannelInfo, MqClientConnectionInfo, NamespaceRef } from "@/types/mq";
import { mqCloseClientConnection, mqListClientChannels, mqListClientConnections } from "@/lib/backend/api";
import { isAllVhostsNamespace, RABBITMQ_MQ_TENANT, resolveMqRowNamespace } from "@/lib/mq/mqConsoleDefaults";
import { formatError } from "@/lib/backend/errorUtils";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";

interface Props {
  connectionId: string;
  /** RabbitMQ virtual host; undefined lists connections across all vhosts. */
  namespace?: string;
  readOnly?: boolean;
}

const props = defineProps<Props>();
const { t } = useI18n();

const connections = ref<MqClientConnectionInfo[]>([]);
const loading = ref(false);
const error = ref<string>();
const connectionSearch = ref("");

const expandedNames = ref<Set<string>>(new Set());
const channelsByConnection = ref<Record<string, MqChannelInfo[]>>({});
const channelsLoading = ref<Record<string, boolean>>({});
const channelsError = ref<Record<string, string | undefined>>({});

const showCloseDialog = ref(false);
const closeTarget = ref<MqClientConnectionInfo>();
const closing = ref(false);

const filteredConnections = computed(() => {
  const query = connectionSearch.value.trim().toLowerCase();
  if (!query) return connections.value;
  return connections.value.filter((connection) => {
    return connection.name.toLowerCase().includes(query) || connection.user.toLowerCase().includes(query) || connection.peerHost.toLowerCase().includes(query);
  });
});

// RabbitMQ "all vhosts" mode: rows carry their own vhost in `namespace`, and
// row-level operations must target that vhost rather than the "*" selection.
const showNamespaceColumn = computed(() => isAllVhostsNamespace(props.namespace));

// RabbitMQ namespace is the vhost; the tenant is always the synthetic one.
function nsRef(namespace?: string): NamespaceRef {
  return { tenant: RABBITMQ_MQ_TENANT, namespace: namespace ?? "" };
}

function guardWritable() {
  if (props.readOnly) {
    error.value = t("mqClientConnections.readOnly");
    return false;
  }
  return true;
}

async function loadConnections() {
  loading.value = true;
  error.value = undefined;
  try {
    connections.value = await mqListClientConnections(props.connectionId, nsRef(props.namespace));
    // Drop cached channels for connections that went away.
    const liveNames = new Set(connections.value.map((connection) => connection.name));
    expandedNames.value = new Set([...expandedNames.value].filter((name) => liveNames.has(name)));
    for (const name of Object.keys(channelsByConnection.value)) {
      if (!liveNames.has(name)) {
        delete channelsByConnection.value[name];
        delete channelsLoading.value[name];
        delete channelsError.value[name];
      }
    }
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function loadChannels(connection: MqClientConnectionInfo) {
  const connectionName = connection.name;
  const namespace = resolveMqRowNamespace(connection, props.namespace);
  if (!namespace) {
    channelsError.value = { ...channelsError.value, [connectionName]: t("mqAdmin.selectNamespaceToWrite") };
    return;
  }
  channelsLoading.value = { ...channelsLoading.value, [connectionName]: true };
  channelsError.value = { ...channelsError.value, [connectionName]: undefined };
  try {
    const channels = await mqListClientChannels(props.connectionId, nsRef(namespace), connectionName);
    channelsByConnection.value = { ...channelsByConnection.value, [connectionName]: channels };
  } catch (e: unknown) {
    channelsError.value = { ...channelsError.value, [connectionName]: formatError(e) };
  } finally {
    channelsLoading.value = { ...channelsLoading.value, [connectionName]: false };
  }
}

function toggleExpanded(connection: MqClientConnectionInfo) {
  const next = new Set(expandedNames.value);
  if (next.has(connection.name)) {
    next.delete(connection.name);
    expandedNames.value = next;
    return;
  }
  next.add(connection.name);
  expandedNames.value = next;
  if (!channelsByConnection.value[connection.name]) {
    void loadChannels(connection);
  }
}

function openCloseDialog(connection: MqClientConnectionInfo) {
  if (!guardWritable()) return;
  closeTarget.value = connection;
  showCloseDialog.value = true;
}

async function confirmClose() {
  const target = closeTarget.value;
  if (!target) return;
  const namespace = resolveMqRowNamespace(target, props.namespace);
  if (!namespace) {
    error.value = t("mqAdmin.selectNamespaceToWrite");
    return;
  }
  closing.value = true;
  error.value = undefined;
  try {
    await mqCloseClientConnection(props.connectionId, nsRef(namespace), target.name);
    showCloseDialog.value = false;
    await loadConnections();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    closing.value = false;
  }
}

function formatRate(value: number | undefined): string {
  if (value === undefined) return "-";
  if (!value) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(2)} ${units[index]}`;
}

function formatConnectedAt(value: number | undefined): string {
  if (value === undefined) return "-";
  return new Date(value).toLocaleString();
}

function formatOptionalNumber(value: number | undefined): string {
  return value === undefined ? "-" : String(value);
}

watch(
  () => props.namespace,
  () => {
    expandedNames.value = new Set();
    channelsByConnection.value = {};
    channelsLoading.value = {};
    channelsError.value = {};
    loadConnections();
  },
  { immediate: true },
);
</script>

<template>
  <div class="clients-panel">
    <div class="panel-toolbar">
      <div class="toolbar-left">
        <input v-model="connectionSearch" type="search" class="connection-search" :placeholder="t('mqClientConnections.searchPlaceholder')" :disabled="loading && !connections.length" />
        <span v-if="connections.length" class="connection-count">{{ filteredConnections.length }} / {{ connections.length }}</span>
      </div>
      <div class="toolbar-actions">
        <button @click="loadConnections" :disabled="loading" class="btn-secondary">
          {{ loading ? t("mqClientConnections.refreshing") : t("mqClientConnections.refresh") }}
        </button>
      </div>
    </div>

    <div v-if="error" class="panel-error">{{ error }}</div>

    <div v-else-if="loading && !connections.length" class="panel-loading">{{ t("mqClientConnections.loading") }}</div>

    <div v-else-if="!connections.length" class="panel-placeholder">{{ t("mqClientConnections.noConnections") }}</div>

    <div v-else-if="!filteredConnections.length" class="panel-placeholder">{{ t("mqClientConnections.noMatches") }}</div>

    <div v-else class="connections-table">
      <table>
        <thead>
          <tr>
            <th class="expand-col"></th>
            <th>{{ t("mqClientConnections.name") }}</th>
            <th v-if="showNamespaceColumn">{{ t("mqAdmin.namespace") }}</th>
            <th>{{ t("mqClientConnections.user") }}</th>
            <th>{{ t("mqClientConnections.peerAddress") }}</th>
            <th>{{ t("mqClientConnections.state") }}</th>
            <th>{{ t("mqClientConnections.channels") }}</th>
            <th>{{ t("mqClientConnections.recvRate") }}</th>
            <th>{{ t("mqClientConnections.sendRate") }}</th>
            <th>{{ t("mqClientConnections.connectedAt") }}</th>
            <th>{{ t("mqClientConnections.actions") }}</th>
          </tr>
        </thead>
        <tbody v-for="connection in filteredConnections" :key="connection.name">
          <tr :class="{ expanded: expandedNames.has(connection.name) }" @click="toggleExpanded(connection)">
            <td class="expand-col">
              <span class="expand-icon">{{ expandedNames.has(connection.name) ? "▾" : "▸" }}</span>
            </td>
            <td class="connection-name" :title="connection.name">{{ connection.name }}</td>
            <td v-if="showNamespaceColumn">{{ connection.namespace || "-" }}</td>
            <td>{{ connection.user || "-" }}</td>
            <td>{{ connection.peerHost ? `${connection.peerHost}:${connection.peerPort}` : "-" }}</td>
            <td>
              <span class="badge" :class="connection.state === 'running' ? 'badge-info' : 'badge-warning'">{{ connection.state || "-" }}</span>
            </td>
            <td>{{ connection.channels }}</td>
            <td>{{ formatRate(connection.recvRate) }}</td>
            <td>{{ formatRate(connection.sendRate) }}</td>
            <td>{{ formatConnectedAt(connection.connectedAt) }}</td>
            <td class="actions" @click.stop>
              <button class="btn-sm btn-danger" :disabled="readOnly || (showNamespaceColumn && !connection.namespace)" :title="showNamespaceColumn && !connection.namespace ? t('mqAdmin.selectNamespaceToWrite') : undefined" @click="openCloseDialog(connection)">
                {{ t("mqClientConnections.closeConnection") }}
              </button>
            </td>
          </tr>
          <tr v-if="expandedNames.has(connection.name)" class="channels-row">
            <td :colspan="showNamespaceColumn ? 11 : 10">
              <div v-if="channelsError[connection.name]" class="panel-error">{{ channelsError[connection.name] }}</div>
              <div v-else-if="channelsLoading[connection.name] && !channelsByConnection[connection.name]?.length" class="panel-loading">{{ t("mqClientConnections.loading") }}</div>
              <div v-else-if="!channelsByConnection[connection.name]?.length" class="panel-placeholder">{{ t("mqClientConnections.noChannels") }}</div>
              <table v-else class="channels-table">
                <thead>
                  <tr>
                    <th>{{ t("mqClientConnections.channelName") }}</th>
                    <th>{{ t("mqClientConnections.state") }}</th>
                    <th>{{ t("mqClientConnections.prefetch") }}</th>
                    <th>{{ t("mqClientConnections.unacked") }}</th>
                    <th>{{ t("mqClientConnections.consumers") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="channel in channelsByConnection[connection.name]" :key="channel.name">
                    <td class="connection-name" :title="channel.name">{{ channel.name }}</td>
                    <td>{{ channel.state || "-" }}</td>
                    <td>{{ formatOptionalNumber(channel.prefetch) }}</td>
                    <td>{{ formatOptionalNumber(channel.messagesUnacked) }}</td>
                    <td>{{ formatOptionalNumber(channel.consumerCount) }}</td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Close Connection Confirm -->
    <DangerConfirmDialog
      v-model:open="showCloseDialog"
      :title="t('mqClientConnections.closeConnection')"
      :message="t('mqClientConnections.confirmClose', { name: closeTarget?.name ?? '' })"
      :confirm-label="t('mqClientConnections.closeConnection')"
      :loading="closing"
      :close-on-confirm="false"
      @confirm="confirmClose"
    />
  </div>
</template>

<style scoped>
.clients-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 16px;
  overflow: auto;
  height: 100%;
}

.panel-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.connection-search {
  width: min(320px, 32vw);
  min-width: 180px;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background);
  color: var(--color-text);
  font-size: 13px;
}

.connection-search:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-alpha);
}

.connection-count {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
  font-size: 12px;
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

.connections-table {
  overflow: auto;
  background: var(--color-background);
  border: 1px solid var(--color-border);
  border-radius: 6px;
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

.connections-table tbody tr {
  cursor: pointer;
  transition: background 0.2s;
}

.connections-table tbody tr:hover {
  background: var(--color-hover);
}

.connections-table tbody tr.expanded {
  background: var(--color-primary-alpha);
}

.expand-col {
  width: 24px;
  padding-right: 0;
}

.expand-icon {
  color: var(--color-text-tertiary);
  font-size: 12px;
}

.connection-name {
  font-weight: 500;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channels-row {
  cursor: default;
}

.channels-row:hover {
  background: transparent;
}

.channels-row td {
  background: var(--color-background-secondary);
  padding: 8px 12px 12px 36px;
}

.channels-table {
  border: 1px solid var(--color-border);
  border-radius: 6px;
  overflow: hidden;
  background: var(--color-background);
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
}

.badge-info {
  background: var(--color-info-alpha);
  color: var(--color-info);
}

.badge-warning {
  background: var(--color-warning-alpha);
  color: var(--color-warning);
}

.actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}

.btn-secondary,
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

.btn-secondary:hover:not(:disabled) {
  background: var(--color-hover);
}

.btn-danger {
  color: var(--color-error);
  border-color: var(--color-error);
}

.btn-danger:hover:not(:disabled) {
  background: var(--color-error);
  color: white;
}

.btn-sm {
  padding: 4px 8px;
  font-size: 12px;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

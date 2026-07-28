<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { BrokerNode, ResetPosition, SubscriptionInfo, TopicInfo, TopicRef } from "@/types/mq";
import { mqAlterTopicConfig, mqGetTopicInternalStats, mqGetTopicRoute, mqGetTopicStats, mqListSubscriptions, mqResetCursor, mqSkipTopicAccumulation } from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";

export type RocketMqTopicDialogKind = "status" | "route" | "consumers" | "config" | "reset" | "skip";

interface PartitionStatRow {
  partition: unknown;
  brokerName: unknown;
  beginOffset: unknown;
  endOffset: unknown;
  messageCount: unknown;
}

interface QueueDataRow {
  brokerName: unknown;
  readQueueNums: unknown;
  writeQueueNums: unknown;
  perm: unknown;
}

interface BrokerDataRow {
  brokerName: unknown;
  cluster: unknown;
  brokerAddrs: unknown;
}

interface Props {
  connectionId: string;
  tenant?: string;
  namespace?: string;
  topic?: TopicInfo;
  dialog?: RocketMqTopicDialogKind | null;
  readOnly?: boolean;
  brokerOptions?: BrokerNode[];
}

const props = defineProps<Props>();
const emit = defineEmits<{
  close: [];
  navigate: [payload: { tab: "subscriptions" | "messages"; subscription?: string }];
  refreshed: [];
}>();

const { t } = useI18n();

const loading = ref(false);
const dialogError = ref<string>();
const statsRaw = ref<unknown>();
const routeRaw = ref<unknown>();
const configForm = ref({
  readQueueNums: 8,
  writeQueueNums: 8,
  perm: 6,
});
const subscriptions = ref<SubscriptionInfo[]>([]);
const selectedSubscription = ref("");
const resetMode = ref<"earliest" | "latest" | "timestamp">("latest");
const resetTimestamp = ref("");

const topicRef = computed<TopicRef | null>(() => {
  if (!props.topic || !props.tenant || !props.namespace) return null;
  return {
    tenant: props.tenant,
    namespace: props.namespace,
    topic: props.topic.shortName,
    persistent: props.topic.persistent,
    partitioned: props.topic.partitioned,
  };
});

function mapPartitionStatRows(list: unknown): PartitionStatRow[] {
  if (!Array.isArray(list)) return [];
  return list.map((row) => {
    const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
    return {
      partition: item.partition,
      brokerName: item.brokerName,
      beginOffset: item.beginOffset,
      endOffset: item.endOffset,
      messageCount: item.messageCount,
    };
  });
}

function mapQueueDataRows(list: unknown): QueueDataRow[] {
  if (!Array.isArray(list)) return [];
  return list.map((row) => {
    const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
    return {
      brokerName: item.brokerName,
      readQueueNums: item.readQueueNums,
      writeQueueNums: item.writeQueueNums,
      perm: item.perm,
    };
  });
}

function mapBrokerDataRows(list: unknown): BrokerDataRow[] {
  if (!Array.isArray(list)) return [];
  return list.map((row) => {
    const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
    return {
      brokerName: item.brokerName,
      cluster: item.cluster,
      brokerAddrs: item.brokerAddrs,
    };
  });
}

const partitionStats = computed(() => {
  const raw = statsRaw.value;
  if (!raw || typeof raw !== "object") return [];
  return mapPartitionStatRows((raw as Record<string, unknown>).partitionStats);
});

const queueDatas = computed(() => {
  const raw = routeRaw.value;
  if (!raw || typeof raw !== "object") return [];
  return mapQueueDataRows((raw as Record<string, unknown>).queueDatas);
});

const brokerDatas = computed(() => {
  const raw = routeRaw.value;
  if (!raw || typeof raw !== "object") return [];
  return mapBrokerDataRows((raw as Record<string, unknown>).brokerDatas);
});

const dialogTitle = computed(() => {
  const name = props.topic?.shortName ?? "";
  switch (props.dialog) {
    case "status":
      return t("mqTopics.topicStatusTitle", { name });
    case "route":
      return t("mqTopics.topicRouteTitle", { name });
    case "consumers":
      return t("mqTopics.topicConsumersTitle", { name });
    case "config":
      return t("mqTopics.topicConfigTitle", { name });
    case "reset":
      return t("mqTopics.topicResetTitle", { name });
    case "skip":
      return t("mqTopics.topicSkipTitle", { name });
    default:
      return "";
  }
});

function closeDialog() {
  dialogError.value = undefined;
  emit("close");
}

function parseConfigEntries(raw: unknown): Array<{ key: string; value: string }> {
  if (!raw || typeof raw !== "object") return [];
  const configs = (raw as Record<string, unknown>).configs;
  if (!configs || typeof configs !== "object") return [];
  const editableKeys = new Set(["readQueueNums", "writeQueueNums", "perm"]);
  return Object.entries(configs as Record<string, unknown>)
    .filter(([key]) => editableKeys.has(key))
    .map(([key, val]) => {
      if (val && typeof val === "object" && "value" in (val as object)) {
        return { key, value: String((val as Record<string, unknown>).value ?? "") };
      }
      return { key, value: String(val ?? "") };
    });
}

function applyConfigEntriesToForm(entries: Array<{ key: string; value: string }>) {
  for (const entry of entries) {
    const numeric = Number(entry.value);
    if (!Number.isFinite(numeric)) continue;
    if (entry.key === "readQueueNums") configForm.value.readQueueNums = numeric;
    if (entry.key === "writeQueueNums") configForm.value.writeQueueNums = numeric;
    if (entry.key === "perm") configForm.value.perm = numeric;
  }
}

function sortResetSubscriptions(subs: SubscriptionInfo[], topicName: string): SubscriptionInfo[] {
  return [...subs].sort((left, right) => {
    const leftSubscribed = left.topics?.includes(topicName) ? 0 : 1;
    const rightSubscribed = right.topics?.includes(topicName) ? 0 : 1;
    if (leftSubscribed !== rightSubscribed) return leftSubscribed - rightSubscribed;
    return left.name.localeCompare(right.name);
  });
}

async function loadResetSubscriptions(topic: TopicRef): Promise<SubscriptionInfo[]> {
  const topicSpecific = await mqListSubscriptions(props.connectionId, topic);
  if (topicSpecific.length > 0) {
    return sortResetSubscriptions(topicSpecific, topic.topic);
  }
  // Reset offset uses force=true; fall back to all cluster groups when the topic has no committed offsets yet.
  const clusterWide: TopicRef = { ...topic, topic: "" };
  return sortResetSubscriptions(await mqListSubscriptions(props.connectionId, clusterWide), topic.topic);
}

function formatDateTimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function loadDialogData() {
  const topic = topicRef.value;
  if (!topic || !props.dialog) return;
  loading.value = true;
  dialogError.value = undefined;
  try {
    if (props.dialog === "status") {
      const stats = await mqGetTopicStats(props.connectionId, topic);
      statsRaw.value = stats.raw ?? stats;
    } else if (props.dialog === "route") {
      routeRaw.value = await mqGetTopicRoute(props.connectionId, topic);
    } else if (props.dialog === "consumers") {
      subscriptions.value = await mqListSubscriptions(props.connectionId, topic);
      selectedSubscription.value = subscriptions.value[0]?.name ?? "";
    } else if (props.dialog === "reset") {
      subscriptions.value = await loadResetSubscriptions(topic);
      selectedSubscription.value = subscriptions.value[0]?.name ?? "";
      if (resetMode.value === "timestamp" && !resetTimestamp.value) {
        resetTimestamp.value = formatDateTimeLocal(new Date());
      }
    } else if (props.dialog === "config") {
      const internal = await mqGetTopicInternalStats(props.connectionId, topic);
      applyConfigEntriesToForm(parseConfigEntries(internal));
    }
  } catch (e: unknown) {
    dialogError.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function saveConfig() {
  const topic = topicRef.value;
  if (!topic || props.readOnly) return;
  loading.value = true;
  dialogError.value = undefined;
  try {
    const configs = [
      { key: "readQueueNums", value: String(configForm.value.readQueueNums), op: "set" },
      { key: "writeQueueNums", value: String(configForm.value.writeQueueNums), op: "set" },
      { key: "perm", value: String(configForm.value.perm), op: "set" },
    ];
    await mqAlterTopicConfig(props.connectionId, topic, configs);
    emit("refreshed");
    closeDialog();
  } catch (e: unknown) {
    dialogError.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function confirmSkip() {
  const topic = topicRef.value;
  if (!topic || props.readOnly) return;
  if (!confirm(t("mqTopics.confirmSkip", { name: topic.topic }))) return;
  loading.value = true;
  dialogError.value = undefined;
  try {
    await mqSkipTopicAccumulation(props.connectionId, topic);
    emit("refreshed");
    closeDialog();
  } catch (e: unknown) {
    dialogError.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function confirmReset() {
  const topic = topicRef.value;
  if (!topic || props.readOnly || !selectedSubscription.value) return;
  loading.value = true;
  dialogError.value = undefined;
  try {
    let pos: ResetPosition;
    if (resetMode.value === "earliest") {
      pos = { kind: "earliest" };
    } else if (resetMode.value === "timestamp") {
      const ts = Date.parse(resetTimestamp.value);
      if (!Number.isFinite(ts)) {
        dialogError.value = t("mqTopics.invalidTimestamp");
        return;
      }
      pos = { kind: "timestamp", timestampMs: ts };
    } else {
      pos = { kind: "latest" };
    }
    await mqResetCursor(props.connectionId, topic, selectedSubscription.value, pos);
    emit("refreshed");
    closeDialog();
  } catch (e: unknown) {
    dialogError.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function navigateToSubscriptions(sub?: string) {
  emit("navigate", { tab: "subscriptions", subscription: sub });
  closeDialog();
}

watch(resetMode, (mode) => {
  if (mode === "timestamp" && !resetTimestamp.value) {
    resetTimestamp.value = formatDateTimeLocal(new Date());
  }
});

watch(
  () => [props.dialog, props.topic?.name],
  () => {
    statsRaw.value = undefined;
    routeRaw.value = undefined;
    configForm.value = { readQueueNums: 8, writeQueueNums: 8, perm: 6 };
    subscriptions.value = [];
    selectedSubscription.value = "";
    resetMode.value = "latest";
    resetTimestamp.value = "";
    if (props.dialog) void loadDialogData();
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="dialog && topic" class="dialog-overlay" @click="closeDialog">
    <div class="dialog dialog-wide" @click.stop>
      <div class="dialog-header">
        <h3>{{ dialogTitle }}</h3>
        <button class="btn-close" @click="closeDialog">×</button>
      </div>

      <div class="dialog-body">
        <div v-if="loading" class="dialog-loading">{{ t("mqTopics.loading") }}</div>
        <div v-else-if="dialogError" class="form-error">{{ dialogError }}</div>

        <template v-else-if="dialog === 'status'">
          <div v-if="!partitionStats.length" class="dialog-empty">{{ t("mqTopics.noQueueStats") }}</div>
          <table v-else class="data-table">
            <thead>
              <tr>
                <th>{{ t("mqTopics.queueId") }}</th>
                <th>{{ t("mqTopics.brokerName") }}</th>
                <th>{{ t("mqTopics.beginOffset") }}</th>
                <th>{{ t("mqTopics.endOffset") }}</th>
                <th>{{ t("mqTopics.messageCount") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, idx) in partitionStats" :key="idx">
                <td>{{ row.partition }}</td>
                <td>{{ row.brokerName }}</td>
                <td>{{ row.beginOffset }}</td>
                <td>{{ row.endOffset }}</td>
                <td>{{ row.messageCount }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <template v-else-if="dialog === 'route'">
          <h4>{{ t("mqTopics.routeQueues") }}</h4>
          <table v-if="queueDatas.length" class="data-table">
            <thead>
              <tr>
                <th>{{ t("mqTopics.brokerName") }}</th>
                <th>{{ t("mqTopics.readQueues") }}</th>
                <th>{{ t("mqTopics.writeQueues") }}</th>
                <th>{{ t("mqTopics.perm") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, idx) in queueDatas" :key="idx">
                <td>{{ row.brokerName }}</td>
                <td>{{ row.readQueueNums }}</td>
                <td>{{ row.writeQueueNums }}</td>
                <td>{{ row.perm }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="dialog-empty">{{ t("mqTopics.noRouteData") }}</div>

          <h4>{{ t("mqTopics.routeBrokers") }}</h4>
          <table v-if="brokerDatas.length" class="data-table">
            <thead>
              <tr>
                <th>{{ t("mqTopics.brokerName") }}</th>
                <th>{{ t("mqTopics.clusterName") }}</th>
                <th>{{ t("mqTopics.brokerAddrs") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, idx) in brokerDatas" :key="`b-${idx}`">
                <td>{{ row.brokerName }}</td>
                <td>{{ row.cluster }}</td>
                <td class="mono">{{ JSON.stringify(row.brokerAddrs ?? {}) }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <template v-else-if="dialog === 'consumers'">
          <div v-if="!subscriptions.length" class="dialog-empty">{{ t("mqTopics.noConsumers") }}</div>
          <table v-else class="data-table">
            <thead>
              <tr>
                <th>{{ t("mqSubscriptions.subscriptionName") }}</th>
                <th>{{ t("mqSubscriptions.type") }}</th>
                <th>{{ t("mqSubscriptions.backlog") }}</th>
                <th>{{ t("mqTopics.actions") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="sub in subscriptions" :key="sub.name">
                <td>{{ sub.name }}</td>
                <td>{{ sub.subType || "-" }}</td>
                <td>{{ sub.msgBacklog }}</td>
                <td>
                  <button class="btn-sm" @click="navigateToSubscriptions(sub.name)">{{ t("mqTopics.manageConsumers") }}</button>
                </td>
              </tr>
            </tbody>
          </table>
        </template>

        <template v-else-if="dialog === 'config'">
          <p class="config-hint">{{ t("mqTopics.topicConfigHint") }}</p>
          <div class="form-group">
            <label>{{ t("mqTopics.readQueues") }}</label>
            <input v-model.number="configForm.readQueueNums" type="number" min="1" :disabled="readOnly" />
          </div>
          <div class="form-group">
            <label>{{ t("mqTopics.writeQueues") }}</label>
            <input v-model.number="configForm.writeQueueNums" type="number" min="1" :disabled="readOnly" />
          </div>
          <div class="form-group">
            <label>{{ t("mqTopics.perm") }}</label>
            <select v-model.number="configForm.perm" :disabled="readOnly">
              <option :value="6">{{ t("mqTopics.permReadWrite") }}</option>
              <option :value="4">{{ t("mqTopics.permRead") }}</option>
              <option :value="2">{{ t("mqTopics.permWrite") }}</option>
            </select>
          </div>
        </template>

        <template v-else-if="dialog === 'reset'">
          <div class="form-group">
            <label>{{ t("mqSubscriptions.subscriptionName") }}</label>
            <select v-model="selectedSubscription" :disabled="readOnly || !subscriptions.length">
              <option v-if="!subscriptions.length" disabled value="">{{ t("mqTopics.noConsumerGroups") }}</option>
              <option v-for="sub in subscriptions" :key="sub.name" :value="sub.name">{{ sub.name }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>{{ t("mqTopics.resetPosition") }}</label>
            <select v-model="resetMode" :disabled="readOnly">
              <option value="latest">{{ t("mqTopics.positionLatest") }}</option>
              <option value="earliest">{{ t("mqTopics.positionEarliest") }}</option>
              <option value="timestamp">{{ t("mqTopics.positionTimestamp") }}</option>
            </select>
          </div>
          <div v-if="resetMode === 'timestamp'" class="form-group">
            <label>{{ t("mqTopics.timestamp") }}</label>
            <input v-model="resetTimestamp" class="datetime-input" type="datetime-local" step="60" :disabled="readOnly" />
            <div v-if="resetTimestamp" class="form-hint">
              {{ t("mqTopics.resetTimePreview", { time: new Date(resetTimestamp).toLocaleString() }) }}
            </div>
          </div>
        </template>

        <template v-else-if="dialog === 'skip'">
          <p>{{ t("mqTopics.skipHint") }}</p>
        </template>
      </div>

      <div class="dialog-footer">
        <button class="btn-secondary" @click="closeDialog">{{ t("mqTopics.cancel") }}</button>
        <button v-if="dialog === 'config' && !readOnly" class="btn-primary" :disabled="loading" @click="saveConfig">
          {{ t("mqTopics.saveConfig") }}
        </button>
        <button v-else-if="dialog === 'reset' && !readOnly" class="btn-primary" :disabled="loading || !selectedSubscription" @click="confirmReset">
          {{ t("mqTopics.actionReset") }}
        </button>
        <button v-else-if="dialog === 'skip' && !readOnly" class="btn-primary" :disabled="loading" @click="confirmSkip">
          {{ t("mqTopics.actionSkip") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  background: var(--color-background);
  border-radius: var(--dbx-radius-fixed-6);
  width: 90%;
  max-width: 520px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.dialog-wide {
  max-width: 760px;
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}

.dialog-header h3 {
  margin: 0;
  font-size: 18px;
}

.btn-close {
  border: none;
  background: none;
  font-size: 24px;
  cursor: pointer;
  color: var(--color-text-secondary);
}

.dialog-body {
  padding: 20px;
  overflow-y: auto;
}

.dialog-body h4 {
  margin: 16px 0 8px;
  font-size: 14px;
  color: var(--color-text-secondary);
}

.dialog-body h4:first-child {
  margin-top: 0;
}

.dialog-loading,
.dialog-empty {
  padding: 16px;
  text-align: center;
  color: var(--color-text-secondary);
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin-bottom: 12px;
}

.data-table th,
.data-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border);
  text-align: left;
}

.data-table th {
  color: var(--color-text-secondary);
  font-weight: 600;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  word-break: break-all;
}

.config-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.config-row {
  display: grid;
  grid-template-columns: 1fr 1.5fr;
  gap: 8px;
}

.config-key,
.config-value {
  padding: 7px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  font-size: 13px;
}

.form-group {
  margin-bottom: 14px;
}

.config-hint {
  margin: 0 0 14px;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 500;
}

.form-group select,
.form-group input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  box-sizing: border-box;
  background: var(--color-background);
  color: var(--color-text);
  font-size: 13px;
}

.form-group select {
  appearance: auto;
}

.datetime-input {
  color-scheme: light dark;
}

.datetime-input::-webkit-calendar-picker-indicator {
  cursor: pointer;
  opacity: 0.75;
}

.form-hint {
  margin-top: 6px;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.form-error {
  padding: 8px 12px;
  background: var(--color-error-bg);
  color: var(--color-error);
  border-radius: var(--dbx-radius-fixed-4);
  font-size: 13px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid var(--color-border);
}

.btn-primary,
.btn-secondary,
.btn-sm {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  background: var(--color-background);
  cursor: pointer;
  font-size: 13px;
}

.btn-primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: #fff;
}

.btn-sm {
  padding: 4px 8px;
  font-size: 12px;
}

button:disabled,
input:disabled,
select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

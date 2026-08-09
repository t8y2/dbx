<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ConsumerInfo, PartitionBacklog, RocketMqConsumerGroupConfig, SubscriptionInfo, TopicRef } from "@/types/mq";
import { mqAlterConsumerGroupConfig, mqGetBacklog, mqGetConsumerGroupConfig, mqListConsumers } from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import { resolveRocketMqConsumerGroupMessageModel, resolveRocketMqConsumerGroupType } from "@/lib/mq/rocketmqConsumerGroupTypes";
import { useMqMutationGuard } from "@/composables/useMqMutationGuard";

export type RocketMqConsumerGroupDialogKind = "detail" | "config";

interface TopicConsumeDetail {
  topic: string;
  /** Undefined when backlog probe failed — do not render as healthy zero. */
  delay?: number;
  lastTimestamp?: number;
  partitions: PartitionBacklog[];
  error?: string;
}

interface Props {
  connectionId: string;
  tenant?: string;
  namespace?: string;
  group?: SubscriptionInfo;
  dialog?: RocketMqConsumerGroupDialogKind | null;
  readOnly?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  close: [];
  refreshed: [];
}>();

const { t } = useI18n();
const { confirmMqWrite } = useMqMutationGuard(() => props.connectionId);

const loading = ref(false);
const dialogError = ref<string>();
const terminals = ref<ConsumerInfo[]>([]);
const topicConsumeDetails = ref<TopicConsumeDetail[]>([]);
/** Drops stale detail/config responses when enrich reloads the open dialog. */
let detailLoadSeq = 0;
let configLoadSeq = 0;
const configForm = ref<RocketMqConsumerGroupConfig>({
  groupName: "",
  consumeEnable: true,
  consumeFromMinEnable: false,
  consumeBroadcastEnable: false,
  consumeMessageOrderly: false,
  retryQueueNums: 1,
  retryMaxTimes: 16,
  brokerId: 0,
  whichBrokerWhenConsumeSlowly: 0,
});

const subscribedTopics = computed(() => [...new Set((props.group?.topics ?? []).map((topic) => topic.trim()).filter(Boolean))]);
const groupTypeLabel = computed(() => {
  if (!props.group) return "-";
  return t(`mqSubscriptions.rocketmqGroupType.${resolveRocketMqConsumerGroupType(props.group).toLowerCase()}`);
});
const groupModeLabel = computed(() => {
  if (!props.group) return "-";
  return t(`mqSubscriptions.rocketmqGroupMode.${resolveRocketMqConsumerGroupMessageModel(props.group).toLowerCase()}`);
});

function buildTopicRef(topicName: string): TopicRef | null {
  if (!props.tenant || !props.namespace) return null;
  return {
    tenant: props.tenant,
    namespace: props.namespace,
    topic: topicName,
    persistent: true,
    partitioned: false,
  };
}

function closeDialog() {
  dialogError.value = undefined;
  emit("close");
}

/** Format consume timestamp; treat missing/zero as unavailable (avoid epoch display). */
function formatConsumeTimestamp(ms?: number | null): string {
  if (ms == null || ms <= 0) return "-";
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function partitionRowKey(topic: string, partition: PartitionBacklog, index: number): string {
  return `${topic}:${partition.brokerName ?? ""}:${partition.partition}:${index}`;
}

async function loadDetail() {
  if (!props.group || !props.tenant || !props.namespace) return;
  const seq = ++detailLoadSeq;
  loading.value = true;
  dialogError.value = undefined;
  terminals.value = [];
  topicConsumeDetails.value = [];
  try {
    const topicRef = buildTopicRef("");
    if (topicRef) {
      const online = await mqListConsumers(props.connectionId, topicRef, props.group.name);
      if (seq !== detailLoadSeq) return;
      terminals.value = online;
    }
    const topics = subscribedTopics.value;
    const detailRows = await Promise.all(
      topics.map(async (topic) => {
        const ref = buildTopicRef(topic);
        if (!ref) {
          return { topic, partitions: [] as PartitionBacklog[], error: t("mqSubscriptions.invalidTopicScope") };
        }
        try {
          const stats = await mqGetBacklog(props.connectionId, ref, props.group!.name);
          const partitions = stats.partitions ?? [];
          // Topic-level last consume time = max of queue lastTimestamp values (> 0).
          const lastTimestamp = partitions
            .map((p) => p.lastTimestamp ?? 0)
            .filter((ts) => ts > 0)
            .reduce<number | undefined>((max, ts) => (max == null || ts > max ? ts : max), undefined);
          return {
            topic,
            delay: stats.msgBacklog,
            lastTimestamp,
            partitions,
          };
        } catch (e: unknown) {
          // Keep offsets empty; omit delay so the row does not look like lag=0.
          return {
            topic,
            partitions: [] as PartitionBacklog[],
            error: formatError(e) || String(e),
          };
        }
      }),
    );
    if (seq !== detailLoadSeq) return;
    topicConsumeDetails.value = detailRows;
    const backlogFailures = detailRows.filter((row) => row.error);
    if (backlogFailures.length) {
      dialogError.value = t("mqSubscriptions.backlogPartialFailed", {
        count: backlogFailures.length,
        error: backlogFailures[0]?.error ?? "",
      });
    }
  } catch (e: unknown) {
    if (seq === detailLoadSeq) dialogError.value = formatError(e);
  } finally {
    if (seq === detailLoadSeq) loading.value = false;
  }
}

function resetConfigForm(groupName: string) {
  configForm.value = {
    groupName,
    consumeEnable: true,
    consumeFromMinEnable: false,
    consumeBroadcastEnable: false,
    consumeMessageOrderly: false,
    retryQueueNums: 1,
    retryMaxTimes: 16,
    brokerId: 0,
    whichBrokerWhenConsumeSlowly: 0,
  };
}

async function loadConfig() {
  if (!props.group) return;
  const seq = ++configLoadSeq;
  resetConfigForm(props.group.name);
  loading.value = true;
  dialogError.value = undefined;
  try {
    const config = await mqGetConsumerGroupConfig(props.connectionId, props.group.name);
    if (seq !== configLoadSeq) return;
    configForm.value = {
      groupName: config.groupName || props.group.name,
      consumeEnable: config.consumeEnable ?? true,
      consumeFromMinEnable: config.consumeFromMinEnable ?? false,
      consumeBroadcastEnable: config.consumeBroadcastEnable ?? false,
      consumeMessageOrderly: config.consumeMessageOrderly ?? false,
      retryQueueNums: config.retryQueueNums ?? 1,
      retryMaxTimes: config.retryMaxTimes ?? 16,
      brokerId: config.brokerId ?? 0,
      whichBrokerWhenConsumeSlowly: config.whichBrokerWhenConsumeSlowly ?? 0,
    };
  } catch (e: unknown) {
    if (seq === configLoadSeq) dialogError.value = formatError(e);
  } finally {
    if (seq === configLoadSeq) loading.value = false;
  }
}

async function saveConfig() {
  if (!props.group || props.readOnly) return;
  if (!(await confirmMqWrite(t("mqSubscriptions.editConfig")))) return;
  loading.value = true;
  dialogError.value = undefined;
  try {
    await mqAlterConsumerGroupConfig(props.connectionId, props.group.name, {
      consumeEnable: configForm.value.consumeEnable,
      consumeFromMinEnable: configForm.value.consumeFromMinEnable,
      consumeBroadcastEnable: configForm.value.consumeBroadcastEnable,
      consumeMessageOrderly: configForm.value.consumeMessageOrderly,
      retryQueueNums: configForm.value.retryQueueNums,
      retryMaxTimes: configForm.value.retryMaxTimes,
      brokerId: configForm.value.brokerId,
      whichBrokerWhenConsumeSlowly: configForm.value.whichBrokerWhenConsumeSlowly,
    });
    emit("refreshed");
    closeDialog();
  } catch (e: unknown) {
    dialogError.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

watch(
  // Detail reloads when enrich fills topics; config must not reset the form on topics-only updates.
  () => [props.dialog, props.group?.name, (props.group?.topics ?? []).join("\0")] as const,
  () => {
    if (props.dialog === "detail") {
      void loadDetail();
    }
  },
  { immediate: true },
);

watch(
  () => [props.dialog, props.group?.name] as const,
  () => {
    if (props.dialog === "config") {
      void loadConfig();
    }
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="dialog && group" class="dialog-overlay" @click="closeDialog">
    <div class="dialog" :class="{ 'dialog-wide': dialog === 'detail' }" @click.stop>
      <div class="dialog-header">
        <h3>
          {{ dialog === "detail" ? t("mqSubscriptions.consumerDetailTitle", { name: group.name }) : t("mqSubscriptions.consumerConfigTitle", { name: group.name }) }}
        </h3>
        <button class="btn-close" @click="closeDialog">×</button>
      </div>

      <div class="dialog-body">
        <div v-if="dialog === 'detail'" class="detail-sections">
          <section class="detail-section">
            <h4>{{ t("mqSubscriptions.consumerOverview") }}</h4>
            <div class="detail-grid">
              <span>{{ t("mqSubscriptions.type") }}</span
              ><span>{{ groupTypeLabel }}</span> <span>{{ t("mqSubscriptions.mode") }}</span
              ><span>{{ groupModeLabel }}</span> <span>{{ t("mqSubscriptions.consumers") }}</span
              ><span>{{ group.onlineMembers == null ? "-" : group.onlineMembers }}</span>
              <span>{{ t("mqSubscriptions.subscribedTopics") }}</span>
              <span>{{ subscribedTopics.length ? subscribedTopics.join(", ") : "-" }}</span>
            </div>
          </section>

          <section class="detail-section">
            <div class="section-heading">
              <h4>{{ t("mqSubscriptions.consumerTerminals") }}</h4>
              <button class="btn-sm" :disabled="loading" @click="loadDetail">
                {{ loading ? t("mqSubscriptions.loading") : t("mqSubscriptions.refresh") }}
              </button>
            </div>
            <div v-if="loading && !terminals.length" class="panel-loading">{{ t("mqSubscriptions.loading") }}</div>
            <div v-else-if="!terminals.length" class="panel-placeholder">{{ t("mqSubscriptions.noOnlineConsumers") }}</div>
            <table v-else class="detail-table">
              <thead>
                <tr>
                  <th>{{ t("mqClients.name") }}</th>
                  <th>{{ t("mqClients.address") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="terminal in terminals" :key="`${terminal.consumerName}-${terminal.address}`">
                  <td>{{ terminal.consumerName }}</td>
                  <td>{{ terminal.address || "-" }}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section class="detail-section">
            <h4>{{ t("mqSubscriptions.consumerConsumeDetail") }}</h4>
            <div v-if="loading && !topicConsumeDetails.length" class="panel-loading">{{ t("mqSubscriptions.loading") }}</div>
            <div v-else-if="!topicConsumeDetails.length" class="panel-placeholder">{{ t("mqSubscriptions.noConsumeDetail") }}</div>
            <div v-else class="consume-detail-list">
              <div v-for="detail in topicConsumeDetails" :key="detail.topic" class="consume-topic-block">
                <div class="consume-topic-header">
                  <span
                    ><strong>{{ t("mqSubscriptions.operationTopic") }}:</strong> {{ detail.topic }}</span
                  >
                  <span
                    ><strong>{{ t("mqSubscriptions.consumeDelay") }}:</strong> {{ detail.delay == null ? "-" : detail.delay.toLocaleString() }}</span
                  >
                  <span
                    ><strong>{{ t("mqSubscriptions.lastConsumeTime") }}:</strong> {{ formatConsumeTimestamp(detail.lastTimestamp) }}</span
                  >
                </div>
                <div v-if="detail.error" class="panel-placeholder panel-placeholder-compact form-error">
                  {{ detail.error }}
                </div>
                <div v-else-if="!detail.partitions.length" class="panel-placeholder panel-placeholder-compact">
                  {{ t("mqSubscriptions.noQueueConsumeProgress") }}
                </div>
                <div v-else class="detail-table-scroll">
                  <table class="detail-table detail-table-wide">
                    <thead>
                      <tr>
                        <th>{{ t("mqSubscriptions.broker") }}</th>
                        <th>{{ t("mqSubscriptions.queue") }}</th>
                        <th>{{ t("mqSubscriptions.consumerClient") }}</th>
                        <th>{{ t("mqSubscriptions.brokerOffset") }}</th>
                        <th>{{ t("mqSubscriptions.consumerOffset") }}</th>
                        <th>{{ t("mqSubscriptions.diffTotal") }}</th>
                        <th>{{ t("mqSubscriptions.lastTimestamp") }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(partition, index) in detail.partitions" :key="partitionRowKey(detail.topic, partition, index)">
                        <td>{{ partition.brokerName || "-" }}</td>
                        <td>{{ partition.partition }}</td>
                        <td>{{ partition.consumerClient || "-" }}</td>
                        <td>{{ partition.endOffset.toLocaleString() }}</td>
                        <td>{{ partition.currentOffset.toLocaleString() }}</td>
                        <td>{{ partition.lag.toLocaleString() }}</td>
                        <td>{{ formatConsumeTimestamp(partition.lastTimestamp) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>
        </div>

        <div v-else class="config-form">
          <div class="form-group">
            <label>{{ t("mqSubscriptions.subscriptionName") }}</label>
            <input type="text" :value="configForm.groupName || group.name" disabled />
          </div>
          <div class="form-group checkbox-row">
            <label class="checkbox-label">
              <input v-model="configForm.consumeEnable" type="checkbox" :disabled="readOnly" />
              {{ t("mqSubscriptions.consumeEnable") }}
            </label>
            <label class="checkbox-label">
              <input v-model="configForm.consumeBroadcastEnable" type="checkbox" :disabled="readOnly" />
              {{ t("mqSubscriptions.consumeBroadcastEnable") }}
            </label>
            <label class="checkbox-label">
              <input v-model="configForm.consumeFromMinEnable" type="checkbox" :disabled="readOnly" />
              {{ t("mqSubscriptions.consumeFromMinEnable") }}
            </label>
            <label class="checkbox-label">
              <input v-model="configForm.consumeMessageOrderly" type="checkbox" :disabled="readOnly" />
              {{ t("mqSubscriptions.consumeMessageOrderly") }}
            </label>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>{{ t("mqSubscriptions.retryQueueNums") }}</label>
              <input v-model.number="configForm.retryQueueNums" type="number" min="1" :disabled="readOnly" />
            </div>
            <div class="form-group">
              <label>{{ t("mqSubscriptions.retryMaxTimes") }}</label>
              <input v-model.number="configForm.retryMaxTimes" type="number" min="0" :disabled="readOnly" />
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>{{ t("mqSubscriptions.brokerId") }}</label>
              <input v-model.number="configForm.brokerId" type="number" min="0" :disabled="readOnly" />
            </div>
            <div class="form-group">
              <label>{{ t("mqSubscriptions.whichBrokerWhenConsumeSlowly") }}</label>
              <input v-model.number="configForm.whichBrokerWhenConsumeSlowly" type="number" min="0" :disabled="readOnly" />
            </div>
          </div>
        </div>

        <div v-if="dialogError" class="form-error">{{ dialogError }}</div>
      </div>

      <div class="dialog-footer">
        <button class="btn-secondary" @click="closeDialog">{{ t("mqSubscriptions.close") }}</button>
        <button v-if="dialog === 'config'" class="btn-primary" :disabled="loading || readOnly" @click="saveConfig">
          {{ t("mqSubscriptions.save") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import "../shared/mqPanel.css";

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
  width: 92%;
  max-width: 560px;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.dialog-wide {
  max-width: 1100px;
}

.dialog-header,
.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}

.dialog-footer {
  justify-content: flex-end;
  border-bottom: 0;
  border-top: 1px solid var(--color-border);
}

.dialog-header h3 {
  margin: 0;
  font-size: 18px;
}

.dialog-body {
  padding: 20px;
  overflow: auto;
}

.detail-sections {
  display: grid;
  gap: 18px;
}

.detail-section h4,
.section-heading h4 {
  margin: 0 0 10px;
  font-size: 14px;
}

.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.detail-grid {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 8px 12px;
  font-size: 13px;
}

.consume-detail-list {
  display: grid;
  gap: 16px;
}

.consume-topic-block {
  display: grid;
  gap: 8px;
}

.consume-topic-header {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 20px;
  font-size: 13px;
  color: var(--color-text);
}

.detail-table-scroll {
  overflow-x: auto;
}

.detail-table {
  width: 100%;
  border-collapse: collapse;
}

.detail-table-wide {
  min-width: 720px;
}

.detail-table th,
.detail-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border-light);
  text-align: left;
  font-size: 13px;
  white-space: nowrap;
}

.detail-table th {
  color: var(--color-text-secondary);
  font-weight: 600;
}

.form-group {
  margin-bottom: 14px;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 500;
}

.form-group input[type="text"],
.form-group input[type="number"] {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  box-sizing: border-box;
  background: var(--color-background);
  color: var(--color-text);
}

.form-row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.checkbox-row {
  display: grid;
  gap: 8px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.panel-loading,
.panel-placeholder {
  padding: 16px;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.panel-placeholder-compact {
  padding: 10px;
}

.form-error {
  margin-top: 12px;
  padding: 8px 12px;
  background: var(--color-error-bg);
  color: var(--color-error);
  border-radius: var(--dbx-radius-fixed-4);
  font-size: 13px;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>

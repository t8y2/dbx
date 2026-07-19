<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ConsumerInfo, RocketMqConsumerGroupConfig, SubscriptionInfo, TopicRef } from "@/types/mq";
import { mqAlterConsumerGroupConfig, mqGetBacklog, mqGetConsumerGroupConfig, mqListConsumers } from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import { resolveRocketMqConsumerGroupMessageModel, resolveRocketMqConsumerGroupType } from "@/lib/mq/rocketmqConsumerGroupTypes";

export type RocketMqConsumerGroupDialogKind = "detail" | "config";

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

const loading = ref(false);
const dialogError = ref<string>();
const terminals = ref<ConsumerInfo[]>([]);
const topicBacklogs = ref<Array<{ topic: string; backlog: number }>>([]);
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

async function loadDetail() {
  if (!props.group || !props.tenant || !props.namespace) return;
  loading.value = true;
  dialogError.value = undefined;
  terminals.value = [];
  topicBacklogs.value = [];
  try {
    const topicRef = buildTopicRef("");
    if (topicRef) {
      terminals.value = await mqListConsumers(props.connectionId, topicRef, props.group.name);
    }
    const topics = subscribedTopics.value;
    const backlogRows = await Promise.all(
      topics.map(async (topic) => {
        const ref = buildTopicRef(topic);
        if (!ref) return { topic, backlog: 0 };
        try {
          const stats = await mqGetBacklog(props.connectionId, ref, props.group!.name);
          return { topic, backlog: stats.msgBacklog };
        } catch {
          return { topic, backlog: 0 };
        }
      }),
    );
    topicBacklogs.value = backlogRows;
  } catch (e: unknown) {
    dialogError.value = formatError(e);
  } finally {
    loading.value = false;
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
  resetConfigForm(props.group.name);
  loading.value = true;
  dialogError.value = undefined;
  try {
    const config = await mqGetConsumerGroupConfig(props.connectionId, props.group.name);
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
    dialogError.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function saveConfig() {
  if (!props.group || props.readOnly) return;
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
  () => [props.dialog, props.group?.name],
  () => {
    if (props.dialog === "detail") {
      void loadDetail();
    } else if (props.dialog === "config") {
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
              ><span>{{ group.onlineMembers ?? 0 }}</span>
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
            <div v-if="!topicBacklogs.length" class="panel-placeholder">{{ t("mqSubscriptions.noConsumeDetail") }}</div>
            <table v-else class="detail-table">
              <thead>
                <tr>
                  <th>{{ t("mqSubscriptions.operationTopic") }}</th>
                  <th>{{ t("mqSubscriptions.backlog") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in topicBacklogs" :key="row.topic">
                  <td>{{ row.topic }}</td>
                  <td>{{ row.backlog.toLocaleString() }}</td>
                </tr>
              </tbody>
            </table>
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
  border-radius: 8px;
  width: 92%;
  max-width: 560px;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.dialog-wide {
  max-width: 860px;
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

.btn-close {
  border: none;
  background: none;
  font-size: 24px;
  cursor: pointer;
  color: var(--color-text-secondary);
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

.detail-table {
  width: 100%;
  border-collapse: collapse;
}

.detail-table th,
.detail-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border-light);
  text-align: left;
  font-size: 13px;
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
  border-radius: 4px;
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

.form-error {
  margin-top: 12px;
  padding: 8px 12px;
  background: var(--color-error-bg);
  color: var(--color-error);
  border-radius: 4px;
  font-size: 13px;
}

.btn-primary,
.btn-secondary,
.btn-sm {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;
}

.btn-primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: #fff;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

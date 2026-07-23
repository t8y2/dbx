<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { MqSystemKind, SendMessageRequest, SendMessageResponse, TopicInfo, TopicRef } from "@/types/mq";
import { mqViewMessage, mqQueryMessagesByKey, mqQueryMessagesByTopic, mqSendMessage, mqPeekMessages } from "@/lib/backend/api";
import { formatRocketMqMessagePayload, formatRocketMqTimestamp, parseRocketMqMessagesFromResult, rocketMqDisplayFromPeeked, rocketMqMessagePayload, type RocketMqDisplayMessage } from "@/lib/mq/rocketmqMessageUtils";
import { formatError } from "@/lib/backend/errorUtils";
import { copyToClipboard } from "@/lib/common/clipboard";
import { buildRocketMqTraceTopicOptions, DEFAULT_ROCKETMQ_TRACE_TOPIC, resolveRocketMqMessageType } from "@/lib/mq/rocketmqTopicTypes";
import RocketMqTraceDetailDialog from "./RocketMqTraceDetailDialog.vue";
import RocketMqTopicSelect from "./shared/RocketMqTopicSelect.vue";
import RocketMqMessageDetailDialog from "./shared/RocketMqMessageDetailDialog.vue";

interface Props {
  connectionId: string;
  tenant?: string;
  namespace?: string;
  topic?: TopicInfo;
  readOnly?: boolean;
  mqSystemKind?: MqSystemKind;
  embedded?: boolean;
  preferDlqTopic?: boolean;
  tracePanel?: boolean;
}

const props = defineProps<Props>();
const { t } = useI18n();

const topicSelectRef = ref<InstanceType<typeof RocketMqTopicSelect>>();
const availableTopics = ref<TopicInfo[]>([]);
const topicsLoading = computed(() => topicSelectRef.value?.loading ?? false);
const topicName = ref("");
const queryMsgId = ref("");
const queryKey = ref("");
const queryBeginTime = ref("");
const queryEndTime = ref("");
const queryMaxNum = ref(32);
const queryLoading = ref(false);
const queryError = ref<string>();
const queryMessages = ref<RocketMqDisplayMessage[]>([]);
const activeQueryMode = ref<"topic" | "key" | "msgId">("topic");
const selectedMessage = ref<RocketMqDisplayMessage>();
const detailLoading = ref(false);
const detailError = ref<string>();
const resendLoading = ref(false);
const resendError = ref<string>();
const resendSuccess = ref<SendMessageResponse>();
const payloadCopied = ref(false);
const traceDialogOpen = ref(false);
const traceMsgId = ref("");
const traceTopic = ref(DEFAULT_ROCKETMQ_TRACE_TOPIC);
const consumerGroup = ref("");
const dlqUseKeyQuery = ref(false);
const noDlqTopics = ref(false);

let payloadCopiedTimer: ReturnType<typeof setTimeout> | undefined;
let resendSuccessTimer: ReturnType<typeof setTimeout> | undefined;

const isRocketMqCluster = computed(() => props.mqSystemKind === "rocketmq");
const isDlqTopicSelected = computed(() => {
  if (props.tracePanel) return false;
  if (!isRocketMqCluster.value || !topicName.value.trim()) return false;
  const fromList = availableTopics.value.find((item) => item.shortName === topicName.value.trim());
  if (fromList) return resolveRocketMqMessageType(fromList) === "DLQ";
  return topicSelectRef.value?.resolveTopicType(topicName.value) === "DLQ";
});
const showBusinessQueryModes = computed(() => !isDlqTopicSelected.value);
const canViewMessageTrace = computed(() => isRocketMqCluster.value && showBusinessQueryModes.value);
const traceTopicOptions = computed(() => buildRocketMqTraceTopicOptions(availableTopics.value));
const contextPlaceholder = computed(() => (isRocketMqCluster.value ? t("mqRocketmq.connectionNotReady") : t("mqMessages.selectNamespaceOrTopicFirst")));

const selectedTopicRef = computed<TopicRef | null>(() => {
  const topic = topicName.value.trim();
  if (!topic || !props.tenant || !props.namespace) return null;
  const selected = availableTopics.value.find((item) => item.shortName === topic);
  return {
    tenant: props.tenant,
    namespace: props.namespace,
    topic,
    persistent: selected?.persistent ?? true,
    partitioned: selected?.partitioned,
  };
});

const detailPayload = computed(() => (selectedMessage.value ? rocketMqMessagePayload(selectedMessage.value) : ""));
const formattedDetailPayload = computed(() => formatRocketMqMessagePayload(detailPayload.value));
const resendTopic = computed(() => selectedMessage.value?.topic?.trim() || selectedTopicRef.value?.topic || topicName.value.trim());
const canResend = computed(() => !props.readOnly && !isDlqTopicSelected.value && !!resendTopic.value && !!detailPayload.value.trim());

const detailHeaders = computed(() => {
  const headers = selectedMessage.value?.headers ?? {};
  return Object.entries(headers).filter(([key]) => key !== "TAGS");
});

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toDatetimeLocalValue(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function defaultTimeRange(): { begin: string; end: string } {
  const begin = new Date();
  begin.setHours(0, 0, 0, 0);
  const end = new Date(begin);
  end.setDate(end.getDate() + 1);
  return {
    begin: toDatetimeLocalValue(begin),
    end: toDatetimeLocalValue(end),
  };
}

async function loadTopics() {
  await topicSelectRef.value?.loadTopics();
}

function handleTopicsLoaded(topics: TopicInfo[]) {
  availableTopics.value = topics;
  noDlqTopics.value = !topics.some((topic) => resolveRocketMqMessageType(topic) === "DLQ");
  if (props.preferDlqTopic) {
    const firstDlq = topics.find((topic) => resolveRocketMqMessageType(topic) === "DLQ");
    if (firstDlq) topicName.value = firstDlq.shortName;
  } else if (props.topic && !topicName.value) {
    topicName.value = props.topic.shortName;
  } else if (!topicName.value && topics.length === 1) {
    topicName.value = topics[0].shortName;
  }
  if (!traceTopicOptions.value.includes(traceTopic.value)) {
    traceTopic.value = DEFAULT_ROCKETMQ_TRACE_TOPIC;
  }
}

async function runQuery() {
  const topic = selectedTopicRef.value;
  if (!topic) {
    queryError.value = t("mqMessages.selectTopicBeforeLoad");
    return;
  }
  queryLoading.value = true;
  queryError.value = undefined;
  queryMessages.value = [];
  selectedMessage.value = undefined;
  try {
    if (isDlqTopicSelected.value) {
      if (dlqUseKeyQuery.value && queryKey.value.trim()) {
        const end = Date.now();
        const begin = end - 7 * 24 * 60 * 60 * 1000;
        const result = await mqQueryMessagesByKey(props.connectionId, topic, queryKey.value.trim(), begin, end, 64);
        queryMessages.value = parseRocketMqMessagesFromResult(result);
      } else {
        const group = consumerGroup.value.trim() || "__dbx_rocketmq_dlq__";
        const peeked = await mqPeekMessages(props.connectionId, topic, group, 64);
        queryMessages.value = peeked.map((msg) => rocketMqDisplayFromPeeked(msg, topic.topic));
      }
    } else if (activeQueryMode.value === "msgId") {
      const id = queryMsgId.value.trim();
      if (!id) throw new Error(t("mqMessages.msgIdRequired"));
      const result = await mqViewMessage(props.connectionId, topic, id);
      queryMessages.value = parseRocketMqMessagesFromResult(result);
    } else {
      const begin = queryBeginTime.value ? Date.parse(queryBeginTime.value) : 0;
      const end = queryEndTime.value ? Date.parse(queryEndTime.value) : Date.now();
      const maxNum = Math.max(1, Math.min(200, Number(queryMaxNum.value) || 32));
      if (activeQueryMode.value === "key") {
        const key = queryKey.value.trim();
        if (!key) throw new Error(t("mqMessages.queryKeyRequired"));
        // Dashboard key query only needs topic + key; broker returns up to 64 recent matches.
        const result = await mqQueryMessagesByKey(props.connectionId, topic, key, 0, Date.now(), 64);
        queryMessages.value = parseRocketMqMessagesFromResult(result);
      } else {
        const result = await mqQueryMessagesByTopic(props.connectionId, topic, begin, end, maxNum);
        queryMessages.value = parseRocketMqMessagesFromResult(result);
      }
    }
  } catch (e: unknown) {
    queryError.value = formatError(e);
  } finally {
    queryLoading.value = false;
  }
}

async function viewMessageDetails(message: RocketMqDisplayMessage) {
  const topic = selectedTopicRef.value;
  const msgId = message.messageId?.trim();
  resendError.value = undefined;
  resendSuccess.value = undefined;
  payloadCopied.value = false;
  if (isDlqTopicSelected.value || !topic || !msgId) {
    selectedMessage.value = message;
    detailError.value = undefined;
    return;
  }
  detailLoading.value = true;
  detailError.value = undefined;
  try {
    const result = await mqViewMessage(props.connectionId, topic, msgId);
    const rows = parseRocketMqMessagesFromResult(result);
    selectedMessage.value = rows[0] ?? message;
  } catch (e: unknown) {
    detailError.value = formatError(e);
    selectedMessage.value = message;
  } finally {
    detailLoading.value = false;
  }
}

function closeDetails() {
  selectedMessage.value = undefined;
  detailError.value = undefined;
  resendError.value = undefined;
  resendSuccess.value = undefined;
  payloadCopied.value = false;
}

function openTraceDialog(message: RocketMqDisplayMessage) {
  const msgId = message.messageId?.trim();
  if (!msgId) return;
  traceMsgId.value = msgId;
  traceDialogOpen.value = true;
}

function closeTraceDialog() {
  traceDialogOpen.value = false;
  traceMsgId.value = "";
}

async function copyPayload() {
  const text = detailPayload.value;
  if (!text) return;
  try {
    await copyToClipboard(text);
    payloadCopied.value = true;
    if (payloadCopiedTimer) clearTimeout(payloadCopiedTimer);
    payloadCopiedTimer = setTimeout(() => {
      payloadCopied.value = false;
    }, 2000);
  } catch (e: unknown) {
    detailError.value = formatError(e);
  }
}

function clearResendSuccessLater() {
  if (resendSuccessTimer) clearTimeout(resendSuccessTimer);
  resendSuccessTimer = setTimeout(() => {
    resendSuccess.value = undefined;
  }, 4000);
}

async function resendMessage() {
  if (props.readOnly) {
    resendError.value = t("mqMessages.readOnlyCannotSend");
    return;
  }
  const topic = resendTopic.value;
  const payloadText = detailPayload.value.trim();
  if (!topic) {
    resendError.value = t("mqMessages.selectTargetTopic");
    return;
  }
  if (!payloadText) {
    resendError.value = t("mqMessages.messageContentRequired");
    return;
  }

  resendLoading.value = true;
  resendError.value = undefined;
  resendSuccess.value = undefined;
  try {
    const message = selectedMessage.value;
    const headers: Record<string, string> = { ...(message?.headers ?? {}) };
    if (isRocketMqCluster.value && message?.tag?.trim()) {
      headers.TAGS = message.tag.trim();
    }
    const req: SendMessageRequest = {
      topic,
      key: message?.key?.trim() || undefined,
      payloadBase64: btoa(unescape(encodeURIComponent(payloadText))),
      payloadText,
      headers,
    };
    resendSuccess.value = await mqSendMessage(props.connectionId, req);
    clearResendSuccessLater();
  } catch (e: unknown) {
    resendError.value = formatError(e);
  } finally {
    resendLoading.value = false;
  }
}

onUnmounted(() => {
  if (payloadCopiedTimer) clearTimeout(payloadCopiedTimer);
  if (resendSuccessTimer) clearTimeout(resendSuccessTimer);
});

watch(
  () => [props.tenant, props.namespace],
  () => {
    const range = defaultTimeRange();
    queryBeginTime.value = range.begin;
    queryEndTime.value = range.end;
    queryMessages.value = [];
    selectedMessage.value = undefined;
  },
  { immediate: true },
);

watch(
  () => props.topic,
  (newTopic) => {
    if (newTopic) {
      topicName.value = newTopic.shortName;
    }
  },
);

watch(isDlqTopicSelected, (isDlq) => {
  queryError.value = undefined;
  queryMessages.value = [];
  selectedMessage.value = undefined;
  if (isDlq) {
    dlqUseKeyQuery.value = false;
  }
});

watch(activeQueryMode, () => {
  queryError.value = undefined;
  queryMessages.value = [];
  selectedMessage.value = undefined;
});

watch(topicName, () => {
  queryMessages.value = [];
  selectedMessage.value = undefined;
});
</script>

<template>
  <div class="message-query-panel">
    <div v-if="!embedded" class="panel-toolbar">
      <h3>{{ tracePanel ? t("mqTrace.title") : t("mqMessages.queryTitle") }}</h3>
      <button type="button" class="btn-secondary" :disabled="topicsLoading || !tenant || !namespace" @click="loadTopics">
        {{ topicsLoading ? t("mqMessages.querying") : t("mqMessages.refreshTopicList") }}
      </button>
    </div>

    <div v-if="!tenant || !namespace" class="panel-placeholder">{{ contextPlaceholder }}</div>

    <div v-else-if="!tracePanel && preferDlqTopic && noDlqTopics" class="panel-placeholder">{{ t("mqRocketmq.noDlqTopics") }}</div>

    <div v-else class="query-content">
      <div v-if="showBusinessQueryModes" class="query-mode-tabs">
        <button type="button" class="query-tab" :class="{ active: activeQueryMode === 'topic' }" @click="activeQueryMode = 'topic'">
          {{ t("mqMessages.queryTabTopic") }}
        </button>
        <button type="button" class="query-tab" :class="{ active: activeQueryMode === 'key' }" @click="activeQueryMode = 'key'">
          {{ t("mqMessages.queryTabKey") }}
        </button>
        <button type="button" class="query-tab" :class="{ active: activeQueryMode === 'msgId' }" @click="activeQueryMode = 'msgId'">
          {{ t("mqMessages.queryTabMsgId") }}
        </button>
      </div>

      <div class="query-filters">
        <label class="filter-field filter-topic">
          <span>{{ t("mqMessages.queryTopicLabel") }}</span>
          <RocketMqTopicSelect ref="topicSelectRef" v-model="topicName" :connection-id="connectionId" :tenant="tenant" :namespace="namespace" :disabled="queryLoading" :show-type-filter="false" @loaded="handleTopicsLoaded" @select="runQuery" />
        </label>

        <label v-if="tracePanel" class="filter-field">
          <span>{{ t("mqTrace.traceTopic") }}</span>
          <select v-model="traceTopic" :disabled="queryLoading">
            <option v-for="item in traceTopicOptions" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>

        <template v-if="isDlqTopicSelected">
          <label class="filter-field">
            <span>{{ t("mqRocketmq.dlqConsumerGroup") }}</span>
            <input v-model="consumerGroup" type="text" :placeholder="t('mqMessages.dlqConsumerGroupPlaceholder')" :disabled="queryLoading || dlqUseKeyQuery" />
          </label>
          <label class="filter-field checkbox-field">
            <span class="checkbox-label">
              <input v-model="dlqUseKeyQuery" type="checkbox" :disabled="queryLoading" />
              {{ t("mqRocketmq.dlqQueryByKey") }}
            </span>
          </label>
          <label v-if="dlqUseKeyQuery" class="filter-field">
            <span>{{ t("mqMessages.queryKey") }}</span>
            <input v-model="queryKey" type="text" :placeholder="t('mqMessages.queryKeyPlaceholder')" :disabled="queryLoading" />
          </label>
        </template>

        <label v-else-if="activeQueryMode === 'msgId'" class="filter-field">
          <span>{{ t("mqMessages.msgId") }}</span>
          <input v-model="queryMsgId" type="text" :placeholder="t('mqMessages.msgIdPlaceholder')" :disabled="queryLoading" />
        </label>

        <label v-else-if="activeQueryMode === 'key'" class="filter-field">
          <span>{{ t("mqMessages.queryKey") }}</span>
          <input v-model="queryKey" type="text" :placeholder="t('mqMessages.queryKeyPlaceholder')" :disabled="queryLoading" />
        </label>

        <label v-else-if="activeQueryMode === 'topic'" class="filter-field">
          <span>{{ t("mqMessages.beginTime") }}</span>
          <input v-model="queryBeginTime" type="datetime-local" :disabled="queryLoading" />
        </label>

        <label v-else-if="activeQueryMode === 'topic'" class="filter-field">
          <span>{{ t("mqMessages.endTime") }}</span>
          <input v-model="queryEndTime" type="datetime-local" :disabled="queryLoading" />
        </label>

        <label v-else-if="activeQueryMode === 'topic'" class="filter-field filter-narrow">
          <span>{{ t("mqMessages.maxNum") }}</span>
          <input v-model.number="queryMaxNum" type="number" min="1" max="200" :disabled="queryLoading" />
        </label>

        <div class="filter-actions">
          <button type="button" class="btn-primary" :disabled="queryLoading || !selectedTopicRef" @click="runQuery">
            {{ queryLoading ? t("mqMessages.querying") : t("mqMessages.query") }}
          </button>
        </div>
      </div>

      <div v-if="queryError" class="panel-error">{{ queryError }}</div>

      <div class="results-section">
        <div v-if="queryLoading" class="results-empty">{{ t("mqMessages.messagesLoading") }}</div>
        <div v-else-if="!queryMessages.length" class="results-empty">{{ t("mqMessages.noQueryResults") }}</div>
        <div v-else class="results-table-wrap">
          <table class="results-table">
            <thead>
              <tr>
                <th>{{ t("mqMessages.tableMessageId") }}</th>
                <th>{{ t("mqMessages.tableTag") }}</th>
                <th>{{ t("mqMessages.tableKey") }}</th>
                <th>{{ t("mqMessages.tableStoreTime") }}</th>
                <th>{{ t("mqMessages.tableOperation") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(message, index) in queryMessages" :key="`${message.messageId ?? index}-${message.partition ?? 0}`">
                <td class="mono">{{ message.messageId ?? "-" }}</td>
                <td>{{ message.tag ?? "-" }}</td>
                <td>{{ message.key ?? "-" }}</td>
                <td>{{ formatRocketMqTimestamp(message.timestamp) }}</td>
                <td class="operation-cell">
                  <button type="button" class="btn-sm" :disabled="detailLoading" @click="viewMessageDetails(message)">
                    {{ t("mqMessages.viewDetails") }}
                  </button>
                  <button v-if="canViewMessageTrace" type="button" class="btn-sm" :disabled="!message.messageId" @click="openTraceDialog(message)">
                    {{ t("mqTrace.viewTrace") }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <RocketMqMessageDetailDialog
      :message="selectedMessage"
      :detail-loading="detailLoading"
      :detail-error="detailError"
      :resend-loading="resendLoading"
      :resend-error="resendError"
      :resend-success="resendSuccess"
      :payload-copied="payloadCopied"
      :resend-topic="resendTopic"
      :formatted-detail-payload="formattedDetailPayload"
      :detail-headers="detailHeaders"
      :can-resend="canResend"
      :can-view-trace="canViewMessageTrace"
      :read-only="readOnly"
      @close="closeDetails"
      @copy="copyPayload"
      @resend="resendMessage"
      @view-trace="selectedMessage && openTraceDialog(selectedMessage)"
    />

    <RocketMqTraceDetailDialog :open="traceDialogOpen" :connection-id="connectionId" :msg-id="traceMsgId" :trace-topic="traceTopic" @close="closeTraceDialog" />
  </div>
</template>

<style scoped>
.message-query-panel {
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

.panel-placeholder,
.results-empty {
  padding: 40px 24px;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 14px;
}

.query-content {
  flex: 1;
  overflow: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.query-mode-tabs {
  display: flex;
  gap: 24px;
  border-bottom: 1px solid var(--color-border);
}

.query-tab {
  padding: 0 0 10px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--color-text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}

.query-tab.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
}

.query-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: end;
}

.filter-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1 1 200px;
  min-width: 0;
  max-width: 320px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 500;
}

.filter-topic {
  flex: 1 1 280px;
  max-width: 360px;
}

.topic-select-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.topic-select-row select {
  flex: 1;
  min-width: 0;
}

.btn-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background);
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 16px;
  transition: all 0.15s;
  flex-shrink: 0;
}

.btn-icon:hover:not(:disabled) {
  background: var(--color-background-secondary);
  color: var(--color-text);
}

.btn-icon:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.spin {
  display: inline-block;
  animation: spin-anim 0.8s linear infinite;
}

@keyframes spin-anim {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.filter-narrow {
  flex: 0 1 120px;
  max-width: 120px;
}

.filter-field select,
.filter-field input {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background);
  color: var(--color-text);
  font-size: 13px;
  box-sizing: border-box;
}

.filter-actions {
  display: flex;
  align-items: end;
  flex: 0 0 auto;
}

.checkbox-field {
  flex: 0 1 auto;
  max-width: none;
}

.checkbox-field .checkbox-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--color-text);
}

.panel-error {
  padding: 10px 14px;
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-error-bg);
  color: var(--color-error);
  font-size: 13px;
}

.results-section {
  flex: 1;
  min-height: 240px;
}

.results-table-wrap {
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  overflow: auto;
}

.results-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.results-table th,
.results-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
  text-align: left;
  vertical-align: top;
}

.results-table th {
  background: var(--color-background-secondary);
  color: var(--color-text-secondary);
  font-weight: 600;
}

.results-table tbody tr:hover {
  background: var(--color-hover, color-mix(in srgb, var(--color-primary) 6%, transparent));
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  word-break: break-all;
}

.btn-primary,
.btn-sm {
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;
}

.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

.operation-cell {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.btn-sm:hover:not(:disabled) {
  background: var(--color-background-secondary);
}

.btn-primary {
  padding: 7px 16px;
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: #fff;
  font-weight: 500;
}

.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}

.dialog {
  width: min(720px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  overflow: auto;
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
}

.dialog-wide {
  width: min(860px, calc(100vw - 32px));
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-border);
}

.dialog-header h3 {
  margin: 0;
  font-size: 16px;
}

.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid var(--color-border);
}

.btn-close {
  border: none;
  background: none;
  color: var(--color-text-secondary);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}

.dialog-body {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  overflow: auto;
}

.detail-section h4,
.section-heading h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
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

.detail-grid > span:nth-child(odd) {
  color: var(--color-text-secondary);
  font-weight: 500;
}

.panel-success {
  padding: 10px 14px;
  border-radius: var(--dbx-radius-fixed-6);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  color: var(--color-primary);
  font-size: 13px;
}

.btn-secondary {
  padding: 7px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background);
  color: var(--color-text);
  font-size: 13px;
  cursor: pointer;
}

.detail-payload {
  margin: 0;
  padding: 12px;
  max-height: 360px;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background-secondary);
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

button:disabled,
input:disabled,
select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

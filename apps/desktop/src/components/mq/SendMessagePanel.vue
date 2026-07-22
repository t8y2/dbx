<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { MqSystemKind, PeekedMessage, TopicInfo, TopicRef, SendMessageRequest, SendMessageResponse } from "@/types/mq";
import { mqSendMessage, mqListTopics, mqPeekMessages } from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import { parseNonNegativeSafeInteger } from "@/lib/mq/mqPeekFilters";
import { resolveRabbitMqSendNamespace } from "@/lib/mq/mqConsoleDefaults";
import RocketMqTopicSelect from "./shared/RocketMqTopicSelect.vue";

interface Props {
  connectionId: string;
  tenant?: string;
  namespace?: string;
  topic?: TopicInfo;
  readOnly?: boolean;
  mqSystemKind?: MqSystemKind;
  isFlatMqCluster?: boolean;
  supportsPeekMessages?: boolean;
  /** Hide outer toolbar when embedded in a dialog. */
  embedded?: boolean;
}

const props = defineProps<Props>();
const { t } = useI18n();

const topicName = ref("");
const messageKey = ref("");
const messageTag = ref("");
const exchangeName = ref("");
const routingKey = ref("");
const messageValue = ref("");
const headersText = ref("");
const loading = ref(false);
const error = ref<string>();
const success = ref<SendMessageResponse>();
const availableTopics = ref<TopicInfo[]>([]);
const topicsLoading = ref(false);
const rocketMqTopicSelectRef = ref<InstanceType<typeof RocketMqTopicSelect>>();
const headersExpanded = ref(false);
const peekAdvancedExpanded = ref(false);
const peekLoading = ref(false);
const peekError = ref<string>();
const peekMessages = ref<PeekedMessage[]>([]);
const peekPartition = ref("");
const peekOffset = ref("");
const peekCount = ref(20);

let successTimer: ReturnType<typeof setTimeout> | undefined;

const readOnlyMessage = computed(() => t("mqMessages.readOnlyCannotSend"));
const isRocketMqCluster = computed(() => props.mqSystemKind === "rocketmq");
const isRabbitMqCluster = computed(() => props.mqSystemKind === "rabbitmq");

const topicOptions = computed(() => {
  return availableTopics.value.map((t) => ({
    value: t.shortName,
    label: t.shortName,
    partitions: t.partitions,
  }));
});

const selectedTopicRef = computed<TopicRef | null>(() => {
  const topic = topicName.value.trim();
  if (!topic || !props.tenant || !props.namespace) return null;
  const selected = availableTopics.value.find((item) => item.shortName === topic);
  return {
    tenant: props.tenant,
    // Cross-vhost listings tag each row with its own vhost; row-level
    // operations (e.g. peek) must target that vhost, not the "*" selection.
    namespace: selected?.namespace || props.topic?.namespace || props.namespace,
    topic,
    persistent: selected?.persistent ?? true,
    partitioned: selected?.partitioned,
  };
});

const canBrowseMessages = computed(() => props.isFlatMqCluster === true && props.supportsPeekMessages !== false && !isRocketMqCluster.value);

function flatMqPeekGroupName(): string {
  if (props.mqSystemKind === "rocketmq") return "__dbx_rocketmq_viewer__";
  return "__dbx_kafka_viewer__";
}
const topicListId = computed(() => `mq-topic-options-${props.connectionId}`);

function clearSuccessLater() {
  if (successTimer) clearTimeout(successTimer);
  successTimer = setTimeout(() => {
    success.value = undefined;
  }, 4000);
}

onUnmounted(() => {
  if (successTimer) clearTimeout(successTimer);
});

function guardWritable() {
  if (props.readOnly) {
    error.value = readOnlyMessage.value;
    return false;
  }
  return true;
}

async function loadTopics() {
  if (isRocketMqCluster.value) {
    await rocketMqTopicSelectRef.value?.loadTopics();
    return;
  }
  if (!props.tenant || !props.namespace) return;
  topicsLoading.value = true;
  try {
    availableTopics.value = await mqListTopics(
      props.connectionId,
      {
        tenant: props.tenant,
        namespace: props.namespace,
      },
      { includeNonPersistent: false },
    );
    if (props.topic && !topicName.value) {
      topicName.value = props.topic.shortName;
    }
  } catch (e: unknown) {
    console.warn("Failed to load topics:", e);
  } finally {
    topicsLoading.value = false;
  }
}

function handleRocketMqTopicsLoaded(topics: TopicInfo[]) {
  availableTopics.value = topics;
  if (props.topic && !topicName.value) {
    topicName.value = props.topic.shortName;
  }
}

function parseHeaders(): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headersText.value.trim()) return result;
  for (const line of headersText.value.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes(":")) continue;
    const colonIndex = trimmed.indexOf(":");
    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

async function sendMessage() {
  if (!guardWritable()) return;
  error.value = undefined;
  success.value = undefined;

  const topic = topicName.value.trim();
  if (!topic) {
    error.value = t("mqMessages.selectTargetTopic");
    return;
  }
  if (!messageValue.value) {
    error.value = t("mqMessages.messageContentRequired");
    return;
  }

  loading.value = true;
  try {
    const headers = parseHeaders();
    if (isRocketMqCluster.value && messageTag.value.trim()) {
      headers.TAGS = messageTag.value.trim();
    }
    const payloadBase64 = btoa(unescape(encodeURIComponent(messageValue.value)));
    const req: SendMessageRequest = {
      topic,
      key: messageKey.value.trim() || undefined,
      payloadBase64,
      payloadText: messageValue.value,
      headers,
    };
    // RabbitMQ: publish through a specific exchange only when one is given;
    // an empty exchange keeps the default-exchange behavior. The vhost is
    // resolved for every publish: a topic picked from the datalist keeps the
    // vhost of that row (cross-vhost listings), then the selected topic prop,
    // then the current selection; in all-vhosts mode without a row topic the
    // publish falls back to the connection default vhost (no explicit
    // namespace).
    const exchange = exchangeName.value.trim();
    if (isRabbitMqCluster.value) {
      if (exchange) {
        req.exchange = exchange;
        req.routingKey = routingKey.value.trim() || undefined;
      }
      const datalistTopic = availableTopics.value.find((item) => item.shortName === topic);
      const sendNamespace = resolveRabbitMqSendNamespace(datalistTopic, props.namespace, props.topic);
      if (sendNamespace) req.namespace = sendNamespace;
    }
    success.value = await mqSendMessage(props.connectionId, req);
    if (canBrowseMessages.value) {
      peekPartition.value = String(success.value.partition);
      peekOffset.value = String(success.value.offset);
      void loadMessages();
    }
    messageValue.value = "";
    messageKey.value = "";
    clearSuccessLater();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function loadMessages() {
  const topic = selectedTopicRef.value;
  if (!topic) {
    peekError.value = t("mqMessages.selectTopicBeforeLoad");
    return;
  }
  peekLoading.value = true;
  peekError.value = undefined;
  try {
    const count = Math.max(1, Math.min(100, Number(peekCount.value) || 20));
    peekCount.value = count;
    const options: { partition?: number; offset?: number } = {};
    const partitionText = peekPartition.value.trim();
    const offsetText = peekOffset.value.trim();
    if (partitionText !== "") {
      const partition = parseNonNegativeSafeInteger(partitionText);
      if (partition == null) {
        throw new Error(t("mqMessages.partitionMustBeNonNegativeInt"));
      }
      options.partition = partition;
      peekPartition.value = String(partition);
    }
    if (offsetText !== "") {
      const offset = parseNonNegativeSafeInteger(offsetText);
      if (offset == null) {
        throw new Error(t("mqMessages.offsetMustBeNonNegativeInt"));
      }
      options.offset = offset;
      peekOffset.value = String(offset);
    }
    peekMessages.value = await mqPeekMessages(props.connectionId, topic, flatMqPeekGroupName(), count, options);
  } catch (e: unknown) {
    peekError.value = formatError(e);
  } finally {
    peekLoading.value = false;
  }
}

function messagePayload(message: PeekedMessage): string {
  return message.payloadText ?? message.payloadBase64;
}

function formatMessageTimestamp(value?: string): string {
  if (!value) return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return new Date(numeric).toLocaleString();
}

function formatJson() {
  try {
    const parsed = JSON.parse(messageValue.value);
    messageValue.value = JSON.stringify(parsed, null, 2);
  } catch {
    // Not valid JSON, leave as-is
  }
}

function clearForm() {
  topicName.value = "";
  messageKey.value = "";
  exchangeName.value = "";
  routingKey.value = "";
  messageValue.value = "";
  headersText.value = "";
  error.value = undefined;
  success.value = undefined;
}

watch(
  () => [props.tenant, props.namespace],
  () => {
    loadTopics();
  },
  { immediate: true },
);

watch(topicName, () => {
  peekError.value = undefined;
  peekMessages.value = [];
});

watch(
  () => props.topic,
  (newTopic) => {
    if (newTopic) {
      topicName.value = newTopic.shortName;
    }
  },
);
</script>

<template>
  <div class="send-message-panel" :class="{ embedded: embedded }">
    <div v-if="!embedded" class="panel-toolbar">
      <h3>{{ t("mqMessages.title") }}</h3>
      <button @click="clearForm" :disabled="loading" class="btn-sm">{{ t("mqMessages.clear") }}</button>
    </div>

    <div v-if="!tenant || !namespace" class="panel-placeholder">
      {{ isRocketMqCluster ? t("mqRocketmq.connectionNotReady") : t("mqMessages.selectNamespaceOrTopicFirst") }}
    </div>

    <div v-else class="send-form">
      <div v-if="readOnly" class="readonly-hint">{{ readOnlyMessage }}</div>
      <div v-if="error" class="panel-error">{{ error }}</div>
      <div v-if="success" class="panel-success">
        <span class="success-icon">✓</span>
        <span>{{ t("mqMessages.sendSuccess", { partition: success.partition, offset: success.offset }) }}</span>
      </div>

      <div class="form-group">
        <label>{{ t("mqMessages.targetTopic") }} <span class="required">*</span></label>
        <RocketMqTopicSelect v-if="isRocketMqCluster" ref="rocketMqTopicSelectRef" v-model="topicName" :connection-id="connectionId" :tenant="tenant" :namespace="namespace" grouping="business" :show-type-filter="false" :disabled="readOnly" @loaded="handleRocketMqTopicsLoaded" />
        <template v-else>
          <div class="topic-select-row">
            <input v-model="topicName" :list="topicListId" :disabled="readOnly || topicsLoading" class="topic-input" :placeholder="topicsLoading ? t('mqMessages.topicLoading') : t('mqMessages.topicSearchPlaceholder')" autocomplete="off" />
            <datalist :id="topicListId">
              <option v-for="t in topicOptions" :key="t.value" :value="t.value" :label="t.partitions != null ? $t('mqMessages.topicOptionWithPartitions', { label: t.label, partitions: t.partitions }) : t.label" />
            </datalist>
            <button @click="loadTopics" :disabled="topicsLoading" class="btn-icon" :title="t('mqMessages.refreshTopicList')">
              <span v-if="topicsLoading" class="spin">⟳</span>
              <span v-else>⟳</span>
            </button>
          </div>
          <div v-if="!availableTopics.length && !topicsLoading" class="form-hint">{{ t("mqMessages.noTopicsAvailable") }}</div>
          <div v-else class="form-hint">{{ t("mqMessages.topicSearchHint") }}</div>
        </template>
      </div>

      <!-- 消息键 -->
      <div class="form-group">
        <label>{{ t("mqMessages.messageKey") }}</label>
        <input v-model="messageKey" type="text" :placeholder="t('mqMessages.optional')" :disabled="readOnly" />
      </div>

      <div v-if="isRocketMqCluster" class="form-group">
        <label>{{ t("mqMessages.messageTag") }}</label>
        <input v-model="messageTag" type="text" :placeholder="t('mqMessages.optional')" :disabled="readOnly" />
      </div>

      <template v-if="isRabbitMqCluster">
        <div class="form-group">
          <label>{{ t("mqMessages.exchange") }}</label>
          <input v-model="exchangeName" type="text" :placeholder="t('mqMessages.exchangePlaceholder')" :disabled="readOnly" />
          <div class="form-hint">{{ t("mqMessages.exchangeHint") }}</div>
        </div>
        <div v-if="exchangeName.trim()" class="form-group">
          <label>{{ t("mqMessages.routingKey") }}</label>
          <input v-model="routingKey" type="text" :placeholder="t('mqMessages.optional')" :disabled="readOnly" />
        </div>
      </template>

      <!-- 消息内容 -->
      <div class="form-group">
        <div class="label-row">
          <label>{{ t("mqMessages.messageContent") }} <span class="required">*</span></label>
          <button @click="formatJson" :disabled="readOnly || !messageValue" class="btn-sm">{{ t("mqMessages.formatJson") }}</button>
        </div>
        <textarea v-model="messageValue" :disabled="readOnly" :placeholder="t('mqMessages.jsonBodyPlaceholder')" rows="8" class="code-textarea" />
      </div>

      <!-- 消息头（可折叠） -->
      <div class="form-group">
        <button type="button" class="collapse-toggle" @click="headersExpanded = !headersExpanded">
          <span class="collapse-arrow" :class="{ expanded: headersExpanded }">▶</span>
          <span>{{ t("mqMessages.messageHeaders") }}</span>
          <span v-if="headersText.trim() && !headersExpanded" class="collapse-badge">·</span>
        </button>
        <div v-if="headersExpanded" class="collapse-body">
          <textarea v-model="headersText" :disabled="readOnly" :placeholder="t('mqMessages.headersPlaceholder')" rows="3" class="headers-textarea" />
        </div>
      </div>

      <!-- 发送按钮 -->
      <div class="form-actions">
        <button @click="sendMessage" :disabled="loading || readOnly || !topicName || !messageValue" class="btn-primary">
          {{ loading ? t("mqMessages.sending") : t("mqMessages.sendMessage") }}
        </button>
      </div>

      <section v-if="canBrowseMessages" class="message-browser">
        <div class="message-browser-header">
          <h4>{{ t("mqMessages.messageList") }}</h4>
          <button type="button" class="btn-sm" :disabled="peekLoading || !selectedTopicRef" @click="loadMessages">
            {{ peekLoading ? t("mqMessages.loading") : t("mqMessages.loadMessages") }}
          </button>
        </div>

        <p class="peek-default-hint">{{ t("mqMessages.peekDefaultHint", { count: peekCount }) }}</p>

        <div class="peek-controls">
          <label>
            <span>{{ t("mqMessages.count") }}</span>
            <input v-model.number="peekCount" type="number" min="1" max="100" :disabled="peekLoading" />
          </label>
        </div>

        <button type="button" class="collapse-toggle peek-advanced-toggle" @click="peekAdvancedExpanded = !peekAdvancedExpanded">
          <span class="collapse-arrow" :class="{ expanded: peekAdvancedExpanded }">▶</span>
          <span>{{ t("mqMessages.advancedFilter") }}</span>
          <span v-if="(peekPartition || peekOffset) && !peekAdvancedExpanded" class="collapse-badge">·</span>
        </button>
        <div v-if="peekAdvancedExpanded" class="peek-controls collapse-body">
          <label>
            <span>{{ t("mqMessages.partition") }}</span>
            <input v-model="peekPartition" type="number" min="0" :placeholder="t('mqMessages.partitionPlaceholderAll')" :disabled="peekLoading" />
          </label>
          <label>
            <span>{{ t("mqMessages.offset") }}</span>
            <input v-model="peekOffset" type="number" min="0" :placeholder="t('mqMessages.offsetPlaceholderEarliest')" :disabled="peekLoading" />
          </label>
        </div>

        <div v-if="peekError" class="panel-error">{{ peekError }}</div>
        <div v-else-if="peekLoading" class="message-empty">{{ t("mqMessages.messagesLoading") }}</div>
        <div v-else-if="!peekMessages.length" class="message-empty">{{ t("mqMessages.noMessages") }}</div>
        <div v-else class="message-list">
          <article v-for="message in peekMessages" :key="`${message.properties?.partition ?? 'p'}-${message.messageId || message.position}`" class="message-row">
            <div class="message-meta">
              <span>#{{ message.position }}</span>
              <span v-if="message.properties?.partition != null">{{ t("mqMessages.metaPartition", { partition: message.properties.partition }) }}</span>
              <span>{{ t("mqMessages.metaOffset", { offset: message.messageId || "-" }) }}</span>
              <span v-if="message.key">{{ t("mqMessages.metaKey", { key: message.key }) }}</span>
              <span>{{ formatMessageTimestamp(message.publishTime) }}</span>
            </div>
            <pre class="message-payload">{{ messagePayload(message) }}</pre>
            <div v-if="Object.keys(message.headers || {}).length" class="message-headers">
              <span v-for="(value, key) in message.headers" :key="key">{{ key }}: {{ value }}</span>
            </div>
          </article>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.send-message-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.send-message-panel.embedded {
  height: auto;
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

.panel-placeholder {
  padding: 40px 24px;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 14px;
}

.send-form {
  flex: 1;
  overflow: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.readonly-hint {
  padding: 10px 14px;
  border-radius: 6px;
  background: var(--color-warning-alpha);
  color: var(--color-warning);
  font-size: 13px;
}

.panel-error {
  padding: 10px 14px;
  border-radius: 6px;
  background: var(--color-error-bg);
  color: var(--color-error);
  font-size: 13px;
}

.panel-success {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 18px;
  border: 1px solid color-mix(in srgb, var(--color-success) 34%, transparent);
  border-left: 4px solid var(--color-success);
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-success) 13%, var(--color-background));
  color: var(--color-success);
  font-size: 15px;
  font-weight: 700;
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.08);
}

.success-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  background: var(--color-success);
  color: #fff;
  font-size: 16px;
  line-height: 1;
}

.panel-success span:last-child {
  padding-top: 3px;
  line-height: 1.45;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.label-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.form-group label {
  font-weight: 500;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.required {
  color: var(--color-error);
}

.topic-select-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.topic-input {
  flex: 1;
  padding: 7px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background);
  color: var(--color-text);
  font-size: 13px;
  min-width: 0;
}

.topic-input:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-alpha);
}

.btn-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
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

input[type="text"],
input[type="number"] {
  padding: 7px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background);
  color: var(--color-text);
  font-size: 13px;
  box-sizing: border-box;
}

input[type="text"]:focus,
input[type="number"]:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-alpha);
}

.code-textarea,
.headers-textarea {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background);
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  resize: vertical;
  box-sizing: border-box;
  line-height: 1.5;
}

.code-textarea:focus,
.headers-textarea:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-alpha);
}

.headers-textarea {
  font-family: inherit;
}

.form-hint {
  font-size: 12px;
  color: var(--color-text-tertiary);
  line-height: 1.4;
}

.collapse-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  user-select: none;
}

.collapse-arrow {
  font-size: 10px;
  transition: transform 0.15s;
  display: inline-block;
}

.collapse-arrow.expanded {
  transform: rotate(90deg);
}

.collapse-badge {
  color: var(--color-primary);
  font-weight: 700;
}

.collapse-body {
  margin-top: 6px;
}

.form-actions {
  display: flex;
  gap: 8px;
  padding-top: 4px;
}

.btn-primary,
.btn-sm {
  padding: 7px 16px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.15s;
}

.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

.btn-primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
  font-weight: 500;
  min-width: 100px;
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}

.query-mode-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 12px;
}

.query-mode-tabs .btn-sm.active {
  border-color: var(--color-primary);
  color: var(--color-primary);
  background: var(--color-primary-alpha);
}

.message-browser {
  margin-top: 4px;
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-secondary);
}

.message-browser-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.message-browser-header h4 {
  margin: 0;
  color: var(--color-text);
  font-size: 14px;
  font-weight: 600;
}

.peek-default-hint {
  margin: 0 0 12px;
  padding: 8px 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.peek-advanced-toggle {
  margin-bottom: 10px;
}

.peek-controls {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}

.peek-controls label {
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 500;
}

.peek-controls input {
  width: 100%;
}

.message-empty {
  padding: 18px;
  border: 1px dashed var(--color-border);
  border-radius: 6px;
  color: var(--color-text-tertiary);
  text-align: center;
  font-size: 13px;
}

.message-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 360px;
  overflow: auto;
}

.message-row {
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background);
}

.message-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--color-text-tertiary);
  font-size: 12px;
}

.message-meta span:first-child {
  color: var(--color-primary);
  font-weight: 700;
}

.message-payload {
  margin: 8px 0 0;
  padding: 10px;
  max-height: 160px;
  overflow: auto;
  border-radius: 6px;
  background: var(--color-background-tertiary, var(--color-background-secondary));
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-headers {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.message-headers span {
  padding: 2px 6px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text-secondary);
  background: var(--color-background-secondary);
  font-size: 12px;
}

@media (max-width: 720px) {
  .peek-controls {
    grid-template-columns: 1fr;
  }
}

button:disabled,
input:disabled,
textarea:disabled,
select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

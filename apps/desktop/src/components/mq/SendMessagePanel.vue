<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import type { PeekedMessage, TopicInfo, TopicRef, SendMessageRequest, SendMessageResponse } from "@/types/mq";
import { mqSendMessage, mqListTopics, mqPeekMessages } from "@/lib/api";
import { formatError } from "@/lib/errorUtils";

interface Props {
  connectionId: string;
  tenant?: string;
  namespace?: string;
  topic?: TopicInfo;
  readOnly?: boolean;
  isKafkaCluster?: boolean;
  supportsPeekMessages?: boolean;
}

const props = defineProps<Props>();

const topicName = ref("");
const messageKey = ref("");
const messageValue = ref("");
const headersText = ref("");
const loading = ref(false);
const error = ref<string>();
const success = ref<SendMessageResponse>();
const availableTopics = ref<TopicInfo[]>([]);
const topicsLoading = ref(false);
const headersExpanded = ref(false);
const peekLoading = ref(false);
const peekError = ref<string>();
const peekMessages = ref<PeekedMessage[]>([]);
const peekPartition = ref(0);
const peekOffset = ref(0);
const peekCount = ref(20);

let successTimer: ReturnType<typeof setTimeout> | undefined;

const readOnlyMessage = "当前连接为只读模式，不能发送消息";

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
    namespace: props.namespace,
    topic,
    persistent: selected?.persistent ?? true,
    partitioned: selected?.partitioned,
  };
});

const canBrowseMessages = computed(() => props.isKafkaCluster === true && props.supportsPeekMessages !== false);

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
    error.value = readOnlyMessage;
    return false;
  }
  return true;
}

async function loadTopics() {
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
    error.value = "请选择目标主题";
    return;
  }
  if (!messageValue.value) {
    error.value = "消息内容不能为空";
    return;
  }

  loading.value = true;
  try {
    const headers = parseHeaders();
    const payloadBase64 = btoa(unescape(encodeURIComponent(messageValue.value)));
    const req: SendMessageRequest = {
      topic,
      key: messageKey.value.trim() || undefined,
      payloadBase64,
      payloadText: messageValue.value,
      headers,
    };
    success.value = await mqSendMessage(props.connectionId, req);
    if (canBrowseMessages.value) {
      peekPartition.value = success.value.partition;
      peekOffset.value = success.value.offset;
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
    peekError.value = "Select a topic before loading messages";
    return;
  }
  peekLoading.value = true;
  peekError.value = undefined;
  try {
    const count = Math.max(1, Math.min(100, Number(peekCount.value) || 20));
    const partition = Math.max(0, Number(peekPartition.value) || 0);
    const offset = Math.max(0, Number(peekOffset.value) || 0);
    peekCount.value = count;
    peekPartition.value = partition;
    peekOffset.value = offset;
    peekMessages.value = await mqPeekMessages(props.connectionId, topic, "__dbx_kafka_viewer__", count, { partition, offset });
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
  <div class="send-message-panel">
    <div class="panel-toolbar">
      <h3>发送消息</h3>
      <button @click="clearForm" :disabled="loading" class="btn-sm">清空</button>
    </div>

    <div v-if="!tenant || !namespace" class="panel-placeholder">请先选择命名空间或主题</div>

    <div v-else class="send-form">
      <div v-if="readOnly" class="readonly-hint">{{ readOnlyMessage }}</div>
      <div v-if="error" class="panel-error">{{ error }}</div>
      <div v-if="success" class="panel-success">
        <span class="success-icon">✓</span>
        <span>消息发送成功 — 分区: {{ success.partition }}，偏移: {{ success.offset }}</span>
      </div>

      <!-- 主题选择 -->
      <div class="form-group">
        <label>目标主题 <span class="required">*</span></label>
        <div class="topic-select-row">
          <select v-model="topicName" :disabled="readOnly || topicsLoading" class="topic-select">
            <option value="" disabled>{{ topicsLoading ? "加载中..." : "选择主题..." }}</option>
            <option v-for="t in topicOptions" :key="t.value" :value="t.value">
              {{ t.label }}<template v-if="t.partitions != null"> ({{ t.partitions }} 分区)</template>
            </option>
          </select>
          <button @click="loadTopics" :disabled="topicsLoading" class="btn-icon" title="刷新主题列表">
            <span v-if="topicsLoading" class="spin">⟳</span>
            <span v-else>⟳</span>
          </button>
        </div>
        <div v-if="!availableTopics.length && !topicsLoading" class="form-hint">暂无可用主题</div>
      </div>

      <!-- 消息键 -->
      <div class="form-group">
        <label>消息键 (Key)</label>
        <input v-model="messageKey" type="text" placeholder="可选" :disabled="readOnly" />
      </div>

      <!-- 消息内容 -->
      <div class="form-group">
        <div class="label-row">
          <label>消息内容 <span class="required">*</span></label>
          <button @click="formatJson" :disabled="readOnly || !messageValue" class="btn-sm">格式化 JSON</button>
        </div>
        <textarea v-model="messageValue" :disabled="readOnly" placeholder='{"key": "value"}' rows="8" class="code-textarea" />
      </div>

      <!-- 消息头（可折叠） -->
      <div class="form-group">
        <button type="button" class="collapse-toggle" @click="headersExpanded = !headersExpanded">
          <span class="collapse-arrow" :class="{ expanded: headersExpanded }">▶</span>
          <span>消息头 (Headers)</span>
          <span v-if="headersText.trim() && !headersExpanded" class="collapse-badge">·</span>
        </button>
        <div v-if="headersExpanded" class="collapse-body">
          <textarea v-model="headersText" :disabled="readOnly" placeholder="key: value（每行一个）" rows="3" class="headers-textarea" />
        </div>
      </div>

      <!-- 发送按钮 -->
      <div class="form-actions">
        <button @click="sendMessage" :disabled="loading || readOnly || !topicName || !messageValue" class="btn-primary">
          {{ loading ? "发送中..." : "发送消息" }}
        </button>
      </div>

      <section v-if="canBrowseMessages" class="message-browser">
        <div class="message-browser-header">
          <h4>消息列表</h4>
          <button type="button" class="btn-sm" :disabled="peekLoading || !selectedTopicRef" @click="loadMessages">
            {{ peekLoading ? "加载中..." : "加载消息" }}
          </button>
        </div>

        <div class="peek-controls">
          <label>
            <span>分区</span>
            <input v-model.number="peekPartition" type="number" min="0" :disabled="peekLoading" />
          </label>
          <label>
            <span>Offset</span>
            <input v-model.number="peekOffset" type="number" min="0" :disabled="peekLoading" />
          </label>
          <label>
            <span>数量</span>
            <input v-model.number="peekCount" type="number" min="1" max="100" :disabled="peekLoading" />
          </label>
        </div>

        <div v-if="peekError" class="panel-error">{{ peekError }}</div>
        <div v-else-if="peekLoading" class="message-empty">消息加载中...</div>
        <div v-else-if="!peekMessages.length" class="message-empty">暂无消息</div>
        <div v-else class="message-list">
          <article v-for="message in peekMessages" :key="message.messageId || message.position" class="message-row">
            <div class="message-meta">
              <span>#{{ message.position }}</span>
              <span>offset {{ message.messageId || "-" }}</span>
              <span v-if="message.key">key {{ message.key }}</span>
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

.topic-select {
  flex: 1;
  padding: 7px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background);
  color: var(--color-text);
  font-size: 13px;
  cursor: pointer;
  appearance: auto;
}

.topic-select:focus {
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

.peek-controls {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
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

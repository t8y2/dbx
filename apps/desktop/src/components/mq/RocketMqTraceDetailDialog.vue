<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { mqQueryMessageTrace } from "@/lib/backend/api";
import { formatRocketMqTraceError } from "@/lib/mq/rocketmqTraceUtils";
import { formatRocketMqTimestamp, parseRocketMqMessagesFromResult, rocketMqMessagePayload, type RocketMqDisplayMessage } from "@/lib/mq/rocketmqMessageUtils";
import { DEFAULT_ROCKETMQ_TRACE_TOPIC } from "@/lib/mq/rocketmqTopicTypes";

interface Props {
  open: boolean;
  connectionId: string;
  msgId: string;
  traceTopic?: string;
}

const props = withDefaults(defineProps<Props>(), {
  traceTopic: DEFAULT_ROCKETMQ_TRACE_TOPIC,
});

const emit = defineEmits<{
  close: [];
}>();

const { t } = useI18n();

const loading = ref(false);
const error = ref<string>();
const messages = ref<RocketMqDisplayMessage[]>([]);

async function loadTrace() {
  const msgId = props.msgId.trim();
  if (!msgId) {
    error.value = t("mqTrace.msgIdRequired");
    messages.value = [];
    return;
  }

  loading.value = true;
  error.value = undefined;
  messages.value = [];
  try {
    const traceTopic = props.traceTopic.trim() || DEFAULT_ROCKETMQ_TRACE_TOPIC;
    const result = await mqQueryMessageTrace(props.connectionId, msgId, traceTopic);
    messages.value = parseRocketMqMessagesFromResult(result);
  } catch (e: unknown) {
    error.value = formatRocketMqTraceError(e, t("mqTrace.traceTopicRouteMissing"));
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.open, props.connectionId, props.msgId, props.traceTopic] as const,
  ([open]) => {
    if (open) {
      void loadTrace();
    } else {
      loading.value = false;
      error.value = undefined;
      messages.value = [];
    }
  },
);
</script>

<template>
  <div v-if="open" class="dialog-overlay" @click="emit('close')">
    <div class="dialog dialog-wide" @click.stop>
      <div class="dialog-header">
        <h3>{{ t("mqTrace.detailTitle") }}</h3>
        <button type="button" class="btn-close" @click="emit('close')">×</button>
      </div>
      <div class="dialog-body">
        <div class="detail-grid">
          <span>{{ t("mqMessages.tableMessageId") }}</span>
          <span class="mono">{{ msgId || "-" }}</span>
          <span>{{ t("mqTrace.traceTopic") }}</span>
          <span class="mono">{{ traceTopic || DEFAULT_ROCKETMQ_TRACE_TOPIC }}</span>
        </div>

        <div v-if="loading" class="panel-placeholder">{{ t("mqTrace.querying") }}</div>
        <div v-else-if="error" class="panel-error">{{ error }}</div>
        <div v-else-if="!messages.length" class="panel-placeholder">{{ t("mqTrace.noTrace") }}</div>
        <div v-else class="message-list">
          <article v-for="(message, index) in messages" :key="`${message.messageId ?? index}-${message.timestamp ?? 0}`" class="message-row">
            <div class="message-meta">
              <span>#{{ index + 1 }}</span>
              <span v-if="message.topic">{{ message.topic }}</span>
              <span v-if="message.partition != null">{{ t("mqMessages.metaPartition", { partition: message.partition }) }}</span>
              <span>{{ formatRocketMqTimestamp(message.timestamp) }}</span>
            </div>
            <pre class="message-payload">{{ rocketMqMessagePayload(message) }}</pre>
            <div v-if="message.headers && Object.keys(message.headers).length" class="message-headers">
              <span v-for="(value, key) in message.headers" :key="key">{{ key }}: {{ value }}</span>
            </div>
          </article>
        </div>
      </div>
      <div class="dialog-footer">
        <button type="button" class="btn-secondary" @click="emit('close')">{{ t("common.close") }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
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
  width: min(860px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  overflow: auto;
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
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
  gap: 16px;
  overflow: auto;
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

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  word-break: break-all;
}

.panel-placeholder {
  padding: 24px;
  text-align: center;
  color: var(--color-text-secondary);
  font-size: 14px;
}

.panel-error {
  padding: 12px 14px;
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-error-bg);
  color: var(--color-error);
  font-size: 13px;
  white-space: pre-wrap;
}

.message-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.message-row {
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background-secondary);
}

.message-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.message-payload {
  margin: 8px 0 0;
  padding: 10px;
  max-height: 240px;
  overflow: auto;
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-headers {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.message-headers span {
  padding: 2px 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  font-size: 12px;
  color: var(--color-text-secondary);
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
</style>

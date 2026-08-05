<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { mqQueryMessageTrace } from "@/lib/backend/api";
import { formatRocketMqTraceError, isParsedRocketMqTraceRecord, parseRocketMqTracePayload, rocketMqTraceRecordTimeLabel, splitRocketMqTraceKeys, type RocketMqTraceFieldKey, type RocketMqTraceRecord, type RocketMqTraceType } from "@/lib/mq/rocketmqTraceUtils";
import { parseRocketMqMessagesFromResult, rocketMqMessagePayload, type RocketMqDisplayMessage } from "@/lib/mq/rocketmqMessageUtils";
import { DEFAULT_ROCKETMQ_TRACE_TOPIC } from "@/lib/mq/rocketmqTopicTypes";

interface Props {
  open: boolean;
  connectionId: string;
  msgId: string;
  traceTopic?: string;
}

interface TraceCardModel {
  index: number;
  message: RocketMqDisplayMessage;
  record: RocketMqTraceRecord;
  parsed: boolean;
  rawPayload: string;
  headerEntries: Array<[string, string]>;
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
let loadSeq = 0;

const FIELD_I18N: Record<RocketMqTraceFieldKey, string> = {
  regionId: "mqTrace.fieldRegionId",
  group: "mqTrace.fieldGroup",
  topic: "mqTrace.fieldTopic",
  msgId: "mqTrace.fieldMsgId",
  tags: "mqTrace.fieldTags",
  keys: "mqTrace.fieldKeys",
  storeHost: "mqTrace.fieldStoreHost",
  clientHost: "mqTrace.fieldClientHost",
  bodyLength: "mqTrace.fieldBodyLength",
  costTime: "mqTrace.fieldCostTime",
  msgType: "mqTrace.fieldMsgType",
  offsetMsgId: "mqTrace.fieldOffsetMsgId",
  requestId: "mqTrace.fieldRequestId",
  retryTimes: "mqTrace.fieldRetryTimes",
  contextCode: "mqTrace.fieldContextCode",
};

function typeLabel(type: RocketMqTraceType): string {
  switch (type) {
    case "Pub":
      return t("mqTrace.typePub");
    case "SubBefore":
      return t("mqTrace.typeSubBefore");
    case "SubAfter":
      return t("mqTrace.typeSubAfter");
    case "EndTransaction":
      return t("mqTrace.typeEndTransaction");
    default:
      return t("mqTrace.typeUnknown");
  }
}

function fieldLabel(key: RocketMqTraceFieldKey): string {
  return t(FIELD_I18N[key]);
}

function headerEntries(message: RocketMqDisplayMessage): Array<[string, string]> {
  if (!message.headers) return [];
  return Object.entries(message.headers);
}

const cards = computed<TraceCardModel[]>(() => {
  const result: TraceCardModel[] = [];
  let index = 0;
  for (const message of messages.value) {
    const rawPayload = rocketMqMessagePayload(message);
    const records = parseRocketMqTracePayload(rawPayload);
    const units = records.length ? records : [{ type: "Unknown" as const, fields: [], raw: rawPayload }];
    for (const record of units) {
      index += 1;
      result.push({
        index,
        message,
        record,
        parsed: isParsedRocketMqTraceRecord(record),
        rawPayload: record.raw || rawPayload,
        headerEntries: headerEntries(message),
      });
    }
  }
  return result;
});

async function loadTrace() {
  const msgId = props.msgId.trim();
  if (!msgId) {
    error.value = t("mqTrace.msgIdRequired");
    messages.value = [];
    return;
  }

  const seq = ++loadSeq;
  loading.value = true;
  error.value = undefined;
  messages.value = [];
  try {
    const traceTopic = props.traceTopic.trim() || DEFAULT_ROCKETMQ_TRACE_TOPIC;
    const result = await mqQueryMessageTrace(props.connectionId, msgId, traceTopic);
    if (seq !== loadSeq) return;
    messages.value = parseRocketMqMessagesFromResult(result);
  } catch (e: unknown) {
    if (seq !== loadSeq) return;
    error.value = formatRocketMqTraceError(e, t("mqTrace.traceTopicRouteMissing"));
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

watch(
  () => [props.open, props.connectionId, props.msgId, props.traceTopic] as const,
  ([open]) => {
    if (open) {
      void loadTrace();
    } else {
      loadSeq += 1;
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
        <div v-else-if="!cards.length" class="panel-placeholder">{{ t("mqTrace.noTrace") }}</div>
        <div v-else class="message-list">
          <article v-for="card in cards" :key="`${card.index}-${card.record.type}-${card.record.timestamp ?? 0}`" class="message-row">
            <div class="message-meta">
              <span>#{{ card.index }}</span>
              <span class="type-badge" :data-type="card.record.type">{{ typeLabel(card.record.type) }}</span>
              <span>{{ rocketMqTraceRecordTimeLabel(card.record, card.message.timestamp) }}</span>
              <span v-if="card.message.partition != null">{{ t("mqMessages.metaPartition", { partition: card.message.partition }) }}</span>
              <span v-if="card.record.success != null" class="status-badge" :class="card.record.success ? 'status-success' : 'status-fail'">
                {{ card.record.success ? t("mqTrace.statusSuccess") : t("mqTrace.statusFail") }}
              </span>
            </div>

            <div v-if="card.parsed" class="detail-grid trace-fields">
              <template v-for="field in card.record.fields" :key="field.key">
                <span>{{ fieldLabel(field.key) }}</span>
                <span v-if="field.key === 'keys'" class="keys-chips">
                  <template v-if="splitRocketMqTraceKeys(field.value).length">
                    <span v-for="key in splitRocketMqTraceKeys(field.value)" :key="key" class="key-chip mono">{{ key }}</span>
                  </template>
                  <span v-else class="mono">{{ field.value }}</span>
                </span>
                <span v-else class="mono">{{ field.value }}</span>
              </template>
            </div>
            <pre v-else class="message-payload">{{ card.rawPayload || "-" }}</pre>

            <div v-if="card.headerEntries.length" class="message-headers">
              <template v-for="[key, value] in card.headerEntries" :key="key">
                <div v-if="key === 'KEYS'" class="header-keys">
                  <span class="header-keys-label">{{ key }}:</span>
                  <span class="keys-chips">
                    <span v-for="chip in splitRocketMqTraceKeys(value)" :key="chip" class="key-chip mono">{{ chip }}</span>
                  </span>
                </div>
                <span v-else>{{ key }}: {{ value }}</span>
              </template>
            </div>

            <details v-if="card.parsed && card.rawPayload" class="raw-payload">
              <summary>{{ t("mqTrace.rawPayload") }}</summary>
              <pre class="message-payload">{{ card.rawPayload }}</pre>
            </details>
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

.trace-fields {
  margin-top: 10px;
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
  align-items: center;
  gap: 8px 10px;
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.type-badge,
.status-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: var(--dbx-radius-fixed-4);
  font-size: 12px;
  font-weight: 600;
  line-height: 1.4;
}

.type-badge {
  border: 1px solid var(--color-border);
  background: var(--color-background);
  color: var(--color-text);
}

.type-badge[data-type="Pub"] {
  border-color: color-mix(in srgb, var(--color-primary, #3b82f6) 40%, transparent);
  background: color-mix(in srgb, var(--color-primary, #3b82f6) 12%, transparent);
  color: var(--color-primary, #2563eb);
}

.type-badge[data-type="SubBefore"],
.type-badge[data-type="SubAfter"] {
  border-color: color-mix(in srgb, var(--color-info, #0ea5e9) 40%, transparent);
  background: color-mix(in srgb, var(--color-info, #0ea5e9) 12%, transparent);
  color: var(--color-info, #0284c7);
}

.status-success {
  border: 1px solid color-mix(in srgb, var(--color-success, #22c55e) 40%, transparent);
  background: color-mix(in srgb, var(--color-success, #22c55e) 12%, transparent);
  color: var(--color-success, #16a34a);
}

.status-fail {
  border: 1px solid color-mix(in srgb, var(--color-error, #ef4444) 40%, transparent);
  background: color-mix(in srgb, var(--color-error, #ef4444) 12%, transparent);
  color: var(--color-error, #dc2626);
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

.message-headers > span {
  padding: 2px 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  font-size: 12px;
  color: var(--color-text-secondary);
  word-break: break-all;
}

.header-keys {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  padding: 4px 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  font-size: 12px;
  color: var(--color-text-secondary);
}

.header-keys-label {
  flex: 0 0 auto;
  font-weight: 500;
}

.keys-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}

.key-chip {
  padding: 1px 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  background: var(--color-background);
  font-size: 11px;
  color: var(--color-text-secondary);
}

.raw-payload {
  margin-top: 8px;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.raw-payload summary {
  cursor: pointer;
  user-select: none;
}

.raw-payload .message-payload {
  margin-top: 6px;
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

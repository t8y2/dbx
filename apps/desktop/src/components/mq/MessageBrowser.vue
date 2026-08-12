<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Copy } from "@lucide/vue";
import type { MqSystemKind, PeekedMessage, PeekMessagesOptions, TopicRef } from "@/types/mq";
import { mqPeekMessages } from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import { copyToClipboard } from "@/lib/common/clipboard";
import { parseNonNegativeSafeInteger } from "@/lib/mq/mqPeekFilters";
import { useToast } from "@/composables/useToast";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

type MessageBrowserAppearance = "form" | "monitoring";

interface Props {
  connectionId: string;
  topic?: TopicRef | null;
  mqSystemKind?: MqSystemKind;
  /** Flatten chrome when embedded in MonitoringPanel so it is not a second nested card. */
  appearance?: MessageBrowserAppearance;
}

const props = withDefaults(defineProps<Props>(), {
  appearance: "form",
});
const { t } = useI18n();
const { toast } = useToast();

const loading = ref(false);
const error = ref<string>();
const messages = ref<PeekedMessage[]>([]);
const incomplete = ref(false);
const partition = ref<string | number>("");
const offset = ref<string | number>("");
const count = ref(20);
const advancedExpanded = ref(false);
type KafkaPeekStartPosition = NonNullable<PeekMessagesOptions["startPosition"]>;
const kafkaStartPosition = ref<KafkaPeekStartPosition>("latest");
let messageRequestVersion = 0;

const isKafka = computed(() => props.mqSystemKind === "kafka");
const isKafkaOffsetMode = computed(() => kafkaStartPosition.value === "offset");
const isMonitoring = computed(() => props.appearance === "monitoring");

function peekGroupName(): string {
  if (props.mqSystemKind === "rocketmq") return "__dbx_rocketmq_viewer__";
  return "__dbx_kafka_viewer__";
}

async function loadMessages() {
  const topic = props.topic;
  if (!topic || loading.value) return;
  const requestVersion = ++messageRequestVersion;
  loading.value = true;
  error.value = undefined;
  incomplete.value = false;
  try {
    const resultLimit = Math.max(1, Math.min(100, Math.trunc(Number(count.value) || 20)));
    count.value = resultLimit;
    const options: PeekMessagesOptions = {};
    const partitionText = String(partition.value).trim();
    const offsetText = String(offset.value).trim();

    if (isKafka.value) {
      options.startPosition = kafkaStartPosition.value;
      if (partitionText !== "") {
        const parsedPartition = parseNonNegativeSafeInteger(partitionText);
        if (parsedPartition == null) throw new Error(t("mqMessages.partitionMustBeNonNegativeInt"));
        options.partition = parsedPartition;
        partition.value = String(parsedPartition);
      }
      if (isKafkaOffsetMode.value) {
        if (offsetText === "") throw new Error(t("mqMessages.offsetRequiredForOffset"));
        const parsedOffset = parseNonNegativeSafeInteger(offsetText);
        if (parsedOffset == null) throw new Error(t("mqMessages.offsetMustBeNonNegativeIntRequired"));
        options.offset = parsedOffset;
        offset.value = String(parsedOffset);
      }
    } else {
      if (partitionText !== "") {
        const parsedPartition = parseNonNegativeSafeInteger(partitionText);
        if (parsedPartition == null) throw new Error(t("mqMessages.partitionMustBeNonNegativeInt"));
        options.partition = parsedPartition;
        partition.value = String(parsedPartition);
      }
      if (offsetText !== "") {
        const parsedOffset = parseNonNegativeSafeInteger(offsetText);
        if (parsedOffset == null) throw new Error(t("mqMessages.offsetMustBeNonNegativeInt"));
        options.offset = parsedOffset;
        offset.value = String(parsedOffset);
      }
    }
    const result = await mqPeekMessages(props.connectionId, topic, peekGroupName(), resultLimit, options);
    if (requestVersion === messageRequestVersion) {
      const browseResult = Array.isArray(result) ? { messages: result, incomplete: false } : result;
      messages.value = browseResult.messages;
      incomplete.value = browseResult.incomplete;
    }
  } catch (cause: unknown) {
    if (requestVersion === messageRequestVersion) {
      error.value = formatError(cause);
    }
  } finally {
    if (requestVersion === messageRequestVersion) {
      loading.value = false;
    }
  }
}

function invalidateMessageRequest() {
  messageRequestVersion += 1;
  loading.value = false;
  error.value = undefined;
  messages.value = [];
  incomplete.value = false;
}

function messagePayload(message: PeekedMessage): string {
  return message.payloadText ?? message.payloadBase64;
}

async function copyMessagePayload(message: PeekedMessage) {
  await copyMessageText(messagePayload(message));
}

async function copyMessageHeaders(message: PeekedMessage) {
  await copyMessageText(JSON.stringify(message.headers, null, 2));
}

async function copyMessageText(text: string) {
  try {
    await copyToClipboard(text);
    toast(t("grid.copied"));
  } catch (cause: unknown) {
    toast(t("grid.copyFailed", { message: formatError(cause) }), 5000);
  }
}

function formatMessageTimestamp(value?: string): string {
  if (!value) return "-";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return new Date(numeric).toLocaleString();
}

watch([() => props.connectionId, () => props.mqSystemKind, () => JSON.stringify(props.topic ?? null)], () => {
  invalidateMessageRequest();
});

watch(kafkaStartPosition, () => {
  // Keep offset values for switching back, but never retain results from another start mode.
  invalidateMessageRequest();
});
</script>

<template>
  <section v-if="topic" class="message-browser" :class="{ 'is-monitoring': isMonitoring }" data-testid="message-browser">
    <div class="message-browser-header">
      <h4>{{ t("mqMessages.messageList") }}</h4>
      <button type="button" class="btn-sm" :disabled="loading" @click="loadMessages">
        {{ loading ? t("mqMessages.loading") : t("mqMessages.loadMessages") }}
      </button>
    </div>

    <p v-if="isKafka" class="peek-default-hint">
      <template v-if="kafkaStartPosition === 'latest'">
        {{ t("mqMessages.kafkaLatestHint") }}
      </template>
      <template v-else-if="kafkaStartPosition === 'earliest'">
        {{ t("mqMessages.kafkaEarliestHint") }}
      </template>
      <template v-else>
        {{ t("mqMessages.kafkaOffsetHint") }}
      </template>
    </p>
    <p v-else class="peek-default-hint">{{ t("mqMessages.peekDefaultHint") }}</p>
    <p v-if="incomplete" class="peek-incomplete" role="status" data-testid="peek-incomplete">
      {{ t("mqMessages.peekIncomplete") }}
    </p>

    <div class="peek-controls">
      <label>
        <span>{{ t("mqMessages.count") }}</span>
        <input v-model.number="count" data-testid="peek-count" type="number" min="1" max="100" :disabled="loading" />
      </label>
      <label v-if="isKafka">
        <span>{{ t("mqMessages.startPosition") }}</span>
        <Select v-model="kafkaStartPosition" :disabled="loading">
          <SelectTrigger data-testid="kafka-peek-start-position" class="message-browser-start-position">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper" class="message-browser-start-position-content">
            <SelectItem value="latest">{{ t("mqMessages.kafkaLatest") }}</SelectItem>
            <SelectItem value="earliest">{{ t("mqMessages.kafkaEarliest") }}</SelectItem>
            <SelectItem value="offset">{{ t("mqMessages.kafkaOffset") }}</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <label v-if="isKafka">
        <span>{{ t("mqMessages.partition") }}</span>
        <input v-model="partition" data-testid="kafka-peek-partition" type="number" min="0" :placeholder="t('mqMessages.partitionPlaceholderAll')" :disabled="loading" />
      </label>
      <label v-if="isKafkaOffsetMode">
        <span>{{ t("mqMessages.offset") }}</span>
        <input v-model="offset" data-testid="kafka-peek-offset" type="number" min="0" :placeholder="t('mqMessages.offsetPlaceholderRequired')" :disabled="loading" />
      </label>
    </div>

    <template v-if="!isKafka">
      <button type="button" class="collapse-toggle peek-advanced-toggle" @click="advancedExpanded = !advancedExpanded">
        <span class="collapse-arrow" :class="{ expanded: advancedExpanded }">&#9654;</span>
        <span>{{ t("mqMessages.advancedFilter") }}</span>
        <span v-if="(partition || offset) && !advancedExpanded" class="collapse-badge">&middot;</span>
      </button>
      <div v-if="advancedExpanded" class="peek-controls non-kafka-controls">
        <label>
          <span>{{ t("mqMessages.partition") }}</span>
          <input v-model="partition" type="number" min="0" :placeholder="t('mqMessages.partitionPlaceholderAll')" :disabled="loading" />
        </label>
        <label>
          <span>{{ t("mqMessages.offset") }}</span>
          <input v-model="offset" type="number" min="0" :placeholder="t('mqMessages.offsetPlaceholderEarliest')" :disabled="loading" />
        </label>
      </div>
    </template>

    <div v-if="error" class="panel-error">{{ error }}</div>
    <div v-else-if="loading" class="message-empty">{{ t("mqMessages.messagesLoading") }}</div>
    <div v-else-if="!messages.length" class="message-empty">{{ t("mqMessages.noMessages") }}</div>
    <div v-else class="message-list">
      <article v-for="message in messages" :key="`${message.properties?.partition ?? 'p'}-${message.messageId || message.position}`" class="message-row">
        <div class="message-meta">
          <span>#{{ message.position }}</span>
          <span v-if="message.properties?.partition != null">{{ t("mqMessages.metaPartition", { partition: message.properties.partition }) }}</span>
          <span>{{ t("mqMessages.metaOffset", { offset: message.messageId || "-" }) }}</span>
          <span v-if="message.key">{{ t("mqMessages.metaKey", { key: message.key }) }}</span>
          <span>{{ formatMessageTimestamp(message.publishTime) }}</span>
        </div>
        <div class="message-payload-section">
          <div class="message-payload-heading">
            <span>{{ t("mqMessages.messageContent") }}</span>
            <Button type="button" variant="outline" size="sm" class="message-copy-action h-7 gap-1.5 px-2 text-xs" :aria-label="`${t('grid.copy')} ${t('mqMessages.messageContent')}`" data-testid="copy-message-payload" @click="copyMessagePayload(message)">
              <Copy :size="14" aria-hidden="true" />
              {{ t("grid.copy") }}
            </Button>
          </div>
          <pre data-native-clipboard class="message-payload">{{ messagePayload(message) }}</pre>
        </div>
        <div v-if="Object.keys(message.headers || {}).length" class="message-headers">
          <div class="message-headers-heading">
            <span>{{ t("mqMessages.messageHeaders") }}</span>
            <Button type="button" variant="outline" size="sm" class="message-copy-action h-7 gap-1.5 px-2 text-xs" :aria-label="`${t('grid.copy')} ${t('mqMessages.messageHeaders')}`" data-testid="copy-message-headers" @click="copyMessageHeaders(message)">
              <Copy :size="14" aria-hidden="true" />
              {{ t("grid.copy") }}
            </Button>
          </div>
          <div class="message-headers-values">
            <span v-for="(value, key) in message.headers" :key="key">{{ key }}: {{ value }}</span>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
@import "./shared/mqPanel.css";

.message-browser {
  margin-top: 4px;
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background-secondary);
}

/* Only flatten outer chrome when embedded in MonitoringPanel — do not restyle list rows. */
.message-browser.is-monitoring {
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
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

.btn-sm:disabled,
.peek-controls input:disabled,
.peek-controls :deep(.message-browser-start-position[data-disabled]) {
  opacity: 0.5;
  cursor: not-allowed;
}

.peek-default-hint {
  margin: 0 0 12px;
  padding: 8px 10px;
  border-radius: var(--dbx-radius-fixed-6);
  background: color-mix(in srgb, var(--color-primary) 8%, transparent);
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.peek-incomplete {
  margin: 0 0 12px;
  padding: 8px 10px;
  border: 1px solid var(--color-warning-border, #d99a22);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-warning-background, #fff6df);
  color: var(--color-warning-text, #7a4a00);
  font-size: 12px;
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

.peek-controls input,
.peek-controls :deep(.message-browser-start-position) {
  height: 32px;
  width: 100%;
  padding: 7px 10px;
  box-sizing: border-box;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background);
  color: var(--color-text);
  font-size: 13px;
}

.peek-controls input:focus,
.peek-controls :deep(.message-browser-start-position:focus-visible) {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-alpha);
}

.non-kafka-controls {
  margin-top: 6px;
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

.peek-advanced-toggle {
  margin-bottom: 10px;
}

.collapse-arrow {
  display: inline-block;
  font-size: 10px;
  transition: transform 0.15s;
}

.collapse-arrow.expanded {
  transform: rotate(90deg);
}

.collapse-badge {
  color: var(--color-primary);
  font-weight: 700;
}

.panel-error {
  padding: 10px 14px;
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-error-bg);
  color: var(--color-error);
  font-size: 13px;
}

.message-empty {
  padding: 18px;
  border: 1px dashed var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
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

/* Monitoring page already scrolls via .stats-container — avoid a second vertical bar. */
.message-browser.is-monitoring .message-list {
  max-height: none;
  overflow: visible;
}

.message-row {
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
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

.message-copy-action {
  flex-shrink: 0;
}

.message-payload-section,
.message-headers {
  margin-top: 8px;
}

.message-payload-heading,
.message-headers-heading,
.message-headers-values {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.message-payload-heading,
.message-headers-heading {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
}

.message-payload-heading .message-copy-action,
.message-headers-heading .message-copy-action {
  margin-left: auto;
}

.message-payload {
  margin: 6px 0 0;
  padding: 10px;
  max-height: 160px;
  overflow: auto;
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background-tertiary, var(--color-background-secondary));
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-headers-heading {
  margin-bottom: 6px;
}

.message-headers-values span {
  padding: 2px 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  color: var(--color-text-secondary);
  background: var(--color-background-secondary);
  font-size: 12px;
}

@media (max-width: 720px) {
  .peek-controls {
    grid-template-columns: 1fr;
  }
}
</style>

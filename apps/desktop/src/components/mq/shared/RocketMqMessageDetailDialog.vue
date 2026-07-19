<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { SendMessageResponse } from "@/types/mq";
import { formatRocketMqTimestamp } from "@/lib/mq/rocketmqMessageUtils";
import type { RocketMqDisplayMessage } from "@/lib/mq/rocketmqMessageUtils";

interface Props {
  message?: RocketMqDisplayMessage;
  detailLoading?: boolean;
  detailError?: string;
  resendLoading?: boolean;
  resendError?: string;
  resendSuccess?: SendMessageResponse;
  payloadCopied?: boolean;
  resendTopic?: string;
  formattedDetailPayload?: string;
  detailHeaders?: Array<[string, string]>;
  canResend?: boolean;
  canViewTrace?: boolean;
  readOnly?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  detailLoading: false,
  payloadCopied: false,
  canResend: false,
  canViewTrace: false,
  readOnly: false,
});

const emit = defineEmits<{
  close: [];
  copy: [];
  resend: [];
  viewTrace: [];
}>();

const { t } = useI18n();
</script>

<template>
  <div v-if="message" class="dialog-overlay" @click="emit('close')">
    <div class="dialog dialog-wide" @click.stop>
      <div class="dialog-header">
        <h3>{{ t("mqMessages.messageDetails") }}</h3>
        <button type="button" class="btn-close" @click="emit('close')">×</button>
      </div>
      <div class="dialog-body">
        <div v-if="detailLoading" class="results-empty">{{ t("mqMessages.messagesLoading") }}</div>
        <template v-else>
          <div v-if="detailError" class="panel-error">{{ detailError }}</div>
          <div v-if="resendSuccess" class="panel-success">
            {{ t("mqMessages.sendSuccess", { partition: resendSuccess.partition, offset: resendSuccess.offset }) }}
          </div>
          <div v-if="resendError" class="panel-error">{{ resendError }}</div>

          <section class="detail-section">
            <h4>{{ t("mqMessages.messageOverview") }}</h4>
            <div class="detail-grid">
              <span>{{ t("mqMessages.queryTopicLabel") }}</span>
              <span class="mono">{{ resendTopic || "-" }}</span>
              <span>{{ t("mqMessages.tableMessageId") }}</span>
              <span class="mono">{{ message.messageId ?? "-" }}</span>
              <span>{{ t("mqMessages.tableTag") }}</span>
              <span>{{ message.tag ?? "-" }}</span>
              <span>{{ t("mqMessages.tableKey") }}</span>
              <span>{{ message.key ?? "-" }}</span>
              <span>{{ t("mqMessages.tableStoreTime") }}</span>
              <span>{{ formatRocketMqTimestamp(message.timestamp) }}</span>
              <span v-if="message.partition != null">{{ t("mqMessages.partition") }}</span>
              <span v-if="message.partition != null">{{ message.partition }}</span>
            </div>
          </section>

          <section v-if="detailHeaders?.length" class="detail-section">
            <h4>{{ t("mqMessages.messageHeaders") }}</h4>
            <div class="detail-grid">
              <template v-for="[headerKey, headerValue] in detailHeaders" :key="headerKey">
                <span>{{ headerKey }}</span>
                <span class="mono">{{ headerValue }}</span>
              </template>
            </div>
          </section>

          <section class="detail-section">
            <div class="section-heading">
              <h4>{{ t("mqMessages.messageBody") }}</h4>
              <button type="button" class="mq-btn-sm" :disabled="!formattedDetailPayload" @click="emit('copy')">
                {{ payloadCopied ? t("mqMessages.payloadCopied") : t("common.copy") }}
              </button>
            </div>
            <pre class="detail-payload">{{ formattedDetailPayload || "-" }}</pre>
          </section>
        </template>
      </div>
      <div class="dialog-footer">
        <button type="button" class="mq-btn-secondary" @click="emit('close')">{{ t("common.close") }}</button>
        <button v-if="canResend" type="button" class="mq-btn-primary" :disabled="detailLoading || resendLoading || !canResend" :title="readOnly ? t('mqMessages.readOnlyCannotSend') : undefined" @click="emit('resend')">
          {{ resendLoading ? t("mqMessages.sending") : t("mqMessages.resendMessage") }}
        </button>
        <button v-if="canViewTrace && message.messageId" type="button" class="mq-btn-secondary" @click="emit('viewTrace')">
          {{ t("mqTrace.viewTrace") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import "./mqPanel.css";

.results-empty {
  padding: 24px;
  text-align: center;
  color: var(--color-text-secondary);
}

.detail-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.detail-section h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.detail-grid {
  display: grid;
  grid-template-columns: minmax(120px, 160px) 1fr;
  gap: 8px 16px;
  font-size: 13px;
}

.detail-grid > span:nth-child(odd) {
  color: var(--color-text-secondary);
}

.mono {
  font-family: var(--font-mono, ui-monospace, monospace);
  word-break: break-all;
}

.detail-payload {
  margin: 0;
  padding: 12px;
  border-radius: 6px;
  background: var(--color-background-secondary);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
}

.panel-error {
  padding: 10px 12px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--color-error) 12%, transparent);
  color: var(--color-error);
  font-size: 13px;
}

.panel-success {
  padding: 10px 12px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--color-success, #22c55e) 12%, transparent);
  color: var(--color-success, #16a34a);
  font-size: 13px;
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
  max-height: calc(100vh - 32px);
  display: flex;
  flex-direction: column;
  background: var(--color-background);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.dialog-wide {
  width: min(860px, calc(100vw - 32px));
}

.dialog-header,
.dialog-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-border);
}

.dialog-footer {
  border-bottom: none;
  border-top: 1px solid var(--color-border);
  justify-content: flex-end;
}

.dialog-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.dialog-body {
  padding: 16px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.btn-close {
  border: none;
  background: none;
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
  color: var(--color-text-secondary);
}
</style>

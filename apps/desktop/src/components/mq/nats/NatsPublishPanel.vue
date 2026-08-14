<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { NatsPayloadMode } from "@/lib/nats/messagePresentation";

const props = defineProps<{
  subject: string;
  replyTo: string;
  headerText: string;
  payload: string;
  payloadMode: NatsPayloadMode;
  busy?: boolean;
  readOnly?: boolean;
  success?: string;
}>();

const emit = defineEmits<{
  "update:subject": [value: string];
  "update:replyTo": [value: string];
  "update:headerText": [value: string];
  "update:payload": [value: string];
  "update:payloadMode": [value: NatsPayloadMode];
  publish: [];
}>();

const { t } = useI18n();

const subjectHasWildcard = computed(() => /[*]|>/.test(props.subject));
const canPublish = computed(() => !props.readOnly && !!props.payload.trim() && !!props.subject.trim() && !subjectHasWildcard.value);
const payloadPlaceholder = computed(() => {
  if (props.payloadMode === "base64") return t("nats.publish.payloadPlaceholderBase64");
  if (props.payloadMode === "json") return t("nats.publish.payloadPlaceholderJson");
  return t("nats.publish.payloadPlaceholderText");
});
</script>

<template>
  <section class="nats-panel">
    <div class="section-title">{{ t("nats.publish.title") }}</div>
    <p class="form-hint">{{ t("nats.publish.hint") }}</p>
    <div class="publish-grid">
      <div class="field">
        <label for="nats-publish-subject">{{ t("nats.publish.subject") }} <span class="required">*</span></label>
        <input id="nats-publish-subject" type="text" :value="subject" :placeholder="t('nats.publish.subjectPlaceholder')" :disabled="readOnly" :aria-label="t('nats.publish.subject')" @input="emit('update:subject', ($event.target as HTMLInputElement).value)" />
        <div v-if="subjectHasWildcard" class="field-error">{{ t("nats.publish.wildcardError") }}</div>
      </div>
      <div class="field">
        <label for="nats-reply">{{ t("nats.publish.replyTo") }}</label>
        <input id="nats-reply" type="text" :value="replyTo" :placeholder="t('nats.publish.replyPlaceholder')" :disabled="readOnly" :aria-label="t('nats.publish.replyTo')" @input="emit('update:replyTo', ($event.target as HTMLInputElement).value)" />
      </div>
      <div class="field">
        <label for="nats-payload-mode">{{ t("nats.publish.payloadMode") }}</label>
        <select id="nats-payload-mode" :value="payloadMode" :disabled="readOnly" :aria-label="t('nats.publish.payloadMode')" @change="emit('update:payloadMode', ($event.target as HTMLSelectElement).value as NatsPayloadMode)">
          <option value="text">{{ t("nats.publish.modeText") }}</option>
          <option value="json">{{ t("nats.publish.modeJson") }}</option>
          <option value="base64">{{ t("nats.publish.modeBase64") }}</option>
        </select>
      </div>
      <div class="field span-2">
        <label for="nats-headers">{{ t("nats.publish.headers") }}</label>
        <textarea id="nats-headers" class="headers-textarea" rows="3" :value="headerText" :placeholder="t('nats.publish.headersPlaceholder')" :disabled="readOnly" :aria-label="t('nats.publish.headers')" @input="emit('update:headerText', ($event.target as HTMLTextAreaElement).value)" />
      </div>
      <div class="field span-2">
        <label for="nats-payload">{{ t("nats.publish.payload") }} <span class="required">*</span></label>
        <textarea id="nats-payload" class="code-textarea" rows="6" :value="payload" :placeholder="payloadPlaceholder" :disabled="readOnly" :aria-label="t('nats.publish.payload')" @input="emit('update:payload', ($event.target as HTMLTextAreaElement).value)" />
      </div>
    </div>
    <div class="form-actions">
      <button type="button" class="btn-primary" :disabled="busy || !canPublish" @click="emit('publish')">
        {{ t("nats.publish.action") }}
      </button>
      <span v-if="readOnly" class="readonly-hint inline">{{ t("nats.publish.readOnly") }}</span>
      <span v-else-if="success" class="success-text">{{ success }}</span>
    </div>
  </section>
</template>

<style scoped>
@import "../shared/mqPanel.css";
@import "./natsPanel.css";
</style>

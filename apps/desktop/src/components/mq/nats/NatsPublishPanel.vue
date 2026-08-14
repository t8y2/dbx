<script setup lang="ts">
/**
 * NATS Publish tab — standalone page (separate from Subscribe).
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useMqMutationGuard } from "@/composables/useMqMutationGuard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import * as api from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import { buildNatsPublishRequest, isWildcardSubject, type NatsPayloadMode } from "@/lib/nats/messagePresentation";

const props = defineProps<{
  connectionId: string;
  readOnly?: boolean;
}>();

const { t } = useI18n();
const { confirmMqWrite } = useMqMutationGuard(() => props.connectionId);

const subject = ref("");
const replyTo = ref("");
const headerText = ref("");
const payload = ref("");
const payloadMode = ref<NatsPayloadMode>("text");
const busy = ref(false);
const error = ref("");
const success = ref("");

const subjectHasWildcard = computed(() => isWildcardSubject(subject.value));
const canPublish = computed(() => !props.readOnly && !!payload.value.trim() && !!subject.value.trim() && !subjectHasWildcard.value);
const payloadPlaceholder = computed(() => {
  if (payloadMode.value === "base64") return t("nats.publish.payloadPlaceholderBase64");
  if (payloadMode.value === "json") return t("nats.publish.payloadPlaceholderJson");
  return t("nats.publish.payloadPlaceholderText");
});

async function publish() {
  success.value = "";
  error.value = "";
  if (props.readOnly || !canPublish.value) return;
  if (!(await confirmMqWrite(t("nats.publish.confirm", { subject: subject.value.trim() })))) return;
  busy.value = true;
  try {
    const result = await api.natsPublish(props.connectionId, buildNatsPublishRequest(subject.value, replyTo.value, headerText.value, payload.value, payloadMode.value));
    success.value = t("nats.publish.success", { bytes: result.payloadBytes, subject: subject.value.trim() });
    payload.value = "";
  } catch (e) {
    error.value = formatError(e);
  } finally {
    busy.value = false;
  }
}

watch(
  () => props.connectionId,
  () => {
    error.value = "";
    success.value = "";
  },
);
</script>

<template>
  <div class="nats-page nats-publish-page">
    <header class="nats-page-header">
      <h3 class="nats-page-title">{{ t("nats.publish.title") }}</h3>
    </header>

    <div class="nats-page-body">
      <div v-if="error" class="panel-error">{{ error }}</div>
      <div v-if="success" class="success-text">{{ success }}</div>
      <div v-if="readOnly" class="readonly-hint inline">{{ t("nats.publish.readOnly") }}</div>

      <div class="publish-fields">
        <div class="publish-row">
          <div class="field publish-subject">
            <label for="nats-publish-subject">{{ t("nats.publish.subject") }} <span class="required">*</span></label>
            <input id="nats-publish-subject" type="text" v-model="subject" :placeholder="t('nats.publish.subjectPlaceholder')" :disabled="readOnly" :aria-label="t('nats.publish.subject')" />
            <div v-if="subjectHasWildcard" class="field-error">{{ t("nats.publish.wildcardError") }}</div>
          </div>
          <div class="field publish-reply">
            <label for="nats-reply">{{ t("nats.publish.replyTo") }}</label>
            <input id="nats-reply" type="text" v-model="replyTo" :placeholder="t('nats.publish.replyPlaceholder')" :disabled="readOnly" :aria-label="t('nats.publish.replyTo')" />
          </div>
          <div class="field publish-mode">
            <label>{{ t("nats.publish.payloadMode") }}</label>
            <Select :model-value="payloadMode" :disabled="readOnly" @update:model-value="payloadMode = $event as NatsPayloadMode">
              <SelectTrigger class="publish-mode-select" :aria-label="t('nats.publish.payloadMode')">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="text">{{ t("nats.publish.modeText") }}</SelectItem>
                <SelectItem value="json">{{ t("nats.publish.modeJson") }}</SelectItem>
                <SelectItem value="base64">{{ t("nats.publish.modeBase64") }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div class="field">
          <label for="nats-headers">{{ t("nats.publish.headers") }}</label>
          <textarea id="nats-headers" class="headers-textarea" rows="3" v-model="headerText" :placeholder="t('nats.publish.headersPlaceholder')" :disabled="readOnly" :aria-label="t('nats.publish.headers')" />
        </div>

        <div class="field">
          <label for="nats-payload">{{ t("nats.publish.payload") }} <span class="required">*</span></label>
          <textarea id="nats-payload" class="code-textarea" rows="10" v-model="payload" :placeholder="payloadPlaceholder" :disabled="readOnly" :aria-label="t('nats.publish.payload')" />
        </div>

        <div class="form-actions">
          <button type="button" class="btn-primary" :disabled="busy || !canPublish" @click="publish">
            {{ t("nats.publish.action") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import "../shared/mqPanel.css";
@import "./natsPanel.css";
</style>

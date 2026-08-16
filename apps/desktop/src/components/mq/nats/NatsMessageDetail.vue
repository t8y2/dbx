<script setup lang="ts">
/**
 * Master/detail right pane — mirrors mainstream NATS GUIs (NUI, NATS Studio):
 * the selected message's metadata, a multi-format payload viewer, and a
 * headers table, with copy affordances. Purely presentational.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatError } from "@/lib/backend/errorUtils";
import { LARGE_PAYLOAD_BYTES, availableViewModes, formatHeadersForCopy, presentNatsMessage, type NatsViewMode } from "@/lib/nats/messagePresentation";
import type { NatsMessage } from "@/types/nats";

const props = defineProps<{ message?: NatsMessage }>();

const { t } = useI18n();
const { toast } = useToast();

const mode = ref<NatsViewMode>("auto");
const expanded = ref(false);

const modes = computed(() => (props.message ? availableViewModes(props.message) : []));
const view = computed(() => (props.message ? presentNatsMessage(props.message, mode.value) : undefined));
const isLarge = computed(() => !!props.message && props.message.sizeBytes > LARGE_PAYLOAD_BYTES);
const showPayload = computed(() => !isLarge.value || expanded.value);
const receivedAt = computed(() => (props.message ? new Date(props.message.receivedAtMs).toISOString() : ""));

watch(
  () => props.message,
  () => {
    // Keep the user's chosen mode across the live stream when it still applies.
    if (!modes.value.includes(mode.value)) mode.value = modes.value[0] ?? "auto";
    expanded.value = false;
  },
);

async function copyText(text: string) {
  try {
    await copyToClipboard(text);
    toast(t("grid.copied"));
  } catch (cause: unknown) {
    toast(t("grid.copyFailed", { message: formatError(cause) }), 5000);
  }
}
</script>

<template>
  <div class="nats-message-detail">
    <div v-if="!message || !view" class="panel-placeholder">{{ t("nats.messages.detailPlaceholder") }}</div>
    <template v-else>
      <div class="detail-meta">
        <div class="detail-subject">{{ message.subject }}</div>
        <div class="detail-sub">
          <span>{{ receivedAt }}</span>
          <span>· {{ view.sizeLabel }}</span>
          <span v-if="message.reply">· {{ t("nats.messages.reply", { reply: message.reply }) }}</span>
        </div>
      </div>

      <div class="detail-payload">
        <div class="detail-bar">
          <div class="mode-tabs">
            <button v-for="m in modes" :key="m" type="button" class="mode-tab" :class="{ active: view.mode === m || (mode === m && m === 'auto') }" @click="mode = m">
              {{ t(`nats.messages.mode.${m}`) }}
            </button>
          </div>
          <div class="detail-actions">
            <button v-if="isLarge" type="button" class="btn-sm" @click="expanded = !expanded">
              {{ expanded ? t("nats.messages.hidePayload") : t("nats.messages.showPayload", { size: view.sizeLabel }) }}
            </button>
            <button type="button" class="btn-sm" @click="copyText(view.payload)">{{ t("nats.messages.copyPayload") }}</button>
          </div>
        </div>
        <pre v-if="showPayload" data-native-clipboard class="detail-payload-body">{{ view.payload }}</pre>
        <div v-else class="message-payload-collapsed">{{ t("nats.messages.showPayload", { size: view.sizeLabel }) }}</div>
      </div>

      <div class="detail-headers">
        <div class="detail-headers-head">
          <span>{{ t("nats.messages.headers") }}</span>
          <button v-if="message.headers.length" type="button" class="btn-sm" @click="copyText(formatHeadersForCopy(message.headers))">{{ t("nats.messages.copyHeaders") }}</button>
        </div>
        <table v-if="message.headers.length" class="headers-table">
          <tbody>
            <tr v-for="(header, index) in message.headers" :key="`${header.key}-${index}`">
              <td class="header-key">{{ header.key }}</td>
              <td class="header-value">{{ header.value }}</td>
            </tr>
          </tbody>
        </table>
        <div v-else class="status-text">{{ t("nats.messages.noHeaders") }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
@import "../shared/mqPanel.css";
@import "./natsPanel.css";
</style>

<script setup lang="ts">
/** A stable card instance avoids reformatting older payloads during live updates. */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Copy } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { useToast } from "@/composables/useToast";
import { formatError } from "@/lib/backend/errorUtils";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatHeadersForCopy, presentNatsMessage } from "@/lib/nats/messagePresentation";
import type { NatsMessage } from "@/types/nats";

const props = defineProps<{
  message: NatsMessage;
  ordinal: number;
}>();

const { t } = useI18n();
const { toast } = useToast();

const view = computed(() => presentNatsMessage(props.message));

function timestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}

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
  <article class="nats-msg-card">
    <div class="nats-msg-meta">
      <span>#{{ ordinal }}</span>
      <span class="nats-msg-subject">{{ message.subject }}</span>
      <span v-if="message.reply">{{ t("nats.messages.reply", { reply: message.reply }) }}</span>
      <span>{{ view.sizeLabel }}</span>
      <span>{{ timestamp(message.receivedAtMs) }}</span>
    </div>
    <div class="nats-msg-section">
      <div class="nats-msg-heading">
        <span>{{ t("nats.messages.payload") }}</span>
        <Button type="button" variant="outline" size="sm" class="nats-msg-copy h-7 gap-1.5 px-2 text-xs" @click="copyText(view.payload)">
          <Copy :size="14" aria-hidden="true" />
          {{ t("grid.copy") }}
        </Button>
      </div>
      <pre data-native-clipboard class="nats-msg-payload">{{ view.payload }}</pre>
    </div>
    <div v-if="message.headers.length" class="nats-msg-section">
      <div class="nats-msg-heading">
        <span>{{ t("nats.messages.headers") }}</span>
        <Button type="button" variant="outline" size="sm" class="nats-msg-copy h-7 gap-1.5 px-2 text-xs" @click="copyText(formatHeadersForCopy(message.headers))">
          <Copy :size="14" aria-hidden="true" />
          {{ t("grid.copy") }}
        </Button>
      </div>
      <div class="nats-msg-headers-values">
        <span v-for="(header, index) in message.headers" :key="index">{{ header.key }}: {{ header.value }}</span>
      </div>
    </div>
  </article>
</template>

<style scoped>
@import "../shared/mqPanel.css";
@import "./natsPanel.css";
</style>

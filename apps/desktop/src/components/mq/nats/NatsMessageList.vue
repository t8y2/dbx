<script setup lang="ts">
/**
 * Shared NATS message list — same card layout as the Kafka MessageBrowser:
 * each message is a card with a meta line, an inline payload block, and a
 * headers block, each with a copy action. No format tabs, no separate detail
 * pane. Used by both the Pub/Sub and JetStream Stored-messages tabs.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Copy } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatError } from "@/lib/backend/errorUtils";
import { formatHeadersForCopy, presentNatsMessage } from "@/lib/nats/messagePresentation";
import type { NatsMessage } from "@/types/nats";

const props = defineProps<{
  messages: NatsMessage[];
  emptyText?: string;
}>();

const { t } = useI18n();
const { toast } = useToast();

const items = computed(() => props.messages.map((message) => ({ message, view: presentNatsMessage(message) })));

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
  <div class="nats-msg-list">
    <article v-for="(item, index) in items" :key="`${item.message.receivedAtMs}-${index}`" class="nats-msg-card">
      <div class="nats-msg-meta">
        <span>#{{ index + 1 }}</span>
        <span class="nats-msg-subject">{{ item.message.subject }}</span>
        <span v-if="item.message.reply">{{ t("nats.messages.reply", { reply: item.message.reply }) }}</span>
        <span>{{ item.view.sizeLabel }}</span>
        <span>{{ timestamp(item.message.receivedAtMs) }}</span>
      </div>
      <div class="nats-msg-section">
        <div class="nats-msg-heading">
          <span>{{ t("nats.messages.payload") }}</span>
          <Button type="button" variant="outline" size="sm" class="nats-msg-copy h-7 gap-1.5 px-2 text-xs" @click="copyText(item.view.payload)">
            <Copy :size="14" aria-hidden="true" />
            {{ t("grid.copy") }}
          </Button>
        </div>
        <pre data-native-clipboard class="nats-msg-payload">{{ item.view.payload }}</pre>
      </div>
      <div v-if="item.message.headers.length" class="nats-msg-section">
        <div class="nats-msg-heading">
          <span>{{ t("nats.messages.headers") }}</span>
          <Button type="button" variant="outline" size="sm" class="nats-msg-copy h-7 gap-1.5 px-2 text-xs" @click="copyText(formatHeadersForCopy(item.message.headers))">
            <Copy :size="14" aria-hidden="true" />
            {{ t("grid.copy") }}
          </Button>
        </div>
        <div class="nats-msg-headers-values">
          <span v-for="(header, hi) in item.message.headers" :key="hi">{{ header.key }}: {{ header.value }}</span>
        </div>
      </div>
    </article>
    <div v-if="!items.length" class="panel-placeholder compact">{{ emptyText || t("nats.messages.empty") }}</div>
  </div>
</template>

<style scoped>
@import "../shared/mqPanel.css";
@import "./natsPanel.css";
</style>

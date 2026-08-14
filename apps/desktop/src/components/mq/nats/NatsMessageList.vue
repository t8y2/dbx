<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { presentNatsMessage } from "@/lib/nats/messagePresentation";
import type { NatsMessage } from "@/types/nats";

const props = defineProps<{
  messages: NatsMessage[];
  summary?: string;
}>();

const { t } = useI18n();

const presented = computed(() =>
  props.messages.map((message) => ({
    message,
    view: presentNatsMessage(message),
  })),
);
</script>

<template>
  <section class="nats-panel messages-card">
    <div class="messages-summary">{{ summary || t("nats.messages.title") }}</div>
    <div v-if="presented.length" class="message-list">
      <div v-for="(item, index) in presented" :key="`${item.message.receivedAtMs}-${index}`" class="message-item">
        <div class="message-meta">
          {{ item.view.receivedAt }} · {{ item.message.subject }} · {{ item.view.sizeLabel }} · {{ item.view.mode }}
          <span v-if="item.message.reply"> · {{ t("nats.messages.reply", { reply: item.message.reply }) }}</span>
        </div>
        <pre class="message-payload">{{ item.view.payload }}</pre>
        <div v-if="item.message.headers.length" class="message-headers">
          {{ item.message.headers.map((header) => `${header.key}: ${header.value}`).join("; ") }}
        </div>
      </div>
    </div>
    <div v-else class="panel-placeholder compact">{{ t("nats.messages.empty") }}</div>
  </section>
</template>

<style scoped>
@import "../shared/mqPanel.css";
@import "./natsPanel.css";
</style>

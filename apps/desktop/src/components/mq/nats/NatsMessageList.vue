<script setup lang="ts">
/**
 * Shared NATS message list — same card layout as the Kafka MessageBrowser:
 * each message is a card with a meta line, an inline payload block, and a
 * headers block, each with a copy action. No format tabs, no separate detail
 * pane. Used by both the Pub/Sub and JetStream Stored-messages tabs.
 */
import { useI18n } from "vue-i18n";
import type { NatsMessage } from "@/types/nats";
import NatsMessageCard from "./NatsMessageCard.vue";

const props = defineProps<{
  messages: NatsMessage[];
  emptyText?: string;
}>();

const { t } = useI18n();

const ordinals = new WeakMap<NatsMessage, number>();
let nextOrdinal = 1;

function ordinalFor(message: NatsMessage): number {
  let ordinal = ordinals.get(message);
  if (ordinal === undefined) {
    ordinal = nextOrdinal;
    nextOrdinal += 1;
    ordinals.set(message, ordinal);
  }
  return ordinal;
}
</script>

<template>
  <div class="nats-msg-list">
    <NatsMessageCard v-for="(message, index) in messages" :key="ordinalFor(message)" :message="message" :ordinal="index + 1" />
    <div v-if="!messages.length" class="panel-placeholder compact">{{ emptyText || t("nats.messages.empty") }}</div>
  </div>
</template>

<style scoped>
@import "../shared/mqPanel.css";
@import "./natsPanel.css";
</style>

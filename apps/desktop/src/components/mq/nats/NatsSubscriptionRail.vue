<script setup lang="ts">
/**
 * Active feeds as selectable chips — click to view messages, × to remove.
 * Compact enough for many concurrent subscriptions without a full table.
 */
import { useI18n } from "vue-i18n";
import type { NatsFeed } from "./feed";

defineProps<{
  feeds: NatsFeed[];
  activeId?: string;
}>();

const emit = defineEmits<{
  select: [id: string];
  remove: [id: string];
}>();

const { t } = useI18n();

function kindLabel(feed: NatsFeed): string {
  return feed.kind === "capture" ? t("nats.subjectWorkbench.capture") : t("nats.subjectWorkbench.subscribe");
}

function stateClass(feed: NatsFeed): string {
  if (feed.state === "error") return "is-error";
  if (feed.state === "starting") return "is-starting";
  if (feed.kind === "capture") return "is-capture";
  return "";
}
</script>

<template>
  <div v-if="feeds.length" class="feed-chips" data-testid="nats-feed-chips" role="tablist" :aria-label="t('nats.messages.subscriptions')">
    <div v-for="feed in feeds" :key="feed.id" class="feed-chip" :class="[{ active: feed.id === activeId }, stateClass(feed)]" role="tab" :aria-selected="feed.id === activeId" :data-feed-id="feed.id" data-testid="nats-feed-chip">
      <button type="button" class="feed-chip-main" @click="emit('select', feed.id)">
        <span class="feed-chip-subject" :title="feed.subject">{{ feed.subject }}</span>
        <span class="feed-chip-kind">{{ kindLabel(feed) }}</span>
        <span class="feed-chip-count">{{ feed.receivedCount }}</span>
      </button>
      <button type="button" class="feed-chip-close" :aria-label="t('nats.messages.remove')" data-testid="nats-feed-remove" @click="emit('remove', feed.id)">✕</button>
    </div>
  </div>
</template>

<style scoped>
@import "../shared/mqPanel.css";
@import "./natsPanel.css";
</style>

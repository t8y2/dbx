<script setup lang="ts">
/**
 * NATS Subscribe tab — multi-subscription inbox with a dedicated toolbar header.
 * Feed chips switch the active buffer; publish lives on its own tab.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import * as api from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import type { NatsMessage, NatsSubscriptionErrorEvent, NatsSubscriptionMessageEvent, NatsSubscriptionStateEvent } from "@/types/nats";
import { FEED_BUFFER_LIMIT, type NatsFeed } from "./feed";
import NatsSubscriptionRail from "./NatsSubscriptionRail.vue";
import NatsMessageList from "./NatsMessageList.vue";

const props = defineProps<{
  connectionId: string;
  readOnly?: boolean;
}>();

const { t } = useI18n();

const receiveMode = ref<"subscribe" | "capture">("subscribe");
const subject = ref("");
const durationMs = ref(5000);
const maxMessages = ref(100);

const feeds = ref<NatsFeed[]>([]);
const activeFeedId = ref<string>();
const busy = ref(false);
const error = ref("");

const listeners = new Map<string, () => void>();

interface PendingSubscriptionStart {
  connectionId: string;
  cancelled: boolean;
  requested: boolean;
  startPromise?: ReturnType<typeof api.natsStartSubscription>;
  stopPromise?: Promise<void>;
}

const pendingStarts = new Map<string, PendingSubscriptionStart>();

interface PendingFeedMessages {
  messages: NatsMessage[];
  start: number;
  receivedCount: number;
}

// Native events can arrive much faster than Vue can render cards. Keep only the
// newest pending messages and commit them together on the next browser frame.
const pendingMessages = new Map<string, PendingFeedMessages>();
let messageFlushScheduled = false;
let messageFlushFrame: number | undefined;
let messageFlushGeneration = 0;
let captureGeneration = 0;

const activeFeed = computed(() => feeds.value.find((feed) => feed.id === activeFeedId.value));
const activeMessages = computed(() => activeFeed.value?.messages ?? []);

const activeSummary = computed(() => {
  const feed = activeFeed.value;
  if (!feed) return "";
  if (feed.kind === "capture") {
    const reasonKey = `nats.captureReason.${feed.stopReason}`;
    const translated = t(reasonKey);
    const reason = translated === reasonKey ? (feed.stopReason ?? "") : translated;
    return t("nats.messages.captureSummary", { received: feed.receivedCount, reason });
  }
  const stateKey = `nats.state.${feed.state}`;
  const translatedState = t(stateKey);
  const state = translatedState === stateKey ? feed.state : translatedState;
  return t("nats.messages.liveSummary", { received: feed.receivedCount, dropped: feed.droppedCount, state });
});

function nextSubscriptionId() {
  return globalThis.crypto?.randomUUID?.() || `nats-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function selectFeed(id: string) {
  activeFeedId.value = id;
}

function flushPendingMessages() {
  messageFlushScheduled = false;
  messageFlushFrame = undefined;
  const batches = [...pendingMessages.entries()];
  pendingMessages.clear();

  for (const [feedId, pending] of batches) {
    const feed = feeds.value.find((item) => item.id === feedId);
    if (!feed) continue;
    const messages = pending.start ? pending.messages.slice(pending.start) : pending.messages;
    if (messages.length) feed.messages = [...feed.messages, ...messages].slice(-FEED_BUFFER_LIMIT);
    feed.receivedCount += pending.receivedCount;
  }
}

function scheduleMessageFlush() {
  if (messageFlushScheduled) return;
  messageFlushScheduled = true;
  const generation = messageFlushGeneration;
  const flush = () => {
    if (generation !== messageFlushGeneration) return;
    flushPendingMessages();
  };

  if (typeof requestAnimationFrame === "function") {
    messageFlushFrame = requestAnimationFrame(flush);
  } else {
    queueMicrotask(flush);
  }
}

function queueFeedMessage(feedId: string, message: NatsMessage) {
  let pending = pendingMessages.get(feedId);
  if (!pending) {
    pending = { messages: [], start: 0, receivedCount: 0 };
    pendingMessages.set(feedId, pending);
  }
  pending.messages.push(message);
  pending.receivedCount += 1;

  // A suspended window may not receive animation frames. Bound the queue until
  // rendering resumes without losing the newest-message-wins buffer behaviour.
  if (pending.messages.length - pending.start > FEED_BUFFER_LIMIT) pending.start = pending.messages.length - FEED_BUFFER_LIMIT;
  if (pending.start >= FEED_BUFFER_LIMIT / 2) {
    pending.messages = pending.messages.slice(pending.start);
    pending.start = 0;
  }
  scheduleMessageFlush();
}

function discardPendingMessages(feedId?: string) {
  if (feedId) {
    pendingMessages.delete(feedId);
    return;
  }
  pendingMessages.clear();
  messageFlushGeneration += 1;
  if (messageFlushFrame !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(messageFlushFrame);
  messageFlushFrame = undefined;
  messageFlushScheduled = false;
}

async function installFeedListener(connectionId: string, feedId: string) {
  const stop = await api.natsListenSubscription(connectionId, feedId, {
    onMessage(event: NatsSubscriptionMessageEvent) {
      if (event.connectionId !== connectionId || event.subscriptionId !== feedId) return;
      const feed = feeds.value.find((item) => item.id === feedId);
      if (!feed || feed.runtimeId === undefined || event.runtimeId !== feed.runtimeId) return;
      queueFeedMessage(feedId, event.message);
    },
    onState(event: NatsSubscriptionStateEvent) {
      if (event.connectionId !== connectionId || event.subscriptionId !== feedId) return;
      const feed = feeds.value.find((item) => item.id === feedId);
      if (feed && feed.runtimeId !== undefined && event.runtimeId === feed.runtimeId) feed.state = event.state;
    },
    onError(event: NatsSubscriptionErrorEvent) {
      if (event.connectionId !== connectionId || event.subscriptionId !== feedId) return;
      const feed = feeds.value.find((item) => item.id === feedId);
      if (!feed || feed.runtimeId === undefined || event.runtimeId !== feed.runtimeId) return;
      error.value = event.message;
      feed.state = "error";
    },
  });
  listeners.set(feedId, stop);
}

function stopStartedSubscription(id: string, pending: PendingSubscriptionStart): Promise<void> {
  if (!pending.requested) return Promise.resolve();
  // A stop sent before the start reaches the backend is a no-op there. Wait
  // for the start request to settle so teardown cannot leave an orphan feed.
  pending.stopPromise ??= (pending.startPromise ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => api.natsStopSubscription(pending.connectionId, id))
    .then(() => undefined);
  return pending.stopPromise;
}

async function rollbackStartedSubscription(id: string, pending: PendingSubscriptionStart): Promise<unknown> {
  try {
    await stopStartedSubscription(id, pending);
    return undefined;
  } catch (e) {
    return e;
  }
}

function stopListener(feedId: string) {
  listeners.get(feedId)?.();
  listeners.delete(feedId);
}

function removeFeedState(id: string) {
  feeds.value = feeds.value.filter((item) => item.id !== id);
  if (activeFeedId.value === id) activeFeedId.value = feeds.value[feeds.value.length - 1]?.id;
}

async function subscribe() {
  const value = subject.value.trim();
  if (!value || busy.value) return;
  const existing = feeds.value.find((feed) => feed.kind === "live" && feed.subject === value && feed.state !== "stopped");
  if (existing) {
    selectFeed(existing.id);
    subject.value = "";
    return;
  }
  busy.value = true;
  error.value = "";
  const connectionId = props.connectionId;
  const id = nextSubscriptionId();
  const feed: NatsFeed = { id, connectionId, subject: value, kind: "live", state: "starting", messages: [], receivedCount: 0, droppedCount: 0 };
  const pending: PendingSubscriptionStart = { connectionId, cancelled: false, requested: false };
  pendingStarts.set(id, pending);
  feeds.value = [...feeds.value, feed];
  selectFeed(id);
  try {
    if (isTauriRuntime()) await installFeedListener(connectionId, id);
    if (pending.cancelled) {
      stopListener(id);
      removeFeedState(id);
      return;
    }
    pending.requested = true;
    const startPromise = api.natsStartSubscription(connectionId, { subscriptionId: id, subject: value });
    pending.startPromise = startPromise;
    const started = await startPromise;
    if (pending.cancelled) {
      await stopStartedSubscription(id, pending);
      removeFeedState(id);
      return;
    }
    const current = feeds.value.find((item) => item.id === id);
    if (!current) {
      pending.cancelled = true;
      await stopStartedSubscription(id, pending);
      return;
    }
    current.state = started.state;
    current.runtimeId = started.runtimeId;
    current.receivedCount = Math.max(started.receivedCount, current.receivedCount);
    current.droppedCount = Math.max(started.droppedCount, current.droppedCount);
    if (!isTauriRuntime()) await installFeedListener(connectionId, id);
    if (pending.cancelled) {
      stopListener(id);
      await stopStartedSubscription(id, pending);
      removeFeedState(id);
      return;
    }
    subject.value = "";
  } catch (e) {
    stopListener(id);
    discardPendingMessages(id);
    const rollbackError = await rollbackStartedSubscription(id, pending);
    if (rollbackError === undefined) {
      removeFeedState(id);
    } else {
      const current = feeds.value.find((item) => item.id === id);
      if (current) current.state = "error";
    }
    error.value = formatError(rollbackError ?? e);
  } finally {
    pendingStarts.delete(id);
    busy.value = false;
  }
}

async function capture() {
  const value = subject.value.trim();
  if (!value || busy.value) return;
  const generation = ++captureGeneration;
  const connectionId = props.connectionId;
  busy.value = true;
  error.value = "";
  try {
    const result = await api.natsCapture(connectionId, {
      subject: value,
      durationMs: durationMs.value,
      maxMessages: maxMessages.value,
      includeHeaders: true,
    });
    if (generation !== captureGeneration || connectionId !== props.connectionId) return;
    const feed: NatsFeed = {
      id: `capture-${nextSubscriptionId()}`,
      connectionId,
      subject: value,
      kind: "capture",
      state: "stopped",
      messages: result.messages,
      receivedCount: result.receivedCount,
      droppedCount: result.droppedCount,
      stopReason: result.stopReason,
    };
    feeds.value = [...feeds.value, feed];
    selectFeed(feed.id);
    subject.value = "";
  } catch (e) {
    if (generation === captureGeneration) error.value = formatError(e);
  } finally {
    if (generation === captureGeneration) busy.value = false;
  }
}

async function removeFeed(id: string) {
  const feed = feeds.value.find((item) => item.id === id);
  if (!feed) return;
  const pending = pendingStarts.get(id);
  if (pending) pending.cancelled = true;
  stopListener(id);
  discardPendingMessages(id);
  if (feed.kind !== "live") {
    removeFeedState(id);
    return;
  }
  if (pending?.requested) {
    try {
      await stopStartedSubscription(id, pending);
    } catch (e) {
      error.value = formatError(e);
      const current = feeds.value.find((item) => item.id === id);
      if (current) current.state = "error";
      return;
    }
  } else if (pending) {
    removeFeedState(id);
    return;
  } else if (feed.state !== "stopped") {
    try {
      await api.natsStopSubscription(feed.connectionId, id);
    } catch (e) {
      error.value = formatError(e);
      const current = feeds.value.find((item) => item.id === id);
      if (current) current.state = "error";
      return;
    }
  }
  removeFeedState(id);
}

function clearActiveMessages() {
  const feed = activeFeed.value;
  if (!feed) return;
  discardPendingMessages(feed.id);
  feed.messages = [];
  feed.receivedCount = 0;
}

function runReceiveAction() {
  if (receiveMode.value === "subscribe") void subscribe();
  else void capture();
}

async function stopAllFeeds() {
  captureGeneration += 1;
  busy.value = false;
  // Include feeds that are still starting even if a late state event already
  // marked them stopped; their start request still needs cancellation.
  const live = feeds.value.filter((feed) => feed.kind === "live");
  const pending = live.map((feed) => [feed, pendingStarts.get(feed.id)] as const);
  pending.forEach(([, start]) => {
    if (start) start.cancelled = true;
  });
  listeners.forEach((stop) => stop());
  listeners.clear();
  discardPendingMessages();
  feeds.value = [];
  activeFeedId.value = undefined;
  await Promise.all(
    pending.map(([feed, start]) =>
      (start?.requested ? stopStartedSubscription(feed.id, start) : start ? Promise.resolve() : api.natsStopSubscription(feed.connectionId, feed.id)).catch(() => {
        /* best-effort teardown */
      }),
    ),
  );
}

watch(
  () => props.connectionId,
  async () => {
    await stopAllFeeds();
    error.value = "";
  },
);

onBeforeUnmount(() => {
  void stopAllFeeds();
});

defineExpose({ stopAllFeeds, clearActiveMessages });
</script>

<template>
  <div class="nats-page nats-subscribe-page">
    <!-- Dedicated toolbar header: title + subject composer + actions -->
    <header class="nats-page-header nats-sub-header" data-testid="nats-receive-controls">
      <h3 class="nats-page-title">{{ t("nats.messages.subscriptions") }}</h3>

      <div class="nats-sub-composer">
        <input class="nats-header-subject sub-subject" type="text" v-model="subject" :placeholder="t('nats.subjectWorkbench.subjectPlaceholder')" :aria-label="t('nats.subjectWorkbench.subjectFilter')" @keydown.enter="subject.trim() && runReceiveAction()" />
        <Select :model-value="receiveMode" @update:model-value="receiveMode = String($event) === 'capture' ? 'capture' : 'subscribe'">
          <SelectTrigger class="nats-header-mode" :aria-label="t('nats.messages.receiveMode')">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="subscribe">{{ t("nats.subjectWorkbench.subscribe") }}</SelectItem>
            <SelectItem value="capture">{{ t("nats.subjectWorkbench.capture") }}</SelectItem>
          </SelectContent>
        </Select>
        <template v-if="receiveMode === 'capture'">
          <input class="nats-header-num" type="number" min="1" max="60000" v-model.number="durationMs" :aria-label="t('nats.subjectWorkbench.captureMs')" :title="t('nats.subjectWorkbench.captureMs')" />
          <input class="nats-header-num" type="number" min="1" max="1000" v-model.number="maxMessages" :aria-label="t('nats.subjectWorkbench.maxMessages')" :title="t('nats.subjectWorkbench.maxMessages')" />
        </template>
        <button type="button" class="mq-btn-primary" data-testid="nats-receive-action" :disabled="busy || !subject.trim()" @click="runReceiveAction">
          {{ receiveMode === "subscribe" ? t("nats.subjectWorkbench.subscribe") : t("nats.subjectWorkbench.capture") }}
        </button>
      </div>

      <div class="nats-sub-header-actions">
        <span v-if="activeSummary" class="msg-summary status-text">{{ activeSummary }}</span>
        <button type="button" class="mq-btn-sm" :disabled="busy || !activeMessages.length" @click="clearActiveMessages">
          {{ t("nats.messages.clear") }}
        </button>
      </div>
    </header>

    <div class="nats-page-body nats-sub-body">
      <div v-if="error" class="panel-error">{{ error }}</div>
      <NatsSubscriptionRail :feeds="feeds" :active-id="activeFeedId" @select="selectFeed" @remove="removeFeed" />
      <NatsMessageList :messages="activeMessages" :empty-text="feeds.length ? t('nats.messages.empty') : t('nats.messages.noSubscriptions')" />
    </div>
  </div>
</template>

<style scoped>
@import "../shared/mqPanel.css";
@import "./natsPanel.css";
</style>

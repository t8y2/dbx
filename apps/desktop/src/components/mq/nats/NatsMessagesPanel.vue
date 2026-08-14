<script setup lang="ts">
/**
 * NATS Messages tab — mirrors Kafka/RocketMQ Messages panel interaction:
 * choose target → browse/receive → send. Domain fields are subject-based.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useMqMutationGuard } from "@/composables/useMqMutationGuard";
import * as api from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { buildNatsPublishRequest, type NatsPayloadMode } from "@/lib/nats/messagePresentation";
import type { NatsCaptureResult, NatsMessage, NatsSubscriptionErrorEvent, NatsSubscriptionInfo, NatsSubscriptionMessageEvent, NatsSubscriptionStateEvent } from "@/types/nats";
import NatsSubjectWorkbench from "./NatsSubjectWorkbench.vue";
import NatsPublishPanel from "./NatsPublishPanel.vue";
import NatsMessageList from "./NatsMessageList.vue";

const props = defineProps<{
  connectionId: string;
  readOnly?: boolean;
}>();

const { t } = useI18n();
const { confirmMqWrite } = useMqMutationGuard(() => props.connectionId);

const subject = ref("orders.>");
const publishSubject = ref("orders.created");
const durationMs = ref(5000);
const maxMessages = ref(100);
const capture = ref<NatsCaptureResult>();
const payload = ref("");
const payloadMode = ref<NatsPayloadMode>("text");
const replyTo = ref("");
const headerText = ref("");
const liveSubscription = ref<NatsSubscriptionInfo>();
const liveMessages = ref<NatsMessage[]>([]);
const busy = ref(false);
const error = ref("");
const publishOk = ref("");

const isLiveActive = computed(() => liveSubscription.value?.state === "active" || liveSubscription.value?.state === "starting");

const displayMessages = computed(() => {
  if (liveSubscription.value) return liveMessages.value;
  return capture.value?.messages || [];
});

const displaySummary = computed(() => {
  if (liveSubscription.value) {
    const stateKey = `nats.state.${liveSubscription.value.state}`;
    const translated = t(stateKey);
    const state = translated === stateKey ? liveSubscription.value.state : translated;
    return t("nats.messages.liveSummary", {
      received: liveSubscription.value.receivedCount,
      dropped: liveSubscription.value.droppedCount,
      state,
    });
  }
  if (capture.value) {
    return t("nats.messages.captureSummary", {
      received: capture.value.receivedCount,
      reason: capture.value.stopReason,
    });
  }
  return "";
});

const showMessagePanel = computed(() => !!capture.value || !!liveSubscription.value || liveMessages.value.length > 0);

let stopListening: (() => void) | undefined;

function nextSubscriptionId() {
  return globalThis.crypto?.randomUUID?.() || `nats-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function installLiveListeners(subscriptionId: string) {
  stopListening?.();
  stopListening = await api.natsListenSubscription(props.connectionId, subscriptionId, {
    onMessage(event: NatsSubscriptionMessageEvent) {
      if (event.connectionId !== props.connectionId || event.subscriptionId !== liveSubscription.value?.subscriptionId) return;
      liveMessages.value = [...liveMessages.value.slice(-999), event.message];
      if (liveSubscription.value) liveSubscription.value.receivedCount += 1;
    },
    onState(event: NatsSubscriptionStateEvent) {
      if (event.connectionId !== props.connectionId || event.subscriptionId !== liveSubscription.value?.subscriptionId) return;
      if (liveSubscription.value) liveSubscription.value.state = event.state;
    },
    onError(event: NatsSubscriptionErrorEvent) {
      if (event.connectionId !== props.connectionId || event.subscriptionId !== liveSubscription.value?.subscriptionId) return;
      error.value = event.message;
      if (liveSubscription.value) liveSubscription.value.state = "error";
    },
  });
}

async function captureMessages() {
  busy.value = true;
  error.value = "";
  try {
    if (liveSubscription.value) await stopLiveSubscription({ keepMessages: false });
    capture.value = await api.natsCapture(props.connectionId, {
      subject: subject.value.trim(),
      durationMs: durationMs.value,
      maxMessages: maxMessages.value,
      includeHeaders: true,
    });
    liveMessages.value = [];
  } catch (e) {
    error.value = formatError(e);
  } finally {
    busy.value = false;
  }
}

async function startLiveSubscription() {
  if (busy.value) return;
  await stopLiveSubscription({ keepMessages: false });
  busy.value = true;
  error.value = "";
  capture.value = undefined;
  try {
    const subscriptionId = nextSubscriptionId();
    liveMessages.value = [];
    liveSubscription.value = {
      subscriptionId,
      subject: subject.value.trim(),
      state: "starting",
      receivedCount: 0,
      droppedCount: 0,
    };
    if (isTauriRuntime()) await installLiveListeners(subscriptionId);
    const started = await api.natsStartSubscription(props.connectionId, {
      subscriptionId,
      subject: subject.value.trim(),
    });
    started.receivedCount = Math.max(started.receivedCount, liveSubscription.value?.receivedCount || 0);
    started.droppedCount = Math.max(started.droppedCount, liveSubscription.value?.droppedCount || 0);
    liveSubscription.value = started;
    if (!isTauriRuntime()) await installLiveListeners(subscriptionId);
  } catch (e) {
    liveSubscription.value = undefined;
    stopListening?.();
    stopListening = undefined;
    error.value = formatError(e);
  } finally {
    busy.value = false;
  }
}

async function stopLiveSubscription(options: { keepMessages?: boolean } = {}) {
  const { keepMessages = true } = options;
  const subscriptionId = liveSubscription.value?.subscriptionId;
  if (!subscriptionId) return;
  try {
    await api.natsStopSubscription(props.connectionId, subscriptionId);
  } catch (e) {
    error.value = formatError(e);
  } finally {
    if (liveSubscription.value) {
      liveSubscription.value = { ...liveSubscription.value, state: "stopped" };
    }
    if (!keepMessages) {
      liveSubscription.value = undefined;
      liveMessages.value = [];
    } else if (liveSubscription.value && liveMessages.value.length === 0) {
      liveSubscription.value = undefined;
    }
    stopListening?.();
    stopListening = undefined;
  }
}

async function publish() {
  publishOk.value = "";
  if (props.readOnly || !payload.value.trim() || !publishSubject.value.trim() || /[*]|>/.test(publishSubject.value)) return;
  if (!(await confirmMqWrite(t("nats.publish.confirm", { subject: publishSubject.value.trim() })))) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await api.natsPublish(props.connectionId, buildNatsPublishRequest(publishSubject.value, replyTo.value, headerText.value, payload.value, payloadMode.value));
    publishOk.value = t("nats.publish.success", { bytes: result.payloadBytes, subject: publishSubject.value.trim() });
    payload.value = "";
  } catch (e) {
    error.value = formatError(e);
  } finally {
    busy.value = false;
  }
}

function clearLocalMessages() {
  capture.value = undefined;
  liveMessages.value = [];
  if (liveSubscription.value?.state === "stopped") liveSubscription.value = undefined;
}

watch(
  () => props.connectionId,
  async () => {
    await stopLiveSubscription({ keepMessages: false });
    capture.value = undefined;
    error.value = "";
    publishOk.value = "";
  },
);

onBeforeUnmount(() => {
  void stopLiveSubscription({ keepMessages: false });
  stopListening?.();
  stopListening = undefined;
});

defineExpose({
  stopLiveSubscription,
  clearLocalMessages,
});
</script>

<template>
  <div class="nats-messages-panel">
    <div class="panel-toolbar">
      <h3>{{ t("mqAdmin.tabMessages") }}</h3>
      <div class="panel-toolbar-actions">
        <button type="button" class="btn-sm" :disabled="busy || (!displayMessages.length && !showMessagePanel)" @click="clearLocalMessages">
          {{ t("nats.messages.clear") }}
        </button>
      </div>
    </div>

    <div v-if="error" class="panel-error">{{ error }}</div>

    <div class="nats-messages-content">
      <NatsSubjectWorkbench v-model:subject="subject" v-model:duration-ms="durationMs" v-model:max-messages="maxMessages" :busy="busy" :live-active="isLiveActive" @capture="captureMessages" @subscribe="startLiveSubscription" @stop="stopLiveSubscription()" />

      <NatsMessageList v-if="showMessagePanel" :messages="displayMessages" :summary="displaySummary" />

      <NatsPublishPanel v-model:subject="publishSubject" v-model:reply-to="replyTo" v-model:header-text="headerText" v-model:payload="payload" v-model:payload-mode="payloadMode" :busy="busy" :read-only="readOnly" :success="publishOk" @publish="publish" />
    </div>
  </div>
</template>

<style scoped>
@import "../shared/mqPanel.css";
@import "./natsPanel.css";

.nats-messages-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.panel-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.panel-toolbar h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.panel-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.nats-messages-content {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.panel-error {
  margin: 0;
  padding: 10px 14px;
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-error-bg);
  color: var(--color-error);
  font-size: 13px;
}
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useMqMutationGuard } from "@/composables/useMqMutationGuard";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { buildNatsPublishRequest, presentNatsMessage, type NatsPayloadMode } from "@/lib/nats/messagePresentation";
import type { NatsCaptureResult, NatsConsumerInfo, NatsConsumerList, NatsHistoryResult, NatsJetStreamInfo, NatsMessage, NatsServerInfo, NatsStreamInfo, NatsStreamList, NatsSubscriptionErrorEvent, NatsSubscriptionInfo, NatsSubscriptionMessageEvent, NatsSubscriptionStateEvent } from "@/types/nats";

const props = defineProps<{ connectionId: string; readOnly?: boolean }>();
const { t } = useI18n();
const store = useConnectionStore();
const { confirmMqWrite } = useMqMutationGuard(() => props.connectionId);
const subject = ref("orders.>");
const durationMs = ref(5000);
const maxMessages = ref(100);
const capture = ref<NatsCaptureResult>();
const server = ref<NatsServerInfo>();
const jetstream = ref<NatsJetStreamInfo>();
const streamList = ref<NatsStreamList>();
const selectedStream = ref<NatsStreamInfo>();
const consumerList = ref<NatsConsumerList>();
const selectedConsumer = ref<NatsConsumerInfo>();
const history = ref<NatsHistoryResult>();
const historyMaxMessages = ref(50);
const historyStartSequence = ref<number>();
const payload = ref("");
const payloadMode = ref<NatsPayloadMode>("text");
const replyTo = ref("");
const headerText = ref("");
const liveSubscription = ref<NatsSubscriptionInfo>();
const liveMessages = ref<NatsMessage[]>([]);
const busy = ref(false);
const error = ref("");
const status = computed(() => (server.value ? `${server.value.serverName || "NATS"} ${server.value.serverVersion || ""}` : ""));
const config = computed(() => store.getConfig(props.connectionId));
const canLiveSubscribe = true;
const displayMessages = computed(() => (liveSubscription.value?.state === "active" ? liveMessages.value : capture.value?.messages || []));
const displaySummary = computed(() => {
  if (liveSubscription.value?.state === "active") {
    return `${liveSubscription.value.receivedCount} live · ${liveSubscription.value.droppedCount} dropped`;
  }
  return capture.value ? `${capture.value.receivedCount} received · ${capture.value.stopReason}` : "";
});
let stopListening: (() => void) | undefined;

async function testConnection() {
  busy.value = true;
  error.value = "";
  try {
    server.value = await api.natsTestConnection(props.connectionId);
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function loadJetStream() {
  if (!server.value?.jetstreamEnabled) return;
  busy.value = true;
  error.value = "";
  try {
    const [info, streams] = await Promise.all([api.natsJetstreamInfo(props.connectionId), api.natsListStreams(props.connectionId)]);
    jetstream.value = info;
    streamList.value = streams;
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function selectJetStream(streamName: string) {
  busy.value = true;
  error.value = "";
  try {
    const [stream, consumers, messages] = await Promise.all([api.natsGetStream(props.connectionId, streamName), api.natsListConsumers(props.connectionId, streamName), api.natsFetchHistory(props.connectionId, { stream: streamName, maxMessages: historyMaxMessages.value })]);
    selectedStream.value = stream;
    consumerList.value = consumers;
    selectedConsumer.value = undefined;
    history.value = messages;
    historyStartSequence.value = messages.nextSequence;
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function loadHistory() {
  const stream = selectedStream.value?.name;
  if (!stream) return;
  busy.value = true;
  error.value = "";
  try {
    const messages = await api.natsFetchHistory(props.connectionId, {
      stream,
      startSequence: historyStartSequence.value || undefined,
      maxMessages: historyMaxMessages.value,
    });
    history.value = messages;
    historyStartSequence.value = messages.nextSequence;
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function selectConsumer(consumerName: string) {
  const stream = selectedStream.value?.name;
  if (!stream) return;
  busy.value = true;
  error.value = "";
  try {
    selectedConsumer.value = await api.natsGetConsumer(props.connectionId, stream, consumerName);
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function captureMessages() {
  busy.value = true;
  error.value = "";
  try {
    capture.value = await api.natsCapture(props.connectionId, { subject: subject.value.trim(), durationMs: durationMs.value, maxMessages: maxMessages.value, includeHeaders: true });
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

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

async function startLiveSubscription() {
  if (!canLiveSubscribe || busy.value) return;
  await stopLiveSubscription();
  busy.value = true;
  error.value = "";
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
    // Desktop notifications cannot be replayed by Tauri, so register before
    // starting the Agent subscription. The Web SSE path safely replays events
    // created during its EventSource setup after the start response.
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
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

async function stopLiveSubscription() {
  const subscriptionId = liveSubscription.value?.subscriptionId;
  if (!subscriptionId) return;
  try {
    await api.natsStopSubscription(props.connectionId, subscriptionId);
  } catch (e) {
    error.value = String(e);
  } finally {
    liveSubscription.value = undefined;
    stopListening?.();
    stopListening = undefined;
  }
}

async function publish() {
  if (!payload.value || props.readOnly || !(await confirmMqWrite(`NATS publish ${subject.value.trim()}`))) return;
  busy.value = true;
  error.value = "";
  try {
    await api.natsPublish(props.connectionId, buildNatsPublishRequest(subject.value, replyTo.value, headerText.value, payload.value, payloadMode.value));
    payload.value = "";
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}

onMounted(testConnection);
onBeforeUnmount(() => {
  void stopLiveSubscription();
  stopListening?.();
  stopListening = undefined;
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-3 overflow-auto p-4">
    <div class="flex flex-wrap items-center gap-2">
      <input v-model="subject" class="input input-sm min-w-56" placeholder="orders.>" aria-label="NATS subject" />
      <input v-model.number="durationMs" type="number" min="1" max="60000" class="input input-sm w-28" aria-label="Capture duration" />
      <input v-model.number="maxMessages" type="number" min="1" max="1000" class="input input-sm w-24" aria-label="Max messages" />
      <button class="btn btn-sm" :disabled="busy" @click="testConnection">{{ t("common.refresh") }}</button>
      <button class="btn btn-sm btn-primary" :disabled="busy" @click="captureMessages">Capture</button>
      <button v-if="canLiveSubscribe && liveSubscription?.state !== 'active'" class="btn btn-sm btn-outline" :disabled="busy" @click="startLiveSubscription">Subscribe</button>
      <button v-if="canLiveSubscribe && liveSubscription?.state === 'active'" class="btn btn-sm btn-outline" :disabled="busy" @click="stopLiveSubscription">Stop</button>
      <span v-if="status" class="text-xs text-muted-foreground">{{ status }} · {{ server?.roundTripMs }} ms</span>
    </div>
    <div class="grid gap-2 rounded border p-3 sm:grid-cols-2">
      <input v-model="replyTo" class="input input-sm" placeholder="Reply-to subject (optional)" aria-label="NATS reply-to subject" />
      <select v-model="payloadMode" class="select select-sm" aria-label="NATS payload mode">
        <option value="text">Text</option>
        <option value="json">JSON</option>
        <option value="base64">Base64</option>
      </select>
      <textarea v-model="headerText" class="textarea textarea-sm min-h-16" placeholder="Headers, one per line: Key: Value" aria-label="NATS headers" />
      <textarea v-model="payload" class="textarea textarea-sm min-h-16" :placeholder="payloadMode === 'base64' ? 'Canonical Base64 payload' : 'Payload'" aria-label="NATS payload" />
      <div class="flex items-center gap-2 sm:col-span-2">
        <button class="btn btn-sm btn-warning" :disabled="busy || props.readOnly || !payload" @click="publish">Publish</button>
        <span v-if="config?.read_only" class="text-xs text-warning">Read-only connection</span>
      </div>
    </div>
    <p v-if="error" class="rounded bg-destructive/10 p-2 text-sm text-destructive">{{ error }}</p>
    <div v-if="capture || liveSubscription" class="min-h-0 flex-1 overflow-auto rounded border">
      <div class="border-b px-3 py-2 text-xs text-muted-foreground">{{ displaySummary }}</div>
      <div v-for="(message, index) in displayMessages" :key="`${message.receivedAtMs}-${index}`" class="border-b p-3 font-mono text-xs">
        <div class="mb-1 text-muted-foreground">
          {{ presentNatsMessage(message).receivedAt }} · {{ message.subject }} · {{ presentNatsMessage(message).sizeLabel }} · {{ presentNatsMessage(message).mode }} <span v-if="message.reply">reply={{ message.reply }}</span>
        </div>
        <pre class="whitespace-pre-wrap break-all">{{ presentNatsMessage(message).payload }}</pre>
        <div v-if="message.headers.length" class="mt-1 text-muted-foreground">{{ message.headers.map((header) => `${header.key}: ${header.value}`).join("; ") }}</div>
      </div>
      <div v-if="!displayMessages.length" class="p-6 text-center text-sm text-muted-foreground">No messages captured.</div>
    </div>
    <section v-if="server?.jetstreamEnabled" class="rounded border p-3">
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <div class="font-medium">JetStream</div>
        <span v-if="jetstream" class="text-xs text-muted-foreground">{{ jetstream.streams }} streams · {{ jetstream.consumers }} consumers · {{ jetstream.storageBytes }} bytes</span>
        <button class="btn btn-sm btn-outline" :disabled="busy" @click="loadJetStream">Load streams</button>
      </div>
      <p class="mb-3 text-xs text-muted-foreground">Read-only browser. History uses direct stream reads and does not create or acknowledge a Consumer.</p>
      <div v-if="streamList" class="grid gap-3 lg:grid-cols-[minmax(12rem,1fr)_minmax(0,2fr)]">
        <div class="max-h-64 overflow-auto rounded border">
          <button v-for="stream in streamList.streams" :key="stream.name" class="block w-full border-b px-3 py-2 text-left text-xs hover:bg-muted" :class="selectedStream?.name === stream.name ? 'bg-muted' : ''" :disabled="busy" @click="selectJetStream(stream.name)">
            <div class="font-medium">{{ stream.name }}</div>
            <div class="text-muted-foreground">{{ stream.messages }} messages · {{ stream.consumers }} consumers</div>
          </button>
          <div v-if="!streamList.streams.length" class="p-3 text-xs text-muted-foreground">No Streams available for this account.</div>
          <div v-if="streamList.truncated" class="p-2 text-xs text-warning">Showing the first 200 Streams.</div>
        </div>
        <div v-if="selectedStream" class="min-w-0 space-y-3">
          <div class="rounded border p-2 text-xs">
            <div class="font-medium">{{ selectedStream.name }} · {{ selectedStream.storage }} · {{ selectedStream.retention }}</div>
            <div class="mt-1 break-all text-muted-foreground">{{ selectedStream.subjects.join(", ") || "No explicit subjects" }}</div>
            <div class="mt-1 text-muted-foreground">Sequences {{ selectedStream.firstSequence }}–{{ selectedStream.lastSequence }} · {{ selectedStream.bytes }} bytes</div>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <input v-model.number="historyStartSequence" type="number" min="1" class="input input-sm w-32" placeholder="Start sequence" aria-label="JetStream history start sequence" />
            <input v-model.number="historyMaxMessages" type="number" min="1" max="1000" class="input input-sm w-28" aria-label="JetStream history max messages" />
            <button class="btn btn-sm btn-outline" :disabled="busy" @click="loadHistory">Fetch history</button>
            <span v-if="history" class="text-xs text-muted-foreground">{{ history.receivedCount }} messages · ack={{ history.ackMode }}</span>
          </div>
          <div v-if="history" class="max-h-64 overflow-auto rounded border">
            <div v-for="(message, index) in history.messages" :key="`${message.receivedAtMs}-${index}`" class="border-b p-2 font-mono text-xs">
              <div class="text-muted-foreground">{{ message.subject }} · {{ presentNatsMessage(message).sizeLabel }}</div>
              <pre class="whitespace-pre-wrap break-all">{{ presentNatsMessage(message).payload }}</pre>
            </div>
            <div v-if="!history.messages.length" class="p-3 text-xs text-muted-foreground">No stored messages in this history page.</div>
            <div v-if="history.truncated" class="p-2 text-xs text-warning">Result capped; the start sequence field is set to {{ history.nextSequence }}.</div>
          </div>
          <div v-if="consumerList" class="rounded border">
            <div class="border-b px-2 py-1 text-xs text-muted-foreground">Consumers <span v-if="consumerList.truncated">(first 200)</span></div>
            <button v-for="consumer in consumerList.consumers" :key="consumer.name" class="block w-full border-b px-2 py-1 text-left text-xs hover:bg-muted" :disabled="busy" @click="selectConsumer(consumer.name)">
              {{ consumer.name }} · {{ consumer.ackPolicy }} · {{ consumer.pending }} pending
            </button>
            <div v-if="!consumerList.consumers.length" class="p-2 text-xs text-muted-foreground">No Consumers.</div>
          </div>
          <div v-if="selectedConsumer" class="rounded border p-2 text-xs text-muted-foreground">
            {{ selectedConsumer.name }}: delivered {{ selectedConsumer.deliveredStreamSequence }}, ack floor {{ selectedConsumer.ackFloorStreamSequence }}, {{ selectedConsumer.ackPending }} awaiting ack, {{ selectedConsumer.redelivered }} redelivered.
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

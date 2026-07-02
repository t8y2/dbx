<script setup lang="ts">
import { ref, nextTick, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/api";
import { useToast } from "@/composables/useToast";

const props = defineProps<{
  connectionId: string;
  db: number;
}>();

const { t } = useI18n();
const { toast } = useToast();

// State
const channels = ref<string[]>([]);
const patterns = ref<string[]>([]);
const newChannel = ref("");
const newPattern = ref("");

const publishChannel = ref("");
const publishMessage = ref("");

interface PubSubEntry {
  id: number;
  channel: string;
  pattern: string | null;
  payload: string;
  timestamp: Date;
}
const messages = ref<PubSubEntry[]>([]);
let nextId = 0;

let ws: WebSocket | null = null;
const connected = ref(false);
const connecting = ref(false);

const messagesContainer = ref<HTMLElement | null>(null);

function scrollToBottom() {
  void nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    }
  });
}

function addMessage(channel: string, pattern: string | null, payload: string) {
  messages.value.push({
    id: ++nextId,
    channel,
    pattern,
    payload,
    timestamp: new Date(),
  });
  // Keep max 500 messages
  if (messages.value.length > 500) {
    messages.value.shift();
  }
  scrollToBottom();
}

// Connect WebSocket
async function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  connecting.value = true;
  try {
    ws = await api.redisPubSubConnect(props.connectionId);

    ws.onopen = () => {
      connected.value = true;
      connecting.value = false;
      // Re-subscribe existing channels
      if (channels.value.length > 0) {
        ws!.send(JSON.stringify({ type: "subscribe", channels: channels.value }));
      }
      if (patterns.value.length > 0) {
        ws!.send(JSON.stringify({ type: "psubscribe", patterns: patterns.value }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        if (data.error) {
          toast(data.error, 5000);
          return;
        }
        addMessage(data.channel, data.pattern ?? null, data.payload);
      } catch {
        // Non-JSON message, skip
      }
    };

    ws.onclose = () => {
      connected.value = false;
      connecting.value = false;
      ws = null;
    };

    ws.onerror = () => {
      connected.value = false;
      connecting.value = false;
      ws = null;
    };
  } catch (e) {
    connecting.value = false;
    toast(t("redis.pubsubWsConnectFailed", { error: e instanceof Error ? e.message : String(e) }), 5000);
  }
}

function disconnect() {
  if (ws) {
    ws.close();
    ws = null;
    connected.value = false;
  }
}

function subscribe() {
  const ch = newChannel.value.trim();
  if (!ch) return;
  if (channels.value.includes(ch)) return;
  channels.value.push(ch);
  newChannel.value = "";
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "subscribe", channels: [ch] }));
  }
}

function psubscribe() {
  const pat = newPattern.value.trim();
  if (!pat) return;
  if (patterns.value.includes(pat)) return;
  patterns.value.push(pat);
  newPattern.value = "";
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "psubscribe", patterns: [pat] }));
  }
}

function unsubscribe(channel: string) {
  channels.value = channels.value.filter((c) => c !== channel);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "unsubscribe", channels: [channel] }));
  }
}

function punsubscribe(pattern: string) {
  patterns.value = patterns.value.filter((p) => p !== pattern);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "punsubscribe", patterns: [pattern] }));
  }
}

async function publish() {
  const ch = publishChannel.value.trim();
  const msg = publishMessage.value;
  if (!ch || !msg) return;
  try {
    await api.redisPubSubPublish(props.connectionId, props.db, ch, msg);
    // Echo locally only if subscribed — Redis PubSub doesn't deliver to publisher
    const isSubscribed = channels.value.includes(ch) || patterns.value.some((p) => new RegExp("^" + p.replace(/\*/g, ".*") + "$").test(ch));
    if (isSubscribed) {
      addMessage(ch, null, msg);
    }
    publishMessage.value = "";
  } catch (e) {
    toast(t("redis.pubsubPublishFailed", { error: e instanceof Error ? e.message : String(e) }), 3000);
  }
}

function clearMessages() {
  messages.value = [];
}

onBeforeUnmount(() => {
  disconnect();
});
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Connection bar -->
    <div class="flex items-center gap-2 px-3 py-1.5 border-b bg-muted/30 min-h-0 shrink-0">
      <span class="text-xs font-medium whitespace-nowrap">{{ t("redis.pubsub") }}</span>
      <span class="flex-1"></span>
      <span class="inline-flex items-center gap-1 text-xs whitespace-nowrap" :class="connected ? 'text-green-600' : 'text-muted-foreground'">
        <span class="inline-block w-2 h-2 rounded-full" :class="connected ? 'bg-green-500' : 'bg-gray-400'"></span>
        {{ connected ? t("redis.pubsubConnected") : connecting ? t("redis.pubsubConnecting") : t("redis.pubsubDisconnected") }}
      </span>
      <button v-if="!connected" class="text-xs px-2 py-0.5 rounded border border-transparent bg-primary text-primary-foreground hover:bg-primary/90" :disabled="connecting" @click="connect">
        {{ t("redis.pubsubConnect") }}
      </button>
      <button v-else class="text-xs px-2 py-0.5 rounded border hover:bg-muted" @click="disconnect">
        {{ t("redis.pubsubDisconnect") }}
      </button>
    </div>

    <!-- Subscriptions -->
    <div class="px-3 py-2 border-b space-y-2" :class="{ 'opacity-50 pointer-events-none': !connected }">
      <!-- Channel subscriptions -->
      <div>
        <div class="text-xs font-medium mb-1">{{ t("redis.pubsubChannels") }}</div>
        <div class="flex gap-1 mb-1">
          <input v-model="newChannel" type="text" :disabled="!connected" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" class="flex-1 h-7 px-2 text-xs border rounded bg-background" :placeholder="t('redis.pubsubChannelPlaceholder')" @keydown.enter="subscribe" />
          <button :disabled="!connected" class="text-xs px-2 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50" @click="subscribe">
            {{ t("redis.pubsubSubscribe") }}
          </button>
        </div>
        <div v-if="channels.length > 0" class="flex flex-wrap gap-1">
          <span v-for="ch in channels" :key="ch" class="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
            {{ ch }}
            <button class="hover:text-red-500" @click="unsubscribe(ch)">×</button>
          </span>
        </div>
      </div>

      <!-- Pattern subscriptions -->
      <div>
        <div class="text-xs font-medium mb-1">{{ t("redis.pubsubPatterns") }}</div>
        <div class="flex gap-1 mb-1">
          <input v-model="newPattern" type="text" :disabled="!connected" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" class="flex-1 h-7 px-2 text-xs border rounded bg-background" :placeholder="t('redis.pubsubPatternPlaceholder')" @keydown.enter="psubscribe" />
          <button :disabled="!connected" class="text-xs px-2 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50" @click="psubscribe">
            {{ t("redis.pubsubPsubscribe") }}
          </button>
        </div>
        <div v-if="patterns.length > 0" class="flex flex-wrap gap-1">
          <span v-for="pat in patterns" :key="pat" class="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200">
            {{ pat }}
            <button class="hover:text-red-500" @click="punsubscribe(pat)">×</button>
          </span>
        </div>
      </div>
    </div>

    <!-- Messages -->
    <div class="flex-1 flex flex-col min-h-0">
      <div class="flex items-center gap-2 px-3 py-1 border-b">
        <span class="text-xs font-medium">{{ t("redis.pubsubMessages") }}</span>
        <span class="text-xs text-muted-foreground">({{ messages.length }})</span>
        <span class="flex-1"></span>
        <button class="text-xs px-2 py-0.5 rounded border hover:bg-muted" @click="clearMessages">
          {{ t("redis.pubsubClear") }}
        </button>
      </div>
      <div ref="messagesContainer" class="flex-1 overflow-auto px-3 py-1 font-mono text-xs">
        <div v-if="messages.length === 0" class="text-muted-foreground py-4 text-center">
          {{ t("redis.pubsubEmpty") }}
        </div>
        <div v-for="msg in messages" :key="msg.id" class="py-0.5 border-b border-dashed border-border/50">
          <span class="text-muted-foreground">{{ msg.timestamp.toLocaleTimeString() }}</span>
          <span class="ml-2 font-semibold text-blue-600 dark:text-blue-400">{{ msg.channel }}</span>
          <span v-if="msg.pattern" class="ml-1 text-purple-500">({{ msg.pattern }})</span>
          <span class="ml-2">{{ msg.payload }}</span>
        </div>
      </div>
    </div>

    <!-- Publish -->
    <div class="px-3 py-2 border-t space-y-1.5">
      <div class="text-xs font-medium">{{ t("redis.pubsubPublish") }}</div>
      <input v-model="publishChannel" type="text" class="w-full h-7 px-2 text-xs border rounded bg-background" :placeholder="t('redis.pubsubPublishChannel')" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" />
      <div class="flex gap-1">
        <input v-model="publishMessage" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" class="flex-1 h-7 px-2 text-xs border rounded bg-background" :placeholder="t('redis.pubsubPublishMessage')" @keydown.enter="publish" />
        <button class="text-xs px-3 py-0.5 rounded bg-primary text-primary-foreground hover:bg-primary/90" @click="publish">
          {{ t("redis.pubsubSend") }}
        </button>
      </div>
    </div>
  </div>
</template>

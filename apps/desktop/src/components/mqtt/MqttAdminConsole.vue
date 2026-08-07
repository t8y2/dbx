<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { mqttGetBrokerInfo, mqttListTopics, mqttGetTopicTree, mqttGetMessages, mqttSubscribe, mqttUnsubscribe, mqttClearMessages } from "@/lib/backend/api";
import type { MqttBrokerInfo, MqttTopicNode, MqttMessage } from "@/types/mqtt";
import { Button } from "@/components/ui/button";
import TopicTreeNode from "./TopicTreeNode.vue";
import MqttPublishPanel from "./MqttPublishDialog.vue";
import { decodePayload, PAYLOAD_ENCODINGS, PAYLOAD_ENCODING_LABELS, type PayloadEncoding } from "@/lib/mqtt/mqttPayloadCodec";

interface Props {
  connectionId: string;
  initialTopic?: string;
}
const props = defineProps<Props>();
const { t } = useI18n();

/* ========== State ========== */
const brokerInfo = ref<MqttBrokerInfo | null>(null);
const topicTree = ref<MqttTopicNode | null>(null);
const messages = ref<MqttMessage[]>([]);
const subscribedTopics = ref<[string, string][]>([]);
const noLocalSubscribe = ref(false);
const selectedTopic = ref<string>(props.initialTopic ?? "");
const loading = ref(true);
const error = ref<string | null>(null);
const pollingTimer = ref<ReturnType<typeof setInterval> | null>(null);

/* Payload 显示编码格式 */
const displayEncoding = ref<PayloadEncoding>("plaintext");

/* ========== Computed ========== */
const connected = computed(() => brokerInfo.value?.connected ?? false);

/* ========== 数据刷新 ========== */
async function refreshData() {
  try {
    const [info, topics, tree, msgs] = await Promise.all([
      mqttGetBrokerInfo(props.connectionId) as Promise<MqttBrokerInfo>,
      mqttListTopics(props.connectionId) as Promise<[string, string][]>,
      mqttGetTopicTree(props.connectionId) as Promise<MqttTopicNode>,
      mqttGetMessages(props.connectionId, selectedTopic.value || undefined, 50) as Promise<MqttMessage[]>,
    ]);
    brokerInfo.value = info;
    subscribedTopics.value = topics;
    topicTree.value = tree;
    messages.value = msgs;
    error.value = null;
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function handleSubscribe(topic: string, noLocal = noLocalSubscribe.value) {
  try {
    await mqttSubscribe(props.connectionId, topic, "atmostonce", noLocal);
    await refreshData();
  } catch (e) {
    error.value = String(e);
  }
}

async function handleUnsubscribe(topics: string[]) {
  const subscribed = new Set(subscribedTopics.value.map(([topic]) => topic));
  const targets = [...new Set(topics)].filter((topic) => subscribed.has(topic));
  if (targets.length === 0) {
    error.value = t("connection.mqttUnsubscribeMissing");
    return;
  }

  const prompt = targets.length === 1 ? t("connection.mqttUnsubscribeConfirm", { topic: targets[0] }) : t("connection.mqttUnsubscribeGroupConfirm", { count: targets.length });
  if (!window.confirm(prompt)) return;

  const failures: string[] = [];
  for (const topic of targets) {
    try {
      await mqttUnsubscribe(props.connectionId, topic);
    } catch (e) {
      failures.push(`${topic}：${String(e)}`);
    }
  }

  if (targets.includes(selectedTopic.value)) selectedTopic.value = "";
  await refreshData();
  if (failures.length > 0) {
    error.value = t("connection.mqttUnsubscribeFailed", { count: failures.length, errors: failures.join("; ") });
  }
}

function handleTopicClick(topic: string) {
  selectedTopic.value = topic;
  refreshData();
}

function handleMessagePublished() {
  refreshData();
}

async function handleClearMessages() {
  try {
    await mqttClearMessages(props.connectionId);
    messages.value = [];
  } catch (e) {
    error.value = String(e);
  }
}

/* ========== 消息轮询 ========== */
function startPolling() {
  stopPolling();
  pollingTimer.value = setInterval(async () => {
    try {
      const msgs = (await mqttGetMessages(props.connectionId, selectedTopic.value || undefined, 50)) as MqttMessage[];
      messages.value = msgs;
    } catch {
      /* 忽略轮询错误 */
    }
  }, 3000);
}

function stopPolling() {
  if (pollingTimer.value) {
    clearInterval(pollingTimer.value);
    pollingTimer.value = null;
  }
}

/* ========== 格式化消息 Payload ========== */
function formatMessagePayload(msg: MqttMessage): string {
  if (displayEncoding.value === "plaintext" && msg.payloadText != null) {
    return msg.payloadText;
  }
  return decodePayload(msg.payloadBase64, displayEncoding.value);
}

/* ========== 生命周期 ========== */
onMounted(async () => {
  await refreshData();
  startPolling();
});

onUnmounted(() => {
  stopPolling();
});
</script>

<template>
  <div class="flex flex-col h-full bg-card text-card-foreground">
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-2 border-b shrink-0">
      <div class="flex items-center gap-3">
        <span class="text-lg font-semibold">{{ t("connection.mqttConsoleTitle") }}</span>
        <span v-if="brokerInfo" class="text-sm text-muted-foreground">{{ brokerInfo.brokerUrl }}</span>
        <span v-if="brokerInfo" class="px-1.5 py-0.5 rounded text-xs font-medium" :class="connected ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'">
          {{ connected ? t("connection.mqttConnected") : t("connection.mqttDisconnected") }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <Button size="sm" variant="outline" @click="refreshData">{{ t("connection.mqttRefresh") }}</Button>
        <Button size="sm" variant="outline" @click="handleClearMessages">{{ t("connection.mqttClearMessages") }}</Button>
      </div>
    </div>

    <!-- Error banner -->
    <div v-if="error" class="px-4 py-2 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 text-sm border-b">
      {{ error }}
      <button class="ml-2 underline" @click="error = null">{{ t("common.close") }}</button>
    </div>

    <!-- Body: 双栏布局 -->
    <div class="flex-1 flex min-h-0">
      <!-- 左侧：主题树 -->
      <div class="w-72 border-r flex flex-col shrink-0">
        <div class="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase border-b">{{ t("connection.mqttTopics") }}</div>
        <div class="flex-1 overflow-auto p-2">
          <div v-if="loading" class="text-xs text-muted-foreground p-2">{{ t("common.loading") }}</div>
          <div v-else-if="!topicTree?.children?.length" class="text-xs text-muted-foreground p-2">{{ t("connection.mqttNoTopicsHint") }}</div>
          <TopicTreeNode v-for="child in topicTree?.children ?? []" :key="child.fullPath" :node="child" :depth="0" :selected-topic="selectedTopic" :subscribed-topics="subscribedTopics" @select="handleTopicClick" @subscribe="handleSubscribe" @unsubscribe="handleUnsubscribe" />
        </div>
        <!-- 快速订阅 -->
        <div class="border-t p-2">
          <form
            class="flex gap-1"
            @submit.prevent="
              (e) => {
                const input = (e.target as HTMLFormElement).querySelector('input');
                const topic = input?.value.trim();
                if (topic && input) {
                  handleSubscribe(topic);
                  input.value = '';
                }
              }
            "
          >
            <input class="flex-1 h-7 px-2 text-xs rounded border bg-transparent" :placeholder="t('connection.mqttSubscribePlaceholder')" />
            <label class="flex items-center gap-1 text-[10px] whitespace-nowrap"><input v-model="noLocalSubscribe" type="checkbox" />{{ t("connection.mqttNoLocal") }}</label>
            <Button size="sm" variant="ghost" class="h-7 text-xs" type="submit">{{ t("connection.mqttSubscribe") }}</Button>
          </form>
        </div>
      </div>

      <!-- 右侧：消息列表 + 发布面板 -->
      <div class="flex-1 flex flex-col min-w-0">
        <!-- 消息区域 -->
        <div class="flex-1 flex flex-col min-h-0">
          <div class="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase border-b flex items-center justify-between shrink-0">
            <span v-if="selectedTopic">{{ t("connection.mqttMessagesForTopic", { topic: selectedTopic }) }}</span>
            <span v-else>{{ t("connection.mqttAllMessages") }}</span>
            <div class="flex items-center gap-2">
              <span class="font-normal">{{ messages.length }}</span>
              <!-- Payload 编码格式选择 -->
              <select v-model="displayEncoding" class="h-6 px-1.5 text-[11px] rounded border bg-transparent text-muted-foreground cursor-pointer outline-none">
                <option v-for="enc in PAYLOAD_ENCODINGS" :key="enc" :value="enc">
                  {{ PAYLOAD_ENCODING_LABELS[enc] }}
                </option>
              </select>
            </div>
          </div>
          <div class="flex-1 overflow-auto flex flex-col">
            <div v-if="messages.length === 0" class="text-xs text-muted-foreground p-4 text-center">{{ t("connection.mqttNoMessages") }}</div>
            <div
              v-for="(msg, i) in messages"
              :key="i"
              class="px-3 py-2 border-b last:border-b-0 cursor-pointer text-xs self-start w-full"
              :class="msg.direction === 'sent' ? 'bg-emerald-50/60 dark:bg-emerald-950/20 hover:bg-emerald-100/60 dark:hover:bg-emerald-950/40 ml-auto max-w-[85%] rounded-l-md' : 'hover:bg-muted/50 mr-auto max-w-[85%] rounded-r-md'"
              @click="handleTopicClick(msg.topic)"
            >
              <div class="flex items-center gap-2 mb-0.5">
                <span v-if="msg.direction === 'sent'" class="text-emerald-600 dark:text-emerald-400 text-[10px] font-bold shrink-0">{{ t("connection.mqttSent") }}</span>
                <span v-else class="text-blue-600 dark:text-blue-400 text-[10px] font-bold shrink-0">{{ t("connection.mqttReceived") }}</span>
                <span class="font-mono text-blue-600 dark:text-blue-400 font-medium truncate">{{ msg.topic }}</span>
                <span class="text-muted-foreground/60 shrink-0">QoS{{ msg.qos }}</span>
                <span v-if="msg.retain" class="text-amber-600 dark:text-amber-400 text-[10px] font-medium shrink-0">{{ t("connection.mqttRetained") }}</span>
              </div>
              <div class="text-muted-foreground font-mono whitespace-pre-wrap break-all">{{ formatMessagePayload(msg) }}</div>
              <div class="text-muted-foreground/50 mt-0.5 text-[10px]">{{ new Date(msg.receivedAtMs).toLocaleTimeString() }}</div>
            </div>
          </div>
        </div>

        <!-- 底部：内联发布面板 -->
        <MqttPublishPanel v-if="connected" :connection-id="connectionId" :initial-topic="selectedTopic" @published="handleMessagePublished" />
      </div>
    </div>
  </div>
</template>

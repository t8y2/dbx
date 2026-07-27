<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { mqttGetBrokerInfo, mqttListTopics, mqttGetTopicTree, mqttGetMessages, mqttSubscribe, mqttUnsubscribe } from "@/lib/backend/api";
import type { MqttBrokerInfo, MqttTopicNode, MqttMessage } from "@/types/mqtt";
import { Button } from "@/components/ui/button";
import TopicTreeNode from "./TopicTreeNode.vue";
import MqttPublishDialog from "./MqttPublishDialog.vue";

interface Props {
  connectionId: string;
  initialTopic?: string;
}
const props = defineProps<Props>();

// --- State ---
const brokerInfo = ref<MqttBrokerInfo | null>(null);
const topicTree = ref<MqttTopicNode | null>(null);
const messages = ref<MqttMessage[]>([]);
const subscribedTopics = ref<[string, string][]>([]);
const selectedTopic = ref<string>(props.initialTopic ?? "");
const loading = ref(true);
const error = ref<string | null>(null);
const showPublishDialog = ref(false);
const pollingTimer = ref<ReturnType<typeof setInterval> | null>(null);

// --- Computed ---
const connected = computed(() => brokerInfo.value?.connected ?? false);

// --- Actions ---
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

async function handleSubscribe(topic: string) {
  try {
    await mqttSubscribe(props.connectionId, topic, "atmostonce");
    await refreshData();
  } catch (e) {
    error.value = String(e);
  }
}

async function handleUnsubscribe(topic: string) {
  try {
    await mqttUnsubscribe(props.connectionId, topic);
    await refreshData();
  } catch (e) {
    error.value = String(e);
  }
}

function handleTopicClick(topic: string) {
  selectedTopic.value = topic;
  refreshData();
}

function handleMessagePublished() {
  refreshData();
}

// --- Polling for messages ---
function startPolling() {
  stopPolling();
  pollingTimer.value = setInterval(async () => {
    try {
      const msgs = (await mqttGetMessages(props.connectionId, selectedTopic.value || undefined, 50)) as MqttMessage[];
      messages.value = msgs;
    } catch {
      /* ignore polling errors */
    }
  }, 3000);
}

function stopPolling() {
  if (pollingTimer.value) {
    clearInterval(pollingTimer.value);
    pollingTimer.value = null;
  }
}

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
        <span class="text-lg font-semibold">MQTT 控制台</span>
        <span v-if="brokerInfo" class="text-sm text-muted-foreground">{{ brokerInfo.brokerUrl }}</span>
        <span v-if="brokerInfo" class="px-1.5 py-0.5 rounded text-xs font-medium" :class="connected ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'">{{ connected ? "已连接" : "已断开" }}</span>
      </div>
      <div class="flex items-center gap-2">
        <Button size="sm" variant="outline" @click="refreshData">刷新</Button>
        <Button size="sm" @click="showPublishDialog = true" :disabled="!connected">发布消息</Button>
      </div>
    </div>

    <!-- Error banner -->
    <div v-if="error" class="px-4 py-2 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 text-sm border-b">
      {{ error }}
      <button class="ml-2 underline" @click="error = null">关闭</button>
    </div>

    <!-- Body: two-panel layout -->
    <div class="flex-1 flex min-h-0">
      <!-- Left: Topic Tree -->
      <div class="w-72 border-r flex flex-col shrink-0">
        <div class="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase border-b">主题列表</div>
        <div class="flex-1 overflow-auto p-2">
          <div v-if="loading" class="text-xs text-muted-foreground p-2">加载中...</div>
          <div v-else-if="!topicTree?.children?.length" class="text-xs text-muted-foreground p-2">暂无订阅。使用下方输入框订阅主题。</div>
          <TopicTreeNode v-for="child in topicTree?.children ?? []" :key="child.fullPath" :node="child" :depth="0" :selected-topic="selectedTopic" :subscribed-topics="subscribedTopics" @select="handleTopicClick" @subscribe="handleSubscribe" @unsubscribe="handleUnsubscribe" />
        </div>
        <!-- Quick subscribe -->
        <div class="border-t p-2">
          <form
            class="flex gap-1"
            @submit.prevent="
              (e) => {
                const input = (e.target as HTMLFormElement).querySelector('input');
                if (input?.value) {
                  handleSubscribe(input.value);
                  input.value = '';
                }
              }
            "
          >
            <input class="flex-1 h-7 px-2 text-xs rounded border bg-transparent" placeholder="输入要订阅的主题..." />
            <Button size="sm" variant="ghost" class="h-7 text-xs" type="submit">订阅</Button>
          </form>
        </div>
      </div>

      <!-- Right: Messages -->
      <div class="flex-1 flex flex-col min-w-0">
        <div class="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase border-b flex items-center justify-between">
          <span v-if="selectedTopic">消息: {{ selectedTopic }}</span>
          <span v-else>消息（所有主题）</span>
          <span class="font-normal">{{ messages.length }}</span>
        </div>
        <div class="flex-1 overflow-auto">
          <div v-if="messages.length === 0" class="text-xs text-muted-foreground p-4 text-center">暂无消息。</div>
          <div v-for="(msg, i) in messages" :key="i" class="px-3 py-2 border-b last:border-b-0 hover:bg-muted/50 cursor-pointer text-xs" @click="handleTopicClick(msg.topic)">
            <div class="flex items-center gap-2 mb-0.5">
              <span class="font-mono text-blue-600 dark:text-blue-400 font-medium truncate">{{ msg.topic }}</span>
              <span class="text-muted-foreground/60 shrink-0">QoS{{ msg.qos }}</span>
              <span v-if="msg.retain" class="text-amber-600 dark:text-amber-400 text-[10px] font-medium shrink-0">保留</span>
            </div>
            <div class="text-muted-foreground font-mono whitespace-pre-wrap break-all">{{ msg.payloadText ?? "(二进制数据)" }}</div>
            <div class="text-muted-foreground/50 mt-0.5 text-[10px]">{{ new Date(msg.receivedAtMs).toLocaleTimeString() }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Publish Dialog -->
    <MqttPublishDialog v-if="showPublishDialog" :connection-id="connectionId" :initial-topic="selectedTopic" @close="showPublishDialog = false" @published="handleMessagePublished" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { mqttGetBrokerInfo, mqttListTopics, mqttListSavedTopicConfigs, mqttGetMessages, mqttSubscribe, mqttUnsubscribe, mqttSaveTopicConfig, mqttDeleteTopicConfig, mqttClearMessages } from "@/lib/backend/api";
import type { MqttBrokerInfo, MqttSavedTopic, MqttTopicNode, MqttMessage, MqttQoS } from "@/types/mqtt";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import TopicTreeNode from "./TopicTreeNode.vue";
import MqttPublishPanel from "./MqttPublishDialog.vue";
import { decodePayload, PAYLOAD_ENCODINGS, PAYLOAD_ENCODING_LABELS, type PayloadEncoding } from "@/lib/mqtt/mqttPayloadCodec";

interface Props {
  connectionId: string;
  initialTopic?: string;
}
const props = defineProps<Props>();
const { t } = useI18n();

const brokerInfo = ref<MqttBrokerInfo | null>(null);
const savedTopics = ref<MqttSavedTopic[]>([]);
const subscribedTopics = ref<[string, string][]>([]);
const messages = ref<MqttMessage[]>([]);
const noLocalSubscribe = ref(false);
const selectedTopic = ref<string>(props.initialTopic ?? "");
const loading = ref(true);
const error = ref<string | null>(null);
const pollingTimer = ref<ReturnType<typeof setInterval> | null>(null);
const displayEncoding = ref<PayloadEncoding>("plaintext");
const topicSearch = ref("");
const showSubscriptionDialog = ref(false);
const savingSubscription = ref(false);
const formTopic = ref("");
const formQos = ref<MqttQoS>("atmostonce");
const formNoLocal = ref(false);
const formEnabled = ref(true);
const editingTopic = ref<string | null>(null);

const connected = computed(() => brokerInfo.value?.connected ?? false);
const mqtt5 = computed(() => brokerInfo.value?.protocolVersion?.includes("5") ?? false);

function buildTopicTree(topics: MqttSavedTopic[]): MqttTopicNode {
  const root: MqttTopicNode = { name: "root", fullPath: "", children: [], isLeaf: false };
  for (const config of topics) {
    const segments = config.topic.split("/");
    let current = root;
    for (let index = 0; index < segments.length; index += 1) {
      const fullPath = segments.slice(0, index + 1).join("/");
      let child = current.children.find((candidate) => candidate.name === segments[index]);
      if (!child) {
        child = { name: segments[index], fullPath, children: [], isLeaf: false };
        current.children.push(child);
      }
      if (index === segments.length - 1) child.isLeaf = true;
      current = child;
    }
  }
  const sort = (node: MqttTopicNode) => {
    node.children.sort((left, right) => left.name.localeCompare(right.name));
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

const topicTree = computed(() => buildTopicTree(savedTopics.value));

async function refreshData() {
  try {
    const [info, active, configs, msgs] = await Promise.all([
      mqttGetBrokerInfo(props.connectionId) as Promise<MqttBrokerInfo>,
      mqttListTopics(props.connectionId) as Promise<[string, string][]>,
      mqttListSavedTopicConfigs(props.connectionId) as Promise<MqttSavedTopic[]>,
      mqttGetMessages(props.connectionId, selectedTopic.value || undefined, 50) as Promise<MqttMessage[]>,
    ]);
    brokerInfo.value = info;
    subscribedTopics.value = active;
    savedTopics.value = configs.map((config) => ({ ...config, enabled: config.enabled !== false, noLocal: config.noLocal === true }));
    messages.value = msgs;
    error.value = null;
  } catch (e) {
    error.value = String(e);
  } finally {
    loading.value = false;
  }
}

async function handleSubscribe(topic: string, qos: MqttQoS = "atmostonce", noLocal = noLocalSubscribe.value) {
  try {
    await mqttSubscribe(props.connectionId, topic, qos, noLocal);
    selectedTopic.value = topic;
    await refreshData();
  } catch (e) {
    error.value = String(e);
  }
}

async function handleToggleEnabled(config: MqttSavedTopic) {
  try {
    if (subscribedTopics.value.some(([topic]) => topic === config.topic)) {
      await mqttUnsubscribe(props.connectionId, config.topic);
    } else {
      await handleSubscribe(config.topic, config.qos, config.noLocal === true);
      return;
    }
    await refreshData();
  } catch (e) {
    error.value = String(e);
  }
}

async function handleDelete(config: MqttSavedTopic) {
  if (!window.confirm(t("connection.mqttDeleteSubscriptionConfirm", { topic: config.topic }))) return;
  try {
    if (subscribedTopics.value.some(([topic]) => topic === config.topic)) await mqttUnsubscribe(props.connectionId, config.topic);
    await mqttDeleteTopicConfig(props.connectionId, config.topic);
    if (selectedTopic.value === config.topic) selectedTopic.value = "";
    await refreshData();
  } catch (e) {
    error.value = String(e);
  }
}

function openSubscriptionDialog() {
  editingTopic.value = null;
  formTopic.value = "";
  formQos.value = "atmostonce";
  formNoLocal.value = false;
  formEnabled.value = true;
  error.value = null;
  showSubscriptionDialog.value = true;
}

function editSubscription(config: MqttSavedTopic) {
  editingTopic.value = config.topic;
  formTopic.value = config.topic;
  formQos.value = config.qos;
  formNoLocal.value = config.noLocal === true;
  formEnabled.value = config.enabled !== false;
  error.value = null;
  showSubscriptionDialog.value = true;
}

function validTopicFilter(topic: string): boolean {
  if (!topic) return false;
  const segments = topic.split("/");
  return segments.every((segment, index) => {
    if (segment === "#") return index === segments.length - 1;
    return !segment.includes("#") && (!segment.includes("+") || segment === "+");
  });
}

async function saveSubscription() {
  const topic = formTopic.value.trim();
  if (!validTopicFilter(topic)) {
    error.value = t("connection.mqttSubscriptionTopicFilterInvalid");
    return;
  }
  if (savedTopics.value.some((config) => config.topic === topic && config.topic !== editingTopic.value)) {
    error.value = t("connection.mqttSubscriptionTopicFilterDuplicate");
    return;
  }
  if (formNoLocal.value && !mqtt5.value) {
    error.value = t("connection.mqttSubscriptionNoLocalProtocolError");
    return;
  }

  savingSubscription.value = true;
  error.value = null;
  const previousTopic = editingTopic.value;
  const topicChanged = previousTopic != null && previousTopic !== topic;
  const previousWasActive = previousTopic != null && subscribedTopics.value.some(([current]) => current === previousTopic);
  try {
    // Save the new configuration first so a broker failure cannot remove the
    // previous configuration or leave the edited topic without a retry path.
    await mqttSaveTopicConfig(props.connectionId, topic, formQos.value, formNoLocal.value, formEnabled.value);
    if (formEnabled.value) await mqttSubscribe(props.connectionId, topic, formQos.value, formNoLocal.value);
    else if (!topicChanged && previousWasActive) await mqttUnsubscribe(props.connectionId, topic);
    if (topicChanged && previousWasActive && previousTopic) await mqttUnsubscribe(props.connectionId, previousTopic);
    if (topicChanged && previousTopic) await mqttDeleteTopicConfig(props.connectionId, previousTopic);
    selectedTopic.value = topic;
    showSubscriptionDialog.value = false;
    await refreshData();
  } catch (e) {
    error.value = t("connection.mqttSubscriptionOperationFailed", { error: String(e) });
    await refreshData();
  } finally {
    savingSubscription.value = false;
  }
}

function handleTopicClick(topic: string) {
  selectedTopic.value = topic;
  void refreshData();
}

function handleMessagePublished() {
  void refreshData();
}

async function handleClearMessages() {
  try {
    await mqttClearMessages(props.connectionId);
    messages.value = [];
  } catch (e) {
    error.value = String(e);
  }
}

function startPolling() {
  stopPolling();
  pollingTimer.value = setInterval(async () => {
    try {
      messages.value = (await mqttGetMessages(props.connectionId, selectedTopic.value || undefined, 50)) as MqttMessage[];
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

function formatMessagePayload(msg: MqttMessage): string {
  if (displayEncoding.value === "plaintext" && msg.payloadText != null) return msg.payloadText;
  return decodePayload(msg.payloadBase64, displayEncoding.value);
}

watch(
  () => props.initialTopic,
  (topic) => {
    if (topic !== undefined && topic !== selectedTopic.value) {
      selectedTopic.value = topic;
      void refreshData();
    }
  },
);

onMounted(async () => {
  await refreshData();
  startPolling();
});

onUnmounted(stopPolling);
</script>

<template>
  <div class="flex h-full flex-col bg-card text-card-foreground">
    <div class="flex shrink-0 items-center justify-between border-b px-4 py-2">
      <div class="flex items-center gap-3">
        <span class="text-lg font-semibold">{{ t("connection.mqttConsoleTitle") }}</span>
        <span v-if="brokerInfo" class="text-sm text-muted-foreground">{{ brokerInfo.brokerUrl }}</span>
        <span v-if="brokerInfo" class="rounded px-1.5 py-0.5 text-xs font-medium" :class="connected ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'">
          {{ connected ? t("connection.mqttConnected") : t("connection.mqttDisconnected") }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <Button size="sm" variant="outline" @click="refreshData">{{ t("connection.mqttRefresh") }}</Button>
        <Button size="sm" variant="outline" @click="handleClearMessages">{{ t("connection.mqttClearMessages") }}</Button>
      </div>
    </div>

    <div v-if="error" class="border-b bg-red-50 px-4 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-400">
      {{ error }}
      <button class="ml-2 underline" @click="error = null">{{ t("common.close") }}</button>
    </div>

    <div class="flex min-h-0 flex-1">
      <div class="flex w-[22rem] shrink-0 flex-col border-r">
        <div class="flex items-center justify-between border-b px-3 py-2">
          <span class="text-xs font-semibold uppercase text-muted-foreground">{{ t("connection.mqttSubscriptionConfig") }}</span>
          <div class="flex items-center gap-1">
            <Button size="sm" variant="ghost" class="h-7 px-2 text-xs" @click="refreshData">{{ t("connection.mqttRefresh") }}</Button>
            <Button size="sm" class="h-7 px-2 text-xs" @click="openSubscriptionDialog">+ {{ t("connection.mqttNewSubscription") }}</Button>
          </div>
        </div>
        <div class="border-b p-2">
          <input v-model="topicSearch" class="h-8 w-full rounded border bg-transparent px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring" :placeholder="t('connection.mqttSearchSubscriptionsPlaceholder')" />
        </div>
        <div class="min-h-0 flex-1 overflow-auto">
          <div v-if="loading" class="p-3 text-xs text-muted-foreground">{{ t("common.loading") }}</div>
          <div v-else-if="!savedTopics.length" class="p-3 text-xs text-muted-foreground">{{ t("connection.mqttNoSavedSubscriptions") }}</div>
          <TopicTreeNode
            v-for="child in topicTree.children"
            :key="child.fullPath"
            :node="child"
            :depth="0"
            :selected-topic="selectedTopic"
            :subscribed-topics="subscribedTopics"
            :saved-topics="savedTopics"
            :filter="topicSearch"
            @select="handleTopicClick"
            @toggle-enabled="handleToggleEnabled"
            @edit="editSubscription"
            @delete="handleDelete"
          />
        </div>
        <div class="border-t p-2">
          <form class="flex gap-1" @submit.prevent="handleSubscribe((($event.target as HTMLFormElement).querySelector('input') as HTMLInputElement)?.value.trim() || '')">
            <input class="h-7 min-w-0 flex-1 rounded border bg-transparent px-2 text-xs" :placeholder="t('connection.mqttSubscribePlaceholder')" />
            <Button size="sm" variant="ghost" class="h-7 px-2 text-xs" type="submit">{{ t("connection.mqttQuickSubscribe") }}</Button>
          </form>
          <label class="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground"><input v-model="noLocalSubscribe" type="checkbox" :disabled="!mqtt5" />{{ t("connection.mqttNoLocal") }}</label>
        </div>
      </div>

      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex min-h-0 flex-1 flex-col">
          <div class="flex shrink-0 items-center justify-between border-b px-3 py-2 text-xs font-semibold uppercase text-muted-foreground">
            <span v-if="selectedTopic">{{ t("connection.mqttMessagesForTopic", { topic: selectedTopic }) }}</span>
            <span v-else>{{ t("connection.mqttAllMessages") }}</span>
            <div class="flex items-center gap-2">
              <span class="font-normal">{{ messages.length }}</span>
              <select v-model="displayEncoding" class="h-6 rounded border bg-transparent px-1.5 text-[11px] text-muted-foreground outline-none">
                <option v-for="enc in PAYLOAD_ENCODINGS" :key="enc" :value="enc">{{ PAYLOAD_ENCODING_LABELS[enc] }}</option>
              </select>
            </div>
          </div>
          <div class="flex min-h-0 flex-1 flex-col overflow-auto">
            <div v-if="messages.length === 0" class="p-4 text-center text-xs text-muted-foreground">{{ t("connection.mqttNoMessages") }}</div>
            <div
              v-for="(msg, i) in messages"
              :key="i"
              class="w-full cursor-pointer border-b px-3 py-2 text-xs"
              :class="
                msg.direction === 'sent'
                  ? 'ml-auto max-w-[85%] rounded-l-md border-r-2 border-emerald-400 bg-emerald-50/70 hover:bg-emerald-100/70 dark:border-emerald-500 dark:bg-emerald-950/30 dark:hover:bg-emerald-950/50'
                  : 'mr-auto max-w-[85%] rounded-r-md border-l-2 border-blue-400 bg-blue-50/70 hover:bg-blue-100/70 dark:border-blue-500 dark:bg-blue-950/30 dark:hover:bg-blue-950/50'
              "
              @click="handleTopicClick(msg.topic)"
            >
              <div class="mb-0.5 flex items-center gap-2">
                <span v-if="msg.direction === 'sent'" class="shrink-0 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">{{ t("connection.mqttSent") }}</span>
                <span v-else class="shrink-0 text-[10px] font-bold text-blue-600 dark:text-blue-400">{{ t("connection.mqttReceived") }}</span>
                <span class="truncate font-mono font-medium text-blue-700 dark:text-blue-300">{{ msg.topic }}</span>
                <span class="shrink-0 text-muted-foreground">QoS{{ msg.qos }}</span>
                <span v-if="msg.retain" class="shrink-0 text-[10px] font-medium text-amber-600 dark:text-amber-400">{{ t("connection.mqttRetained") }}</span>
              </div>
              <div class="break-all whitespace-pre-wrap font-mono text-muted-foreground">{{ formatMessagePayload(msg) }}</div>
              <div class="mt-0.5 text-[10px] text-muted-foreground/60">{{ new Date(msg.receivedAtMs).toLocaleTimeString() }}</div>
            </div>
          </div>
        </div>
        <MqttPublishPanel v-if="connected" :connection-id="connectionId" :initial-topic="selectedTopic" @published="handleMessagePublished" />
      </div>
    </div>

    <Dialog v-model:open="showSubscriptionDialog">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ editingTopic ? t("connection.mqttEditSubscription") : t("connection.mqttNewSubscription") }}</DialogTitle>
        </DialogHeader>
        <div class="grid gap-3">
          <label class="grid gap-1.5 text-xs font-medium">
            <span>{{ t("connection.mqttTopicFilter") }}</span>
            <input v-model="formTopic" class="h-8 rounded border bg-transparent px-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring" :placeholder="t('connection.mqttTopicFilterPlaceholder')" :disabled="savingSubscription" @keydown.enter.prevent="saveSubscription" />
            <span class="text-[11px] font-normal text-muted-foreground">{{ t("connection.mqttTopicFilterHint") }}</span>
          </label>
          <label class="grid gap-1.5 text-xs font-medium">
            <span>QoS</span>
            <select v-model="formQos" class="h-8 rounded border bg-transparent px-2 text-xs" :disabled="savingSubscription">
              <option value="atmostonce">QoS 0 — {{ t("connection.mqttQosAtMostOnce") }}</option>
              <option value="atleastonce">QoS 1 — {{ t("connection.mqttQosAtLeastOnce") }}</option>
              <option value="exactlyonce">QoS 2 — {{ t("connection.mqttQosExactlyOnce") }}</option>
            </select>
          </label>
          <label class="flex items-center gap-2 text-xs font-medium">
            <input v-model="formNoLocal" type="checkbox" :disabled="savingSubscription || !mqtt5" />
            <span>{{ t("connection.mqttNoLocal") }}（No Local）</span>
            <span v-if="!mqtt5" class="font-normal text-muted-foreground">{{ t("connection.mqttNoLocalMqtt5Only") }}</span>
          </label>
          <label class="flex items-start gap-2 text-xs font-medium">
            <input v-model="formEnabled" type="checkbox" :disabled="savingSubscription" />
            <span
              ><span>{{ t("connection.mqttEnableSubscription") }}</span
              ><span class="block font-normal text-muted-foreground">{{ t("connection.mqttEnableSubscriptionHint") }}</span></span
            >
          </label>
          <p v-if="error" class="text-xs text-destructive">{{ error }}</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" :disabled="savingSubscription" @click="showSubscriptionDialog = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="savingSubscription" @click="saveSubscription">{{ savingSubscription ? t("connection.mqttSaving") : t("common.save") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

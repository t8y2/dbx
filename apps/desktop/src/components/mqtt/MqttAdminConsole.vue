<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { mqttGetBrokerInfo, mqttListTopics, mqttListSavedTopicConfigs, mqttGetMessages, mqttSubscribe, mqttUnsubscribe, mqttSaveTopicConfig, mqttDeleteTopicConfig, mqttClearMessages, mqttDeleteMessage } from "@/lib/backend/api";
import type { MqttBrokerInfo, MqttSavedTopic, MqttTopicNode, MqttMessage, MqttMessageDirection, MqttQoS } from "@/types/mqtt";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import TopicTreeNode from "./TopicTreeNode.vue";
import MqttPublishPanel from "./MqttPublishDialog.vue";
import { decodePayload, PAYLOAD_ENCODINGS, PAYLOAD_ENCODING_LABELS, type PayloadEncoding } from "@/lib/mqtt/mqttPayloadCodec";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { ChevronDown, ChevronUp, Copy, Pause, Play, Trash2 } from "@lucide/vue";
import { copyToClipboard } from "@/lib/common/clipboard";
import { useTabUiState } from "@/lib/tabs/tabUiState";

interface Props {
  connectionId: string;
  initialTopic?: string;
}
const props = defineProps<Props>();
const { t } = useI18n();

interface MqttTabUiState {
  selectedTopic?: string;
  messagesPaused?: boolean;
  displayEncoding?: PayloadEncoding;
  topicSearch?: string;
  payloadSearch?: string;
  messageDirectionFilter?: MqttMessageDirectionFilter;
  showSubscriptionDialog?: boolean;
  formTopic?: string;
  formQos?: MqttQoS;
  formNoLocal?: boolean;
  formEnabled?: boolean;
  editingTopic?: string | null;
  publishPanelCollapsed?: boolean;
}

interface MqttMessagePreview extends MqttMessage {
  previewKey: string;
  payloadElementId: string;
}

type MqttMessageDirectionFilter = "all" | MqttMessageDirection;

const { initialState: restoredUiState, track: trackUiState } = useTabUiState<MqttTabUiState>({}, "MqttAdminConsole");

const brokerInfo = ref<MqttBrokerInfo | null>(null);
const savedTopics = ref<MqttSavedTopic[]>([]);
const subscribedTopics = ref<[string, string][]>([]);
const messages = ref<MqttMessage[]>([]);
const collapsedMessageKeys = ref<Set<string>>(new Set());
const noLocalSubscribe = ref(false);
const selectedTopic = ref<string>(restoredUiState.selectedTopic ?? props.initialTopic ?? "");
const loading = ref(true);
const error = ref<string | null>(null);
const pollingTimer = ref<ReturnType<typeof setInterval> | null>(null);
const messageListRef = ref<HTMLElement | null>(null);
const contextMenuMessage = ref<MqttMessagePreview | null>(null);
const messagesPaused = ref(restoredUiState.messagesPaused ?? false);
const displayEncoding = ref<PayloadEncoding>(restoredUiState.displayEncoding ?? "plaintext");
const topicSearch = ref(restoredUiState.topicSearch ?? "");
const payloadSearch = ref(restoredUiState.payloadSearch ?? "");
const messageDirectionFilter = ref<MqttMessageDirectionFilter>(restoredUiState.messageDirectionFilter ?? "all");
const showSubscriptionDialog = ref(restoredUiState.showSubscriptionDialog ?? false);
const savingSubscription = ref(false);
const formTopic = ref(restoredUiState.formTopic ?? "");
const formQos = ref<MqttQoS>(restoredUiState.formQos ?? "atmostonce");
const formNoLocal = ref(restoredUiState.formNoLocal ?? false);
const formEnabled = ref(restoredUiState.formEnabled ?? true);
const editingTopic = ref<string | null>(restoredUiState.editingTopic ?? null);
const MQTT_PUBLISH_PANEL_COLLAPSED_STORAGE_KEY = "dbx-mqtt-publish-panel-collapsed";
const MQTT_MESSAGE_HISTORY_LIMIT = 400;
const publishPanelCollapsed = ref(restoredUiState.publishPanelCollapsed ?? safeLocalStorageGet(MQTT_PUBLISH_PANEL_COLLAPSED_STORAGE_KEY) === "true");

const subscriptionDialogDragOffset = ref({ x: 0, y: 0 });
const isDraggingSubscriptionDialog = ref(false);
const subscriptionDialogDragStart = ref({ x: 0, y: 0 });
const subscriptionDialogDragStartOffset = ref({ x: 0, y: 0 });
const subscriptionDialogDragStartRect = ref<DOMRect | null>(null);
const activeSubscriptionDialogPointerId = ref<number | null>(null);
const subscriptionDialogContentStyle = computed(() => {
  const { x, y } = subscriptionDialogDragOffset.value;
  if (isDraggingSubscriptionDialog.value || x !== 0 || y !== 0) {
    return {
      transform: `translate(${x}px, ${y}px)`,
      transition: isDraggingSubscriptionDialog.value ? "none" : "transform 0.15s ease-out",
    };
  }
  return {};
});

trackUiState(() => ({
  selectedTopic: selectedTopic.value,
  messagesPaused: messagesPaused.value,
  displayEncoding: displayEncoding.value,
  topicSearch: topicSearch.value,
  payloadSearch: payloadSearch.value,
  messageDirectionFilter: messageDirectionFilter.value,
  showSubscriptionDialog: showSubscriptionDialog.value,
  formTopic: formTopic.value,
  formQos: formQos.value,
  formNoLocal: formNoLocal.value,
  formEnabled: formEnabled.value,
  editingTopic: editingTopic.value,
  publishPanelCollapsed: publishPanelCollapsed.value,
}));

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

function messagePayloadText(msg: MqttMessage): string {
  return msg.payloadText ?? decodePayload(msg.payloadBase64, "plaintext");
}

function hashMessageValue(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function messagePreviewIdentity(msg: MqttMessage): string {
  return [msg.receivedAtMs, msg.direction ?? "received", msg.qos, msg.retain ? 1 : 0, hashMessageValue(msg.topic), msg.payloadBase64.length, hashMessageValue(msg.payloadBase64)].join("-");
}

const messagePreviews = computed<MqttMessagePreview[]>(() => {
  const identityOccurrences = new Map<string, number>();
  return messages.value.map((msg) => {
    const identity = messagePreviewIdentity(msg);
    const occurrence = identityOccurrences.get(identity) ?? 0;
    identityOccurrences.set(identity, occurrence + 1);
    const previewKey = `${identity}-${occurrence}`;
    return { ...msg, previewKey, payloadElementId: `mqtt-message-payload-${previewKey}` };
  });
});

const directionFilteredMessages = computed(() => {
  if (messageDirectionFilter.value === "all") return messagePreviews.value;
  return messagePreviews.value.filter((msg) => (msg.direction ?? "received") === messageDirectionFilter.value);
});

const filteredMessages = computed(() => {
  const query = payloadSearch.value.trim().toLowerCase();
  if (!query) return directionFilteredMessages.value;
  return directionFilteredMessages.value.filter((msg) => messagePayloadText(msg).toLowerCase().includes(query));
});

async function refreshData() {
  try {
    const [info, active, configs, msgs] = await Promise.all([
      mqttGetBrokerInfo(props.connectionId) as Promise<MqttBrokerInfo>,
      mqttListTopics(props.connectionId) as Promise<[string, string][]>,
      mqttListSavedTopicConfigs(props.connectionId) as Promise<MqttSavedTopic[]>,
      mqttGetMessages(props.connectionId, selectedTopic.value || undefined, MQTT_MESSAGE_HISTORY_LIMIT) as Promise<MqttMessage[]>,
    ]);
    brokerInfo.value = info;
    subscribedTopics.value = active;
    savedTopics.value = configs.map((config) => ({ ...config, enabled: config.enabled !== false, noLocal: config.noLocal === true }));
    messages.value = msgs;
    error.value = null;
    void nextTick(() => {
      if (messageListRef.value) messageListRef.value.scrollTop = 0;
    });
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
  resetSubscriptionDialogDrag();
  editingTopic.value = null;
  formTopic.value = "";
  formQos.value = "atmostonce";
  formNoLocal.value = false;
  formEnabled.value = true;
  error.value = null;
  showSubscriptionDialog.value = true;
}

function editSubscription(config: MqttSavedTopic) {
  resetSubscriptionDialogDrag();
  editingTopic.value = config.topic;
  formTopic.value = config.topic;
  formQos.value = config.qos;
  formNoLocal.value = config.noLocal === true;
  formEnabled.value = config.enabled !== false;
  error.value = null;
  showSubscriptionDialog.value = true;
}

function resetSubscriptionDialogDrag() {
  subscriptionDialogDragOffset.value = { x: 0, y: 0 };
  isDraggingSubscriptionDialog.value = false;
  activeSubscriptionDialogPointerId.value = null;
  subscriptionDialogDragStartRect.value = null;
}

function startSubscriptionDialogDrag(event: PointerEvent) {
  if (event.button !== 0) return;
  const dialogContent = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-slot="dialog-content"]');
  if (!dialogContent) return;

  subscriptionDialogDragStartRect.value = dialogContent.getBoundingClientRect();
  subscriptionDialogDragStart.value = { x: event.clientX, y: event.clientY };
  subscriptionDialogDragStartOffset.value = { ...subscriptionDialogDragOffset.value };
  activeSubscriptionDialogPointerId.value = event.pointerId;
  isDraggingSubscriptionDialog.value = true;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function moveSubscriptionDialog(event: PointerEvent) {
  const rect = subscriptionDialogDragStartRect.value;
  if (!isDraggingSubscriptionDialog.value || event.pointerId !== activeSubscriptionDialogPointerId.value || !rect) return;

  const startOffset = subscriptionDialogDragStartOffset.value;
  const deltaX = event.clientX - subscriptionDialogDragStart.value.x;
  const deltaY = event.clientY - subscriptionDialogDragStart.value.y;
  const margin = 8;
  const minX = startOffset.x + margin - rect.left;
  const maxX = startOffset.x + window.innerWidth - margin - rect.right;
  const minY = startOffset.y + margin - rect.top;
  const maxY = startOffset.y + window.innerHeight - margin - rect.bottom;
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

  subscriptionDialogDragOffset.value = {
    x: clamp(startOffset.x + deltaX, minX, maxX),
    y: clamp(startOffset.y + deltaY, minY, maxY),
  };
}

function endSubscriptionDialogDrag(event: PointerEvent) {
  if (!isDraggingSubscriptionDialog.value || event.pointerId !== activeSubscriptionDialogPointerId.value) return;
  isDraggingSubscriptionDialog.value = false;
  activeSubscriptionDialogPointerId.value = null;
  subscriptionDialogDragStartRect.value = null;
  try {
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  } catch {
    // Pointer capture may already be released when the pointer is cancelled.
  }
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

function handleMessageClick(topic: string) {
  if (messagesPaused.value) return;
  handleTopicClick(topic);
}

function handleMessagePublished() {
  void refreshData();
}

function togglePublishPanel() {
  publishPanelCollapsed.value = !publishPanelCollapsed.value;
  safeLocalStorageSet(MQTT_PUBLISH_PANEL_COLLAPSED_STORAGE_KEY, String(publishPanelCollapsed.value));
}

async function handleClearMessages() {
  try {
    await mqttClearMessages(props.connectionId);
    messages.value = [];
    collapsedMessageKeys.value = new Set();
  } catch (e) {
    error.value = String(e);
  }
}

async function copyMessageValue(value: string) {
  try {
    await copyToClipboard(value);
  } catch (e) {
    error.value = t("grid.copyFailed", { message: e instanceof Error ? e.message : String(e) });
  }
}

async function deleteMessage(msg: MqttMessagePreview) {
  try {
    await mqttDeleteMessage(props.connectionId, msg);
    const index = messagePreviews.value.findIndex((candidate) => candidate.previewKey === msg.previewKey);
    if (index !== -1) messages.value.splice(index, 1);
    const nextCollapsedMessageKeys = new Set(collapsedMessageKeys.value);
    nextCollapsedMessageKeys.delete(msg.previewKey);
    collapsedMessageKeys.value = nextCollapsedMessageKeys;
  } catch (e) {
    error.value = String(e);
  }
}

function messageContextMenuItems(): ContextMenuItem[] {
  const msg = contextMenuMessage.value;
  if (!msg) return [];
  return [
    { label: t("connection.mqttCopyPayload"), icon: Copy, action: () => void copyMessageValue(formatMessagePayload(msg)) },
    { label: t("connection.mqttCopyTopic"), icon: Copy, action: () => void copyMessageValue(msg.topic) },
    { label: t("connection.mqttDeleteMessage"), icon: Trash2, variant: "destructive", action: () => void deleteMessage(msg) },
  ];
}

function openMessageContextMenu(event: MouseEvent, msg: MqttMessagePreview, openMenu: (event: MouseEvent) => void) {
  contextMenuMessage.value = msg;
  openMenu(event);
}

function startPolling() {
  stopPolling();
  pollingTimer.value = setInterval(async () => {
    if (messagesPaused.value) return;
    try {
      const nextMessages = (await mqttGetMessages(props.connectionId, selectedTopic.value || undefined, MQTT_MESSAGE_HISTORY_LIMIT)) as MqttMessage[];
      if (!messagesPaused.value) messages.value = nextMessages;
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

function toggleMessagesPaused() {
  messagesPaused.value = !messagesPaused.value;
}

function isMessagePayloadCollapsed(messageKey: string): boolean {
  return collapsedMessageKeys.value.has(messageKey);
}

function toggleMessagePayload(messageKey: string) {
  const nextCollapsedMessageKeys = new Set(collapsedMessageKeys.value);
  if (nextCollapsedMessageKeys.has(messageKey)) nextCollapsedMessageKeys.delete(messageKey);
  else nextCollapsedMessageKeys.add(messageKey);
  collapsedMessageKeys.value = nextCollapsedMessageKeys;
}

function collapseAllMessagePayloads() {
  const nextCollapsedMessageKeys = new Set(collapsedMessageKeys.value);
  for (const msg of filteredMessages.value) nextCollapsedMessageKeys.add(msg.previewKey);
  collapsedMessageKeys.value = nextCollapsedMessageKeys;
}

function expandAllMessagePayloads() {
  if (filteredMessages.value.length === 0) {
    collapsedMessageKeys.value = new Set();
    return;
  }
  const keysToExpand = new Set(filteredMessages.value.map((msg) => msg.previewKey));
  const nextCollapsedMessageKeys = new Set([...collapsedMessageKeys.value].filter((key) => !keysToExpand.has(key)));
  collapsedMessageKeys.value = nextCollapsedMessageKeys;
}

function formatMessagePayload(msg: MqttMessage): string {
  if (displayEncoding.value === "plaintext") return messagePayloadText(msg);
  return decodePayload(msg.payloadBase64, displayEncoding.value);
}

function formatMessageTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
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
          <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-3 py-2 text-xs font-semibold uppercase text-muted-foreground">
            <span v-if="selectedTopic" class="min-w-0 truncate">{{ t("connection.mqttMessagesForTopic", { topic: selectedTopic }) }}</span>
            <span v-else class="min-w-0 truncate">{{ t("connection.mqttAllMessages") }}</span>
            <div class="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
              <div class="inline-flex h-6 shrink-0 items-center rounded-md border p-0.5" role="group" :aria-label="t('connection.mqttMessageDirectionFilterLabel')">
                <button
                  type="button"
                  data-testid="mqtt-direction-filter-all"
                  class="h-5 rounded px-1.5 text-[10px] font-normal transition-colors"
                  :class="messageDirectionFilter === 'all' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'"
                  :aria-pressed="messageDirectionFilter === 'all'"
                  @click="messageDirectionFilter = 'all'"
                >
                  {{ t("connection.mqttDirectionFilterAll") }}
                </button>
                <button
                  type="button"
                  data-testid="mqtt-direction-filter-received"
                  class="h-5 rounded px-1.5 text-[10px] font-normal transition-colors"
                  :class="messageDirectionFilter === 'received' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'"
                  :aria-pressed="messageDirectionFilter === 'received'"
                  @click="messageDirectionFilter = 'received'"
                >
                  {{ t("connection.mqttDirectionFilterReceived") }}
                </button>
                <button
                  type="button"
                  data-testid="mqtt-direction-filter-sent"
                  class="h-5 rounded px-1.5 text-[10px] font-normal transition-colors"
                  :class="messageDirectionFilter === 'sent' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:text-foreground'"
                  :aria-pressed="messageDirectionFilter === 'sent'"
                  @click="messageDirectionFilter = 'sent'"
                >
                  {{ t("connection.mqttDirectionFilterSent") }}
                </button>
              </div>
              <input
                v-model="payloadSearch"
                data-testid="mqtt-payload-search"
                class="h-6 min-w-[10rem] flex-1 rounded border bg-transparent px-1.5 text-[11px] font-normal normal-case outline-none focus-visible:ring-1 focus-visible:ring-ring"
                :placeholder="t('connection.mqttSearchPayloadPlaceholder')"
                :aria-label="t('connection.mqttSearchPayloadPlaceholder')"
              />
              <span data-testid="mqtt-message-count" class="font-normal" aria-live="polite">
                <template v-if="payloadSearch.trim() || messageDirectionFilter !== 'all'">{{ filteredMessages.length }} / {{ messages.length }}</template>
                <template v-else>{{ messages.length }}</template>
              </span>
              <select v-model="displayEncoding" class="h-6 rounded border bg-transparent px-1.5 text-[11px] text-muted-foreground outline-none">
                <option v-for="enc in PAYLOAD_ENCODINGS" :key="enc" :value="enc">{{ PAYLOAD_ENCODING_LABELS[enc] }}</option>
              </select>
              <Button size="sm" variant="ghost" class="h-6 gap-1 px-2 text-[11px] font-normal normal-case" :title="messagesPaused ? t('connection.mqttResumeMessages') : t('connection.mqttPauseMessages')" @click="toggleMessagesPaused">
                <Play v-if="messagesPaused" class="h-3.5 w-3.5" />
                <Pause v-else class="h-3.5 w-3.5" />
                <span>{{ messagesPaused ? t("connection.mqttResumeMessages") : t("connection.mqttPauseMessages") }}</span>
              </Button>
              <Button type="button" size="sm" variant="ghost" data-testid="mqtt-message-payload-collapse-all" class="h-6 gap-1 px-2 text-[11px] font-normal normal-case" :disabled="filteredMessages.length === 0" :title="t('connection.mqttCollapseAllPayloads')" @click="collapseAllMessagePayloads">
                <ChevronUp class="h-3.5 w-3.5" />
                <span>{{ t("connection.mqttCollapseAllPayloads") }}</span>
              </Button>
              <Button type="button" size="sm" variant="ghost" data-testid="mqtt-message-payload-expand-all" class="h-6 gap-1 px-2 text-[11px] font-normal normal-case" :disabled="filteredMessages.length === 0" :title="t('connection.mqttExpandAllPayloads')" @click="expandAllMessagePayloads">
                <ChevronDown class="h-3.5 w-3.5" />
                <span>{{ t("connection.mqttExpandAllPayloads") }}</span>
              </Button>
              <Button
                size="sm"
                variant="ghost"
                class="h-6 gap-1 px-2 text-[11px] font-normal normal-case"
                :disabled="!connected"
                :aria-expanded="!publishPanelCollapsed"
                :title="publishPanelCollapsed ? t('connection.mqttShowPublishPanel') : t('connection.mqttHidePublishPanel')"
                @click="togglePublishPanel"
              >
                <ChevronUp v-if="publishPanelCollapsed" class="h-3.5 w-3.5" />
                <ChevronDown v-else class="h-3.5 w-3.5" />
                <span>{{ publishPanelCollapsed ? t("connection.mqttShowPublishPanel") : t("connection.mqttHidePublishPanel") }}</span>
              </Button>
            </div>
          </div>
          <CustomContextMenu :items="messageContextMenuItems" v-slot="{ onContextMenu }">
            <div ref="messageListRef" data-testid="mqtt-message-list" class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
              <div v-if="messages.length === 0" class="p-4 text-center text-xs text-muted-foreground">{{ t("connection.mqttNoMessages") }}</div>
              <div v-else-if="filteredMessages.length === 0" data-testid="mqtt-no-matching-messages" class="p-4 text-center text-xs text-muted-foreground">{{ t("connection.mqttNoMatchingMessages") }}</div>
              <div
                v-for="msg in filteredMessages"
                :key="msg.previewKey"
                data-testid="mqtt-message"
                class="w-full cursor-pointer border px-3 py-2 text-xs"
                :class="
                  msg.direction === 'sent'
                    ? 'ml-auto max-w-[85%] rounded-l-md border-r-2 border-emerald-400 bg-emerald-50/70 hover:bg-emerald-100/70 dark:border-emerald-500 dark:bg-emerald-950/30 dark:hover:bg-emerald-950/50'
                    : 'mr-auto max-w-[85%] rounded-r-md border-l-2 border-blue-400 bg-blue-50/70 hover:bg-blue-100/70 dark:border-blue-500 dark:bg-blue-950/30 dark:hover:bg-blue-950/50'
                "
                @click="handleMessageClick(msg.topic)"
                @contextmenu="openMessageContextMenu($event, msg, onContextMenu)"
              >
                <div class="mb-0.5 flex items-center gap-2">
                  <span v-if="msg.direction === 'sent'" class="shrink-0 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">{{ t("connection.mqttSent") }}</span>
                  <span v-else class="shrink-0 text-[10px] font-bold text-blue-600 dark:text-blue-400">{{ t("connection.mqttReceived") }}</span>
                  <span class="truncate font-mono font-medium text-blue-700 dark:text-blue-300">{{ msg.topic }}</span>
                  <span class="shrink-0 text-muted-foreground">QoS{{ msg.qos }}</span>
                  <span v-if="msg.retain" class="shrink-0 text-[10px] font-medium text-amber-600 dark:text-amber-400">{{ t("connection.mqttRetained") }}</span>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    data-testid="mqtt-message-payload-toggle"
                    class="ml-auto h-5 gap-0.5 px-1.5 text-[10px] font-normal"
                    :title="isMessagePayloadCollapsed(msg.previewKey) ? t('connection.mqttExpandPayload') : t('connection.mqttCollapsePayload')"
                    :aria-expanded="!isMessagePayloadCollapsed(msg.previewKey)"
                    :aria-controls="msg.payloadElementId"
                    @click.stop="toggleMessagePayload(msg.previewKey)"
                  >
                    <ChevronDown v-if="isMessagePayloadCollapsed(msg.previewKey)" class="h-3 w-3" />
                    <ChevronUp v-else class="h-3 w-3" />
                    <span>{{ isMessagePayloadCollapsed(msg.previewKey) ? t("connection.mqttExpandPayload") : t("connection.mqttCollapsePayload") }}</span>
                    <span class="sr-only">: {{ msg.topic }}</span>
                  </Button>
                </div>
                <div :id="msg.payloadElementId" data-testid="mqtt-message-payload" class="break-all whitespace-pre-wrap font-mono text-muted-foreground" :hidden="isMessagePayloadCollapsed(msg.previewKey)">
                  <template v-if="!isMessagePayloadCollapsed(msg.previewKey)">{{ formatMessagePayload(msg) }}</template>
                </div>
                <time class="mt-1 block text-[10px] tabular-nums text-muted-foreground/70">{{ formatMessageTimestamp(msg.receivedAtMs) }}</time>
              </div>
            </div>
          </CustomContextMenu>
        </div>
        <MqttPublishPanel v-if="connected" v-show="!publishPanelCollapsed" :connection-id="connectionId" :initial-topic="selectedTopic" @published="handleMessagePublished" />
      </div>
    </div>

    <Dialog v-model:open="showSubscriptionDialog">
      <DialogContent :style="subscriptionDialogContentStyle" class="sm:max-w-md">
        <DialogHeader class="cursor-move select-none touch-none" @pointerdown="startSubscriptionDialogDrag" @pointermove="moveSubscriptionDialog" @pointerup="endSubscriptionDialogDrag" @pointercancel="endSubscriptionDialogDrag">
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
            <span>{{ t("connection.mqttNoLocal") }}</span>
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

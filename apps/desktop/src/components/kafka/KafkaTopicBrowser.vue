<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2, Plus, Radio, RefreshCw, Search, Send, Sparkles } from "@lucide/vue";
import { uuid } from "@/lib/utils";
import { useConnectionStore } from "@/stores/connectionStore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import * as api from "@/lib/api";
import type { KafkaDecodedPayload, KafkaMessageRecord, KafkaPartitionInfo, KafkaPayload, KafkaStartOffset } from "@/types/database";
import { useToast } from "@/composables/useToast";
import { formatKafkaPayloadText, highlightSearchText, kafkaMessageMatchesQuery, KAFKA_PAYLOAD_FORMATS, type KafkaPayloadFormat } from "@/lib/kafkaPayloadFormat";

const props = defineProps<{ connectionId: string; topic: string }>();

type OffsetMode = "earliest" | "latest" | "offset";

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();

const tailing = ref(false);
const tailId = ref("");
const decodedValue = ref<KafkaDecodedPayload | null>(null);
const decoding = ref(false);
const hasSchemaRegistry = computed(() => !!connectionStore.getConfig(props.connectionId)?.kafka_schema_registry_url?.trim());

const topicInfoLoading = ref(false);
const loadingMessages = ref(false);
const partitions = ref<KafkaPartitionInfo[]>([]);
const selectedPartition = ref("0");
const offsetMode = ref<OffsetMode>("latest");
const offsetValue = ref("");
const limit = ref(100);
const messages = ref<KafkaMessageRecord[]>([]);
const error = ref("");
const selectedMessage = ref<KafkaMessageRecord | null>(null);
const showProduceDialog = ref(false);
const produceKey = ref("");
const produceValue = ref("");
const producePartition = ref("");
const producing = ref(false);
const produceError = ref("");
const offsetInputRef = ref<HTMLInputElement>();
const messageSearchQuery = ref("");
const detailSearchQuery = ref("");
const keyFormat = ref<KafkaPayloadFormat>("raw");
const valueFormat = ref<KafkaPayloadFormat>("json");

const selectedPartitionNumber = computed(() => Number(selectedPartition.value));
const selectedPartitionInfo = computed(() => partitions.value.find((partition) => partition.partition === selectedPartitionNumber.value));
const offsetRangeHint = computed(() => {
  const info = selectedPartitionInfo.value;
  if (!info || info.offsetBegin == null || info.offsetEnd == null) return "";
  return t("kafka.offsetRange", { begin: info.offsetBegin, end: info.offsetEnd });
});

function payloadText(payload?: KafkaPayload | null): string {
  if (!payload) return "";
  if (payload.encoding === "base64") {
    try {
      return atob(payload.data);
    } catch {
      return payload.data;
    }
  }
  return payload.data;
}

function payloadPreview(payload?: KafkaPayload | null): string {
  const text = payloadText(payload);
  if (!text) return "-";
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function formattedPayloadText(payload?: KafkaPayload | null, format: KafkaPayloadFormat = "raw"): string {
  const text = payloadText(payload);
  if (!text) return "";
  return formatKafkaPayloadText(text, format, payload?.encoding);
}

const filteredMessages = computed(() => {
  const query = messageSearchQuery.value.trim();
  if (!query) return messages.value;
  return messages.value.filter((message) => kafkaMessageMatchesQuery([String(message.offset), String(message.partition), payloadText(message.key), payloadText(message.value), ...message.headers.map(([name, value]) => `${name}:${value}`)], query));
});

const selectedKeyText = computed(() => formattedPayloadText(selectedMessage.value?.key, keyFormat.value));
const selectedValueText = computed(() => formattedPayloadText(selectedMessage.value?.value, valueFormat.value));
const highlightedKeySegments = computed(() => highlightSearchText(selectedKeyText.value || "-", detailSearchQuery.value));
const highlightedValueSegments = computed(() => highlightSearchText(selectedValueText.value || "-", detailSearchQuery.value));

function formatTimestamp(timestamp: number): string {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleString();
}

function buildStartOffset(): KafkaStartOffset {
  if (offsetMode.value === "earliest") return "earliest";
  if (offsetMode.value === "latest") return "latest";
  const parsed = Number(offsetValue.value);
  return { offset: Number.isFinite(parsed) ? parsed : 0 };
}

async function loadTopicInfo() {
  topicInfoLoading.value = true;
  error.value = "";
  try {
    const info = await api.kafkaDescribeTopic(props.connectionId, props.topic);
    partitions.value = info.partitions || [];
    if (partitions.value.length > 0 && !partitions.value.some((partition) => partition.partition === selectedPartitionNumber.value)) {
      selectedPartition.value = String(partitions.value[0].partition);
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    partitions.value = [];
  } finally {
    topicInfoLoading.value = false;
  }
}

async function fetchMessages() {
  loadingMessages.value = true;
  error.value = "";
  selectedMessage.value = null;
  try {
    messages.value = await api.kafkaFetchMessages(props.connectionId, {
      topic: props.topic,
      partition: selectedPartitionNumber.value,
      startOffset: buildStartOffset(),
      limit: limit.value,
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    messages.value = [];
  } finally {
    loadingMessages.value = false;
  }
}

async function refreshAll() {
  await loadTopicInfo();
  await fetchMessages();
}

function openProduceDialog() {
  produceKey.value = "";
  produceValue.value = "";
  producePartition.value = "";
  produceError.value = "";
  showProduceDialog.value = true;
}

async function produceMessage() {
  if (!produceValue.value.trim()) {
    produceError.value = t("kafka.valueRequired");
    return;
  }
  producing.value = true;
  produceError.value = "";
  try {
    await api.kafkaProduceMessage(props.connectionId, {
      topic: props.topic,
      key: produceKey.value.trim() || null,
      value: produceValue.value,
      partition: producePartition.value !== "" ? Number(producePartition.value) : null,
    });
    showProduceDialog.value = false;
    toast(t("kafka.produced"), 2500);
    await fetchMessages();
  } catch (e) {
    produceError.value = e instanceof Error ? e.message : String(e);
  } finally {
    producing.value = false;
  }
}

function selectMessage(message: KafkaMessageRecord) {
  selectedMessage.value = message;
  decodedValue.value = null;
}

async function decodeSelectedValue() {
  if (!selectedMessage.value?.value) return;
  decoding.value = true;
  try {
    decodedValue.value = await api.kafkaDecodePayload(props.connectionId, selectedMessage.value.value, `${props.topic}-value`);
  } catch (e) {
    decodedValue.value = {
      presentation: "",
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    decoding.value = false;
  }
}

async function stopTail() {
  if (!tailId.value) return;
  await api.kafkaTailStop(tailId.value);
  tailId.value = "";
  tailing.value = false;
}

async function toggleTail() {
  if (tailing.value) {
    await stopTail();
    return;
  }
  tailId.value = uuid();
  tailing.value = true;
  messages.value = [];
  selectedMessage.value = null;
  void api
    .kafkaTailStart(
      {
        tailId: tailId.value,
        connectionId: props.connectionId,
        topic: props.topic,
        partition: selectedPartitionNumber.value,
        pollIntervalMs: 1000,
      },
      (event) => {
        if (event.status === "error" && event.error) {
          error.value = event.error;
          return;
        }
        if (event.status === "message" && event.message) {
          error.value = "";
          messages.value = [event.message, ...messages.value].slice(0, Math.max(limit.value, 100));
          if (!selectedMessage.value) selectedMessage.value = event.message;
        }
        if (event.status === "stopped") {
          tailing.value = false;
          tailId.value = "";
        }
      },
    )
    .catch((e) => {
      error.value = e instanceof Error ? e.message : String(e);
      tailing.value = false;
      tailId.value = "";
    });
}

function focusSearch(): boolean {
  offsetInputRef.value?.focus();
  return true;
}

watch(
  () => [props.connectionId, props.topic],
  () => {
    void stopTail();
    messages.value = [];
    selectedMessage.value = null;
    decodedValue.value = null;
    void loadTopicInfo();
  },
);

watch(selectedPartition, () => {
  if (tailing.value) void stopTail().then(() => toggleTail());
});

onMounted(() => void loadTopicInfo());
onUnmounted(() => void stopTail());
defineExpose({ focusSearch });
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-medium">{{ topic }}</div>
        <div v-if="offsetRangeHint" class="text-xs text-muted-foreground">{{ offsetRangeHint }}</div>
      </div>
      <Select v-model="selectedPartition">
        <SelectTrigger class="h-8 w-36">
          <SelectValue :placeholder="t('kafka.partition')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="partition in partitions" :key="partition.partition" :value="String(partition.partition)">
            {{ t("kafka.partitionN", { n: partition.partition }) }}
          </SelectItem>
        </SelectContent>
      </Select>
      <Select v-model="offsetMode">
        <SelectTrigger class="h-8 w-36">
          <SelectValue :placeholder="t('kafka.offsetMode')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="latest">{{ t("kafka.offsetLatest") }}</SelectItem>
          <SelectItem value="earliest">{{ t("kafka.offsetEarliest") }}</SelectItem>
          <SelectItem value="offset">{{ t("kafka.offsetAbsolute") }}</SelectItem>
        </SelectContent>
      </Select>
      <Input v-if="offsetMode === 'offset'" ref="offsetInputRef" v-model="offsetValue" type="number" class="h-8 w-32" :placeholder="t('kafka.offsetPlaceholder')" />
      <Input v-model.number="limit" type="number" class="h-8 w-24" :placeholder="t('kafka.limit')" />
      <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="loadingMessages || topicInfoLoading || tailing" @click="refreshAll">
        <Loader2 v-if="loadingMessages" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCw v-else class="h-3.5 w-3.5" />
        {{ t("grid.refresh") }}
      </Button>
      <Button size="sm" :variant="tailing ? 'default' : 'outline'" class="h-8 gap-1.5" @click="toggleTail">
        <Radio class="h-3.5 w-3.5" :class="{ 'animate-pulse': tailing }" />
        {{ tailing ? t("kafka.stopTail") : t("kafka.startTail") }}
      </Button>
      <Button size="sm" class="h-8 gap-1.5" @click="openProduceDialog">
        <Plus class="h-3.5 w-3.5" />
        {{ t("kafka.produce") }}
      </Button>
    </div>

    <div class="grid min-h-0 flex-1 grid-cols-[minmax(280px,42%)_1fr]">
      <div class="flex min-h-0 flex-col border-r">
        <div class="flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <Search class="h-3.5 w-3.5 text-muted-foreground" />
          <Input v-model="messageSearchQuery" class="h-8" :placeholder="t('kafka.messageSearchPlaceholder')" />
        </div>
        <div class="min-h-0 flex-1">
          <div v-if="topicInfoLoading || loadingMessages" class="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 class="mr-2 h-4 w-4 animate-spin" />
            {{ topicInfoLoading ? t("kafka.loadingTopic") : t("kafka.loadingMessages") }}
          </div>
          <div v-else-if="error" class="p-4 text-sm text-destructive">{{ error }}</div>
          <div v-else-if="filteredMessages.length === 0" class="flex h-full items-center justify-center text-sm text-muted-foreground">
            {{ messageSearchQuery.trim() ? t("kafka.messagesNoMatch") : t("kafka.empty") }}
          </div>
          <div v-else class="h-full overflow-auto py-1 text-sm">
            <button
              v-for="message in filteredMessages"
              :key="`${message.partition}-${message.offset}`"
              type="button"
              class="flex h-auto w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-accent"
              :class="{ 'bg-accent/70': selectedMessage?.partition === message.partition && selectedMessage?.offset === message.offset }"
              @click="selectMessage(message)"
            >
              <div class="flex items-center gap-2">
                <Badge variant="secondary" class="font-mono text-[10px]">p{{ message.partition }}</Badge>
                <Badge variant="outline" class="font-mono text-[10px]">@{{ message.offset }}</Badge>
                <span class="truncate text-xs text-muted-foreground">{{ formatTimestamp(message.timestamp) }}</span>
              </div>
              <div class="truncate text-xs text-muted-foreground">{{ t("kafka.keyLabel") }}: {{ payloadPreview(message.key) }}</div>
              <div class="truncate">{{ payloadPreview(message.value) }}</div>
            </button>
          </div>
        </div>
      </div>

      <div class="min-h-0 overflow-auto">
        <div v-if="!selectedMessage" class="flex h-full items-center justify-center text-sm text-muted-foreground">
          {{ t("kafka.selectMessage") }}
        </div>
        <div v-else class="flex min-h-full flex-col">
          <div class="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
            <div class="min-w-0">
              <div class="truncate font-medium">{{ topic }}</div>
              <div class="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                <Badge variant="secondary">{{ t("kafka.partitionN", { n: selectedMessage.partition }) }}</Badge>
                <Badge variant="outline">{{ t("kafka.offsetN", { n: selectedMessage.offset }) }}</Badge>
                <Badge variant="outline">{{ formatTimestamp(selectedMessage.timestamp) }}</Badge>
              </div>
            </div>
            <div class="flex w-56 items-center gap-2">
              <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <Input v-model="detailSearchQuery" class="h-8" :placeholder="t('kafka.detailSearchPlaceholder')" />
            </div>
          </div>
          <div class="space-y-4 p-4 text-sm">
            <div>
              <div class="mb-1 flex items-center justify-between gap-2">
                <span class="text-xs font-medium text-muted-foreground">{{ t("kafka.keyLabel") }}</span>
                <Select v-model="keyFormat">
                  <SelectTrigger class="h-7 w-28 text-xs">
                    <SelectValue :placeholder="t('kafka.formatMode')" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="option in KAFKA_PAYLOAD_FORMATS" :key="option.id" :value="option.id">
                      {{ option.label }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <pre
                class="dbx-editor-font-family m-0 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/20 p-3"
              ><template v-for="(segment, index) in highlightedKeySegments" :key="`key-${index}`"><mark v-if="segment.highlighted" class="rounded bg-yellow-300/70 px-0.5 text-inherit dark:bg-yellow-500/40">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></pre>
            </div>
            <div>
              <div class="mb-1 flex items-center justify-between gap-2">
                <span class="text-xs font-medium text-muted-foreground">{{ t("kafka.valueLabel") }}</span>
                <div class="flex items-center gap-2">
                  <Select v-model="valueFormat">
                    <SelectTrigger class="h-7 w-28 text-xs">
                      <SelectValue :placeholder="t('kafka.formatMode')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="option in KAFKA_PAYLOAD_FORMATS" :key="option.id" :value="option.id">
                        {{ option.label }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <Button v-if="hasSchemaRegistry && selectedMessage.value" size="sm" variant="outline" class="h-7 gap-1.5 px-2 text-xs" :disabled="decoding" @click="decodeSelectedValue">
                    <Loader2 v-if="decoding" class="h-3 w-3 animate-spin" />
                    <Sparkles v-else class="h-3 w-3" />
                    {{ t("kafka.decodeSchema") }}
                  </Button>
                </div>
              </div>
              <pre
                class="dbx-editor-font-family m-0 min-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/20 p-3"
              ><template v-for="(segment, index) in highlightedValueSegments" :key="`value-${index}`"><mark v-if="segment.highlighted" class="rounded bg-yellow-300/70 px-0.5 text-inherit dark:bg-yellow-500/40">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></pre>
              <div v-if="decodedValue" class="mt-3">
                <div class="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <span>{{ t("kafka.decodedValue") }}</span>
                  <Badge v-if="decodedValue.schemaType" variant="outline">{{ decodedValue.schemaType }}</Badge>
                  <Badge v-if="decodedValue.schemaId != null" variant="secondary">id {{ decodedValue.schemaId }}</Badge>
                </div>
                <div v-if="decodedValue.error" class="text-sm text-destructive">{{ decodedValue.error }}</div>
                <pre v-else class="dbx-editor-font-family m-0 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/20 p-3 text-xs">{{ decodedValue.presentation }}</pre>
              </div>
            </div>
            <div v-if="selectedMessage.headers.length > 0">
              <div class="mb-1 text-xs font-medium text-muted-foreground">{{ t("kafka.headersLabel") }}</div>
              <div class="space-y-1 rounded-md border bg-muted/20 p-3 font-mono text-xs">
                <div v-for="([name, value], index) in selectedMessage.headers" :key="`${name}-${index}`">{{ name }}: {{ value }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <Dialog v-model:open="showProduceDialog">
      <DialogContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ t("kafka.produceTitle") }}</DialogTitle>
        </DialogHeader>
        <div class="grid gap-3 py-2">
          <div class="grid grid-cols-4 items-center gap-3">
            <span class="text-right text-sm">{{ t("kafka.keyLabel") }}</span>
            <Input v-model="produceKey" class="col-span-3" :placeholder="t('kafka.keyOptional')" />
          </div>
          <div class="grid grid-cols-4 items-center gap-3">
            <span class="text-right text-sm">{{ t("kafka.partition") }}</span>
            <Select v-model="producePartition">
              <SelectTrigger class="col-span-3">
                <SelectValue :placeholder="t('kafka.partitionAuto')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{{ t("kafka.partitionAuto") }}</SelectItem>
                <SelectItem v-for="partition in partitions" :key="partition.partition" :value="String(partition.partition)">
                  {{ t("kafka.partitionN", { n: partition.partition }) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <textarea v-model="produceValue" class="min-h-52 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" :placeholder="t('kafka.valuePlaceholder')" spellcheck="false" />
          <div v-if="produceError" class="text-sm text-destructive">{{ produceError }}</div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showProduceDialog = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="producing" @click="produceMessage">
            <Loader2 v-if="producing" class="mr-2 h-4 w-4 animate-spin" />
            <Send v-else class="mr-2 h-4 w-4" />
            {{ t("kafka.produce") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

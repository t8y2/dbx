<script setup lang="ts">
import { formatError } from "@/lib/backend/errorUtils";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ConsumerInfo, ProducerInfo, SubscriptionInfo, TopicInfo, TopicRef, TopicStats, MqSystemKind } from "@/types/mq";
import { mqGetTopicStats, mqListConsumers, mqListProducers, mqListSubscriptions, mqUnloadTopic } from "@/lib/backend/api";
import RocketMqTopicSelect from "./shared/RocketMqTopicSelect.vue";

interface Props {
  connectionId: string;
  topic?: TopicInfo;
  tenant?: string;
  namespace?: string;
  readOnly?: boolean;
  selectedSubscription?: string;
  isFlatMqCluster?: boolean;
  mqSystemKind?: MqSystemKind;
  viewMode?: "all" | "producers" | "consumers";
}

const props = withDefaults(defineProps<Props>(), {
  viewMode: "all",
});
const emit = defineEmits<{
  topicSelected: [topic: TopicInfo | undefined];
}>();
const { t } = useI18n();

interface PartitionClientRow {
  name: string;
  shortName: string;
  msgRateIn: number;
  msgRateOut: number;
  producerCount: number;
  subscriptionCount: number;
  consumerCount: number;
  producers: ProducerInfo[];
  subscriptions: SubscriptionInfo[];
}

interface KafkaPartitionRow {
  partition: number;
  beginOffset: number;
  endOffset: number;
  messageCount: number;
  leader: number;
  replicas: number[];
  isr: number[];
}

const producers = ref<ProducerInfo[]>([]);
const subscriptions = ref<SubscriptionInfo[]>([]);
const stats = ref<TopicStats>();
const selectedSubscription = ref("");
const selectedPartitionName = ref("");
const loading = ref(false);
const unloading = ref(false);
const error = ref<string>();
const availableTopics = ref<TopicInfo[]>([]);
const topicsLoading = ref(false);
const selectedTopicName = ref("");
const topicSelectRef = ref<InstanceType<typeof RocketMqTopicSelect>>();
let loadedTopicsKey = "";
let syncingTopicFromProps = false;

const isRocketMqCluster = computed(() => props.mqSystemKind === "rocketmq");
const isProducersOnly = computed(() => props.viewMode === "producers");
const isConsumersOnly = computed(() => props.viewMode === "consumers");
const requiresTopicForRocketMq = computed(() => isRocketMqCluster.value && isProducersOnly.value);
const showConsumerSections = computed(() => !isProducersOnly.value);
const showProducerSections = computed(() => !isConsumersOnly.value);
const panelTitle = computed(() => {
  if (isProducersOnly.value) return t("mqAdmin.tabProducers");
  if (isConsumersOnly.value) return t("mqClients.activeConsumers");
  return t("mqClients.title");
});
const isClusterWideMode = computed(() => isRocketMqCluster.value && !props.topic && !!props.tenant && !!props.namespace && !requiresTopicForRocketMq.value);

let runtimeLoadSeq = 0;
let consumerLoadSeq = 0;
let scheduledRuntimeLoad: ReturnType<typeof setTimeout> | undefined;
let scheduledRuntimeLoadKey = "";

function buildTopicRefFromName(name: string): TopicRef | null {
  const topic = name.trim();
  if (!topic || !props.tenant || !props.namespace) return null;
  const matched = availableTopics.value.find((item) => item.shortName === topic);
  return {
    tenant: props.tenant,
    namespace: props.namespace,
    topic,
    persistent: matched?.persistent ?? true,
    partitioned: matched?.partitioned ?? false,
  };
}

const topicRef = computed<TopicRef | null>(() => {
  if (!props.tenant || !props.namespace) return null;
  if (requiresTopicForRocketMq.value) {
    return buildTopicRefFromName(selectedTopicName.value);
  }
  if (isClusterWideMode.value) {
    return {
      tenant: props.tenant,
      namespace: props.namespace,
      topic: "",
      persistent: true,
      partitioned: false,
    };
  }
  const topic = props.topic;
  if (!topic) return null;
  return {
    tenant: props.tenant,
    namespace: topic.namespace || props.namespace,
    topic: topic.shortName,
    persistent: topic.persistent,
    partitioned: topic.partitioned,
  };
});

function runtimeWatchKey(): string {
  if (requiresTopicForRocketMq.value) {
    return [props.connectionId, props.tenant, props.namespace, selectedTopicName.value.trim()].join("\0");
  }
  const current = topicRef.value;
  return [props.connectionId, props.tenant, props.namespace, props.mqSystemKind, current ? topicRefKey(current) : ""].join("\0");
}

function scheduleLoadRuntimeClients() {
  const key = runtimeWatchKey();
  if (scheduledRuntimeLoad && scheduledRuntimeLoadKey === key) return;
  scheduledRuntimeLoadKey = key;
  if (scheduledRuntimeLoad) clearTimeout(scheduledRuntimeLoad);
  scheduledRuntimeLoad = setTimeout(() => {
    scheduledRuntimeLoad = undefined;
    void loadRuntimeClients();
  }, 0);
}

async function loadTopics(force = false) {
  if (!requiresTopicForRocketMq.value || !props.tenant || !props.namespace) return;
  const key = [props.connectionId, props.tenant, props.namespace].join("\0");
  if (!force && (topicsLoading.value || (loadedTopicsKey === key && availableTopics.value.length > 0))) return;
  loadedTopicsKey = key;
  topicsLoading.value = true;
  try {
    await topicSelectRef.value?.loadTopics();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    topicsLoading.value = false;
  }
}

function handleTopicsLoaded(topics: TopicInfo[]) {
  availableTopics.value = topics;
  if (props.topic && !selectedTopicName.value) {
    selectedTopicName.value = props.topic.shortName;
  } else if (!selectedTopicName.value && topics.length === 1) {
    selectedTopicName.value = topics[0].shortName;
  }
  syncProducerTopicToParent(selectedTopicName.value);
}

function syncProducerTopicToParent(name: string) {
  if (!requiresTopicForRocketMq.value) return;
  if (!name) {
    emit("topicSelected", undefined);
    return;
  }
  const topic = availableTopics.value.find((item) => item.shortName === name) ?? (props.topic?.shortName === name ? props.topic : undefined);
  if (topic) {
    emit("topicSelected", topic);
    return;
  }
  emit("topicSelected", {
    name,
    shortName: name,
    persistent: true,
    partitioned: false,
  });
}

async function loadRocketMqProducers(current: TopicRef, loadSeq: number, currentKey: string) {
  producers.value = await mqListProducers(props.connectionId, current);
  if (!isRuntimeLoadCurrent(loadSeq, currentKey)) return;
  stats.value = undefined;
  subscriptions.value = [];
  selectedSubscription.value = "";
  selectedPartitionName.value = "";
}

const partitionRows = computed(() => extractPartitionClientRows(stats.value?.raw));
const kafkaPartitionRows = computed(() => extractKafkaPartitionRows(stats.value?.raw));
const isKafkaStats = computed(() => kafkaPartitionRows.value.length > 0);
const selectedPartition = computed(() => {
  if (!partitionRows.value.length) return undefined;
  return partitionRows.value.find((row) => row.name === selectedPartitionName.value) ?? partitionRows.value[0];
});
const subscriptionOptions = computed(() => mergeSubscriptionOptions(subscriptions.value, partitionRows.value));
const selectedPartitionSubscription = computed(() => selectedPartition.value?.subscriptions.find((sub) => sub.name === selectedSubscription.value));
const aggregateConsumers = computed(() => subscriptions.value.find((sub) => sub.name === selectedSubscription.value)?.consumers ?? []);
const displayedProducers = computed(() => selectedPartition.value?.producers ?? producers.value);
const displayedConsumers = computed(() => {
  if (selectedPartition.value) return selectedPartitionSubscription.value?.consumers ?? [];
  return aggregateConsumers.value;
});
const selectedScopeLabel = computed(() => selectedPartition.value?.shortName ?? t("mqClients.aggregateTopic"));

async function loadRuntimeClients() {
  const loadSeq = ++runtimeLoadSeq;
  consumerLoadSeq++;
  const current = topicRef.value;
  if (!current) {
    producers.value = [];
    subscriptions.value = [];
    stats.value = undefined;
    selectedSubscription.value = "";
    selectedPartitionName.value = "";
    loading.value = false;
    error.value = undefined;
    return;
  }
  const currentKey = activeTopicKey(current);

  loading.value = true;
  error.value = undefined;
  try {
    if (isClusterWideMode.value) {
      producers.value = await mqListProducers(props.connectionId, current);
      subscriptions.value = await mqListSubscriptions(props.connectionId, current);
      stats.value = undefined;
      selectedSubscription.value = props.selectedSubscription ?? subscriptions.value[0]?.name ?? "";
      selectedPartitionName.value = "";
      return;
    }

    if (requiresTopicForRocketMq.value) {
      await loadRocketMqProducers(current, loadSeq, currentKey);
      return;
    }

    const statsData = await mqGetTopicStats(props.connectionId, current);
    if (!isRuntimeLoadCurrent(loadSeq, currentKey)) return;
    stats.value = statsData;
    const parsedProducers = extractProducersFromStats(statsData.raw);
    producers.value = parsedProducers.length ? parsedProducers : await mqListProducers(props.connectionId, current);
    if (!isRuntimeLoadCurrent(loadSeq, currentKey)) return;
    const parsedSubscriptions = extractSubscriptionsFromStats(statsData.raw);
    const partitionSubscriptions = mergeSubscriptionOptions([], extractPartitionClientRows(statsData.raw));
    subscriptions.value = parsedSubscriptions.length || partitionSubscriptions.length ? mergeSubscriptionOptions(parsedSubscriptions, extractPartitionClientRows(statsData.raw)) : await mqListSubscriptions(props.connectionId, current);
    if (!isRuntimeLoadCurrent(loadSeq, currentKey)) return;
    const subscriptionChanged = syncSelectedSubscription();
    syncSelectedPartition();
    if (selectedSubscription.value && !subscriptionChanged && !hasConsumersForSelectedSubscription()) {
      await loadSelectedSubscriptionConsumers({ retryIfEmpty: true });
      if (!isRuntimeLoadCurrent(loadSeq, currentKey)) return;
      syncSelectedPartition();
    }
  } catch (e: unknown) {
    if (isRuntimeLoadCurrent(loadSeq, currentKey)) {
      error.value = formatError(e) || String(e);
    }
  } finally {
    if (loadSeq === runtimeLoadSeq) {
      loading.value = false;
    }
  }
}

async function unloadTopic() {
  const current = topicRef.value;
  if (!current || props.readOnly || unloading.value) return;
  if (!confirm(t("mqClients.confirmUnload"))) return;

  unloading.value = true;
  error.value = undefined;
  try {
    await mqUnloadTopic(props.connectionId, current);
    await loadRuntimeClients();
  } catch (e: unknown) {
    error.value = formatError(e) || String(e);
  } finally {
    unloading.value = false;
  }
}

function formatRate(value: number): string {
  return t("mqClients.rateValue", { value: value.toFixed(2) });
}

function formatBytes(value: number): string {
  if (!value) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(2)} ${units[index]}`;
}

function formatOptionalRate(value: number): string {
  return isKafkaStats.value ? "-" : formatRate(value);
}

function formatOptionalBytes(value: number): string {
  return isKafkaStats.value ? "-" : formatBytes(value);
}

function syncSelectedSubscription(): boolean {
  const previous = selectedSubscription.value;
  const options = subscriptionOptions.value;
  if (props.selectedSubscription && options.some((sub) => sub.name === props.selectedSubscription)) {
    selectedSubscription.value = props.selectedSubscription;
  } else if (!options.some((sub) => sub.name === selectedSubscription.value)) {
    selectedSubscription.value = options[0]?.name ?? "";
  }
  return previous !== selectedSubscription.value;
}

function syncSelectedPartition() {
  const rows = partitionRows.value;
  if (!rows.length) {
    selectedPartitionName.value = "";
    return;
  }
  const current = rows.find((row) => row.name === selectedPartitionName.value);
  if (current?.subscriptions.some((sub) => sub.name === selectedSubscription.value)) return;

  const withActiveConsumers = rows.find((row) => row.subscriptions.some((sub) => sub.name === selectedSubscription.value && sub.consumers.length > 0));
  const withSubscription = rows.find((row) => row.subscriptions.some((sub) => sub.name === selectedSubscription.value));
  selectedPartitionName.value = (withActiveConsumers ?? withSubscription ?? current ?? rows[0]).name;
}

function syncSelectedSubscriptionForPartition() {
  const partition = selectedPartition.value;
  if (!partition) return;
  if (selectedSubscription.value && partition.subscriptions.some((sub) => sub.name === selectedSubscription.value)) return;

  const active = partition.subscriptions.find((sub) => sub.consumers.length > 0);
  selectedSubscription.value = (active ?? partition.subscriptions[0])?.name ?? selectedSubscription.value;
}

interface LoadConsumersOptions {
  retryIfEmpty?: boolean;
}

async function loadSelectedSubscriptionConsumers(options: LoadConsumersOptions = {}): Promise<ConsumerInfo[]> {
  const current = topicRef.value;
  const subscriptionName = selectedSubscription.value;
  if (!current || !subscriptionName) return [];

  const loadSeq = ++consumerLoadSeq;
  const currentKey = activeTopicKey(current);
  let consumers = await mqListConsumers(props.connectionId, current, subscriptionName);
  if (!isConsumerLoadCurrent(loadSeq, currentKey, subscriptionName)) return [];
  applySubscriptionConsumers(subscriptionName, consumers);

  if (options.retryIfEmpty && consumers.length === 0) {
    await sleep(700);
    if (!isConsumerLoadCurrent(loadSeq, currentKey, subscriptionName)) return consumers;
    consumers = await mqListConsumers(props.connectionId, current, subscriptionName);
    if (!isConsumerLoadCurrent(loadSeq, currentKey, subscriptionName)) return [];
    applySubscriptionConsumers(subscriptionName, consumers);
  }

  return consumers;
}

function applySubscriptionConsumers(subscriptionName: string, consumers: ConsumerInfo[]) {
  subscriptions.value = subscriptions.value.map((sub) => (sub.name === subscriptionName ? { ...sub, consumers } : sub));
}

function hasConsumersForSelectedSubscription(): boolean {
  return subscriptions.value.some((sub) => sub.name === selectedSubscription.value && sub.consumers.length > 0);
}

function topicRefKey(topic: TopicRef): string {
  return [topic.tenant, topic.namespace, topic.topic, topic.persistent ? "1" : "0", topic.partitioned ? "1" : "0"].join("|");
}

function activeTopicKey(topic: TopicRef): string {
  if (requiresTopicForRocketMq.value) {
    return [topic.tenant, topic.namespace, topic.topic].join("|");
  }
  return topicRefKey(topic);
}

function isRuntimeLoadCurrent(loadSeq: number, topicKey: string): boolean {
  return loadSeq === runtimeLoadSeq && isCurrentTopic(topicKey);
}

function isConsumerLoadCurrent(loadSeq: number, topicKey: string, subscriptionName: string): boolean {
  return loadSeq === consumerLoadSeq && selectedSubscription.value === subscriptionName && isCurrentTopic(topicKey);
}

function isCurrentTopic(topicKey: string): boolean {
  const current = topicRef.value;
  return !!current && activeTopicKey(current) === topicKey;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractProducersFromStats(raw: unknown): ProducerInfo[] {
  const root = objectRecord(raw);
  const producers = arrayObjects(root.publishers).map(parseProducer);
  for (const partition of extractPartitionClientRows(raw)) {
    producers.push(...partition.producers);
  }
  return producers;
}

function extractSubscriptionsFromStats(raw: unknown): SubscriptionInfo[] {
  return Object.entries(objectRecord(objectRecord(raw).subscriptions)).map(([name, body]) => parseSubscription(name, body));
}

function extractPartitionClientRows(raw: unknown): PartitionClientRow[] {
  return Object.entries(objectRecord(objectRecord(raw).partitions)).map(([name, value]) => {
    const body = objectRecord(value);
    const partitionSubscriptions = Object.entries(objectRecord(body.subscriptions)).map(([subscriptionName, subscriptionBody]) => parseSubscription(subscriptionName, subscriptionBody));
    const partitionProducers = arrayObjects(body.publishers).map(parseProducer);
    return {
      name,
      shortName: partitionShortName(name),
      msgRateIn: numberField(body.msgRateIn) ?? 0,
      msgRateOut: numberField(body.msgRateOut) ?? 0,
      producerCount: partitionProducers.length,
      subscriptionCount: partitionSubscriptions.length,
      consumerCount: partitionSubscriptions.reduce((sum, sub) => sum + sub.consumers.length, 0),
      producers: partitionProducers,
      subscriptions: partitionSubscriptions,
    };
  });
}

function extractKafkaPartitionRows(raw: unknown): KafkaPartitionRow[] {
  return arrayObjects(objectRecord(raw).partitionStats)
    .map((body) => ({
      partition: numberField(body.partition) ?? 0,
      beginOffset: numberField(body.beginOffset) ?? 0,
      endOffset: numberField(body.endOffset) ?? 0,
      messageCount: numberField(body.messageCount) ?? 0,
      leader: numberField(body.leader) ?? -1,
      replicas: numberArrayField(body.replicas),
      isr: numberArrayField(body.isr),
    }))
    .sort((a, b) => a.partition - b.partition);
}

function mergeSubscriptionOptions(base: SubscriptionInfo[], partitions: PartitionClientRow[]): SubscriptionInfo[] {
  const byName = new Map<string, SubscriptionInfo>();
  for (const sub of base) {
    byName.set(sub.name, { ...sub, consumers: [...sub.consumers] });
  }
  for (const partition of partitions) {
    for (const sub of partition.subscriptions) {
      const existing = byName.get(sub.name);
      if (!existing) {
        byName.set(sub.name, { ...sub, consumers: [...sub.consumers] });
        continue;
      }
      existing.msgBacklog = Math.max(existing.msgBacklog, sub.msgBacklog);
      existing.msgRateOut = Math.max(existing.msgRateOut, sub.msgRateOut);
      existing.msgThroughputOut = Math.max(existing.msgThroughputOut, sub.msgThroughputOut);
      existing.consumers = [...existing.consumers, ...sub.consumers];
      if (!existing.subType && sub.subType) existing.subType = sub.subType;
    }
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function parseSubscription(name: string, value: unknown): SubscriptionInfo {
  const body = objectRecord(value);
  return {
    name,
    subType: stringField(body.type),
    msgBacklog: numberField(body.msgBacklog) ?? 0,
    msgRateOut: numberField(body.msgRateOut) ?? 0,
    msgThroughputOut: numberField(body.msgThroughputOut) ?? 0,
    consumers: arrayObjects(body.consumers).map(parseConsumer),
  };
}

function parseProducer(value: unknown): ProducerInfo {
  const body = objectRecord(value);
  return {
    producerId: numberField(body.producerId) ?? 0,
    producerName: stringField(body.producerName),
    msgRateIn: numberField(body.msgRateIn) ?? 0,
    msgThroughputIn: numberField(body.msgThroughputIn) ?? 0,
    address: stringField(body.address),
    clientVersion: stringField(body.clientVersion),
  };
}

function parseConsumer(value: unknown): ConsumerInfo {
  const body = objectRecord(value);
  return {
    consumerName: stringField(body.consumerName),
    msgRateOut: numberField(body.msgRateOut) ?? 0,
    msgThroughputOut: numberField(body.msgThroughputOut) ?? 0,
    availablePermits: numberField(body.availablePermits) ?? 0,
    address: stringField(body.address),
    clientVersion: stringField(body.clientVersion),
  };
}

function partitionShortName(name: string): string {
  const path = name.includes("://") ? name.split("://", 2)[1] || name : name;
  return path.split("/").slice(-1)[0] || name;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function numberArrayField(value: unknown): number[] {
  return Array.isArray(value) ? value.map(numberField).filter((item): item is number => item !== undefined) : [];
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

watch(
  runtimeWatchKey,
  () => {
    scheduleLoadRuntimeClients();
  },
  { immediate: true },
);

watch(
  () => props.topic?.shortName ?? "",
  (name) => {
    if (!requiresTopicForRocketMq.value) return;
    if (name === selectedTopicName.value) return;
    syncingTopicFromProps = true;
    selectedTopicName.value = name;
    syncingTopicFromProps = false;
  },
  { immediate: true },
);

watch(selectedTopicName, (name) => {
  if (syncingTopicFromProps) return;
  syncProducerTopicToParent(name);
});

watch(
  () => (requiresTopicForRocketMq.value ? [props.connectionId, props.tenant, props.namespace].join("\0") : ""),
  (key) => {
    if (!key) {
      loadedTopicsKey = "";
      return;
    }
    void loadTopics();
  },
  { immediate: true },
);

watch(selectedSubscription, () => {
  if (isProducersOnly.value) return;
  syncSelectedPartition();
  void loadSelectedSubscriptionConsumers({ retryIfEmpty: true }).catch((e: unknown) => {
    error.value = formatError(e) || String(e);
  });
});

watch(selectedPartitionName, () => {
  syncSelectedSubscriptionForPartition();
});

watch(
  () => props.selectedSubscription,
  (subscription) => {
    if (subscription && subscriptionOptions.value.some((sub) => sub.name === subscription)) {
      selectedSubscription.value = subscription;
    }
  },
);
</script>

<template>
  <div class="producer-consumer-panel">
    <div class="panel-toolbar">
      <h3>{{ panelTitle }}</h3>
      <div class="toolbar-actions">
        <button v-if="!isFlatMqCluster" class="btn-sm danger" :disabled="readOnly || !topicRef || unloading" @click="unloadTopic">
          {{ unloading ? t("mqClients.unloading") : t("mqClients.unloadTopic") }}
        </button>
        <button class="btn-secondary" :disabled="loading || !topicRef" @click="loadRuntimeClients">
          {{ loading ? t("mqClients.refreshing") : t("mqClients.refresh") }}
        </button>
      </div>
    </div>

    <div v-if="requiresTopicForRocketMq" class="topic-picker">
      <label>{{ t("mqMessages.targetTopic") }}</label>
      <RocketMqTopicSelect ref="topicSelectRef" v-model="selectedTopicName" :connection-id="connectionId" :tenant="tenant" :namespace="namespace" grouping="business" :show-type-filter="false" :disabled="topicsLoading" @loaded="handleTopicsLoaded" />
    </div>

    <div v-if="!topicRef && !isClusterWideMode && !requiresTopicForRocketMq" class="panel-placeholder">
      {{ t("mqClients.selectTopicFirst") }}
    </div>
    <template v-else-if="topicRef || isClusterWideMode">
      <div v-if="isClusterWideMode" class="panel-hint">{{ t("mqClients.rocketmqClusterHint") }}</div>
      <div v-if="error" class="panel-error">{{ error }}</div>

      <div v-if="!error" class="runtime-content">
        <section v-if="isKafkaStats" class="runtime-section">
          <div class="section-heading">
            <h4>{{ t("mqClients.kafkaPartitionStatus") }}</h4>
            <span>{{ t("mqClients.partitionCount", { count: kafkaPartitionRows.length }) }}</span>
          </div>
          <table class="runtime-table partition-table">
            <thead>
              <tr>
                <th>{{ t("mqClients.partition") }}</th>
                <th>{{ t("mqClients.beginOffset") }}</th>
                <th>{{ t("mqClients.latestOffset") }}</th>
                <th>{{ t("mqClients.messageCount") }}</th>
                <th>{{ t("mqClients.leader") }}</th>
                <th>{{ t("mqClients.replicas") }}</th>
                <th>{{ t("mqClients.isr") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="partition in kafkaPartitionRows" :key="partition.partition">
                <td>{{ partition.partition }}</td>
                <td>{{ partition.beginOffset }}</td>
                <td>{{ partition.endOffset }}</td>
                <td>{{ partition.messageCount }}</td>
                <td>{{ partition.leader }}</td>
                <td>{{ partition.replicas.join(", ") || "-" }}</td>
                <td>{{ partition.isr.join(", ") || "-" }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-else-if="partitionRows.length" class="runtime-section">
          <div class="section-heading">
            <h4>{{ t("mqClients.partitionClients") }}</h4>
            <span>{{ t("mqClients.partitionCount", { count: partitionRows.length }) }}</span>
          </div>
          <table class="runtime-table partition-table">
            <thead>
              <tr>
                <th>{{ t("mqClients.partition") }}</th>
                <th>{{ t("mqClients.inboundRate") }}</th>
                <th>{{ t("mqClients.outboundRate") }}</th>
                <th>{{ t("mqClients.producers") }}</th>
                <th>{{ t("mqClients.subscriptions") }}</th>
                <th>{{ t("mqClients.consumers") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="partition in partitionRows" :key="partition.name" :class="{ selected: selectedPartition?.name === partition.name }" @click="selectedPartitionName = partition.name">
                <td :title="partition.name">{{ partition.shortName }}</td>
                <td>{{ formatRate(partition.msgRateIn) }}</td>
                <td>{{ formatRate(partition.msgRateOut) }}</td>
                <td>{{ partition.producerCount }}</td>
                <td>{{ partition.subscriptionCount }}</td>
                <td>{{ partition.consumerCount }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="showProducerSections" class="runtime-section">
          <div class="section-heading">
            <h4>{{ t("mqClients.activeProducers") }}</h4>
            <div class="heading-meta">
              <span v-if="selectedPartition" class="scope-chip">{{ selectedScopeLabel }}</span>
              <span>{{ displayedProducers.length }}</span>
            </div>
          </div>
          <div v-if="!displayedProducers.length && !loading" class="empty-state">{{ t("mqClients.noActiveProducers") }}</div>
          <table v-else class="runtime-table">
            <thead>
              <tr>
                <th>{{ t("mqClients.name") }}</th>
                <th>{{ t("mqClients.id") }}</th>
                <th>{{ t("mqClients.address") }}</th>
                <th>{{ t("mqClients.version") }}</th>
                <th>{{ t("mqClients.rate") }}</th>
                <th>{{ t("mqClients.throughput") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="producer in displayedProducers" :key="`${selectedScopeLabel}-${producer.producerId}-${producer.producerName}`">
                <td>{{ producer.producerName || "-" }}</td>
                <td>{{ producer.producerId }}</td>
                <td>{{ producer.address || "-" }}</td>
                <td>{{ producer.clientVersion || "-" }}</td>
                <td>{{ formatOptionalRate(producer.msgRateIn) }}</td>
                <td>{{ formatOptionalBytes(producer.msgThroughputIn) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section v-if="showConsumerSections" class="runtime-section">
          <div class="section-heading">
            <h4>{{ t("mqClients.activeConsumers") }}</h4>
            <div class="subscription-selector">
              <span v-if="selectedPartition" class="scope-chip">{{ selectedScopeLabel }}</span>
              <span>{{ displayedConsumers.length }}</span>
              <select v-if="!isKafkaStats && partitionRows.length" v-model="selectedPartitionName" :disabled="loading">
                <option v-for="partition in partitionRows" :key="partition.name" :value="partition.name">{{ partition.shortName }}</option>
              </select>
              <select v-model="selectedSubscription" :disabled="loading || !subscriptionOptions.length">
                <option v-for="sub in subscriptionOptions" :key="sub.name" :value="sub.name">{{ sub.name }}</option>
              </select>
            </div>
          </div>
          <div v-if="!subscriptionOptions.length && !loading" class="empty-state">{{ t("mqClients.noSubscriptions") }}</div>
          <div v-else-if="!displayedConsumers.length && !loading" class="empty-state">
            {{ selectedPartition ? t("mqClients.noConsumersOnPartition") : t("mqClients.noConsumersOnSubscription") }}
          </div>
          <table v-else class="runtime-table">
            <thead>
              <tr>
                <th>{{ t("mqClients.name") }}</th>
                <th>{{ t("mqClients.address") }}</th>
                <th>{{ t("mqClients.version") }}</th>
                <th>{{ t("mqClients.rate") }}</th>
                <th>{{ t("mqClients.throughput") }}</th>
                <th>{{ t("mqClients.permits") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="consumer in displayedConsumers" :key="`${selectedScopeLabel}-${selectedSubscription}-${consumer.consumerName}-${consumer.address}`">
                <td>{{ consumer.consumerName || "-" }}</td>
                <td>{{ consumer.address || "-" }}</td>
                <td>{{ consumer.clientVersion || "-" }}</td>
                <td>{{ formatOptionalRate(consumer.msgRateOut) }}</td>
                <td>{{ formatOptionalBytes(consumer.msgThroughputOut) }}</td>
                <td>{{ consumer.availablePermits }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.producer-consumer-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.panel-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
}

.panel-toolbar h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.panel-hint {
  padding: 10px 16px;
  font-size: 13px;
  color: var(--color-text-secondary);
  border-bottom: 1px solid var(--color-border-light);
  background: var(--color-background-secondary);
}

.topic-picker {
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border-light);
  background: var(--color-background-secondary);
}

.topic-picker label {
  display: block;
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 500;
}

.topic-select-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.topic-select-row select {
  min-width: 240px;
  max-width: 420px;
  flex: 1;
  height: 32px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  background: var(--color-background);
  color: var(--color-text);
  font-size: 13px;
  padding: 0 10px;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-secondary {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;
}

.btn-secondary:hover:not(:disabled) {
  background: var(--color-hover);
}

.btn-sm {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;
}

.btn-sm:hover:not(:disabled) {
  background: var(--color-hover);
}

.btn-sm.danger {
  border-color: var(--color-error);
  color: var(--color-error);
}

.btn-sm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.runtime-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.runtime-section {
  margin-bottom: 24px;
}

.section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.section-heading h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.section-heading span {
  color: var(--color-text-tertiary);
  font-size: 13px;
}

.heading-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.scope-chip {
  max-width: 260px;
  display: inline-flex;
  align-items: center;
  min-height: 24px;
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  background: var(--color-background-secondary);
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subscription-selector {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.subscription-selector select {
  min-width: 180px;
  max-width: 320px;
  height: 30px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  background: var(--color-background);
  color: var(--color-text);
  font-size: 13px;
}

.runtime-table {
  width: 100%;
  border-collapse: collapse;
  border: 1px solid var(--color-border);
  font-size: 13px;
}

.runtime-table th,
.runtime-table td {
  padding: 9px 10px;
  border-bottom: 1px solid var(--color-border);
  text-align: left;
  vertical-align: top;
}

.runtime-table th {
  background: var(--color-background-secondary);
  color: var(--color-text-secondary);
  font-weight: 600;
}

.runtime-table td {
  color: var(--color-text);
  word-break: break-word;
}

.partition-table tbody tr {
  cursor: pointer;
}

.partition-table tbody tr:hover,
.partition-table tbody tr.selected {
  background: var(--color-hover);
}

.partition-table tbody tr.selected td:first-child {
  color: var(--color-primary);
  font-weight: 600;
}

.empty-state,
.panel-placeholder,
.panel-error {
  padding: 24px;
  text-align: center;
  color: var(--color-text-secondary);
}

.panel-error {
  color: var(--color-error);
}
</style>

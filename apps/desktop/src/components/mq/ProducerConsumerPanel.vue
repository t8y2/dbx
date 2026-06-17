<script setup lang="ts">
import { formatError } from "@/lib/errorUtils";
import { computed, ref, watch } from "vue";
import type { ConsumerInfo, ProducerInfo, SubscriptionInfo, TopicInfo, TopicRef, TopicStats } from "@/types/mq";
import { mqGetTopicStats, mqListSubscriptions, mqUnloadTopic } from "@/lib/api";

interface Props {
  connectionId: string;
  topic?: TopicInfo;
  tenant?: string;
  namespace?: string;
  readOnly?: boolean;
  selectedSubscription?: string;
}

const props = defineProps<Props>();

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

const producers = ref<ProducerInfo[]>([]);
const subscriptions = ref<SubscriptionInfo[]>([]);
const stats = ref<TopicStats>();
const selectedSubscription = ref("");
const selectedPartitionName = ref("");
const loading = ref(false);
const unloading = ref(false);
const error = ref<string>();

const topicRef = computed<TopicRef | null>(() => {
  if (!props.topic || !props.tenant || !props.namespace) return null;
  return {
    tenant: props.tenant,
    namespace: props.namespace,
    topic: props.topic.shortName,
    persistent: props.topic.persistent,
    partitioned: props.topic.partitioned,
  };
});

const partitionRows = computed(() => extractPartitionClientRows(stats.value?.raw));
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
const selectedScopeLabel = computed(() => selectedPartition.value?.shortName ?? "聚合 topic");

async function loadRuntimeClients() {
  const current = topicRef.value;
  if (!current) {
    producers.value = [];
    subscriptions.value = [];
    stats.value = undefined;
    selectedSubscription.value = "";
    selectedPartitionName.value = "";
    return;
  }

  loading.value = true;
  error.value = undefined;
  try {
    const statsData = await mqGetTopicStats(props.connectionId, current);
    stats.value = statsData;
    producers.value = extractProducersFromStats(statsData.raw);
    const parsedSubscriptions = extractSubscriptionsFromStats(statsData.raw);
    const partitionSubscriptions = mergeSubscriptionOptions([], extractPartitionClientRows(statsData.raw));
    subscriptions.value = parsedSubscriptions.length || partitionSubscriptions.length ? mergeSubscriptionOptions(parsedSubscriptions, extractPartitionClientRows(statsData.raw)) : await mqListSubscriptions(props.connectionId, current);
    syncSelectedSubscription();
    syncSelectedPartition();
  } catch (e: unknown) {
    error.value = formatError(e) || String(e);
  } finally {
    loading.value = false;
  }
}

async function unloadTopic() {
  const current = topicRef.value;
  if (!current || props.readOnly || unloading.value) return;
  if (!confirm("确认 unload 当前 topic？活跃生产者和消费者会重新连接。")) return;

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
  return `${value.toFixed(2)} msg/s`;
}

function formatBytes(value: number): string {
  if (!value) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s", "TB/s"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(2)} ${units[index]}`;
}

function syncSelectedSubscription() {
  const options = subscriptionOptions.value;
  if (props.selectedSubscription && options.some((sub) => sub.name === props.selectedSubscription)) {
    selectedSubscription.value = props.selectedSubscription;
  } else if (!options.some((sub) => sub.name === selectedSubscription.value)) {
    selectedSubscription.value = options[0]?.name ?? "";
  }
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

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

watch(
  () => [props.connectionId, props.topic?.name, props.topic?.partitioned, props.tenant, props.namespace],
  () => {
    void loadRuntimeClients();
  },
  { immediate: true },
);

watch(selectedSubscription, () => {
  syncSelectedPartition();
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
      <h3>生产者 / 消费者</h3>
      <div class="toolbar-actions">
        <button class="btn-sm danger" :disabled="readOnly || !topic || unloading" @click="unloadTopic">
          {{ unloading ? "卸载中..." : "Unload topic" }}
        </button>
        <button class="btn-sm" :disabled="loading || !topic" @click="loadRuntimeClients">
          {{ loading ? "刷新中..." : "刷新" }}
        </button>
      </div>
    </div>

    <div v-if="!topic" class="panel-placeholder">请先选择一个 topic</div>
    <div v-else-if="error" class="panel-error">{{ error }}</div>

    <div v-else class="runtime-content">
      <section v-if="partitionRows.length" class="runtime-section">
        <div class="section-heading">
          <h4>分区客户端</h4>
          <span>{{ partitionRows.length }} 个分区</span>
        </div>
        <table class="runtime-table partition-table">
          <thead>
            <tr>
              <th>分区</th>
              <th>入站速率</th>
              <th>出站速率</th>
              <th>生产者</th>
              <th>订阅</th>
              <th>消费者</th>
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

      <section class="runtime-section">
        <div class="section-heading">
          <h4>活跃生产者</h4>
          <div class="heading-meta">
            <span v-if="selectedPartition" class="scope-chip">{{ selectedScopeLabel }}</span>
            <span>{{ displayedProducers.length }}</span>
          </div>
        </div>
        <div v-if="!displayedProducers.length && !loading" class="empty-state">当前没有活跃生产者</div>
        <table v-else class="runtime-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>ID</th>
              <th>地址</th>
              <th>版本</th>
              <th>速率</th>
              <th>吞吐</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="producer in displayedProducers" :key="`${selectedScopeLabel}-${producer.producerId}-${producer.producerName}`">
              <td>{{ producer.producerName || "-" }}</td>
              <td>{{ producer.producerId }}</td>
              <td>{{ producer.address || "-" }}</td>
              <td>{{ producer.clientVersion || "-" }}</td>
              <td>{{ formatRate(producer.msgRateIn) }}</td>
              <td>{{ formatBytes(producer.msgThroughputIn) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="runtime-section">
        <div class="section-heading">
          <h4>活跃消费者</h4>
          <div class="subscription-selector">
            <span v-if="selectedPartition" class="scope-chip">{{ selectedScopeLabel }}</span>
            <span>{{ displayedConsumers.length }}</span>
            <select v-if="partitionRows.length" v-model="selectedPartitionName" :disabled="loading">
              <option v-for="partition in partitionRows" :key="partition.name" :value="partition.name">{{ partition.shortName }}</option>
            </select>
            <select v-model="selectedSubscription" :disabled="loading || !subscriptionOptions.length">
              <option v-for="sub in subscriptionOptions" :key="sub.name" :value="sub.name">{{ sub.name }}</option>
            </select>
          </div>
        </div>
        <div v-if="!subscriptionOptions.length && !loading" class="empty-state">当前 topic 没有订阅</div>
        <div v-else-if="!displayedConsumers.length && !loading" class="empty-state">
          {{ selectedPartition ? "当前分区订阅没有活跃消费者" : "当前订阅没有活跃消费者" }}
        </div>
        <table v-else class="runtime-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>地址</th>
              <th>版本</th>
              <th>速率</th>
              <th>吞吐</th>
              <th>Permits</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="consumer in displayedConsumers" :key="`${selectedScopeLabel}-${selectedSubscription}-${consumer.consumerName}-${consumer.address}`">
              <td>{{ consumer.consumerName || "-" }}</td>
              <td>{{ consumer.address || "-" }}</td>
              <td>{{ consumer.clientVersion || "-" }}</td>
              <td>{{ formatRate(consumer.msgRateOut) }}</td>
              <td>{{ formatBytes(consumer.msgThroughputOut) }}</td>
              <td>{{ consumer.availablePermits }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
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

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-sm {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
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
  border-radius: 4px;
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
  border-radius: 4px;
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

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { TopicInfo, TopicRef, TopicStats } from "@/types/mq";
import { mqGetTopicStats } from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import { extractKafkaPartitionRows } from "@/lib/mq/kafkaTopicStats";
import RocketMqTopicSelect from "./shared/RocketMqTopicSelect.vue";
import MessageBrowser from "./MessageBrowser.vue";
import SendMessagePanel from "./SendMessagePanel.vue";

interface Props {
  connectionId: string;
  tenant?: string;
  namespace?: string;
  topic?: TopicInfo;
  readOnly?: boolean;
  canSendMessage?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  topicSelected: [topic: TopicInfo | undefined];
}>();
const { t } = useI18n();

const topicSelectRef = ref<InstanceType<typeof RocketMqTopicSelect>>();
const topics = ref<TopicInfo[]>([]);
const topicName = ref(props.topic?.shortName ?? "");
const stats = ref<TopicStats>();
const statsLoading = ref(false);
const statsError = ref<string>();
let statsRequestVersion = 0;

const selectedTopic = computed(() => topics.value.find((item) => item.shortName === topicName.value));
const selectedTopicRef = computed<TopicRef | null>(() => {
  const name = topicName.value.trim();
  if (!name || !props.tenant || !props.namespace) return null;
  return {
    tenant: props.tenant,
    namespace: props.namespace,
    topic: name,
    persistent: selectedTopic.value?.persistent ?? true,
    partitioned: selectedTopic.value?.partitioned,
  };
});
const partitionRows = computed(() => extractKafkaPartitionRows(stats.value?.raw));

function handleTopicsLoaded(loaded: TopicInfo[]) {
  topics.value = loaded;
  if (topicName.value && loaded.some((item) => item.shortName === topicName.value)) {
    return;
  }
  if (props.topic && loaded.some((item) => item.shortName === props.topic?.shortName)) {
    topicName.value = props.topic.shortName;
  } else if (loaded.length === 1) {
    topicName.value = loaded[0].shortName;
  } else {
    topicName.value = "";
  }
}

async function loadStats() {
  const topic = selectedTopicRef.value;
  const requestVersion = ++statsRequestVersion;
  stats.value = undefined;
  statsError.value = undefined;
  if (!topic) return;
  statsLoading.value = true;
  try {
    const result = await mqGetTopicStats(props.connectionId, topic);
    if (requestVersion === statsRequestVersion) stats.value = result;
  } catch (cause: unknown) {
    if (requestVersion === statsRequestVersion) statsError.value = formatError(cause);
  } finally {
    if (requestVersion === statsRequestVersion) statsLoading.value = false;
  }
}

watch([() => props.connectionId, () => props.tenant, () => props.namespace, topicName], () => void loadStats(), { immediate: true });
watch([() => props.connectionId, () => props.tenant, () => props.namespace], () => {
  topics.value = [];
  topicName.value = props.topic?.shortName ?? "";
});
watch(
  () => props.topic?.shortName,
  (name) => {
    if (name) topicName.value = name;
  },
);
watch(selectedTopic, (topic) => emit("topicSelected", topic));
</script>

<template>
  <div class="kafka-messages-panel">
    <div class="panel-toolbar">
      <h3>{{ t("mqMessages.queryTitle") }}</h3>
      <button type="button" class="btn-secondary" :disabled="!tenant || !namespace" @click="topicSelectRef?.loadTopics()">
        {{ t("mqMessages.refreshTopicList") }}
      </button>
    </div>

    <div v-if="!tenant || !namespace" class="panel-placeholder">{{ t("mqMessages.selectNamespaceOrTopicFirst") }}</div>
    <div v-else class="kafka-messages-content">
      <section class="kafka-topic-section">
        <label>
          <span>{{ t("mqMessages.queryTopicLabel") }}</span>
          <RocketMqTopicSelect ref="topicSelectRef" v-model="topicName" :connection-id="connectionId" :tenant="tenant" :namespace="namespace" :show-type-filter="false" show-hint @loaded="handleTopicsLoaded" />
        </label>
      </section>

      <section v-if="selectedTopicRef" class="partition-overview" data-testid="kafka-partition-overview">
        <div class="section-heading">
          <h4>{{ t("mqMonitoring.kafkaPartitionDetails") }}</h4>
          <button type="button" class="btn-sm" :disabled="statsLoading" @click="loadStats">{{ t("common.refresh") }}</button>
        </div>
        <div v-if="statsError" class="panel-error">{{ statsError }}</div>
        <div v-else-if="statsLoading" class="section-empty">{{ t("common.loading") }}</div>
        <div v-else-if="!partitionRows.length" class="section-empty">{{ t("mqMonitoring.noKafkaPartitionMetrics") }}</div>
        <div v-else class="partition-table-wrap">
          <table class="partition-table">
            <thead>
              <tr>
                <th>{{ t("mqMonitoring.tablePartition") }}</th>
                <th>{{ t("mqMonitoring.tableBeginOffset") }}</th>
                <th>{{ t("mqMonitoring.tableLogEndOffset") }}</th>
                <th>{{ t("mqMonitoring.tableMessageCount") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in partitionRows" :key="row.partition">
                <td>{{ row.partition }}</td>
                <td>{{ row.beginOffset.toLocaleString() }}</td>
                <td>{{ row.endOffset.toLocaleString() }}</td>
                <td>{{ row.messageCount.toLocaleString() }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <MessageBrowser :connection-id="connectionId" :topic="selectedTopicRef" mq-system-kind="kafka" />
      <SendMessagePanel v-if="canSendMessage && selectedTopic" :connection-id="connectionId" :tenant="tenant" :namespace="namespace" :topic="selectedTopic" :read-only="readOnly" mq-system-kind="kafka" is-flat-mq-cluster :supports-peek-messages="false" fixed-topic embedded />
    </div>
  </div>
</template>

<style scoped>
@import "./shared/mqPanel.css";

.kafka-messages-panel,
.kafka-messages-content {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.kafka-messages-panel {
  padding: 16px;
}

.kafka-topic-section,
.partition-overview {
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background-secondary);
}

.kafka-topic-section label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 500;
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
}

.partition-table-wrap {
  overflow: auto;
}

.partition-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.partition-table th,
.partition-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--color-border);
  text-align: left;
}

.partition-table th {
  color: var(--color-text-secondary);
  font-weight: 600;
}

.section-empty {
  padding: 14px;
  color: var(--color-text-tertiary);
  text-align: center;
  font-size: 13px;
}
</style>

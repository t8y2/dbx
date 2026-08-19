<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { formatError } from "@/lib/backend/errorUtils";
import { mqGetKafkaConsumerGroupSnapshot } from "@/lib/backend/api";
import type { KafkaConsumerGroupSummary } from "@/types/mq";
import MqPanelToolbar from "./shared/MqPanelToolbar.vue";
import MqSearchInput from "./shared/MqSearchInput.vue";

interface Props {
  connectionId: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  navigateSubscriptions: [topic: string];
}>();
const { t } = useI18n();

const groups = ref<KafkaConsumerGroupSummary[]>([]);
const selectedGroupId = ref<string>();
const searchKeyword = ref("");
const loading = ref(false);
const error = ref<string>();
let loadSequence = 0;

const sortedGroups = computed(() => {
  return [...groups.value].sort((left, right) => {
    if (left.lagAvailable !== right.lagAvailable) return left.lagAvailable ? -1 : 1;
    if (left.lagAvailable && right.lagAvailable && left.totalLag !== right.totalLag) {
      return (right.totalLag ?? 0) - (left.totalLag ?? 0);
    }
    return left.groupId.localeCompare(right.groupId);
  });
});

const filteredGroups = computed(() => {
  const keyword = searchKeyword.value.trim().toLowerCase();
  if (!keyword) return sortedGroups.value;
  return sortedGroups.value.filter((group) => {
    return group.groupId.toLowerCase().includes(keyword) || group.topics.some((topic) => topic.toLowerCase().includes(keyword));
  });
});

const selectedGroup = computed(() => groups.value.find((group) => group.groupId === selectedGroupId.value));

watch(filteredGroups, (nextGroups) => {
  if (!nextGroups.length || nextGroups.some((group) => group.groupId === selectedGroupId.value)) return;
  selectedGroupId.value = nextGroups[0].groupId;
});

function syncSelection(nextGroups: KafkaConsumerGroupSummary[]) {
  const currentId = selectedGroupId.value;
  if (currentId && nextGroups.some((group) => group.groupId === currentId)) return;
  selectedGroupId.value = [...nextGroups].sort((left, right) => {
    if (left.lagAvailable !== right.lagAvailable) return left.lagAvailable ? -1 : 1;
    return (right.totalLag ?? 0) - (left.totalLag ?? 0) || left.groupId.localeCompare(right.groupId);
  })[0]?.groupId;
}

async function loadGroups() {
  const sequence = ++loadSequence;
  loading.value = true;
  error.value = undefined;
  try {
    const snapshot = await mqGetKafkaConsumerGroupSnapshot(props.connectionId);
    if (sequence !== loadSequence) return;
    groups.value = snapshot.groups;
    syncSelection(snapshot.groups);
  } catch (e: unknown) {
    if (sequence === loadSequence) error.value = formatError(e);
  } finally {
    if (sequence === loadSequence) loading.value = false;
  }
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "-" : value.toLocaleString();
}

function openTopicSubscriptions(topic: string) {
  emit("navigateSubscriptions", topic);
}

watch(
  () => props.connectionId,
  () => {
    groups.value = [];
    selectedGroupId.value = undefined;
    searchKeyword.value = "";
    void loadGroups();
  },
  { immediate: true },
);
</script>

<template>
  <div class="kafka-consumer-groups-panel">
    <MqPanelToolbar :title="t('mqKafkaConsumerGroups.title')">
      <template #left-extra>
        <MqSearchInput v-model="searchKeyword" :placeholder="t('mqKafkaConsumerGroups.searchPlaceholder')" :disabled="loading && !groups.length" />
        <span v-if="groups.length" class="mq-result-count" data-testid="kafka-consumer-group-count">{{ filteredGroups.length }} / {{ groups.length }}</span>
      </template>
      <template #actions>
        <button class="mq-btn-secondary" :disabled="loading" @click="loadGroups">
          {{ loading ? t("mqKafkaConsumerGroups.refreshing") : t("mqKafkaConsumerGroups.refresh") }}
        </button>
      </template>
    </MqPanelToolbar>

    <div v-if="error" class="panel-error" role="alert">{{ error }}</div>
    <div v-else-if="loading && !groups.length" class="panel-placeholder">{{ t("mqKafkaConsumerGroups.loading") }}</div>
    <div v-else-if="!groups.length" class="panel-placeholder">{{ t("mqKafkaConsumerGroups.empty") }}</div>
    <div v-else-if="!filteredGroups.length" class="panel-placeholder">{{ t("mqKafkaConsumerGroups.noMatches") }}</div>

    <div v-else class="consumer-groups-content">
      <div class="groups-table-wrap">
        <table data-testid="kafka-consumer-groups-table">
          <thead>
            <tr>
              <th>{{ t("mqKafkaConsumerGroups.groupId") }}</th>
              <th>{{ t("mqKafkaConsumerGroups.state") }}</th>
              <th>{{ t("mqKafkaConsumerGroups.members") }}</th>
              <th>{{ t("mqKafkaConsumerGroups.topics") }}</th>
              <th class="number-cell">{{ t("mqKafkaConsumerGroups.totalLag") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="group in filteredGroups" :key="group.groupId" :class="{ selected: group.groupId === selectedGroupId }" :data-group-id="group.groupId" @click="selectedGroupId = group.groupId">
              <td class="group-id-cell">
                <span>{{ group.groupId }}</span>
                <span v-if="group.error" class="partial-warning" :title="group.error" :aria-label="t('mqKafkaConsumerGroups.partialData')">!</span>
              </td>
              <td>
                <span class="state-badge">{{ group.state || "UNKNOWN" }}</span>
              </td>
              <td>{{ formatNumber(group.memberCount) }}</td>
              <td class="topics-cell" :title="group.topics.join(', ')">{{ group.topics.length ? group.topics.join(", ") : "-" }}</td>
              <td class="number-cell" :class="{ 'lag-positive': group.lagAvailable && (group.totalLag ?? 0) > 0 }">
                {{ group.lagAvailable ? formatNumber(group.totalLag) : "-" }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <section v-if="selectedGroup" class="group-detail" data-testid="kafka-consumer-group-detail">
        <div class="detail-header">
          <div>
            <h4>{{ selectedGroup.groupId }}</h4>
            <p>{{ t("mqKafkaConsumerGroups.partitionDetail") }}</p>
          </div>
          <span v-if="selectedGroup.error" class="detail-warning" :title="selectedGroup.error">{{ t("mqKafkaConsumerGroups.partialData") }}</span>
        </div>

        <div v-if="!selectedGroup.partitions.length" class="detail-empty">{{ t("mqKafkaConsumerGroups.noCommittedOffsets") }}</div>
        <div v-else class="partition-table-wrap">
          <table>
            <thead>
              <tr>
                <th>{{ t("mqKafkaConsumerGroups.topic") }}</th>
                <th class="number-cell">{{ t("mqKafkaConsumerGroups.partition") }}</th>
                <th class="number-cell">{{ t("mqKafkaConsumerGroups.committedOffset") }}</th>
                <th class="number-cell">{{ t("mqKafkaConsumerGroups.logEndOffset") }}</th>
                <th class="number-cell">{{ t("mqKafkaConsumerGroups.lag") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="partition in selectedGroup.partitions" :key="`${partition.topic}:${partition.partition}`">
                <td>
                  <button
                    type="button"
                    class="topic-link"
                    :data-topic="partition.topic"
                    :title="t('mqKafkaConsumerGroups.openTopicSubscriptions', { topic: partition.topic })"
                    :aria-label="t('mqKafkaConsumerGroups.openTopicSubscriptions', { topic: partition.topic })"
                    @click="openTopicSubscriptions(partition.topic)"
                  >
                    {{ partition.topic }}
                  </button>
                </td>
                <td class="number-cell">{{ partition.partition }}</td>
                <td class="number-cell">{{ formatNumber(partition.currentOffset) }}</td>
                <td class="number-cell">{{ formatNumber(partition.endOffset) }}</td>
                <td class="number-cell" :class="{ 'lag-positive': (partition.lag ?? 0) > 0 }">{{ formatNumber(partition.lag) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
@import "./shared/mqPanel.css";

.kafka-consumer-groups-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.panel-placeholder,
.panel-error {
  padding: 24px;
  text-align: center;
  color: var(--color-text-secondary);
}

.panel-error {
  color: var(--color-error);
}

.consumer-groups-content {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-rows: minmax(180px, 46%) minmax(180px, 1fr);
}

.groups-table-wrap,
.partition-table-wrap {
  min-height: 0;
  overflow: auto;
}

.groups-table-wrap {
  border-bottom: 1px solid var(--color-border);
}

table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

thead {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--color-background-secondary);
}

th,
td {
  padding: 9px 12px;
  border-bottom: 1px solid var(--color-border-light, var(--color-border));
  text-align: left;
  font-size: 13px;
}

th {
  color: var(--color-text-secondary);
  font-weight: 600;
}

.groups-table-wrap tbody tr {
  cursor: pointer;
}

.groups-table-wrap tbody tr:hover {
  background: var(--color-hover);
}

.groups-table-wrap tbody tr.selected {
  background: var(--color-primary-alpha);
}

.group-id-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-weight: 500;
}

.group-id-cell > span:first-child,
.topics-cell {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state-badge {
  display: inline-block;
  padding: 2px 7px;
  border-radius: var(--dbx-radius-fixed-4);
  background: var(--color-background-secondary);
  color: var(--color-text-secondary);
  font-size: 11px;
}

.partial-warning {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  border-radius: 50%;
  background: var(--color-warning);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
}

.number-cell {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.lag-positive {
  color: var(--color-warning);
  font-weight: 600;
}

.group-detail {
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border);
}

.detail-header h4,
.detail-header p {
  margin: 0;
}

.detail-header h4 {
  font-size: 14px;
}

.detail-header p {
  margin-top: 2px;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.detail-warning {
  color: var(--color-warning);
  font-size: 12px;
}

.detail-empty {
  padding: 24px;
  text-align: center;
  color: var(--color-text-secondary);
}

.topic-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--color-primary);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: transparent;
  text-underline-offset: 2px;
}

.topic-link:hover {
  text-decoration-color: currentColor;
}

.topic-link:focus-visible {
  border-radius: var(--dbx-radius-fixed-4);
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

@media (max-height: 620px) {
  .consumer-groups-content {
    grid-template-rows: minmax(150px, 42%) minmax(150px, 1fr);
  }
}
</style>

<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { useI18n } from "vue-i18n";
import type { NamespaceRef, TopicRef, TopicInfo, ListTopicsOpts } from "@/types/mq";
import { mqListTopics, mqCreateTopic, mqDeleteTopic, mqUpdatePartitions } from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";

interface Props {
  connectionId: string;
  tenant?: string;
  namespace?: string;
  readOnly?: boolean;
  supportsPartitionedTopics?: boolean;
  isKafkaCluster?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  topicSelected: [topic: TopicInfo];
}>();

const { t } = useI18n();

const topics = ref<TopicInfo[]>([]);
const loading = ref(false);
const error = ref<string>();
const dialogError = ref<string>();
const showCreateDialog = ref(false);
const showPartitionsDialog = ref(false);
const selectedTopic = ref<TopicInfo>();
const editingTopic = ref<TopicInfo>();
const topicSearch = ref("");

const formData = ref({
  topicName: "",
  persistent: true,
  partitioned: false,
  partitions: 4,
});

const newPartitions = ref(4);

const includeNonPersistent = ref(false);

const filteredTopics = computed(() => {
  const query = topicSearch.value.trim().toLowerCase();
  if (!query) return topics.value;
  return topics.value.filter((topic) => {
    return topic.name.toLowerCase().includes(query) || topic.shortName.toLowerCase().includes(query);
  });
});
const editingCurrentPartitions = computed(() => editingTopic.value?.partitions ?? 0);
const canSubmitPartitionUpdate = computed(() => {
  const current = editingCurrentPartitions.value;
  return !props.readOnly && current > 0 && Number.isFinite(newPartitions.value) && newPartitions.value > current;
});

function guardWritable() {
  if (props.readOnly) {
    error.value = t("mqTopics.readOnly");
    return false;
  }
  return true;
}

async function loadTopics() {
  if (!props.tenant || !props.namespace) {
    topics.value = [];
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    const ns: NamespaceRef = {
      tenant: props.tenant,
      namespace: props.namespace,
    };
    const opts: ListTopicsOpts = {
      includeNonPersistent: includeNonPersistent.value,
    };
    topics.value = await mqListTopics(props.connectionId, ns, opts);
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function openCreateDialog() {
  if (!guardWritable()) return;
  dialogError.value = undefined;
  formData.value = {
    topicName: "",
    persistent: true,
    partitioned: props.isKafkaCluster ?? false,
    partitions: 4,
  };
  showCreateDialog.value = true;
}

function openPartitionsDialog(topic: TopicInfo) {
  if (!guardWritable()) return;
  dialogError.value = undefined;
  if (!topic.partitions || topic.partitions < 1) {
    error.value = t("mqTopics.currentPartitionsUnknown");
    return;
  }
  editingTopic.value = topic;
  newPartitions.value = topic.partitions + 1;
  showPartitionsDialog.value = true;
}

async function handleCreate() {
  if (!guardWritable()) return;
  if (!formData.value.topicName.trim() || !props.tenant || !props.namespace) {
    dialogError.value = t("mqTopics.topicNameRequired");
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    const topicRef: TopicRef = {
      tenant: props.tenant,
      namespace: props.namespace,
      topic: formData.value.topicName,
      persistent: formData.value.persistent,
    };
    const partitions = props.supportsPartitionedTopics !== false && formData.value.partitioned ? formData.value.partitions : undefined;
    await mqCreateTopic(props.connectionId, topicRef, partitions);
    showCreateDialog.value = false;
    dialogError.value = undefined;
    await loadTopics();
  } catch (e: unknown) {
    dialogError.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function handleDelete(topic: TopicInfo) {
  if (!guardWritable()) return;
  if (!confirm(t("mqTopics.confirmDelete", { name: topic.shortName }))) return;
  if (!props.tenant || !props.namespace) return;
  loading.value = true;
  error.value = undefined;
  try {
    const topicRef: TopicRef = {
      tenant: props.tenant,
      namespace: props.namespace,
      topic: topic.shortName,
      persistent: topic.persistent,
    };
    await mqDeleteTopic(props.connectionId, topicRef, false);
    if (selectedTopic.value?.name === topic.name) {
      selectedTopic.value = undefined;
    }
    await loadTopics();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function handleUpdatePartitions() {
  if (!guardWritable()) return;
  if (!editingTopic.value || !props.tenant || !props.namespace) return;
  const currentPartitions = editingTopic.value.partitions;
  if (!currentPartitions || currentPartitions < 1) {
    dialogError.value = t("mqTopics.currentPartitionsUnknown");
    return;
  }
  if (newPartitions.value <= currentPartitions) {
    dialogError.value = t("mqTopics.partitionMustIncrease");
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    const topicRef: TopicRef = {
      tenant: props.tenant,
      namespace: props.namespace,
      topic: editingTopic.value.shortName,
      persistent: editingTopic.value.persistent,
    };
    await mqUpdatePartitions(props.connectionId, topicRef, newPartitions.value);
    showPartitionsDialog.value = false;
    dialogError.value = undefined;
    await loadTopics();
  } catch (e: unknown) {
    dialogError.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function selectTopic(topic: TopicInfo) {
  selectedTopic.value = topic;
  emit("topicSelected", topic);
}

function normalizePartitionInput() {
  const min = editingCurrentPartitions.value + 1;
  if (!showPartitionsDialog.value || min <= 1) return;
  if (!Number.isFinite(Number(newPartitions.value)) || Number(newPartitions.value) < min) {
    newPartitions.value = min;
  }
}

watch(
  () => [props.tenant, props.namespace],
  () => {
    selectedTopic.value = undefined;
    loadTopics();
  },
  { immediate: true },
);

watch(includeNonPersistent, () => {
  loadTopics();
});

watch(newPartitions, () => {
  if (dialogError.value === t("mqTopics.partitionMustIncrease") && canSubmitPartitionUpdate.value) {
    dialogError.value = undefined;
  }
});
</script>

<template>
  <div class="topics-panel">
    <div class="panel-toolbar">
      <div class="toolbar-left">
        <h3>{{ t("mqTopics.title") }}</h3>
        <input v-model="topicSearch" type="search" class="topic-search" :placeholder="t('mqTopics.searchPlaceholder')" :disabled="loading && !topics.length" />
        <span v-if="topics.length" class="topic-count">{{ filteredTopics.length }} / {{ topics.length }}</span>
        <label class="checkbox-label">
          <input type="checkbox" v-model="includeNonPersistent" />
          {{ t("mqTopics.includeNonPersistent") }}
        </label>
      </div>
      <div class="toolbar-actions">
        <button @click="loadTopics" :disabled="loading || !tenant || !namespace" class="btn-secondary">
          {{ loading ? t("mqTopics.refreshing") : t("mqTopics.refresh") }}
        </button>
        <button @click="openCreateDialog" :disabled="loading || readOnly || !tenant || !namespace" class="btn-primary">+ {{ t("mqTopics.createTopic") }}</button>
      </div>
    </div>

    <div v-if="!tenant || !namespace" class="panel-placeholder">{{ t("mqTopics.selectTenantNamespace") }}</div>

    <div v-else-if="error" class="panel-error">{{ error }}</div>

    <div v-else-if="loading && !topics.length" class="panel-loading">{{ t("mqTopics.loading") }}</div>

    <div v-else-if="!topics.length" class="panel-placeholder">{{ t("mqTopics.noTopics") }}</div>

    <div v-else-if="!filteredTopics.length" class="panel-placeholder">{{ t("mqTopics.noMatches") }}</div>

    <div v-else class="topics-table">
      <table>
        <thead>
          <tr>
            <th>{{ t("mqTopics.name") }}</th>
            <th>{{ t("mqTopics.type") }}</th>
            <th>{{ t("mqTopics.partitions") }}</th>
            <th>{{ t("mqTopics.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="topic in filteredTopics" :key="topic.name" :class="{ selected: selectedTopic?.name === topic.name }" @click="selectTopic(topic)">
            <td class="topic-name">
              <div class="topic-name-cell">
                <span>{{ topic.shortName }}</span>
                <span v-if="!topic.persistent" class="badge badge-warning">{{ t("mqTopics.nonPersistent") }}</span>
              </div>
            </td>
            <td>
              <span class="badge" :class="topic.partitioned ? 'badge-info' : 'badge-default'">
                {{ topic.partitioned ? t("mqTopics.partitionedTopic") : t("mqTopics.normalTopic") }}
              </span>
            </td>
            <td>
              <span v-if="topic.partitioned">{{ topic.partitions ? t("mqTopics.partitionCount", { count: topic.partitions }) : t("mqTopics.partitionsUnknown") }}</span>
              <span v-else class="text-muted">-</span>
            </td>
            <td class="actions">
              <button v-if="topic.partitioned && supportsPartitionedTopics !== false" @click.stop="openPartitionsDialog(topic)" :disabled="readOnly || !topic.partitions" class="btn-sm">
                {{ t("mqTopics.adjustPartitions") }}
              </button>
              <button @click.stop="handleDelete(topic)" :disabled="readOnly" class="btn-sm btn-danger">{{ t("mqTopics.delete") }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Create Dialog -->
    <div v-if="showCreateDialog" class="dialog-overlay" @click="showCreateDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>{{ t("mqTopics.createTopic") }}</h3>
          <button @click="showCreateDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div v-if="!isKafkaCluster" class="form-group">
            <label>{{ t("mqTopics.tenantNamespace") }}</label>
            <input type="text" :value="`${tenant} / ${namespace}`" disabled />
          </div>
          <div class="form-group">
            <label>{{ t("mqTopics.topicName") }}*</label>
            <input v-model="formData.topicName" type="text" :placeholder="t('mqTopics.topicNamePlaceholder')" :disabled="readOnly" />
          </div>
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" v-model="formData.persistent" :disabled="readOnly" />
              {{ t("mqTopics.persistentRecommended") }}
            </label>
            <div class="form-hint">{{ t("mqTopics.persistentHint") }}</div>
          </div>
          <div v-if="supportsPartitionedTopics !== false" class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" v-model="formData.partitioned" :disabled="readOnly" />
              {{ t("mqTopics.enablePartitions") }}
            </label>
            <div v-if="formData.partitioned" class="form-subgroup">
              <label>{{ t("mqTopics.partitionQuantity") }}*</label>
              <input v-model.number="formData.partitions" type="number" min="1" max="256" :disabled="readOnly" />
              <div class="form-hint">{{ t("mqTopics.partitionHint") }}</div>
            </div>
          </div>
          <div v-if="dialogError" class="form-error">{{ dialogError }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showCreateDialog = false" class="btn-secondary">{{ t("mqTopics.cancel") }}</button>
          <button @click="handleCreate" :disabled="loading || readOnly" class="btn-primary">{{ t("mqTopics.create") }}</button>
        </div>
      </div>
    </div>

    <!-- Update Partitions Dialog -->
    <div v-if="showPartitionsDialog" class="dialog-overlay" @click="showPartitionsDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>{{ t("mqTopics.updatePartitionsTitle", { name: editingTopic?.shortName }) }}</h3>
          <button @click="showPartitionsDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>{{ t("mqTopics.currentPartitions") }}</label>
            <input type="number" :value="editingTopic?.partitions" disabled />
          </div>
          <div class="form-group">
            <label>{{ t("mqTopics.newPartitions") }}*</label>
            <input v-model.number="newPartitions" type="number" :min="editingCurrentPartitions + 1" max="256" :disabled="readOnly" @change="normalizePartitionInput" @blur="normalizePartitionInput" />
            <div class="form-hint">{{ t("mqTopics.partitionMinHint", { min: editingCurrentPartitions + 1 }) }}</div>
          </div>
          <div v-if="dialogError" class="form-error">{{ dialogError }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showPartitionsDialog = false" class="btn-secondary">{{ t("mqTopics.cancel") }}</button>
          <button @click="handleUpdatePartitions" :disabled="loading || !canSubmitPartitionUpdate" class="btn-primary">{{ t("mqTopics.update") }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.topics-panel {
  --topics-surface: var(--card, var(--color-background, #ffffff));
  --topics-header-bg: color-mix(in srgb, var(--secondary, #f5f5f5) 86%, var(--card, #ffffff));
  --topics-border: var(--border, var(--color-border, #e5e7eb));
  --topics-border-light: color-mix(in srgb, var(--topics-border) 68%, transparent);
  height: 100%;
  display: flex;
  flex-direction: column;
}

.panel-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.toolbar-left h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  flex: 0 0 auto;
}

.topic-search {
  width: min(320px, 32vw);
  min-width: 180px;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background);
  color: var(--color-text);
  font-size: 13px;
}

.topic-search:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-alpha);
}

.topic-count {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
  font-size: 12px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  cursor: pointer;
}

.panel-placeholder,
.panel-error,
.panel-loading {
  padding: 24px;
  text-align: center;
  color: var(--color-text-secondary);
}

.panel-error {
  color: var(--color-error);
}

.topics-table {
  position: relative;
  flex: 1;
  overflow: auto;
  background: var(--topics-surface);
}

.topics-table::before {
  content: "";
  position: sticky;
  top: 0;
  display: block;
  height: 38px;
  margin-bottom: -38px;
  background: var(--topics-header-bg);
  z-index: 9;
  box-shadow:
    0 1px 0 var(--topics-border),
    0 2px 8px rgba(0, 0, 0, 0.05);
  pointer-events: none;
}

table {
  position: relative;
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
}

thead {
  position: sticky;
  top: 0;
  background: var(--topics-header-bg);
  z-index: 10;
}

th {
  position: sticky;
  top: 0;
  z-index: 11;
  padding: 10px 12px;
  text-align: left;
  font-weight: 600;
  font-size: 13px;
  color: var(--color-text-secondary);
  background: var(--topics-header-bg);
  border-bottom: 1px solid var(--topics-border);
  background-clip: padding-box;
  box-shadow:
    0 1px 0 var(--topics-border),
    0 2px 6px rgba(0, 0, 0, 0.04);
}

tbody tr {
  cursor: pointer;
  transition: background 0.2s;
}

tbody tr:hover {
  background: var(--color-hover);
}

tbody tr:hover td {
  background: var(--color-hover);
}

tbody tr.selected {
  background: var(--color-primary-alpha);
}

tbody tr.selected td {
  background: var(--color-primary-alpha);
}

td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--topics-border-light);
  background: var(--topics-surface);
}

.topic-name-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.topic-name {
  font-weight: 500;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
}

.badge-default {
  background: var(--color-background-secondary);
  color: var(--color-text-secondary);
}

.badge-info {
  background: var(--color-info-alpha);
  color: var(--color-info);
}

.badge-warning {
  background: var(--color-warning-alpha);
  color: var(--color-warning);
}

.text-muted {
  color: var(--color-text-tertiary);
  font-style: italic;
}

.actions {
  display: flex;
  gap: 8px;
}

.btn-primary,
.btn-secondary,
.btn-sm,
.btn-danger {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}

.btn-primary {
  background: var(--color-primary);
  color: white;
  border-color: var(--color-primary);
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}

.btn-danger {
  color: var(--color-error);
  border-color: var(--color-error);
}

.btn-danger:hover:not(:disabled) {
  background: var(--color-error);
  color: white;
}

.btn-sm {
  padding: 4px 8px;
  font-size: 12px;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Dialog styles */
.dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  background: var(--color-background);
  border-radius: 8px;
  width: 90%;
  max-width: 500px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}

.dialog-header h3 {
  margin: 0;
  font-size: 18px;
}

.btn-close {
  border: none;
  background: none;
  font-size: 24px;
  cursor: pointer;
  color: var(--color-text-secondary);
  padding: 0;
  line-height: 1;
}

.dialog-body {
  padding: 20px;
  max-height: 60vh;
  overflow-y: auto;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  font-weight: 500;
  font-size: 13px;
}

.form-group input[type="text"],
.form-group input[type="number"] {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 14px;
  box-sizing: border-box;
}

.form-group input:disabled {
  background: var(--color-background-secondary);
  color: var(--color-text-secondary);
}

.form-subgroup {
  margin-top: 12px;
  padding-left: 24px;
}

.form-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.form-error {
  margin-top: 12px;
  padding: 8px 12px;
  background: var(--color-error-bg);
  color: var(--color-error);
  border-radius: 4px;
  font-size: 13px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid var(--color-border);
}
</style>

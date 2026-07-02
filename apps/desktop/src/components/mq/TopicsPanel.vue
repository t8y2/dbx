<script setup lang="ts">
import { ref, watch, computed } from "vue";
import type { NamespaceRef, TopicRef, TopicInfo, ListTopicsOpts } from "@/types/mq";
import { mqListTopics, mqCreateTopic, mqDeleteTopic, mqUpdatePartitions } from "@/lib/api";
import { formatError } from "@/lib/errorUtils";

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

const topics = ref<TopicInfo[]>([]);
const loading = ref(false);
const error = ref<string>();
const showCreateDialog = ref(false);
const showPartitionsDialog = ref(false);
const selectedTopic = ref<TopicInfo>();
const editingTopic = ref<TopicInfo>();

const formData = ref({
  topicName: "",
  persistent: true,
  partitioned: false,
  partitions: 4,
});

const newPartitions = ref(4);

const includeNonPersistent = ref(false);
const readOnlyMessage = "当前连接为只读模式，不能执行写操作";

const filteredTopics = computed(() => {
  return topics.value;
});

function guardWritable() {
  if (props.readOnly) {
    error.value = readOnlyMessage;
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
  if (!topic.partitions || topic.partitions < 1) {
    error.value = "当前分区数未知，无法安全调整分区";
    return;
  }
  editingTopic.value = topic;
  newPartitions.value = topic.partitions + 1;
  showPartitionsDialog.value = true;
}

async function handleCreate() {
  if (!guardWritable()) return;
  if (!formData.value.topicName.trim() || !props.tenant || !props.namespace) {
    error.value = "Topic name is required";
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
    await loadTopics();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function handleDelete(topic: TopicInfo) {
  if (!guardWritable()) return;
  if (!confirm(`确定要删除主题 "${topic.shortName}" 吗？此操作不可逆。`)) return;
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
    error.value = "当前分区数未知，无法安全调整分区";
    return;
  }
  if (newPartitions.value <= currentPartitions) {
    error.value = "新分区数必须大于当前分区数";
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
    await loadTopics();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function selectTopic(topic: TopicInfo) {
  selectedTopic.value = topic;
  emit("topicSelected", topic);
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
</script>

<template>
  <div class="topics-panel">
    <div class="panel-toolbar">
      <div class="toolbar-left">
        <h3>主题管理</h3>
        <label class="checkbox-label">
          <input type="checkbox" v-model="includeNonPersistent" />
          包含非持久化主题
        </label>
      </div>
      <div class="toolbar-actions">
        <button @click="loadTopics" :disabled="loading || !tenant || !namespace" class="btn-secondary">
          {{ loading ? "刷新中..." : "刷新" }}
        </button>
        <button @click="openCreateDialog" :disabled="loading || readOnly || !tenant || !namespace" class="btn-primary">+ 创建主题</button>
      </div>
    </div>

    <div v-if="!tenant || !namespace" class="panel-placeholder">请先选择租户和命名空间</div>

    <div v-else-if="error" class="panel-error">{{ error }}</div>

    <div v-else-if="loading && !topics.length" class="panel-loading">加载中...</div>

    <div v-else-if="!topics.length" class="panel-placeholder">该命名空间下暂无主题</div>

    <div v-else class="topics-table">
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>类型</th>
            <th>分区</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="topic in filteredTopics" :key="topic.name" :class="{ selected: selectedTopic?.name === topic.name }" @click="selectTopic(topic)">
            <td class="topic-name">
              <div class="topic-name-cell">
                <span>{{ topic.shortName }}</span>
                <span v-if="!topic.persistent" class="badge badge-warning">非持久化</span>
              </div>
            </td>
            <td>
              <span class="badge" :class="topic.partitioned ? 'badge-info' : 'badge-default'">
                {{ topic.partitioned ? "分区主题" : "普通主题" }}
              </span>
            </td>
            <td>
              <span v-if="topic.partitioned">{{ topic.partitions ? `${topic.partitions} 个分区` : "分区数未知" }}</span>
              <span v-else class="text-muted">-</span>
            </td>
            <td class="actions">
              <button v-if="topic.partitioned && supportsPartitionedTopics !== false" @click.stop="openPartitionsDialog(topic)" :disabled="readOnly || !topic.partitions" class="btn-sm">调整分区</button>
              <button @click.stop="handleDelete(topic)" :disabled="readOnly" class="btn-sm btn-danger">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Create Dialog -->
    <div v-if="showCreateDialog" class="dialog-overlay" @click="showCreateDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>创建主题</h3>
          <button @click="showCreateDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div v-if="!isKafkaCluster" class="form-group">
            <label>租户 / 命名空间</label>
            <input type="text" :value="`${tenant} / ${namespace}`" disabled />
          </div>
          <div class="form-group">
            <label>主题名称*</label>
            <input v-model="formData.topicName" type="text" placeholder="例如: my-topic" :disabled="readOnly" />
          </div>
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" v-model="formData.persistent" :disabled="readOnly" />
              持久化主题（推荐）
            </label>
            <div class="form-hint">持久化主题会将消息保存到磁盘，非持久化主题仅保存在内存中</div>
          </div>
          <div v-if="supportsPartitionedTopics !== false" class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" v-model="formData.partitioned" :disabled="readOnly" />
              启用分区
            </label>
            <div v-if="formData.partitioned" class="form-subgroup">
              <label>分区数量*</label>
              <input v-model.number="formData.partitions" type="number" min="1" max="256" :disabled="readOnly" />
              <div class="form-hint">分区可以提高并发性能，但会增加资源消耗</div>
            </div>
          </div>
          <div v-if="error" class="form-error">{{ error }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showCreateDialog = false" class="btn-secondary">取消</button>
          <button @click="handleCreate" :disabled="loading || readOnly" class="btn-primary">创建</button>
        </div>
      </div>
    </div>

    <!-- Update Partitions Dialog -->
    <div v-if="showPartitionsDialog" class="dialog-overlay" @click="showPartitionsDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>调整分区数: {{ editingTopic?.shortName }}</h3>
          <button @click="showPartitionsDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>当前分区数</label>
            <input type="number" :value="editingTopic?.partitions" disabled />
          </div>
          <div class="form-group">
            <label>新分区数*</label>
            <input v-model.number="newPartitions" type="number" :min="(editingTopic?.partitions || 0) + 1" max="256" :disabled="readOnly" />
            <div class="form-hint">⚠️ 分区数只能增加，不能减少</div>
          </div>
          <div v-if="error" class="form-error">{{ error }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showPartitionsDialog = false" class="btn-secondary">取消</button>
          <button @click="handleUpdatePartitions" :disabled="loading || readOnly" class="btn-primary">更新</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.topics-panel {
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
  flex: 1;
  overflow: auto;
  background: var(--color-background);
}

table {
  width: 100%;
  border-collapse: collapse;
}

thead {
  position: sticky;
  top: 0;
  background: var(--color-background-secondary);
  z-index: 1;
}

th {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 10px 12px;
  text-align: left;
  font-weight: 600;
  font-size: 13px;
  color: var(--color-text-secondary);
  background: var(--color-background-secondary);
  border-bottom: 1px solid var(--color-border);
  box-shadow: 0 1px 0 var(--color-border);
}

tbody tr {
  cursor: pointer;
  transition: background 0.2s;
}

tbody tr:hover {
  background: var(--color-hover);
}

tbody tr.selected {
  background: var(--color-primary-alpha);
}

td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border-light);
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

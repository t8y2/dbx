<script setup lang="ts">
import { formatError } from "@/lib/backend/errorUtils";
import { ref, watch } from "vue";
import type { NamespaceRef, NamespaceInfo, NamespaceConfig } from "@/types/mq";
import { mqListNamespaces, mqCreateNamespace, mqDeleteNamespace } from "@/lib/backend/api";

interface Props {
  connectionId: string;
  tenant?: string;
  supportsNamespaces: boolean;
  readOnly?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  namespaceSelected: [namespace: string];
  namespaceRolesSelected: [namespace: string];
}>();

const namespaces = ref<NamespaceInfo[]>([]);
const loading = ref(false);
const error = ref<string>();
const showCreateDialog = ref(false);
const selectedNamespace = ref<string>();

const formData = ref({
  namespace: "",
});

const readOnlyMessage = "当前连接为只读模式，不能执行写操作";

function guardWritable() {
  if (props.readOnly) {
    error.value = readOnlyMessage;
    return false;
  }
  return true;
}

async function loadNamespaces() {
  if (!props.tenant) {
    namespaces.value = [];
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    namespaces.value = await mqListNamespaces(props.connectionId, props.tenant);
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function openCreateDialog() {
  if (!guardWritable()) return;
  formData.value = {
    namespace: "",
  };
  showCreateDialog.value = true;
}

async function handleCreate() {
  if (!guardWritable()) return;
  if (!formData.value.namespace.trim() || !props.tenant) {
    error.value = "Namespace name is required";
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    const ns: NamespaceRef = {
      tenant: props.tenant,
      namespace: formData.value.namespace,
    };
    const config: NamespaceConfig = {};
    await mqCreateNamespace(props.connectionId, ns, config);
    showCreateDialog.value = false;
    await loadNamespaces();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function handleDelete(ns: NamespaceInfo) {
  if (!guardWritable()) return;
  if (!confirm(`确定要删除命名空间 "${ns.namespace}" 吗？此操作不可逆。`)) return;
  if (!props.tenant) return;
  loading.value = true;
  error.value = undefined;
  try {
    const nsRef: NamespaceRef = {
      tenant: props.tenant,
      namespace: ns.namespace,
    };
    await mqDeleteNamespace(props.connectionId, nsRef, false);
    if (selectedNamespace.value === ns.namespace) {
      selectedNamespace.value = undefined;
    }
    await loadNamespaces();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function selectNamespace(ns: NamespaceInfo) {
  selectedNamespace.value = ns.namespace;
  emit("namespaceSelected", ns.namespace);
}

function editNamespaceRoles(ns: NamespaceInfo) {
  selectedNamespace.value = ns.namespace;
  emit("namespaceRolesSelected", ns.namespace);
}

watch(
  () => props.tenant,
  () => {
    selectedNamespace.value = undefined;
    loadNamespaces();
  },
  { immediate: true },
);
</script>

<template>
  <div class="namespaces-panel">
    <div class="panel-toolbar">
      <h3>命名空间管理</h3>
      <button @click="openCreateDialog" :disabled="loading || readOnly || !tenant" class="btn-primary">+ 创建命名空间</button>
    </div>

    <div v-if="!supportsNamespaces" class="panel-placeholder">当前消息队列系统不支持命名空间管理</div>

    <div v-else-if="!tenant" class="panel-placeholder">请先选择一个租户</div>

    <div v-else-if="error" class="panel-error">{{ error }}</div>

    <div v-else-if="loading && !namespaces.length" class="panel-loading">加载中...</div>

    <div v-else class="namespaces-table">
      <table>
        <thead>
          <tr>
            <th>名称</th>
            <th>租户</th>
            <th>管理角色</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="ns in namespaces" :key="ns.namespace" :class="{ selected: selectedNamespace === ns.namespace }" @click="selectNamespace(ns)">
            <td class="namespace-name">{{ ns.namespace }}</td>
            <td>{{ ns.tenant }}</td>
            <td>
              <span v-if="ns.adminRoles.length" class="tag-list">
                <span v-for="role in ns.adminRoles" :key="role" class="tag">{{ role }}</span>
              </span>
              <span v-else class="text-muted">无</span>
            </td>
            <td class="actions">
              <button @click.stop="editNamespaceRoles(ns)" class="btn-sm">编辑角色</button>
              <button @click.stop="handleDelete(ns)" :disabled="readOnly" class="btn-sm btn-danger">删除</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Create Dialog -->
    <div v-if="showCreateDialog" class="dialog-overlay" @click="showCreateDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>创建命名空间</h3>
          <button @click="showCreateDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>租户</label>
            <input type="text" :value="tenant" disabled />
          </div>
          <div class="form-group">
            <label>命名空间名称*</label>
            <input v-model="formData.namespace" type="text" placeholder="例如: my-namespace" :disabled="readOnly" />
          </div>
          <div v-if="error" class="form-error">{{ error }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showCreateDialog = false" class="btn-secondary">取消</button>
          <button @click="handleCreate" :disabled="loading || readOnly" class="btn-primary">创建</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.namespaces-panel {
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

.panel-toolbar h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
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

.namespaces-table {
  flex: 1;
  overflow: auto;
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
  padding: 10px 12px;
  text-align: left;
  font-weight: 600;
  font-size: 13px;
  color: var(--color-text-secondary);
  border-bottom: 1px solid var(--color-border);
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

.namespace-name {
  font-weight: 500;
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

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: var(--color-primary-alpha);
  color: var(--color-primary);
  border-radius: 4px;
  font-size: 12px;
}

.tag-remove {
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  padding: 0;
  font-size: 14px;
  line-height: 1;
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

.input-with-button {
  display: flex;
  gap: 8px;
}

.input-with-button input {
  flex: 1;
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

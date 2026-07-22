<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { MqPolicyInfo, MqPolicyUpsertRequest } from "@/types/mq";
import { mqDeletePolicy, mqListNamespaces, mqListPolicies, mqSetPolicy } from "@/lib/backend/api";
import { isAllVhostsNamespace, RABBITMQ_MQ_TENANT } from "@/lib/mq/mqConsoleDefaults";
import { formatError } from "@/lib/backend/errorUtils";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";

interface Props {
  connectionId: string;
  /** Selected RabbitMQ virtual host; "*" lists policies across all vhosts. */
  namespace?: string;
  readOnly?: boolean;
}

interface DefinitionEntry {
  key: string;
  value: string;
}

const props = defineProps<Props>();
const { t } = useI18n();

/** Well-known policy definition keys offered in the editor dropdown. */
const COMMON_DEFINITION_KEYS = ["message-ttl", "expires", "max-length", "max-length-bytes", "dead-letter-exchange", "dead-letter-routing-key", "max-age"];
/** Definition keys whose values are numeric. */
const NUMERIC_DEFINITION_KEYS = new Set(["message-ttl", "expires", "max-length", "max-length-bytes"]);
const APPLY_TO_OPTIONS = ["queues", "exchanges", "all"];

const policies = ref<MqPolicyInfo[]>([]);
const loading = ref(false);
const error = ref<string>();

/** Virtual hosts for the create/edit dialog dropdown. */
const vhosts = ref<string[]>([]);

const dialogError = ref<string>();
const showEditDialog = ref(false);
/** When set the dialog edits this policy; name and vhost stay fixed. */
const editingPolicy = ref<MqPolicyInfo>();
const editForm = ref({ name: "", virtualHost: "", pattern: "", applyTo: "queues", priority: 0 });
const definitionEntries = ref<DefinitionEntry[]>([]);
const saving = ref(false);

const showDeleteDialog = ref(false);
const deleteTarget = ref<MqPolicyInfo>();
const deleting = ref(false);

function guardWritable(): boolean {
  if (props.readOnly) {
    error.value = t("mqRabbitMqPolicies.readOnly");
    return false;
  }
  return true;
}

async function loadPolicies() {
  loading.value = true;
  error.value = undefined;
  try {
    // "*" is a listing sentinel: translate it into the all-vhosts listing.
    if (isAllVhostsNamespace(props.namespace)) {
      policies.value = await mqListPolicies(props.connectionId, { allVhosts: true });
    } else if (props.namespace) {
      policies.value = await mqListPolicies(props.connectionId, { virtualHost: props.namespace });
    } else {
      policies.value = await mqListPolicies(props.connectionId);
    }
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function loadVhosts() {
  try {
    const namespaces = await mqListNamespaces(props.connectionId, RABBITMQ_MQ_TENANT);
    vhosts.value = namespaces.map((ns) => ns.namespace);
  } catch (e: unknown) {
    console.warn("[DBX] Failed to load RabbitMQ vhosts:", e);
  }
}

function definitionEntriesFrom(policy: MqPolicyInfo): DefinitionEntry[] {
  return Object.entries(policy.definition).map(([key, value]) => ({ key, value: String(value) }));
}

function openCreateDialog() {
  if (!guardWritable()) return;
  const currentVhost = props.namespace && !isAllVhostsNamespace(props.namespace) ? props.namespace : "";
  editingPolicy.value = undefined;
  editForm.value = { name: "", virtualHost: currentVhost || vhosts.value[0] || "", pattern: "", applyTo: "queues", priority: 0 };
  definitionEntries.value = [];
  dialogError.value = undefined;
  showEditDialog.value = true;
}

function openEditDialog(policy: MqPolicyInfo) {
  if (!guardWritable()) return;
  editingPolicy.value = policy;
  editForm.value = { name: policy.name, virtualHost: policy.vhost, pattern: policy.pattern, applyTo: policy.applyTo || "queues", priority: policy.priority };
  definitionEntries.value = definitionEntriesFrom(policy);
  dialogError.value = undefined;
  showEditDialog.value = true;
}

function addDefinitionEntry() {
  definitionEntries.value = [...definitionEntries.value, { key: "", value: "" }];
}

function removeDefinitionEntry(index: number) {
  definitionEntries.value = definitionEntries.value.filter((_, i) => i !== index);
}

function buildDefinition(): Record<string, unknown> {
  const definition: Record<string, unknown> = {};
  for (const entry of definitionEntries.value) {
    const key = entry.key.trim();
    if (!key) continue;
    const raw = entry.value.trim();
    if (NUMERIC_DEFINITION_KEYS.has(key) && raw !== "" && Number.isFinite(Number(raw))) {
      definition[key] = Number(raw);
    } else {
      definition[key] = raw;
    }
  }
  return definition;
}

async function handleSave() {
  const name = editForm.value.name.trim();
  const virtualHost = editForm.value.virtualHost.trim();
  const pattern = editForm.value.pattern.trim();
  if (!name) {
    dialogError.value = t("mqRabbitMqPolicies.nameRequired");
    return;
  }
  // "*" is a listing sentinel and must never reach a write operation.
  if (!virtualHost || isAllVhostsNamespace(virtualHost)) {
    dialogError.value = t("mqRabbitMqPolicies.vhostRequired");
    return;
  }
  if (!pattern) {
    dialogError.value = t("mqRabbitMqPolicies.patternRequired");
    return;
  }
  const request: MqPolicyUpsertRequest = {
    name,
    pattern,
    applyTo: editForm.value.applyTo || undefined,
    priority: Number.isFinite(editForm.value.priority) ? editForm.value.priority : undefined,
    definition: buildDefinition(),
  };
  saving.value = true;
  dialogError.value = undefined;
  try {
    await mqSetPolicy(props.connectionId, virtualHost, request);
    showEditDialog.value = false;
    await loadPolicies();
  } catch (e: unknown) {
    dialogError.value = formatError(e);
  } finally {
    saving.value = false;
  }
}

function openDeleteDialog(policy: MqPolicyInfo) {
  if (!guardWritable()) return;
  deleteTarget.value = policy;
  showDeleteDialog.value = true;
}

async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target) return;
  deleting.value = true;
  error.value = undefined;
  try {
    await mqDeletePolicy(props.connectionId, target.vhost, target.name);
    showDeleteDialog.value = false;
    await loadPolicies();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    deleting.value = false;
  }
}

function formatDefinitionValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

watch(
  () => props.namespace,
  () => {
    loadPolicies();
  },
);

watch(
  () => props.connectionId,
  () => {
    loadPolicies();
    loadVhosts();
  },
  { immediate: true },
);
</script>

<template>
  <div class="policies-panel">
    <div class="panel-toolbar">
      <div class="toolbar-left">
        <h3 class="section-title">{{ t("mqRabbitMqPolicies.title") }}</h3>
        <span v-if="policies.length" class="row-count">{{ policies.length }}</span>
      </div>
      <div class="toolbar-actions">
        <button @click="openCreateDialog" :disabled="readOnly" class="btn-secondary">{{ t("mqRabbitMqPolicies.createPolicy") }}</button>
        <button @click="loadPolicies" :disabled="loading" class="btn-secondary">
          {{ loading ? t("mqRabbitMqPolicies.refreshing") : t("mqRabbitMqPolicies.refresh") }}
        </button>
      </div>
    </div>

    <div v-if="error" class="panel-error">{{ error }}</div>
    <div v-else-if="loading && !policies.length" class="panel-loading">{{ t("mqRabbitMqPolicies.loading") }}</div>
    <div v-else-if="!policies.length" class="panel-placeholder">{{ t("mqRabbitMqPolicies.noPolicies") }}</div>
    <div v-else class="data-table">
      <table>
        <thead>
          <tr>
            <th>{{ t("mqRabbitMqPolicies.name") }}</th>
            <th>{{ t("mqRabbitMqPolicies.vhost") }}</th>
            <th>{{ t("mqRabbitMqPolicies.pattern") }}</th>
            <th>{{ t("mqRabbitMqPolicies.applyTo") }}</th>
            <th>{{ t("mqRabbitMqPolicies.priority") }}</th>
            <th>{{ t("mqRabbitMqPolicies.definition") }}</th>
            <th>{{ t("mqRabbitMqPolicies.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="policy in policies" :key="`${policy.vhost}/${policy.name}`">
            <td class="policy-name" :title="policy.name">{{ policy.name }}</td>
            <td>{{ policy.vhost }}</td>
            <td class="pattern-cell" :title="policy.pattern">{{ policy.pattern }}</td>
            <td>{{ policy.applyTo }}</td>
            <td>{{ policy.priority }}</td>
            <td class="definition-cell">
              <div v-for="(value, key) in policy.definition" :key="key" class="definition-item">
                <span class="definition-key">{{ key }}</span>
                <span class="definition-value">{{ formatDefinitionValue(value) }}</span>
              </div>
            </td>
            <td class="actions">
              <button class="btn-sm" :disabled="readOnly" @click="openEditDialog(policy)">{{ t("mqRabbitMqPolicies.edit") }}</button>
              <button class="btn-sm btn-danger" :disabled="readOnly" @click="openDeleteDialog(policy)">{{ t("mqRabbitMqPolicies.delete") }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Create / Edit Policy Dialog -->
    <div v-if="showEditDialog" class="dialog-overlay" @click="showEditDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>{{ editingPolicy ? t("mqRabbitMqPolicies.editPolicy") : t("mqRabbitMqPolicies.createPolicy") }}</h3>
          <button @click="showEditDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>{{ t("mqRabbitMqPolicies.name") }}</label>
            <input v-model="editForm.name" type="text" :disabled="readOnly || !!editingPolicy" />
          </div>
          <div class="form-group">
            <label>{{ t("mqRabbitMqPolicies.vhost") }}</label>
            <select v-model="editForm.virtualHost" :disabled="readOnly || !!editingPolicy">
              <option value="" disabled>{{ t("mqRabbitMqPolicies.selectVhost") }}</option>
              <option v-for="vhost in vhosts" :key="vhost" :value="vhost">{{ vhost }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>{{ t("mqRabbitMqPolicies.pattern") }}</label>
            <input v-model="editForm.pattern" type="text" placeholder="^dbx-" :disabled="readOnly" />
          </div>
          <div class="form-hint">{{ t("mqRabbitMqPolicies.patternHint") }}</div>
          <div class="form-group">
            <label>{{ t("mqRabbitMqPolicies.applyTo") }}</label>
            <select v-model="editForm.applyTo" :disabled="readOnly">
              <option v-for="option in APPLY_TO_OPTIONS" :key="option" :value="option">{{ option }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>{{ t("mqRabbitMqPolicies.priority") }}</label>
            <input v-model.number="editForm.priority" type="number" :disabled="readOnly" />
          </div>
          <div class="form-group">
            <label>{{ t("mqRabbitMqPolicies.definition") }}</label>
            <div v-for="(entry, index) in definitionEntries" :key="index" class="definition-row">
              <input v-model="entry.key" type="text" list="rabbitmq-policy-definition-keys" :placeholder="t('mqRabbitMqPolicies.definitionKey')" :disabled="readOnly" />
              <input v-model="entry.value" type="text" :placeholder="t('mqRabbitMqPolicies.definitionValue')" :disabled="readOnly" />
              <button class="btn-sm btn-danger" :disabled="readOnly" @click="removeDefinitionEntry(index)">×</button>
            </div>
            <datalist id="rabbitmq-policy-definition-keys">
              <option v-for="key in COMMON_DEFINITION_KEYS" :key="key" :value="key" />
            </datalist>
            <button class="btn-sm" :disabled="readOnly" @click="addDefinitionEntry">{{ t("mqRabbitMqPolicies.addDefinition") }}</button>
          </div>
          <div v-if="dialogError" class="form-error">{{ dialogError }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showEditDialog = false" class="btn-secondary">{{ t("mqRabbitMqPolicies.cancel") }}</button>
          <button @click="handleSave" :disabled="saving || readOnly" class="btn-primary">{{ t("mqRabbitMqPolicies.save") }}</button>
        </div>
      </div>
    </div>

    <!-- Delete Policy Confirm -->
    <DangerConfirmDialog
      v-model:open="showDeleteDialog"
      :title="t('mqRabbitMqPolicies.delete')"
      :message="t('mqRabbitMqPolicies.confirmDelete', { name: deleteTarget?.name ?? '', vhost: deleteTarget?.vhost ?? '' })"
      :confirm-label="t('mqRabbitMqPolicies.delete')"
      :loading="deleting"
      :close-on-confirm="false"
      @confirm="confirmDelete"
    />
  </div>
</template>

<style scoped>
.policies-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 16px;
  overflow: auto;
  height: 100%;
}

.section-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.panel-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row-count {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
  font-size: 12px;
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

.data-table {
  overflow: auto;
  background: var(--color-background);
  border: 1px solid var(--color-border);
  border-radius: 6px;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th {
  padding: 10px 12px;
  text-align: left;
  font-weight: 600;
  font-size: 13px;
  color: var(--color-text-secondary);
  background: var(--color-background-secondary);
  border-bottom: 1px solid var(--color-border);
}

td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
  font-size: 13px;
}

.data-table tbody tr {
  transition: background 0.2s;
}

.data-table tbody tr:hover {
  background: var(--color-hover);
}

.policy-name {
  font-weight: 500;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pattern-cell {
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.definition-cell {
  max-width: 320px;
}

.definition-item {
  display: flex;
  gap: 8px;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  line-height: 1.6;
}

.definition-key {
  color: var(--color-text-secondary);
}

.definition-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}

.btn-primary,
.btn-secondary,
.btn-sm {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
}

.btn-secondary:hover:not(:disabled) {
  background: var(--color-hover);
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

/* Dialog */
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
  max-width: 560px;
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
  max-height: 70vh;
  overflow: auto;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid var(--color-border);
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
.form-group input[type="number"],
.form-group select {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 14px;
  box-sizing: border-box;
  background: var(--color-background);
  color: var(--color-text);
}

.definition-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  align-items: center;
}

.definition-row input {
  flex: 1;
}

.definition-row .btn-sm {
  flex: 0 0 auto;
}

.form-hint {
  color: var(--color-text-tertiary);
  font-size: 12px;
  margin-top: -8px;
  margin-bottom: 16px;
}

.form-error {
  color: var(--color-error);
  font-size: 13px;
}
</style>

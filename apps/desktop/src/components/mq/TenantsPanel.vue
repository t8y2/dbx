<script setup lang="ts">
import { formatError } from "@/lib/backend/errorUtils";
import { computed, ref, onBeforeUnmount, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { TenantInfo, TenantConfig } from "@/types/mq";
import { mqListTenants, mqCreateTenant, mqUpdateTenant, mqDeleteTenant } from "@/lib/backend/api";
import { defaultTenantConfig, normalizeClusterOptions, validateTenantForm } from "@/lib/mq/mqTenantForm";

interface Props {
  connectionId: string;
  supportsTenants: boolean;
  readOnly?: boolean;
  clusterOptions?: string[];
}

const props = defineProps<Props>();
const emit = defineEmits<{
  tenantSelected: [tenant: string];
}>();

const { t } = useI18n();

const tenants = ref<TenantInfo[]>([]);
const loading = ref(false);
const error = ref<string>();
const showCreateDialog = ref(false);
const showEditDialog = ref(false);
const editingTenant = ref<TenantInfo>();
const selectedTenant = ref<string>();

const formData = ref<{ name: string; config: TenantConfig }>({
  name: "",
  config: {
    adminRoles: [],
    allowedClusters: [],
  },
});

const newRole = ref("");
const newCluster = ref("");
const clusterDropdownOpen = ref(false);
const clusterSelectRef = ref<HTMLElement | null>(null);
const normalizedClusterOptions = computed(() => normalizeClusterOptions(props.clusterOptions ?? []));
const clusterOptionSet = computed(() => new Set(normalizedClusterOptions.value));
const selectedAllowedClusters = computed(() => normalizeClusterOptions(formData.value.config.allowedClusters));
const displayedSelectedClusters = computed(() => [...normalizedClusterOptions.value.filter((cluster) => selectedAllowedClusters.value.includes(cluster)), ...selectedAllowedClusters.value.filter((cluster) => !clusterOptionSet.value.has(cluster))]);
const canSubmitTenant = computed(() => Boolean(formData.value.name.trim()) && selectedAllowedClusters.value.length > 0);

function guardWritable() {
  if (props.readOnly) {
    error.value = t("mqTenants.readOnly");
    return false;
  }
  return true;
}

async function loadTenants() {
  loading.value = true;
  error.value = undefined;
  try {
    tenants.value = await mqListTenants(props.connectionId);
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function openCreateDialog() {
  if (!guardWritable()) return;
  formData.value = {
    name: "",
    config: defaultTenantConfig(normalizedClusterOptions.value),
  };
  newRole.value = "";
  newCluster.value = "";
  clusterDropdownOpen.value = false;
  showCreateDialog.value = true;
}

function openEditDialog(tenant: TenantInfo) {
  if (!guardWritable()) return;
  editingTenant.value = tenant;
  formData.value = {
    name: tenant.name,
    config: {
      adminRoles: [...tenant.adminRoles],
      allowedClusters: normalizeClusterOptions(tenant.allowedClusters),
    },
  };
  newRole.value = "";
  newCluster.value = "";
  clusterDropdownOpen.value = false;
  showEditDialog.value = true;
}

async function handleCreate() {
  if (!guardWritable()) return;
  const validationError = validateTenantForm(formData.value.name, formData.value.config);
  if (validationError) {
    error.value = t(validationError);
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    formData.value.config.allowedClusters = selectedAllowedClusters.value;
    await mqCreateTenant(props.connectionId, formData.value.name, formData.value.config);
    showCreateDialog.value = false;
    await loadTenants();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function handleUpdate() {
  if (!guardWritable()) return;
  if (!editingTenant.value) return;
  const validationError = validateTenantForm(formData.value.name, formData.value.config);
  if (validationError) {
    error.value = t(validationError);
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    formData.value.config.allowedClusters = selectedAllowedClusters.value;
    await mqUpdateTenant(props.connectionId, editingTenant.value.name, formData.value.config);
    showEditDialog.value = false;
    await loadTenants();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function handleDelete(tenant: TenantInfo) {
  if (!guardWritable()) return;
  if (!confirm(t("mqTenants.confirmDelete", { name: tenant.name }))) return;
  loading.value = true;
  error.value = undefined;
  try {
    await mqDeleteTenant(props.connectionId, tenant.name, false);
    if (selectedTenant.value === tenant.name) {
      selectedTenant.value = undefined;
    }
    await loadTenants();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function addRole() {
  const role = newRole.value.trim();
  if (role && !formData.value.config.adminRoles.includes(role)) {
    formData.value.config.adminRoles.push(role);
    newRole.value = "";
  }
}

function removeRole(role: string) {
  formData.value.config.adminRoles = formData.value.config.adminRoles.filter((r) => r !== role);
}

function addCluster() {
  const cluster = newCluster.value.trim();
  if (cluster && !formData.value.config.allowedClusters.includes(cluster)) {
    formData.value.config.allowedClusters.push(cluster);
    newCluster.value = "";
  }
}

function removeCluster(cluster: string) {
  formData.value.config.allowedClusters = formData.value.config.allowedClusters.filter((c) => c !== cluster);
}

function toggleCluster(cluster: string) {
  const selected = new Set(selectedAllowedClusters.value);
  if (selected.has(cluster)) {
    selected.delete(cluster);
  } else {
    selected.add(cluster);
  }
  formData.value.config.allowedClusters = [...selected];
}

function isClusterSelected(cluster: string) {
  return selectedAllowedClusters.value.includes(cluster);
}

function handleDocumentPointerDown(event: PointerEvent) {
  if (!clusterDropdownOpen.value) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (clusterSelectRef.value?.contains(target)) return;
  clusterDropdownOpen.value = false;
}

function selectTenant(tenant: TenantInfo) {
  selectedTenant.value = tenant.name;
  emit("tenantSelected", tenant.name);
}

onMounted(() => {
  document.addEventListener("pointerdown", handleDocumentPointerDown, true);
  if (props.supportsTenants) {
    loadTenants();
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
});

watch(normalizedClusterOptions, (clusters) => {
  if (showCreateDialog.value && formData.value.config.allowedClusters.length === 0) {
    formData.value.config.allowedClusters = [...clusters];
  }
});
</script>

<template>
  <div class="tenants-panel">
    <div class="panel-toolbar">
      <h3>{{ t("mqTenants.title") }}</h3>
      <button @click="openCreateDialog" :disabled="loading || readOnly" class="btn-primary">+ {{ t("mqTenants.createTenant") }}</button>
    </div>

    <div v-if="!supportsTenants" class="panel-placeholder">{{ t("mqTenants.notSupported") }}</div>

    <div v-else-if="error" class="panel-error">{{ error }}</div>

    <div v-else-if="loading && !tenants.length" class="panel-loading">{{ t("mqTenants.loading") }}</div>

    <div v-else class="tenants-table">
      <table>
        <thead>
          <tr>
            <th>{{ t("mqTenants.name") }}</th>
            <th>{{ t("mqTenants.adminRoles") }}</th>
            <th>{{ t("mqTenants.allowedClusters") }}</th>
            <th>{{ t("mqTenants.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="tenant in tenants" :key="tenant.name" :class="{ selected: selectedTenant === tenant.name }" @click="selectTenant(tenant)">
            <td class="tenant-name">{{ tenant.name }}</td>
            <td>
              <span v-if="tenant.adminRoles.length" class="tag-list">
                <span v-for="role in tenant.adminRoles" :key="role" class="tag">{{ role }}</span>
              </span>
              <span v-else class="text-muted">{{ t("mqTenants.none") }}</span>
            </td>
            <td>
              <span v-if="tenant.allowedClusters.length" class="tag-list">
                <span v-for="cluster in tenant.allowedClusters" :key="cluster" class="tag">{{ cluster }}</span>
              </span>
              <span v-else class="text-muted">{{ t("mqTenants.none") }}</span>
            </td>
            <td class="actions">
              <button @click.stop="openEditDialog(tenant)" :disabled="readOnly" class="btn-sm">{{ t("mqTenants.edit") }}</button>
              <button @click.stop="handleDelete(tenant)" :disabled="readOnly" class="btn-sm btn-danger">{{ t("mqTenants.delete") }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Create Dialog -->
    <div v-if="showCreateDialog" class="dialog-overlay" @click="showCreateDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>{{ t("mqTenants.createDialogTitle") }}</h3>
          <button @click="showCreateDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>{{ t("mqTenants.tenantName") }}</label>
            <input v-model="formData.name" type="text" :placeholder="t('mqTenants.tenantNamePlaceholder')" :disabled="readOnly" />
          </div>
          <div class="form-group">
            <label>{{ t("mqTenants.adminRoles") }}</label>
            <div class="input-with-button">
              <input v-model="newRole" type="text" :placeholder="t('mqTenants.addRolePlaceholder')" :disabled="readOnly" @keyup.enter="addRole" />
              <button @click="addRole" :disabled="readOnly" class="btn-sm">{{ t("mqTenants.add") }}</button>
            </div>
            <div v-if="formData.config.adminRoles.length" class="tag-list">
              <span v-for="role in formData.config.adminRoles" :key="role" class="tag">
                {{ role }}
                <button @click="removeRole(role)" :disabled="readOnly" class="tag-remove">×</button>
              </span>
            </div>
          </div>
          <div class="form-group">
            <label>{{ t("mqTenants.allowedClusters") }}</label>
            <div ref="clusterSelectRef" class="cluster-select-wrap">
              <button type="button" class="cluster-select-trigger" :class="{ open: clusterDropdownOpen }" :disabled="readOnly" @click="clusterDropdownOpen = !clusterDropdownOpen">
                <span v-if="displayedSelectedClusters.length" class="cluster-selected-tags">
                  <span v-for="cluster in displayedSelectedClusters" :key="cluster" class="tag">
                    {{ cluster }}
                    <span class="tag-remove" role="button" tabindex="0" @click.stop="removeCluster(cluster)" @keyup.enter.stop="removeCluster(cluster)">×</span>
                  </span>
                </span>
                <span v-else class="cluster-placeholder">{{ normalizedClusterOptions.length ? t("mqTenants.selectClustersPlaceholder") : t("mqTenants.noClustersDetectedPlaceholder") }}</span>
                <span class="cluster-arrow">{{ clusterDropdownOpen ? "⌃" : "⌄" }}</span>
              </button>
              <div v-if="clusterDropdownOpen" class="cluster-options">
                <button v-for="cluster in normalizedClusterOptions" :key="cluster" type="button" class="cluster-option" :class="{ selected: isClusterSelected(cluster) }" @click="toggleCluster(cluster)">
                  <span>{{ cluster }}</span>
                  <span v-if="isClusterSelected(cluster)" class="cluster-check">✓</span>
                </button>
                <div v-if="!normalizedClusterOptions.length" class="cluster-empty">{{ t("mqTenants.clustersNotReturned") }}</div>
              </div>
            </div>
            <div class="input-with-button cluster-manual">
              <input v-model="newCluster" type="text" :placeholder="t('mqTenants.addClusterPlaceholder')" :disabled="readOnly" @keyup.enter="addCluster" />
              <button @click="addCluster" :disabled="readOnly" class="btn-sm">{{ t("mqTenants.add") }}</button>
            </div>
            <div v-if="!selectedAllowedClusters.length" class="form-hint form-hint-error">{{ t("mqTenants.clustersRequiredHint") }}</div>
          </div>
          <div v-if="error" class="form-error">{{ error }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showCreateDialog = false" class="btn-secondary">{{ t("mqTenants.cancel") }}</button>
          <button @click="handleCreate" :disabled="loading || readOnly || !canSubmitTenant" class="btn-primary">{{ t("mqTenants.create") }}</button>
        </div>
      </div>
    </div>

    <!-- Edit Dialog -->
    <div v-if="showEditDialog" class="dialog-overlay" @click="showEditDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>{{ t("mqTenants.editDialogTitle", { name: editingTenant?.name }) }}</h3>
          <button @click="showEditDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>{{ t("mqTenants.adminRoles") }}</label>
            <div class="input-with-button">
              <input v-model="newRole" type="text" :placeholder="t('mqTenants.addRolePlaceholder')" :disabled="readOnly" @keyup.enter="addRole" />
              <button @click="addRole" :disabled="readOnly" class="btn-sm">{{ t("mqTenants.add") }}</button>
            </div>
            <div v-if="formData.config.adminRoles.length" class="tag-list">
              <span v-for="role in formData.config.adminRoles" :key="role" class="tag">
                {{ role }}
                <button @click="removeRole(role)" :disabled="readOnly" class="tag-remove">×</button>
              </span>
            </div>
          </div>
          <div class="form-group">
            <label>{{ t("mqTenants.allowedClusters") }}</label>
            <div ref="clusterSelectRef" class="cluster-select-wrap">
              <button type="button" class="cluster-select-trigger" :class="{ open: clusterDropdownOpen }" :disabled="readOnly" @click="clusterDropdownOpen = !clusterDropdownOpen">
                <span v-if="displayedSelectedClusters.length" class="cluster-selected-tags">
                  <span v-for="cluster in displayedSelectedClusters" :key="cluster" class="tag">
                    {{ cluster }}
                    <span class="tag-remove" role="button" tabindex="0" @click.stop="removeCluster(cluster)" @keyup.enter.stop="removeCluster(cluster)">×</span>
                  </span>
                </span>
                <span v-else class="cluster-placeholder">{{ normalizedClusterOptions.length ? t("mqTenants.selectClustersPlaceholder") : t("mqTenants.noClustersDetectedPlaceholder") }}</span>
                <span class="cluster-arrow">{{ clusterDropdownOpen ? "⌃" : "⌄" }}</span>
              </button>
              <div v-if="clusterDropdownOpen" class="cluster-options">
                <button v-for="cluster in normalizedClusterOptions" :key="cluster" type="button" class="cluster-option" :class="{ selected: isClusterSelected(cluster) }" @click="toggleCluster(cluster)">
                  <span>{{ cluster }}</span>
                  <span v-if="isClusterSelected(cluster)" class="cluster-check">✓</span>
                </button>
                <div v-if="!normalizedClusterOptions.length" class="cluster-empty">{{ t("mqTenants.clustersNotReturned") }}</div>
              </div>
            </div>
            <div class="input-with-button cluster-manual">
              <input v-model="newCluster" type="text" :placeholder="t('mqTenants.addClusterPlaceholder')" :disabled="readOnly" @keyup.enter="addCluster" />
              <button @click="addCluster" :disabled="readOnly" class="btn-sm">{{ t("mqTenants.add") }}</button>
            </div>
            <div v-if="!selectedAllowedClusters.length" class="form-hint form-hint-error">{{ t("mqTenants.clustersRequiredHint") }}</div>
          </div>
          <div v-if="error" class="form-error">{{ error }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showEditDialog = false" class="btn-secondary">{{ t("mqTenants.cancel") }}</button>
          <button @click="handleUpdate" :disabled="loading || readOnly || !canSubmitTenant" class="btn-primary">{{ t("mqTenants.save") }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tenants-panel {
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

.tenants-table {
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

.tenant-name {
  font-weight: 500;
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: var(--color-primary-alpha);
  color: var(--color-primary);
  border-radius: var(--dbx-radius-fixed-4);
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
  border-radius: var(--dbx-radius-fixed-4);
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
  border-radius: var(--dbx-radius-fixed-6);
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

.form-group input[type="text"] {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  font-size: 14px;
  box-sizing: border-box;
}

.input-with-button {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}

.input-with-button input {
  flex: 1;
}

.cluster-select-wrap {
  position: relative;
  margin-bottom: 8px;
}

.cluster-select-trigger {
  width: 100%;
  min-height: 38px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  text-align: left;
}

.cluster-select-trigger.open {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-alpha);
}

.cluster-selected-tags {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: 4px;
}

.cluster-placeholder {
  flex: 1;
  color: var(--color-text-tertiary);
  font-size: 13px;
}

.cluster-arrow {
  color: var(--color-text-tertiary);
  font-size: 13px;
}

.cluster-options {
  position: absolute;
  left: 0;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  background: var(--color-background);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.12);
}

.cluster-option {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border: none;
  border-bottom: 1px solid var(--color-border-light);
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
  font-size: 14px;
  text-align: left;
}

.cluster-option:hover,
.cluster-option.selected {
  background: var(--color-primary-alpha);
  color: var(--color-primary);
}

.cluster-option:last-child {
  border-bottom: none;
}

.cluster-check {
  color: var(--color-primary);
  font-weight: 600;
}

.cluster-empty {
  padding: 10px 12px;
  color: var(--color-text-tertiary);
  font-size: 13px;
}

.cluster-manual {
  margin-top: 8px;
}

.form-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.form-hint-error {
  color: var(--color-error);
}

.form-error {
  margin-top: 12px;
  padding: 8px 12px;
  background: var(--color-error-bg);
  color: var(--color-error);
  border-radius: var(--dbx-radius-fixed-4);
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

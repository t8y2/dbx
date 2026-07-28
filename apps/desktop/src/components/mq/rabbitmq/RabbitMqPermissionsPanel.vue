<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { MqUserInfo, MqVhostPermission } from "@/types/mq";
import { mqCreateUser, mqDeleteUser, mqGrantUserPermission, mqListNamespaces, mqListUserPermissions, mqListUsers, mqRevokeUserPermission } from "@/lib/backend/api";
import { isAllVhostsNamespace, RABBITMQ_MQ_TENANT } from "@/lib/mq/mqConsoleDefaults";
import { formatError } from "@/lib/backend/errorUtils";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";

interface Props {
  connectionId: string;
  /** Selected RabbitMQ virtual host; "*" lists permissions across all vhosts. */
  namespace?: string;
  readOnly?: boolean;
}

const props = defineProps<Props>();
const { t } = useI18n();

const users = ref<MqUserInfo[]>([]);
const usersLoading = ref(false);
const error = ref<string>();
const userSearch = ref("");
/** Clicking a user row filters the permission matrix to that user. */
const selectedUser = ref<string>();

const permissions = ref<MqVhostPermission[]>([]);
const permissionsLoading = ref(false);

/** Virtual hosts for the grant dialog dropdown. */
const vhosts = ref<string[]>([]);

const dialogError = ref<string>();
const showCreateDialog = ref(false);
const createForm = ref({ name: "", password: "", tagsText: "" });
const creating = ref(false);

const showDeleteDialog = ref(false);
const deleteTarget = ref<MqUserInfo>();
const deleting = ref(false);

const showGrantDialog = ref(false);
const grantForm = ref({ user: "", virtualHost: "", configure: ".*", write: ".*", read: ".*" });
const granting = ref(false);

const showRevokeDialog = ref(false);
const revokeTarget = ref<MqVhostPermission>();
const revoking = ref(false);

const filteredUsers = computed(() => {
  const query = userSearch.value.trim().toLowerCase();
  if (!query) return users.value;
  return users.value.filter((user) => user.name.toLowerCase().includes(query));
});

const filteredPermissions = computed(() => {
  if (!selectedUser.value) return permissions.value;
  return permissions.value.filter((permission) => permission.user === selectedUser.value);
});

function guardWritable(): boolean {
  if (props.readOnly) {
    error.value = t("mqUserPermissions.readOnly");
    return false;
  }
  return true;
}

async function loadUsers() {
  usersLoading.value = true;
  error.value = undefined;
  try {
    users.value = await mqListUsers(props.connectionId);
    if (selectedUser.value && !users.value.some((user) => user.name === selectedUser.value)) {
      selectedUser.value = undefined;
    }
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    usersLoading.value = false;
  }
}

async function loadPermissions() {
  permissionsLoading.value = true;
  error.value = undefined;
  try {
    // "*" is a listing sentinel: translate it into the all-vhosts listing.
    if (isAllVhostsNamespace(props.namespace)) {
      permissions.value = await mqListUserPermissions(props.connectionId, { allVhosts: true });
    } else if (props.namespace) {
      permissions.value = await mqListUserPermissions(props.connectionId, { virtualHost: props.namespace });
    } else {
      permissions.value = await mqListUserPermissions(props.connectionId);
    }
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    permissionsLoading.value = false;
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

function toggleUserFilter(user: MqUserInfo) {
  selectedUser.value = selectedUser.value === user.name ? undefined : user.name;
}

function openCreateDialog() {
  if (!guardWritable()) return;
  createForm.value = { name: "", password: "", tagsText: "" };
  dialogError.value = undefined;
  showCreateDialog.value = true;
}

function parseTags(text: string): string[] | undefined {
  const tags = text
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  return tags.length ? tags : undefined;
}

async function handleCreateUser() {
  const name = createForm.value.name.trim();
  const password = createForm.value.password;
  if (!name) {
    dialogError.value = t("mqUserPermissions.nameRequired");
    return;
  }
  if (!password) {
    dialogError.value = t("mqUserPermissions.passwordRequired");
    return;
  }
  creating.value = true;
  dialogError.value = undefined;
  try {
    await mqCreateUser(props.connectionId, name, password, parseTags(createForm.value.tagsText));
    showCreateDialog.value = false;
    await loadUsers();
  } catch (e: unknown) {
    dialogError.value = formatError(e);
  } finally {
    creating.value = false;
  }
}

function openDeleteDialog(user: MqUserInfo) {
  if (!guardWritable()) return;
  deleteTarget.value = user;
  showDeleteDialog.value = true;
}

async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target) return;
  deleting.value = true;
  error.value = undefined;
  try {
    await mqDeleteUser(props.connectionId, target.name);
    showDeleteDialog.value = false;
    await Promise.all([loadUsers(), loadPermissions()]);
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    deleting.value = false;
  }
}

function openGrantDialog() {
  if (!guardWritable()) return;
  const currentVhost = props.namespace && !isAllVhostsNamespace(props.namespace) ? props.namespace : "";
  grantForm.value = {
    user: selectedUser.value ?? users.value[0]?.name ?? "",
    virtualHost: currentVhost || vhosts.value[0] || "",
    configure: ".*",
    write: ".*",
    read: ".*",
  };
  dialogError.value = undefined;
  showGrantDialog.value = true;
}

function patternOrDefault(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

async function handleGrant() {
  const user = grantForm.value.user.trim();
  const virtualHost = grantForm.value.virtualHost.trim();
  if (!user) {
    dialogError.value = t("mqUserPermissions.userRequired");
    return;
  }
  if (!virtualHost || isAllVhostsNamespace(virtualHost)) {
    dialogError.value = t("mqUserPermissions.vhostRequired");
    return;
  }
  granting.value = true;
  dialogError.value = undefined;
  try {
    await mqGrantUserPermission(props.connectionId, user, virtualHost, {
      configure: patternOrDefault(grantForm.value.configure),
      write: patternOrDefault(grantForm.value.write),
      read: patternOrDefault(grantForm.value.read),
    });
    showGrantDialog.value = false;
    await loadPermissions();
  } catch (e: unknown) {
    dialogError.value = formatError(e);
  } finally {
    granting.value = false;
  }
}

function openRevokeDialog(permission: MqVhostPermission) {
  if (!guardWritable()) return;
  revokeTarget.value = permission;
  showRevokeDialog.value = true;
}

async function confirmRevoke() {
  const target = revokeTarget.value;
  if (!target) return;
  revoking.value = true;
  error.value = undefined;
  try {
    await mqRevokeUserPermission(props.connectionId, target.user, target.vhost);
    showRevokeDialog.value = false;
    await loadPermissions();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    revoking.value = false;
  }
}

watch(
  () => props.namespace,
  () => {
    loadPermissions();
  },
);

watch(
  () => props.connectionId,
  () => {
    selectedUser.value = undefined;
    loadUsers();
    loadPermissions();
    loadVhosts();
  },
  { immediate: true },
);
</script>

<template>
  <div class="user-permissions-panel">
    <!-- Users -->
    <div class="panel-section">
      <div class="panel-toolbar">
        <div class="toolbar-left">
          <h3 class="section-title">{{ t("mqUserPermissions.usersTitle") }}</h3>
          <input v-model="userSearch" type="search" class="user-search" :placeholder="t('mqUserPermissions.searchUsers')" :disabled="usersLoading && !users.length" />
          <span v-if="users.length" class="row-count">{{ filteredUsers.length }} / {{ users.length }}</span>
        </div>
        <div class="toolbar-actions">
          <button @click="openCreateDialog" :disabled="readOnly" class="btn-secondary">{{ t("mqUserPermissions.createUser") }}</button>
          <button @click="loadUsers" :disabled="usersLoading" class="btn-secondary">
            {{ usersLoading ? t("mqUserPermissions.refreshing") : t("mqUserPermissions.refresh") }}
          </button>
        </div>
      </div>

      <div v-if="usersLoading && !users.length" class="panel-loading">{{ t("mqUserPermissions.loading") }}</div>
      <div v-else-if="!users.length" class="panel-placeholder">{{ t("mqUserPermissions.noUsers") }}</div>
      <div v-else-if="!filteredUsers.length" class="panel-placeholder">{{ t("mqUserPermissions.noUserMatches") }}</div>
      <div v-else class="data-table">
        <table>
          <thead>
            <tr>
              <th>{{ t("mqUserPermissions.name") }}</th>
              <th>{{ t("mqUserPermissions.tags") }}</th>
              <th>{{ t("mqUserPermissions.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in filteredUsers" :key="user.name" :class="{ selected: selectedUser === user.name }" @click="toggleUserFilter(user)">
              <td class="user-name" :title="user.name">{{ user.name }}</td>
              <td>
                <span v-if="user.tags.length" class="tag-list">
                  <span v-for="tag in user.tags" :key="tag" class="badge badge-info">{{ tag }}</span>
                </span>
                <span v-else>-</span>
              </td>
              <td class="actions" @click.stop>
                <button class="btn-sm btn-danger" :disabled="readOnly" @click="openDeleteDialog(user)">{{ t("mqUserPermissions.delete") }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Permission matrix -->
    <div class="panel-section">
      <div class="panel-toolbar">
        <div class="toolbar-left">
          <h3 class="section-title">{{ t("mqUserPermissions.permissionsTitle") }}</h3>
          <span v-if="selectedUser" class="filter-chip">
            {{ selectedUser }}
            <button class="chip-clear" @click="selectedUser = undefined">×</button>
          </span>
        </div>
        <div class="toolbar-actions">
          <button @click="openGrantDialog" :disabled="readOnly" class="btn-secondary">{{ t("mqUserPermissions.grantPermission") }}</button>
          <button @click="loadPermissions" :disabled="permissionsLoading" class="btn-secondary">
            {{ permissionsLoading ? t("mqUserPermissions.refreshing") : t("mqUserPermissions.refresh") }}
          </button>
        </div>
      </div>

      <div v-if="error" class="panel-error">{{ error }}</div>
      <div v-else-if="permissionsLoading && !permissions.length" class="panel-loading">{{ t("mqUserPermissions.loading") }}</div>
      <div v-else-if="!filteredPermissions.length" class="panel-placeholder">{{ t("mqUserPermissions.noPermissions") }}</div>
      <div v-else class="data-table">
        <table>
          <thead>
            <tr>
              <th>{{ t("mqUserPermissions.user") }}</th>
              <th>{{ t("mqUserPermissions.vhost") }}</th>
              <th>{{ t("mqUserPermissions.configure") }}</th>
              <th>{{ t("mqUserPermissions.write") }}</th>
              <th>{{ t("mqUserPermissions.read") }}</th>
              <th>{{ t("mqUserPermissions.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="permission in filteredPermissions" :key="`${permission.user}@${permission.vhost}`">
              <td class="user-name" :title="permission.user">{{ permission.user }}</td>
              <td>{{ permission.vhost }}</td>
              <td class="pattern-cell" :title="permission.configure">{{ permission.configure }}</td>
              <td class="pattern-cell" :title="permission.write">{{ permission.write }}</td>
              <td class="pattern-cell" :title="permission.read">{{ permission.read }}</td>
              <td class="actions">
                <button class="btn-sm btn-danger" :disabled="readOnly" @click="openRevokeDialog(permission)">{{ t("mqUserPermissions.revoke") }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Create User Dialog -->
    <div v-if="showCreateDialog" class="dialog-overlay" @click="showCreateDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>{{ t("mqUserPermissions.createUser") }}</h3>
          <button @click="showCreateDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>{{ t("mqUserPermissions.name") }}</label>
            <input v-model="createForm.name" type="text" :disabled="readOnly" />
          </div>
          <div class="form-group">
            <label>{{ t("mqUserPermissions.password") }}</label>
            <input v-model="createForm.password" type="password" :disabled="readOnly" />
          </div>
          <div class="form-group">
            <label>{{ t("mqUserPermissions.tags") }}</label>
            <input v-model="createForm.tagsText" type="text" :placeholder="t('mqUserPermissions.tagsPlaceholder')" :disabled="readOnly" />
          </div>
          <div v-if="dialogError" class="form-error">{{ dialogError }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showCreateDialog = false" class="btn-secondary">{{ t("mqUserPermissions.cancel") }}</button>
          <button @click="handleCreateUser" :disabled="creating || readOnly" class="btn-primary">{{ t("mqUserPermissions.create") }}</button>
        </div>
      </div>
    </div>

    <!-- Grant Permission Dialog -->
    <div v-if="showGrantDialog" class="dialog-overlay" @click="showGrantDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>{{ t("mqUserPermissions.grantPermission") }}</h3>
          <button @click="showGrantDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>{{ t("mqUserPermissions.user") }}</label>
            <select v-model="grantForm.user" :disabled="readOnly">
              <option value="" disabled>{{ t("mqUserPermissions.selectUser") }}</option>
              <option v-for="user in users" :key="user.name" :value="user.name">{{ user.name }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>{{ t("mqUserPermissions.vhost") }}</label>
            <select v-model="grantForm.virtualHost" :disabled="readOnly">
              <option value="" disabled>{{ t("mqUserPermissions.selectVhost") }}</option>
              <option v-for="vhost in vhosts" :key="vhost" :value="vhost">{{ vhost }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>{{ t("mqUserPermissions.configure") }}</label>
            <input v-model="grantForm.configure" type="text" placeholder=".*" :disabled="readOnly" />
          </div>
          <div class="form-group">
            <label>{{ t("mqUserPermissions.write") }}</label>
            <input v-model="grantForm.write" type="text" placeholder=".*" :disabled="readOnly" />
          </div>
          <div class="form-group">
            <label>{{ t("mqUserPermissions.read") }}</label>
            <input v-model="grantForm.read" type="text" placeholder=".*" :disabled="readOnly" />
          </div>
          <div class="form-hint">{{ t("mqUserPermissions.patternHint") }}</div>
          <div v-if="dialogError" class="form-error">{{ dialogError }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showGrantDialog = false" class="btn-secondary">{{ t("mqUserPermissions.cancel") }}</button>
          <button @click="handleGrant" :disabled="granting || readOnly" class="btn-primary">{{ t("mqUserPermissions.grant") }}</button>
        </div>
      </div>
    </div>

    <!-- Delete User Confirm -->
    <DangerConfirmDialog
      v-model:open="showDeleteDialog"
      :title="t('mqUserPermissions.delete')"
      :message="t('mqUserPermissions.confirmDeleteUser', { name: deleteTarget?.name ?? '' })"
      :confirm-label="t('mqUserPermissions.delete')"
      :loading="deleting"
      :close-on-confirm="false"
      @confirm="confirmDelete"
    />

    <!-- Revoke Permission Confirm -->
    <DangerConfirmDialog
      v-model:open="showRevokeDialog"
      :title="t('mqUserPermissions.revoke')"
      :message="t('mqUserPermissions.confirmRevoke', { user: revokeTarget?.user ?? '', vhost: revokeTarget?.vhost ?? '' })"
      :confirm-label="t('mqUserPermissions.revoke')"
      :loading="revoking"
      :close-on-confirm="false"
      @confirm="confirmRevoke"
    />
  </div>
</template>

<style scoped>
.user-permissions-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 12px 16px;
  overflow: auto;
  height: 100%;
}

.panel-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
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

.user-search {
  width: min(280px, 28vw);
  min-width: 160px;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background);
  color: var(--color-text);
  font-size: 13px;
}

.user-search:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-alpha);
}

.row-count {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
  font-size: 12px;
}

.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--dbx-radius-fixed-4);
  background: var(--color-primary-alpha);
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 500;
}

.chip-clear {
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0;
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
  border-radius: var(--dbx-radius-fixed-6);
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

.data-table tbody tr.selected {
  background: var(--color-primary-alpha);
}

.user-name {
  font-weight: 500;
  max-width: 280px;
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

.tag-list {
  display: inline-flex;
  gap: 4px;
  flex-wrap: wrap;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--dbx-radius-fixed-4);
  font-size: 11px;
  font-weight: 500;
}

.badge-info {
  background: var(--color-info-alpha);
  color: var(--color-info);
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
  border-radius: var(--dbx-radius-fixed-4);
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

/* Dialogs */
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
.form-group input[type="password"],
.form-group select {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  font-size: 14px;
  box-sizing: border-box;
  background: var(--color-background);
  color: var(--color-text);
}

.form-hint {
  color: var(--color-text-tertiary);
  font-size: 12px;
  margin-top: -8px;
}

.form-error {
  color: var(--color-error);
  font-size: 13px;
}
</style>

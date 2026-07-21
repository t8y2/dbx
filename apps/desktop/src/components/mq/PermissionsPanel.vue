<script setup lang="ts">
import { formatError } from "@/lib/backend/errorUtils";
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AuthAction, MqIssuedToken, MqSystemKind, MqTokenRecord, PermissionMap, PolicyScope, TopicInfo } from "@/types/mq";
import { mqGrantPermission, mqIssueToken, mqListPermissions, mqListTokenRecords, mqRevokePermission } from "@/lib/backend/api";
import { formatMqTokenIssueError, type MqTokenIssueErrorView } from "@/lib/mq/mqTokenErrors";

interface Props {
  connectionId: string;
  tenant?: string;
  namespace?: string;
  topic?: TopicInfo;
  readOnly?: boolean;
  mqSystemKind?: MqSystemKind;
}

const props = defineProps<Props>();
const { t } = useI18n();

const actionOptions: AuthAction[] = ["produce", "consume", "functions", "sources", "sinks", "packages"];

const isFlatMqCluster = computed(() => props.mqSystemKind === "kafka" || props.mqSystemKind === "rocketmq");
const isRocketMqCluster = computed(() => props.mqSystemKind === "rocketmq");
const panelTitle = computed(() => (isRocketMqCluster.value ? t("mqRocketmq.aclTitle") : t("mqPermissions.title")));
const visibleActionOptions = computed(() => (isFlatMqCluster.value ? (["produce", "consume"] as AuthAction[]) : actionOptions));

const permissions = ref<PermissionMap>({});
const loading = ref(false);
const error = ref<string>();
const notice = ref<string>();
const roleName = ref("");
const roleNameInput = ref<HTMLInputElement | null>(null);
const roleNameError = ref("");
const selectedActions = ref<AuthAction[]>(["produce", "consume"]);
const actionsError = ref("");
const tokenRole = ref("");
const tokenActions = ref<AuthAction[]>([]);
const tokenExpiresUnlimited = ref(true);
const tokenExpiresDays = ref(30);
const tokenNote = ref("");
const tokenRecords = ref<MqTokenRecord[]>([]);
const tokenLoading = ref(false);
const tokenError = ref<string>();
const tokenIssueError = ref<MqTokenIssueErrorView>();
const issuedToken = ref<MqIssuedToken>();
const showTokenDialog = ref(false);
const readOnlyMessage = computed(() => t("mqPermissions.readOnly"));

const scope = computed<PolicyScope | null>(() => {
  if (!props.tenant || !props.namespace) return null;
  if (props.topic) {
    return {
      level: "topic",
      tenant: props.tenant,
      namespace: props.namespace,
      topic: props.topic.shortName,
      persistent: props.topic.persistent,
    };
  }
  return {
    level: "namespace",
    tenant: props.tenant,
    namespace: props.namespace,
  };
});

const scopeLabel = computed(() => {
  const current = scope.value;
  if (!current) return "";
  if (current.level === "topic") {
    return `${current.tenant}/${current.namespace}/${current.topic}`;
  }
  return `${current.tenant}/${current.namespace}`;
});

const permissionRows = computed(() => {
  return Object.entries(permissions.value).map(([role, actions]) => ({ role, actions }));
});

function guardWritable() {
  if (props.readOnly) {
    error.value = readOnlyMessage.value;
    notice.value = undefined;
    return false;
  }
  return true;
}

function formatActionLabel(action: AuthAction): string {
  if (isRocketMqCluster.value) {
    if (action === "produce") return t("mqRocketmq.actionProduce");
    if (action === "consume") return t("mqRocketmq.actionConsume");
  }
  return action;
}

async function loadPermissions() {
  const current = scope.value;
  permissions.value = {};
  notice.value = undefined;
  error.value = undefined;
  if (!current) return;

  loading.value = true;
  try {
    permissions.value = await mqListPermissions(props.connectionId, current);
  } catch (e: unknown) {
    const msg = formatError(e);
    // Gracefully handle Kafka brokers without an authorizer configured.
    if (msg.includes("SecurityDisabled") || msg.includes("No Authorizer") || msg.includes("authorizer")) {
      error.value = undefined;
      notice.value = t("mqPermissions.kafkaAuthorizerNotConfigured");
    } else {
      error.value = msg;
    }
  } finally {
    loading.value = false;
  }
}

async function grantPermission() {
  if (!guardWritable()) return;
  const current = scope.value;
  const role = roleName.value.trim();
  roleNameError.value = "";
  actionsError.value = "";
  if (!current) {
    error.value = t("mqPermissions.selectNamespaceOrTopic");
    return;
  }
  if (!role) {
    error.value = undefined;
    roleNameError.value = t("mqPermissions.roleNameRequired");
    await nextTick();
    roleNameInput.value?.focus();
    return;
  }
  if (!selectedActions.value.length) {
    error.value = undefined;
    actionsError.value = t("mqPermissions.selectAtLeastOneAction");
    return;
  }

  loading.value = true;
  error.value = undefined;
  notice.value = undefined;
  try {
    await mqGrantPermission(props.connectionId, current, role, [...selectedActions.value]);
    notice.value = t("mqPermissions.grantedRole", { role });
    roleName.value = "";
    await loadPermissions();
  } catch (e: unknown) {
    const msg = formatError(e);
    if (msg.includes("SecurityDisabled") || msg.includes("No Authorizer") || msg.includes("authorizer")) {
      error.value = t("mqPermissions.kafkaAuthorizerDisabled");
    } else {
      error.value = msg;
    }
  } finally {
    loading.value = false;
  }
}

async function revokePermission(role: string) {
  if (!guardWritable()) return;
  const current = scope.value;
  if (!current) {
    error.value = t("mqPermissions.selectNamespaceOrTopic");
    return;
  }
  if (!confirm(t("mqPermissions.confirmRevoke", { role }))) return;

  loading.value = true;
  error.value = undefined;
  notice.value = undefined;
  try {
    await mqRevokePermission(props.connectionId, current, role);
    notice.value = t("mqPermissions.revokedRole", { role });
    await loadPermissions();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function openTokenDialog(role: string) {
  const row = permissionRows.value.find((item) => item.role === role);
  tokenRole.value = role;
  tokenActions.value = row?.actions?.length ? [...row.actions] : ["produce", "consume"];
  tokenExpiresUnlimited.value = true;
  tokenExpiresDays.value = 30;
  tokenNote.value = "";
  tokenError.value = undefined;
  tokenIssueError.value = undefined;
  issuedToken.value = undefined;
  tokenRecords.value = [];
  showTokenDialog.value = true;
  void loadTokenRecords();
}

function closeTokenDialog() {
  showTokenDialog.value = false;
  issuedToken.value = undefined;
}

async function loadTokenRecords() {
  if (!tokenRole.value) return;
  tokenLoading.value = true;
  tokenError.value = undefined;
  try {
    tokenRecords.value = await mqListTokenRecords(props.connectionId, tokenRole.value);
  } catch (e: unknown) {
    if (isTokenRecordListUnavailable(e)) {
      tokenRecords.value = [];
      return;
    }
    tokenError.value = formatError(e);
  } finally {
    tokenLoading.value = false;
  }
}

async function issueToken() {
  if (props.readOnly) {
    tokenError.value = readOnlyMessage.value;
    tokenIssueError.value = undefined;
    return;
  }
  const current = scope.value;
  if (!current) {
    tokenError.value = t("mqPermissions.selectNamespaceOrTopic");
    tokenIssueError.value = undefined;
    return;
  }
  const subject = tokenRole.value.trim();
  if (!subject) {
    tokenError.value = t("mqPermissions.roleNameEmpty");
    tokenIssueError.value = undefined;
    return;
  }
  let expiresInSeconds: number | undefined;
  if (!tokenExpiresUnlimited.value) {
    const days = Number(tokenExpiresDays.value);
    if (!Number.isFinite(days) || days <= 0) {
      tokenError.value = t("mqPermissions.expiryMustBePositive");
      tokenIssueError.value = undefined;
      return;
    }
    expiresInSeconds = Math.round(days * 24 * 60 * 60);
  }

  tokenLoading.value = true;
  tokenError.value = undefined;
  tokenIssueError.value = undefined;
  issuedToken.value = undefined;
  try {
    issuedToken.value = await mqIssueToken(props.connectionId, {
      subject,
      expiresInSeconds,
      scope: current,
      actions: [...tokenActions.value],
      note: tokenNote.value.trim() || undefined,
    });
    await loadTokenRecords();
  } catch (e: unknown) {
    const formatted = formatMqTokenIssueError(e);
    if (formatted.kind === "missingSigningKey") {
      tokenIssueError.value = formatted;
      tokenError.value = undefined;
    } else {
      tokenError.value = formatted.message;
    }
  } finally {
    tokenLoading.value = false;
  }
}

async function copyIssuedToken() {
  if (!issuedToken.value?.token) return;
  await navigator.clipboard?.writeText(issuedToken.value.token);
}

function formatDate(value?: string) {
  if (!value) return t("mqPermissions.unlimited");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function shortFingerprint(value: string) {
  if (value.length <= 22) return value;
  return `${value.slice(0, 14)}...${value.slice(-8)}`;
}

function isTokenRecordListUnavailable(e: unknown) {
  const message = e instanceof Error ? formatError(e) : String(e ?? "");
  return message.includes("/api/mq/tokens/list returned 404");
}

watch(roleName, (value) => {
  if (value.trim()) {
    roleNameError.value = "";
  }
});

watch(selectedActions, (value) => {
  if (value.length) {
    actionsError.value = "";
  }
});

watch(
  () => [props.tenant, props.namespace, props.topic?.name, props.topic?.persistent],
  () => {
    loadPermissions();
  },
  { immediate: true },
);
</script>

<template>
  <div class="permissions-panel">
    <div class="panel-toolbar">
      <div>
        <h3>{{ panelTitle }}</h3>
        <div v-if="scopeLabel" class="scope-label">{{ scopeLabel }}</div>
      </div>
      <button @click="loadPermissions" :disabled="loading || !scope" class="btn-secondary">
        {{ loading ? t("mqPermissions.refreshing") : t("mqPermissions.refresh") }}
      </button>
    </div>

    <div v-if="!scope" class="panel-placeholder">{{ t("mqPermissions.selectNamespaceOrTopic") }}</div>

    <div v-else class="permissions-content">
      <div v-if="readOnly" class="readonly-hint">{{ t("mqPermissions.readonlyHint") }}</div>
      <div v-if="error" class="panel-error">{{ error }}</div>
      <div v-if="notice" class="panel-notice">{{ notice }}</div>

      <section class="grant-panel">
        <h4>{{ t("mqPermissions.grantRole") }}</h4>
        <div class="grant-row">
          <label>
            {{ t("mqPermissions.roleName") }}
            <input ref="roleNameInput" v-model="roleName" type="text" :placeholder="t('mqPermissions.roleNamePlaceholder')" :disabled="readOnly" :class="{ invalid: roleNameError }" :aria-invalid="!!roleNameError" />
            <span v-if="roleNameError" class="field-error">{{ roleNameError }}</span>
          </label>
          <div class="actions-group" :class="{ invalid: actionsError }">
            <span>{{ t("mqPermissions.actions") }}</span>
            <label v-for="action in visibleActionOptions" :key="action" class="checkbox-label">
              <input v-model="selectedActions" type="checkbox" :value="action" :disabled="readOnly" />
              {{ formatActionLabel(action) }}
            </label>
            <span v-if="actionsError" class="field-error actions-error">{{ actionsError }}</span>
          </div>
          <button @click="grantPermission" :disabled="loading || readOnly" class="btn-primary">{{ t("mqPermissions.grant") }}</button>
        </div>
      </section>

      <section class="permissions-table">
        <h4>{{ t("mqPermissions.currentPermissions") }}</h4>
        <table v-if="permissionRows.length">
          <thead>
            <tr>
              <th>{{ t("mqPermissions.role") }}</th>
              <th>{{ t("mqPermissions.actions") }}</th>
              <th>{{ t("mqPermissions.operations") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in permissionRows" :key="row.role">
              <td class="role-cell">{{ row.role }}</td>
              <td>
                <span class="tag-list">
                  <span v-for="action in row.actions" :key="action" class="tag">{{ formatActionLabel(action) }}</span>
                </span>
              </td>
              <td class="row-actions">
                <button v-if="!isFlatMqCluster" @click="openTokenDialog(row.role)" class="btn-sm">{{ t("mqPermissions.token") }}</button>
                <button @click="revokePermission(row.role)" :disabled="readOnly" class="btn-sm btn-danger">{{ t("mqPermissions.revoke") }}</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="empty-state">{{ t("mqPermissions.noPermissions") }}</div>
      </section>
    </div>

    <div v-if="showTokenDialog" class="dialog-overlay" @click="closeTokenDialog">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>{{ t("mqPermissions.clientTokenTitle", { role: tokenRole }) }}</h3>
          <button @click="closeTokenDialog" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div v-if="tokenError" class="panel-error">{{ tokenError }}</div>
          <div v-if="tokenIssueError?.kind === 'missingSigningKey'" class="token-config-error" role="alert">
            <strong>{{ t(tokenIssueError.titleKey) }}</strong>
            <span>{{ t(tokenIssueError.messageKey) }}</span>
            <small>{{ t(tokenIssueError.detailKey) }}</small>
          </div>
          <div v-if="issuedToken" class="issued-token-box">
            <div class="token-warning">{{ t("mqPermissions.tokenShowOnceWarning") }}</div>
            <textarea :value="issuedToken.token" readonly class="token-textarea" />
            <button class="btn-sm" @click="copyIssuedToken">{{ t("mqPermissions.copyToken") }}</button>
          </div>

          <section class="token-section">
            <h4>{{ t("mqPermissions.issueNewToken") }}</h4>
            <div class="token-form">
              <label>
                {{ t("mqPermissions.role") }}
                <input v-model="tokenRole" type="text" />
              </label>
              <div class="expiry-control">
                <label class="checkbox-label expiry-toggle">
                  <input v-model="tokenExpiresUnlimited" type="checkbox" />
                  {{ t("mqPermissions.neverExpires") }}
                </label>
                <label :class="{ muted: tokenExpiresUnlimited }">
                  {{ t("mqPermissions.expiryDays") }}
                  <input v-model.number="tokenExpiresDays" type="number" min="1" step="1" :disabled="tokenExpiresUnlimited" />
                </label>
              </div>
              <div class="actions-group token-actions">
                <span>{{ t("mqPermissions.actions") }}</span>
                <label v-for="action in visibleActionOptions" :key="action" class="checkbox-label">
                  <input v-model="tokenActions" type="checkbox" :value="action" />
                  {{ formatActionLabel(action) }}
                </label>
              </div>
              <label>
                {{ t("mqPermissions.note") }}
                <input v-model="tokenNote" type="text" :placeholder="t('mqPermissions.notePlaceholder')" />
              </label>
              <button @click="issueToken" :disabled="tokenLoading || readOnly" class="btn-primary">
                {{ tokenLoading ? t("mqPermissions.issuing") : t("mqPermissions.generateToken") }}
              </button>
            </div>
            <p class="token-message">{{ t("mqPermissions.tokenRevokeHint") }}</p>
          </section>

          <section class="token-section">
            <h4>{{ t("mqPermissions.issueRecords") }}</h4>
            <table v-if="tokenRecords.length">
              <thead>
                <tr>
                  <th>{{ t("mqPermissions.time") }}</th>
                  <th>{{ t("mqPermissions.algorithm") }}</th>
                  <th>{{ t("mqPermissions.expires") }}</th>
                  <th>{{ t("mqPermissions.fingerprint") }}</th>
                  <th>{{ t("mqPermissions.noteColumn") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="record in tokenRecords" :key="record.id">
                  <td>{{ formatDate(record.createdAt) }}</td>
                  <td>{{ record.algorithm.toUpperCase() }}</td>
                  <td>{{ formatDate(record.expiresAt) }}</td>
                  <td :title="record.tokenFingerprint">{{ shortFingerprint(record.tokenFingerprint) }}</td>
                  <td>{{ record.note || "-" }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="empty-state">{{ tokenLoading ? t("mqPermissions.loading") : t("mqPermissions.noIssueRecords") }}</div>
          </section>
        </div>
        <div class="dialog-footer">
          <button @click="closeTokenDialog" class="btn-secondary">{{ t("mqPermissions.close") }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.permissions-panel {
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

.scope-label {
  margin-top: 4px;
  color: var(--color-text-secondary);
  font-size: 12px;
}

.permissions-content {
  flex: 1;
  overflow: auto;
  padding: 16px;
}

.grant-panel,
.permissions-table {
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background-secondary);
}

.permissions-table {
  margin-top: 16px;
}

h4 {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
}

.grant-row {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(280px, 2fr) auto;
  gap: 16px;
  align-items: end;
}

label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--color-text-secondary);
  font-size: 13px;
}

input[type="text"],
input[type="number"] {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-background);
  color: var(--color-text);
  box-sizing: border-box;
}

input.invalid {
  border-color: var(--color-error);
  box-shadow: 0 0 0 2px var(--color-error-bg);
}

.field-error {
  color: var(--color-error);
  font-size: 12px;
  line-height: 1.4;
}

.actions-group {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  color: var(--color-text-secondary);
  font-size: 13px;
}

.actions-group.invalid {
  padding: 8px;
  border: 1px solid var(--color-error);
  border-radius: 6px;
  background: var(--color-error-bg);
}

.actions-group > span {
  width: 100%;
}

.actions-error {
  width: 100%;
}

.checkbox-label {
  flex-direction: row;
  align-items: center;
  gap: 6px;
}

.expiry-control {
  display: grid;
  gap: 8px;
}

.expiry-toggle {
  min-height: 30px;
}

.muted {
  color: var(--color-text-tertiary);
}

table {
  width: 100%;
  border-collapse: collapse;
}

th,
td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border-light);
  text-align: left;
}

th {
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 600;
}

.role-cell {
  font-weight: 500;
}

.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.tag {
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--color-primary-alpha);
  color: var(--color-primary);
  font-size: 12px;
}

.empty-state,
.panel-placeholder {
  padding: 24px;
  color: var(--color-text-secondary);
  text-align: center;
}

.panel-error,
.panel-notice,
.readonly-hint {
  padding: 12px 16px;
  margin-bottom: 12px;
  border-radius: 6px;
  font-size: 13px;
}

.panel-error {
  background: var(--color-error-bg);
  color: var(--color-error);
}

.panel-notice {
  background: var(--color-success-alpha);
  color: var(--color-success);
}

.readonly-hint {
  background: var(--color-warning-alpha);
  color: var(--color-warning);
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
}

.btn-primary {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: white;
}

.btn-danger {
  color: var(--color-error);
  border-color: var(--color-error);
}

.dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
}

.dialog {
  width: min(760px, 92vw);
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  border-radius: 8px;
  background: var(--color-background);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}

.dialog-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.btn-close {
  border: none;
  background: none;
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 22px;
  line-height: 1;
}

.dialog-body {
  padding: 18px 20px;
  overflow: auto;
}

.token-message {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.issued-token-box {
  display: grid;
  gap: 10px;
  padding: 12px;
  margin-bottom: 16px;
  border: 1px solid var(--color-warning);
  border-radius: 6px;
  background: var(--color-warning-alpha);
}

.token-config-error {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  margin-bottom: 16px;
  border: 1px solid var(--color-warning);
  border-left-width: 4px;
  border-radius: 6px;
  background: var(--color-warning-alpha);
  color: var(--color-text);
  font-size: 13px;
  line-height: 1.5;
}

.token-config-error strong {
  color: var(--color-warning);
  font-size: 14px;
  font-weight: 700;
}

.token-config-error small {
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.5;
}

.token-warning {
  color: var(--color-warning);
  font-size: 13px;
  font-weight: 600;
}

.token-textarea {
  min-height: 96px;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-background);
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-size: 12px;
  resize: vertical;
}

.token-section {
  margin-top: 16px;
}

.token-form {
  display: grid;
  grid-template-columns: minmax(160px, 1fr) minmax(120px, 0.6fr);
  gap: 12px;
  align-items: end;
}

.token-actions {
  grid-column: 1 / -1;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--color-border);
}

button:disabled,
input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 800px) {
  .grant-row,
  .token-form {
    grid-template-columns: 1fr;
  }
}
</style>

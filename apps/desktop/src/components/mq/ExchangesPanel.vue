<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { MqBindingInfo, MqExchangeInfo, MqExchangeType, NamespaceRef, TopicInfo } from "@/types/mq";
import { mqBind, mqCreateExchange, mqDeleteExchange, mqListBindings, mqListExchanges, mqListTopics, mqUnbind } from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import { isBuiltinRabbitMqExchange, rabbitMqExchangeDisplayName, RABBITMQ_EXCHANGE_TYPES } from "@/lib/mq/rabbitmqExchanges";
import { isAllVhostsNamespace, resolveMqRowNamespace } from "@/lib/mq/mqConsoleDefaults";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";

interface Props {
  connectionId: string;
  tenant?: string;
  namespace?: string;
  readOnly?: boolean;
}

const props = defineProps<Props>();
const { t } = useI18n();

const exchanges = ref<MqExchangeInfo[]>([]);
const loading = ref(false);
const error = ref<string>();
const exchangeSearch = ref("");
const selectedExchange = ref<MqExchangeInfo>();

const bindings = ref<MqBindingInfo[]>([]);
const bindingsLoading = ref(false);
const bindingsError = ref<string>();

const dialogError = ref<string>();
const showCreateDialog = ref(false);
const createForm = ref({
  name: "",
  type: "direct" as MqExchangeType | string,
  durable: true,
  autoDelete: false,
});
const exchangeTypeOptions = RABBITMQ_EXCHANGE_TYPES;

const showDeleteDialog = ref(false);
const deleteTarget = ref<MqExchangeInfo>();
const deleting = ref(false);

const showBindDialog = ref(false);
const bindForm = ref({
  destinationType: "queue" as "queue" | "exchange",
  destination: "",
  routingKey: "",
  argumentsText: "",
});
const binding = ref(false);

const showUnbindDialog = ref(false);
const unbindTarget = ref<MqBindingInfo>();
const unbinding = ref(false);

const availableQueues = ref<TopicInfo[]>([]);

const filteredExchanges = computed(() => {
  const query = exchangeSearch.value.trim().toLowerCase();
  if (!query) return exchanges.value;
  return exchanges.value.filter((exchange) => rabbitMqExchangeDisplayName(exchange).toLowerCase().includes(query));
});

function nsRef(): NamespaceRef | null {
  if (!props.tenant || !props.namespace) return null;
  return { tenant: props.tenant, namespace: props.namespace };
}

// RabbitMQ "all vhosts" mode: rows carry their own vhost in `namespace`, and
// row-level operations must target that vhost rather than the "*" selection.
const showNamespaceColumn = computed(() => isAllVhostsNamespace(props.namespace));

function nsRefFor(row: { namespace?: string } | undefined): NamespaceRef | null {
  if (!props.tenant || !props.namespace) return null;
  const namespace = resolveMqRowNamespace(row, props.namespace);
  if (!namespace) return null;
  return { tenant: props.tenant, namespace };
}

function guardWritable() {
  if (props.readOnly) {
    error.value = t("mqExchanges.readOnly");
    return false;
  }
  return true;
}

async function loadExchanges() {
  const ns = nsRef();
  if (!ns) {
    exchanges.value = [];
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    exchanges.value = await mqListExchanges(props.connectionId, ns);
    if (selectedExchange.value && !exchanges.value.some((exchange) => exchange.name === selectedExchange.value?.name && exchange.namespace === selectedExchange.value?.namespace)) {
      selectedExchange.value = undefined;
      bindings.value = [];
    }
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function loadBindings(exchange: MqExchangeInfo) {
  const ns = nsRefFor(exchange);
  if (!ns) return;
  bindingsLoading.value = true;
  bindingsError.value = undefined;
  try {
    bindings.value = await mqListBindings(props.connectionId, ns, { exchange: exchange.name });
  } catch (e: unknown) {
    bindingsError.value = formatError(e);
  } finally {
    bindingsLoading.value = false;
  }
}

async function loadQueues() {
  const ns = nsRefFor(selectedExchange.value);
  if (!ns) return;
  try {
    availableQueues.value = await mqListTopics(props.connectionId, ns, { includeNonPersistent: false });
  } catch (e: unknown) {
    console.warn("[DBX] Failed to load queues for binding dialog:", e);
  }
}

function selectExchange(exchange: MqExchangeInfo) {
  if (selectedExchange.value?.name === exchange.name && selectedExchange.value?.namespace === exchange.namespace) {
    selectedExchange.value = undefined;
    bindings.value = [];
    return;
  }
  selectedExchange.value = exchange;
  void loadBindings(exchange);
}

function openCreateDialog() {
  if (!guardWritable()) return;
  dialogError.value = undefined;
  createForm.value = { name: "", type: "direct", durable: true, autoDelete: false };
  showCreateDialog.value = true;
}

async function handleCreate() {
  if (!guardWritable()) return;
  const ns = nsRef();
  if (!createForm.value.name.trim() || !ns) {
    dialogError.value = t("mqExchanges.nameRequired");
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    await mqCreateExchange(props.connectionId, ns, {
      name: createForm.value.name.trim(),
      type: createForm.value.type,
      durable: createForm.value.durable,
      autoDelete: createForm.value.autoDelete,
    });
    showCreateDialog.value = false;
    dialogError.value = undefined;
    await loadExchanges();
  } catch (e: unknown) {
    dialogError.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function openDeleteDialog(exchange: MqExchangeInfo) {
  if (!guardWritable()) return;
  if (isBuiltinRabbitMqExchange(exchange)) return;
  deleteTarget.value = exchange;
  showDeleteDialog.value = true;
}

async function confirmDelete() {
  const target = deleteTarget.value;
  if (!target) return;
  const ns = nsRefFor(target);
  if (!ns) {
    error.value = t("mqAdmin.selectNamespaceToWrite");
    return;
  }
  deleting.value = true;
  error.value = undefined;
  try {
    await mqDeleteExchange(props.connectionId, ns, target.name);
    showDeleteDialog.value = false;
    if (selectedExchange.value?.name === target.name && selectedExchange.value?.namespace === target.namespace) {
      selectedExchange.value = undefined;
      bindings.value = [];
    }
    await loadExchanges();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    deleting.value = false;
  }
}

function openBindDialog() {
  if (!guardWritable()) return;
  if (!selectedExchange.value) return;
  dialogError.value = undefined;
  bindForm.value = { destinationType: "queue", destination: "", routingKey: "", argumentsText: "" };
  void loadQueues();
  showBindDialog.value = true;
}

function parseBindingArguments(): Record<string, unknown> | undefined {
  const text = bindForm.value.argumentsText.trim();
  if (!text) return undefined;
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(t("mqExchanges.argumentsMustBeObject"));
  }
  return parsed as Record<string, unknown>;
}

async function handleBind() {
  if (!guardWritable()) return;
  const exchange = selectedExchange.value;
  if (!exchange) return;
  const ns = nsRefFor(exchange);
  if (!ns) {
    dialogError.value = t("mqAdmin.selectNamespaceToWrite");
    return;
  }
  if (!bindForm.value.destination.trim()) {
    dialogError.value = t("mqExchanges.destinationRequired");
    return;
  }
  binding.value = true;
  dialogError.value = undefined;
  try {
    const args = parseBindingArguments();
    await mqBind(props.connectionId, ns, {
      source: exchange.name,
      destination: bindForm.value.destination.trim(),
      destinationType: bindForm.value.destinationType,
      routingKey: bindForm.value.routingKey.trim() || undefined,
      arguments: args,
    });
    showBindDialog.value = false;
    await loadBindings(exchange);
  } catch (e: unknown) {
    dialogError.value = formatError(e);
  } finally {
    binding.value = false;
  }
}

function openUnbindDialog(bindingRow: MqBindingInfo) {
  if (!guardWritable()) return;
  unbindTarget.value = bindingRow;
  showUnbindDialog.value = true;
}

async function confirmUnbind() {
  const target = unbindTarget.value;
  if (!target) return;
  const ns = nsRefFor(target ?? selectedExchange.value);
  if (!ns) {
    bindingsError.value = t("mqAdmin.selectNamespaceToWrite");
    return;
  }
  unbinding.value = true;
  bindingsError.value = undefined;
  try {
    await mqUnbind(props.connectionId, ns, target);
    showUnbindDialog.value = false;
    if (selectedExchange.value) {
      await loadBindings(selectedExchange.value);
    }
  } catch (e: unknown) {
    bindingsError.value = formatError(e);
  } finally {
    unbinding.value = false;
  }
}

function formatBindingArguments(bindingRow: MqBindingInfo): string {
  if (!bindingRow.arguments || !Object.keys(bindingRow.arguments).length) return "-";
  return JSON.stringify(bindingRow.arguments);
}

watch(
  () => [props.tenant, props.namespace],
  () => {
    selectedExchange.value = undefined;
    bindings.value = [];
    loadExchanges();
  },
  { immediate: true },
);
</script>

<template>
  <div class="exchanges-panel">
    <div class="panel-toolbar">
      <div class="toolbar-left">
        <input v-model="exchangeSearch" type="search" class="exchange-search" :placeholder="t('mqExchanges.searchPlaceholder')" :disabled="loading && !exchanges.length" />
        <span v-if="exchanges.length" class="exchange-count">{{ filteredExchanges.length }} / {{ exchanges.length }}</span>
      </div>
      <div class="toolbar-actions">
        <button @click="loadExchanges" :disabled="loading || !tenant || !namespace" class="btn-secondary">
          {{ loading ? t("mqExchanges.refreshing") : t("mqExchanges.refresh") }}
        </button>
        <button @click="openCreateDialog" :disabled="loading || readOnly || !tenant || !namespace || showNamespaceColumn" :title="showNamespaceColumn ? t('mqAdmin.selectNamespaceToCreate') : undefined" class="btn-primary">+ {{ t("mqExchanges.createExchange") }}</button>
      </div>
    </div>

    <div v-if="!tenant || !namespace" class="panel-placeholder">{{ t("mqExchanges.selectNamespace") }}</div>

    <div v-else-if="error" class="panel-error">{{ error }}</div>

    <div v-else-if="loading && !exchanges.length" class="panel-loading">{{ t("mqExchanges.loading") }}</div>

    <div v-else-if="!exchanges.length" class="panel-placeholder">{{ t("mqExchanges.noExchanges") }}</div>

    <div v-else-if="!filteredExchanges.length" class="panel-placeholder">{{ t("mqExchanges.noMatches") }}</div>

    <div v-else class="exchanges-table">
      <table>
        <thead>
          <tr>
            <th>{{ t("mqExchanges.name") }}</th>
            <th v-if="showNamespaceColumn">{{ t("mqAdmin.namespace") }}</th>
            <th>{{ t("mqExchanges.type") }}</th>
            <th>{{ t("mqExchanges.durable") }}</th>
            <th>{{ t("mqExchanges.autoDelete") }}</th>
            <th>{{ t("mqExchanges.actions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="exchange in filteredExchanges" :key="`${exchange.namespace ?? ''}:${exchange.name || '(default)'}`" :class="{ selected: selectedExchange?.name === exchange.name && selectedExchange?.namespace === exchange.namespace }" @click="selectExchange(exchange)">
            <td class="exchange-name">
              <div class="exchange-name-cell">
                <span>{{ rabbitMqExchangeDisplayName(exchange) }}</span>
                <span v-if="isBuiltinRabbitMqExchange(exchange)" class="badge badge-warning">{{ t("mqExchanges.builtin") }}</span>
              </div>
            </td>
            <td v-if="showNamespaceColumn">{{ exchange.namespace || "-" }}</td>
            <td>
              <span class="badge badge-info">{{ exchange.type }}</span>
            </td>
            <td>{{ exchange.durable ? t("mqExchanges.yes") : t("mqExchanges.no") }}</td>
            <td>{{ exchange.autoDelete ? t("mqExchanges.yes") : t("mqExchanges.no") }}</td>
            <td class="actions" @click.stop>
              <button class="btn-sm" @click="selectExchange(exchange)">{{ t("mqExchanges.viewBindings") }}</button>
              <button class="btn-sm btn-danger" :disabled="readOnly || isBuiltinRabbitMqExchange(exchange) || (showNamespaceColumn && !exchange.namespace)" :title="showNamespaceColumn && !exchange.namespace ? t('mqAdmin.selectNamespaceToWrite') : undefined" @click="openDeleteDialog(exchange)">
                {{ t("mqExchanges.delete") }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Bindings of the selected exchange -->
    <div v-if="selectedExchange" class="bindings-section">
      <div class="bindings-header">
        <h4>{{ t("mqExchanges.bindingsTitle", { name: rabbitMqExchangeDisplayName(selectedExchange) }) }}</h4>
        <div class="toolbar-actions">
          <button class="btn-sm" :disabled="bindingsLoading" @click="loadBindings(selectedExchange)">
            {{ bindingsLoading ? t("mqExchanges.refreshing") : t("mqExchanges.refresh") }}
          </button>
          <button class="btn-sm" :disabled="readOnly" @click="openBindDialog">+ {{ t("mqExchanges.bindDestination") }}</button>
        </div>
      </div>

      <div v-if="bindingsError" class="panel-error">{{ bindingsError }}</div>
      <div v-else-if="bindingsLoading && !bindings.length" class="panel-loading">{{ t("mqExchanges.loading") }}</div>
      <div v-else-if="!bindings.length" class="panel-placeholder">{{ t("mqExchanges.noBindings") }}</div>
      <div v-else class="bindings-table">
        <table>
          <thead>
            <tr>
              <th>{{ t("mqExchanges.bindingSource") }}</th>
              <th>{{ t("mqExchanges.bindingDestination") }}</th>
              <th v-if="showNamespaceColumn">{{ t("mqAdmin.namespace") }}</th>
              <th>{{ t("mqExchanges.bindingType") }}</th>
              <th>{{ t("mqExchanges.routingKey") }}</th>
              <th>{{ t("mqExchanges.arguments") }}</th>
              <th>{{ t("mqExchanges.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(bindingRow, index) in bindings" :key="`${bindingRow.namespace ?? ''}:${bindingRow.source}->${bindingRow.destination}:${bindingRow.routingKey ?? ''}:${index}`">
              <td>{{ rabbitMqExchangeDisplayName({ name: bindingRow.source }) }}</td>
              <td class="exchange-name">{{ bindingRow.destination }}</td>
              <td v-if="showNamespaceColumn">{{ bindingRow.namespace || "-" }}</td>
              <td>
                <span class="badge" :class="bindingRow.destinationType === 'exchange' ? 'badge-info' : 'badge-default'">
                  {{ bindingRow.destinationType === "exchange" ? t("mqExchanges.destinationTypeExchange") : t("mqExchanges.destinationTypeQueue") }}
                </span>
              </td>
              <td>{{ bindingRow.routingKey || "-" }}</td>
              <td class="binding-arguments">{{ formatBindingArguments(bindingRow) }}</td>
              <td class="actions">
                <button class="btn-sm btn-danger" :disabled="readOnly" @click="openUnbindDialog(bindingRow)">{{ t("mqExchanges.unbind") }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Create Exchange Dialog -->
    <div v-if="showCreateDialog" class="dialog-overlay" @click="showCreateDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>{{ t("mqExchanges.createExchange") }}</h3>
          <button @click="showCreateDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>{{ t("mqExchanges.virtualHost") }}</label>
            <input type="text" :value="namespace" disabled />
          </div>
          <div class="form-group">
            <label>{{ t("mqExchanges.name") }}*</label>
            <input v-model="createForm.name" type="text" :placeholder="t('mqExchanges.namePlaceholder')" :disabled="readOnly" />
          </div>
          <div class="form-group">
            <label>{{ t("mqExchanges.type") }}*</label>
            <select v-model="createForm.type" :disabled="readOnly">
              <option v-for="type in exchangeTypeOptions" :key="type" :value="type">{{ type }}</option>
            </select>
          </div>
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" v-model="createForm.durable" :disabled="readOnly" />
              {{ t("mqExchanges.durable") }}
            </label>
          </div>
          <div class="form-group">
            <label class="checkbox-label">
              <input type="checkbox" v-model="createForm.autoDelete" :disabled="readOnly" />
              {{ t("mqExchanges.autoDelete") }}
            </label>
          </div>
          <div v-if="dialogError" class="form-error">{{ dialogError }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showCreateDialog = false" class="btn-secondary">{{ t("mqExchanges.cancel") }}</button>
          <button @click="handleCreate" :disabled="loading || readOnly" class="btn-primary">{{ t("mqExchanges.create") }}</button>
        </div>
      </div>
    </div>

    <!-- Bind Dialog -->
    <div v-if="showBindDialog" class="dialog-overlay" @click="showBindDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>{{ t("mqExchanges.bindDialogTitle", { name: selectedExchange ? rabbitMqExchangeDisplayName(selectedExchange) : "" }) }}</h3>
          <button @click="showBindDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>{{ t("mqExchanges.bindingType") }}*</label>
            <select v-model="bindForm.destinationType" :disabled="readOnly">
              <option value="queue">{{ t("mqExchanges.destinationTypeQueue") }}</option>
              <option value="exchange">{{ t("mqExchanges.destinationTypeExchange") }}</option>
            </select>
          </div>
          <div class="form-group">
            <label>{{ t("mqExchanges.bindingDestination") }}*</label>
            <input v-model="bindForm.destination" type="text" list="mq-exchange-bind-queues" :placeholder="bindForm.destinationType === 'queue' ? t('mqExchanges.queueNamePlaceholder') : t('mqExchanges.exchangeNamePlaceholder')" :disabled="readOnly" />
            <datalist id="mq-exchange-bind-queues">
              <option v-for="queue in availableQueues" :key="queue.name" :value="queue.shortName" />
            </datalist>
          </div>
          <div class="form-group">
            <label>{{ t("mqExchanges.routingKey") }}</label>
            <input v-model="bindForm.routingKey" type="text" :placeholder="t('mqExchanges.routingKeyPlaceholder')" :disabled="readOnly" />
          </div>
          <div class="form-group">
            <label>{{ t("mqExchanges.arguments") }}</label>
            <textarea v-model="bindForm.argumentsText" rows="3" class="arguments-textarea" :placeholder="t('mqExchanges.argumentsPlaceholder')" :disabled="readOnly" />
          </div>
          <div v-if="dialogError" class="form-error">{{ dialogError }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showBindDialog = false" class="btn-secondary">{{ t("mqExchanges.cancel") }}</button>
          <button @click="handleBind" :disabled="binding || readOnly" class="btn-primary">{{ t("mqExchanges.bind") }}</button>
        </div>
      </div>
    </div>

    <!-- Delete Exchange Confirm -->
    <DangerConfirmDialog
      v-model:open="showDeleteDialog"
      :title="t('mqExchanges.delete')"
      :message="t('mqExchanges.confirmDelete', { name: deleteTarget ? rabbitMqExchangeDisplayName(deleteTarget) : '' })"
      :confirm-label="t('mqExchanges.delete')"
      :loading="deleting"
      :close-on-confirm="false"
      @confirm="confirmDelete"
    />

    <!-- Unbind Confirm -->
    <DangerConfirmDialog
      v-model:open="showUnbindDialog"
      :title="t('mqExchanges.unbind')"
      :message="t('mqExchanges.confirmUnbind', { destination: unbindTarget?.destination ?? '', source: unbindTarget?.source ?? '' })"
      :confirm-label="t('mqExchanges.unbind')"
      :loading="unbinding"
      :close-on-confirm="false"
      @confirm="confirmUnbind"
    />
  </div>
</template>

<style scoped>
.exchanges-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 16px;
  overflow: auto;
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

.exchange-search {
  width: min(320px, 32vw);
  min-width: 180px;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  background: var(--color-background);
  color: var(--color-text);
  font-size: 13px;
}

.exchange-search:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-alpha);
}

.exchange-count {
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

.exchanges-table,
.bindings-table {
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

.exchanges-table tbody tr {
  cursor: pointer;
  transition: background 0.2s;
}

.exchanges-table tbody tr:hover {
  background: var(--color-hover);
}

.exchanges-table tbody tr.selected {
  background: var(--color-primary-alpha);
}

.exchange-name {
  font-weight: 500;
}

.exchange-name-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: var(--dbx-radius-fixed-4);
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

.binding-arguments {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}

.bindings-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-6);
  padding: 12px;
  background: var(--color-background-secondary);
}

.bindings-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.bindings-header h4 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
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
.form-group select,
.arguments-textarea {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--dbx-radius-fixed-4);
  font-size: 14px;
  box-sizing: border-box;
  background: var(--color-background);
  color: var(--color-text);
}

.arguments-textarea {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  resize: vertical;
}

.form-group input:disabled {
  background: var(--color-background-secondary);
  color: var(--color-text-secondary);
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}

.form-error {
  color: var(--color-error);
  font-size: 13px;
}
</style>

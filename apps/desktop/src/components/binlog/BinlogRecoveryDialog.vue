<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { uuid } from "@/lib/common/utils";
import { open as openFile, save } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { requestBinlog, cancelBinlog, exportBinlogSql, positionFilter, type BinlogCell, type BinlogDetails, type BinlogFilter, type BinlogList, type BinlogRequest, type BinlogRow } from "@/lib/binlog/client";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();
const { t } = useI18n();
const path = ref("");
const schemaPath = ref("");
const historical = ref(false);
const list = ref<BinlogList | null>(null);
const details = ref<BinlogDetails | null>(null);
const selected = ref<string[]>([]);
const focused = ref("");
const sql = ref("");
const error = ref("");
const status = ref("");
const busy = ref(false);
const filters = ref({ database: "", table: "", gtid: "", fromTime: "", toTime: "", fromPosition: "", toPosition: "" });
const applied = ref<BinlogFilter>({});
let requestId = "";
let generation = 0;
const canGenerate = computed(() => !busy.value && selected.value.length > 0 && !!schemaPath.value && historical.value && !!list.value);
const fileName = (value: string) => value.split(/[\\/]/).pop() || value;

function invalidate() {
  generation++;
  sql.value = "";
  status.value = "";
}
watch([selected, schemaPath, historical, filters], invalidate, { deep: true, flush: "sync" });
function stop() {
  generation++;
  if (requestId) void cancelBinlog(requestId).catch(() => {});
}
watch(
  () => props.open,
  (value) => {
    if (!value) {
      stop();
      path.value = "";
      schemaPath.value = "";
      selected.value = [];
      list.value = null;
      details.value = null;
      sql.value = "";
      error.value = "";
      historical.value = false;
    }
  },
);
onBeforeUnmount(stop);
function close() {
  stop();
  emit("update:open", false);
}
async function request<T>(payload: BinlogRequest): Promise<T | undefined> {
  const ticket = ++generation;
  const id = uuid();
  requestId = id;
  busy.value = true;
  error.value = "";
  try {
    const result = await requestBinlog<T>(payload, id);
    if (ticket === generation && props.open) return result;
  } catch (cause) {
    if (ticket === generation && props.open) error.value = String(cause instanceof Error ? cause.message : cause);
  } finally {
    if (requestId === id) {
      requestId = "";
      busy.value = false;
    }
  }
}
async function focusTransaction(start: string, offset = 0) {
  if (!list.value || busy.value) return;
  focused.value = start;
  details.value = null;
  const result = await request<BinlogDetails>({ action: "details", path: path.value, sha256: list.value.sha256, start_position: start, offset });
  if (result) details.value = result;
}
async function loadPage(offset = 0) {
  if (!path.value) return;
  const result = await request<BinlogList>({ action: "list", path: path.value, filter: applied.value, offset });
  if (!result) return;
  if (list.value && result.sha256 !== list.value.sha256) {
    selected.value = [];
    invalidate();
  }
  list.value = result;
  details.value = null;
  focused.value = "";
  if (result.transactions[0]) await focusTransaction(result.transactions[0].start_position);
}
async function importFile() {
  if (!isTauriRuntime()) {
    error.value = t("binlogRecovery.desktopOnly");
    return;
  }
  const chosen = await openFile({ multiple: false, directory: false, title: t("binlogRecovery.importFile") });
  if (typeof chosen !== "string" || !props.open) return;
  invalidate();
  path.value = chosen;
  schemaPath.value = "";
  historical.value = false;
  selected.value = [];
  list.value = null;
  details.value = null;
  applied.value = {};
  filters.value = { database: "", table: "", gtid: "", fromTime: "", toTime: "", fromPosition: "", toPosition: "" };
  await loadPage();
}
async function chooseSchema() {
  const chosen = await openFile({ multiple: false, directory: false, filters: [{ name: "JSON", extensions: ["json"] }], title: t("binlogRecovery.schemaFile") });
  if (typeof chosen === "string" && props.open) {
    schemaPath.value = chosen;
    historical.value = false;
  }
}
async function applyFilters() {
  try {
    const time = (value: string) => {
      if (!value) return undefined;
      const number = Math.floor(new Date(value).getTime() / 1000);
      if (!Number.isSafeInteger(number) || number < 0 || number > 4294967295) throw new Error(t("binlogRecovery.invalidTime"));
      return number;
    };
    const value = filters.value;
    const filter: BinlogFilter = { database: value.database || undefined, table: value.table || undefined, gtid: value.gtid || undefined, from_time: time(value.fromTime), to_time: time(value.toTime), from_position: positionFilter(value.fromPosition), to_position: positionFilter(value.toPosition) };
    if (filter.from_time !== undefined && filter.to_time !== undefined && filter.from_time > filter.to_time) throw new Error(t("binlogRecovery.invalidTime"));
    applied.value = filter;
    selected.value = [];
    invalidate();
    await loadPage();
  } catch (cause) {
    error.value = String(cause instanceof Error ? cause.message : cause);
  }
}
function toggle(start: string) {
  selected.value = selected.value.includes(start) ? selected.value.filter((p) => p !== start) : [...selected.value, start];
}
function selectPage() {
  selected.value = [...new Set([...selected.value, ...(list.value?.transactions.map((tx) => tx.start_position) || [])])];
}
async function generate() {
  if (!canGenerate.value || !list.value) return;
  sql.value = "";
  const result = await request<{ sha256: string; sql: string }>({ action: "generate", path: path.value, sha256: list.value.sha256, schema_path: schemaPath.value, start_positions: [...selected.value] });
  if (result) sql.value = result.sql;
}
async function exportSql() {
  const snapshot = sql.value;
  if (!snapshot || busy.value) return;
  error.value = "";
  status.value = "";
  try {
    const chosen = await save({ defaultPath: "binlog-recovery.sql", filters: [{ name: "SQL", extensions: ["sql"] }] });
    if (!chosen || !props.open || sql.value !== snapshot) return;
    await exportBinlogSql(chosen, snapshot);
    status.value = t("binlogRecovery.exported");
  } catch (cause) {
    error.value = String(cause instanceof Error ? cause.message : cause);
  }
}
function columns(row: BinlogRow) {
  const map = new Map<number, string>();
  for (const cell of [...(row.before || []), ...(row.after || [])]) map.set(cell.ordinal, cell.column);
  return [...map].sort((a, b) => a[0] - b[0]);
}
function cellText(image: BinlogCell[] | null, ordinal: number) {
  const cell = image?.find((value) => value.ordinal === ordinal);
  if (!cell) return t("binlogRecovery.missing");
  if (cell.kind === "null") return t("binlogRecovery.null");
  if (cell.kind === "ambiguous_integer") return `${t("binlogRecovery.signednessUnknown")}: ${cell.value}`;
  return cell.kind === "bytes_hex" ? `0x${cell.value || ""}` : String(cell.value ?? cell.kind);
}
</script>

<template>
  <Dialog :open="open" @update:open="(value) => (value ? emit('update:open', true) : close())">
    <DialogContent class="binlog-dialog" :show-close-button="false" @escape-key-down="close">
      <DialogHeader class="binlog-heading">
        <div class="binlog-title-line">
          <DialogTitle>{{ t("binlogRecovery.title") }}</DialogTitle
          ><span class="binlog-badge">{{ t("binlogRecovery.experimental") }}</span>
        </div>
        <DialogDescription>{{ t("binlogRecovery.notice") }}</DialogDescription>
      </DialogHeader>
      <div class="binlog-body">
        <div class="binlog-files">
          <Button variant="outline" :disabled="busy" @click="importFile">{{ t("binlogRecovery.importFile") }}</Button>
          <span class="binlog-source" :title="path">{{ path ? fileName(path) : t("binlogRecovery.noFile") }}</span>
          <Button variant="outline" :disabled="busy || !path" @click="chooseSchema">{{ t("binlogRecovery.chooseSchema") }}</Button>
          <span v-if="schemaPath" class="binlog-source" :title="schemaPath">{{ fileName(schemaPath) }}</span>
        </div>
        <code v-if="list" class="binlog-hash" aria-label="SHA256">SHA256 {{ list.sha256 }}</code>
        <fieldset class="binlog-filters" :disabled="busy || !path">
          <label v-for="key in ['database', 'table', 'gtid'] as const" :key="key">{{ t(`binlogRecovery.${key}`) }}<input v-model="filters[key]" :aria-label="t(`binlogRecovery.${key}`)" /></label>
          <label v-for="key in ['fromTime', 'toTime'] as const" :key="key">{{ t(`binlogRecovery.${key}`) }}<input v-model="filters[key]" type="datetime-local" :aria-label="t(`binlogRecovery.${key}`)" /></label>
          <label v-for="key in ['fromPosition', 'toPosition'] as const" :key="key">{{ t(`binlogRecovery.${key}`) }}<input v-model="filters[key]" inputmode="numeric" :aria-label="t(`binlogRecovery.${key}`)" /></label>
          <Button variant="outline" :disabled="busy || !path" @click="applyFilters">{{ t("binlogRecovery.apply") }}</Button>
        </fieldset>
        <p v-if="error" role="alert" class="binlog-error">{{ error }}</p>
        <p v-if="status" role="status" class="binlog-success">{{ status }}</p>
        <p v-if="busy" role="status" class="binlog-working">{{ t("binlogRecovery.busy") }}</p>
        <div class="binlog-panels">
          <section class="binlog-panel" :aria-label="t('binlogRecovery.transactions')">
            <div class="binlog-panel-heading">
              <strong>{{ t("binlogRecovery.transactions") }}</strong
              ><span>{{ t("binlogRecovery.selected", { count: selected.length }) }}</span>
            </div>
            <div class="binlog-list-tools">
              <button :disabled="busy || !list?.transactions.length" @click="selectPage">{{ t("binlogRecovery.selectPage") }}</button><button :disabled="busy || !selected.length" @click="selected = []">{{ t("binlogRecovery.clear") }}</button>
            </div>
            <p class="binlog-help">{{ t("binlogRecovery.whole") }}</p>
            <div class="binlog-scroll binlog-transactions">
              <p v-if="!list?.transactions.length" class="binlog-empty">{{ path ? t("binlogRecovery.noResults") : t("binlogRecovery.noFile") }}</p>
              <div v-for="tx in list?.transactions" :key="tx.start_position" class="binlog-transaction" :class="{ 'is-focused': focused === tx.start_position }">
                <input type="checkbox" :data-binlog-select="tx.start_position" :checked="selected.includes(tx.start_position)" :disabled="busy" :aria-label="`${t('binlogRecovery.position')} ${tx.start_position}`" @change="toggle(tx.start_position)" />
                <button :disabled="busy" @click="focusTransaction(tx.start_position)">
                  <span class="binlog-mono">{{ tx.start_position }} → {{ tx.end_position }}</span
                  ><span>{{ t("binlogRecovery.rows", { count: tx.rows }) }}</span>
                  <small>{{ tx.tables.map((table) => table.join(".")).join(", ") }}</small>
                  <small class="binlog-mono">{{ tx.gtid || new Date(tx.timestamp * 1000).toLocaleString() }}</small>
                </button>
              </div>
            </div>
            <div class="binlog-pager">
              <button :disabled="busy || !list || list.offset === 0" @click="loadPage(Math.max(0, (list?.offset || 0) - 100))">{{ t("binlogRecovery.previous") }}</button><span>{{ t("binlogRecovery.total", { count: list?.total || 0 }) }}</span
              ><button :disabled="busy || !list || list.offset + list.transactions.length >= list.total" @click="loadPage((list?.offset || 0) + 100)">{{ t("binlogRecovery.next") }}</button>
            </div>
          </section>
          <section class="binlog-panel" :aria-label="t('binlogRecovery.rowPreview')">
            <div class="binlog-panel-heading">
              <strong>{{ t("binlogRecovery.rowPreview") }}</strong
              ><span v-if="details">{{ t("binlogRecovery.detailsTotal", { count: details.total }) }}</span>
            </div>
            <div class="binlog-scroll binlog-changes">
              <p v-if="!details?.rows.length" class="binlog-empty">{{ t("binlogRecovery.pickTransaction") }}</p>
              <article v-for="(row, index) in details?.rows" :key="`${row.position}-${index}`" class="binlog-change">
                <header>
                  <strong>{{ row.database }}.{{ row.table }}</strong
                  ><code>{{ row.position }}</code>
                </header>
                <p v-if="!row.full_image" class="binlog-error">{{ t("binlogRecovery.partial") }}</p>
                <p v-if="[...(row.before || []), ...(row.after || [])].some((cell) => cell.kind === 'ambiguous_integer')" class="binlog-help">{{ t("binlogRecovery.signednessWarning") }}</p>
                <p v-if="!row.has_column_names" class="binlog-help">{{ t("binlogRecovery.namesWarning") }}</p>
                <table>
                  <thead>
                    <tr>
                      <th>{{ t("binlogRecovery.column") }}</th>
                      <th>{{ t("binlogRecovery.before") }}</th>
                      <th>{{ t("binlogRecovery.after") }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="[ordinal, column] in columns(row)" :key="ordinal">
                      <th>{{ column }}</th>
                      <td>{{ cellText(row.before, ordinal) }}</td>
                      <td>{{ cellText(row.after, ordinal) }}</td>
                    </tr>
                  </tbody>
                </table>
              </article>
            </div>
            <div class="binlog-pager">
              <button :disabled="busy || !details || details.offset === 0" @click="focusTransaction(focused, Math.max(0, (details?.offset || 0) - 100))">{{ t("binlogRecovery.previous") }}</button><span>{{ details ? `${details.offset + 1}–${details.offset + details.rows.length}` : "—" }}</span
              ><button :disabled="busy || !details || details.offset + details.rows.length >= details.total" @click="focusTransaction(focused, (details?.offset || 0) + 100)">{{ t("binlogRecovery.next") }}</button>
            </div>
          </section>
        </div>
        <label class="binlog-attest"><input v-model="historical" data-binlog-attest type="checkbox" :disabled="busy || !schemaPath" />{{ t("binlogRecovery.attest") }}</label>
        <p class="binlog-help">{{ t("binlogRecovery.schemaHelp") }}</p>
        <details class="binlog-sql" :open="!!sql">
          <summary>{{ t("binlogRecovery.sqlTitle") }}</summary>
          <textarea v-if="sql" :value="sql" readonly spellcheck="false" :aria-label="t('binlogRecovery.sqlTitle')" />
          <p v-else class="binlog-help">{{ t("binlogRecovery.noSql") }}</p>
        </details>
        <p class="binlog-safety">{{ t("binlogRecovery.safety") }}</p>
      </div>
      <footer class="binlog-footer">
        <Button variant="ghost" @click="close">{{ t("binlogRecovery.close") }}</Button
        ><Button v-if="busy" variant="outline" @click="stop">{{ t("binlogRecovery.cancel") }}</Button
        ><span class="binlog-spacer" /><Button variant="outline" :disabled="!canGenerate" @click="generate">{{ t("binlogRecovery.generate") }}</Button
        ><Button :disabled="busy || !sql" @click="exportSql">{{ t("binlogRecovery.export") }}</Button>
      </footer>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
:global(.binlog-dialog) {
  width: min(1140px, calc(100vw - 32px));
  max-width: 1140px;
  max-height: calc(100dvh - 32px);
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow: hidden;
}
.binlog-heading {
  padding: 18px 20px 12px;
  border-bottom: 1px solid var(--border);
}
.binlog-title-line {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.binlog-badge {
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 7px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.binlog-body {
  overflow: auto;
  padding: 14px 20px;
  min-height: 0;
}
.binlog-files {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.binlog-source {
  font-size: 11px;
  color: var(--muted-foreground);
  max-width: 270px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.binlog-hash {
  display: block;
  margin-top: 8px;
  color: var(--muted-foreground);
  font-size: 10px;
  overflow-wrap: anywhere;
  user-select: all;
}
.binlog-filters {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin: 14px 0;
  align-items: end;
}
.binlog-filters label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  color: var(--muted-foreground);
}
.binlog-filters input {
  height: 30px;
  min-width: 0;
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 4px 7px;
  background: var(--background);
  color: var(--foreground);
}
.binlog-filters input:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 1px;
}
.binlog-panels {
  display: grid;
  grid-template-columns: minmax(240px, 0.75fr) minmax(0, 1.25fr);
  gap: 12px;
}
.binlog-panel {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 7px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.binlog-panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  background: var(--muted);
  font-size: 12px;
}
.binlog-panel-heading span {
  color: var(--muted-foreground);
  font-size: 11px;
}
.binlog-help {
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted-foreground);
  margin: 7px 0;
}
.binlog-panel > .binlog-help {
  padding: 0 12px;
}
.binlog-list-tools {
  display: flex;
  gap: 14px;
  padding: 8px 12px 0;
  font-size: 11px;
}
.binlog-list-tools button,
.binlog-pager button {
  color: var(--primary);
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
.binlog-scroll {
  overflow: auto;
  min-height: 140px;
  max-height: 270px;
  flex: 1;
}
.binlog-transaction {
  display: flex;
  gap: 8px;
  padding: 9px 12px;
  border-top: 1px solid var(--border);
}
.binlog-transaction > input {
  margin-top: 3px;
  flex-shrink: 0;
}
.binlog-transaction > button {
  display: grid;
  text-align: left;
  gap: 3px;
  grid-template-columns: 1fr auto;
  width: 100%;
  min-width: 0;
  font-size: 11px;
}
.binlog-transaction small {
  grid-column: 1 / -1;
  color: var(--muted-foreground);
  overflow-wrap: anywhere;
}
.binlog-transaction.is-focused {
  background: var(--accent);
}
.binlog-mono,
.binlog-change td,
.binlog-sql textarea {
  font-family: var(--font-mono, monospace);
}
.binlog-pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 12px;
  border-top: 1px solid var(--border);
  font-size: 11px;
}
.binlog-empty {
  margin: 24px 14px;
  color: var(--muted-foreground);
  font-size: 12px;
  line-height: 1.6;
}
.binlog-change {
  padding: 10px;
  border-bottom: 1px solid var(--border);
}
.binlog-change > header {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  margin-bottom: 7px;
}
.binlog-change code {
  color: var(--muted-foreground);
}
.binlog-change table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  font-size: 11px;
}
.binlog-change th,
.binlog-change td {
  text-align: left;
  padding: 6px;
  border: 1px solid var(--border);
  vertical-align: top;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.binlog-change th:first-child {
  width: 24%;
}
.binlog-change thead {
  background: var(--muted);
}
.binlog-attest {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  font-size: 11px;
  margin-top: 14px;
  line-height: 1.5;
}
.binlog-attest input {
  margin-top: 2px;
}
.binlog-sql {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 9px 12px;
  margin-top: 12px;
  font-size: 12px;
}
.binlog-sql summary {
  cursor: pointer;
}
.binlog-sql textarea {
  margin-top: 10px;
  width: 100%;
  min-height: 170px;
  max-height: 250px;
  background: var(--background);
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 11px;
  resize: vertical;
}
.binlog-safety {
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted-foreground);
  padding: 8px 10px;
  border-left: 2px solid var(--border);
  margin-top: 10px;
}
.binlog-error {
  color: var(--destructive);
  font-size: 12px;
  margin: 8px 0;
  overflow-wrap: anywhere;
}
.binlog-success {
  color: var(--primary);
  font-size: 12px;
  margin: 8px 0;
}
.binlog-working {
  font-size: 11px;
  color: var(--muted-foreground);
  margin-bottom: 8px;
}
.binlog-footer {
  border-top: 1px solid var(--border);
  padding: 12px 20px;
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.binlog-spacer {
  flex: 1;
}
@media (max-width: 640px) {
  .binlog-panels {
    grid-template-columns: 1fr;
  }
  .binlog-filters {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .binlog-heading,
  .binlog-body,
  .binlog-footer {
    padding-left: 12px;
    padding-right: 12px;
  }
  .binlog-source {
    max-width: 150px;
  }
  .binlog-scroll {
    max-height: 220px;
  }
}
</style>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { useTabUiState } from "@/lib/tabs/tabUiState";
import { uuid } from "@/lib/common/utils";
import { compileOracleObject, inspectOracleObject, listOracleInvalidObjects, oracleCompileSql, oracleObjectKey, supportsOracleInvalidObjects, type OracleCompileError, type OracleCompileResult, type OracleInvalidObject, type OracleMetadataQuery, type OracleObjectInspection } from "@/lib/database/oracleInvalidObjects";
import type { ConnectionConfig } from "@/types/database";

const props = defineProps<{ connection: ConnectionConfig }>();
const { t } = useI18n({ useScope: "local", messages: {
  en: { title: "Invalid objects", owner: "Exact owner", type: "Object type", all: "All", refresh: "Refresh", more: "Load more", cancel: "Cancel", loading: "Loading", empty: "No visible invalid objects", scope: "Only objects visible to the current account are listed.", select: "Select an object to read its errors and source.", compile: "Preview compile", execute: "Compile this object", status: "Status", errors: "Compilation errors", source: "Source", previous: "Errors before compile", unsupported: "This compile action is not supported for the target engine/type.", available: "Available", unavailable: "Missing or not visible", denied: "Permission denied", error: "Read failed", unknown: "Unknown", changed: "Object changed; refresh before compiling", valid: "Readback confirmed VALID", invalid: "The object is still INVALID or has compilation errors", failed: "Compile or readback failed", cancelled: "Cancellation requested. A sent DDL may already have completed; inspect the readback status.", sent: "Compile statement sent", notSent: "No compile statement sent", effect: "Compilation may invalidate dependent objects. This operation is not a transaction and cannot be undone by cancelling.", noErrors: "No visible compilation errors", noSource: "Source is unavailable; line navigation is disabled." },
  "zh-CN": { title: "无效对象", owner: "精确 owner", type: "对象类型", all: "全部", refresh: "刷新", more: "加载更多", cancel: "取消", loading: "加载中", empty: "无可见的无效对象", scope: "仅列出当前账号可见的对象。", select: "选择对象以读取错误与源码。", compile: "预览编译", execute: "编译此对象", status: "状态", errors: "编译错误", source: "源码", previous: "编译前的错误", unsupported: "目标引擎或对象类型不支持此编译动作。", available: "可读取", unavailable: "对象不存在或不可见", denied: "无权限", error: "读取失败", unknown: "未知", changed: "对象已变更，请刷新后重新编译", valid: "读回确认 VALID", invalid: "对象仍为 INVALID 或存在编译错误", failed: "编译或读回失败", cancelled: "已请求取消。已发送的 DDL 可能已经完成，请核对读回状态。", sent: "已发送编译语句", notSent: "未发送编译语句", effect: "编译可能使依赖对象失效。此操作不是事务，取消不能撤销已完成的 DDL。", noErrors: "无可见编译错误", noSource: "源码不可读取，无法跳转行号。" },
} });
const store = useConnectionStore();
const { initialState, track } = useTabUiState<{ schema?: string; kind?: string; selected?: string }>({}, "OracleInvalidObjects");
const schema = ref(initialState.schema ?? "");
const kind = ref(initialState.kind ?? "");
const selectedKey = ref(initialState.selected ?? "");
track(() => ({ schema: schema.value, kind: kind.value, selected: selectedKey.value }));
const objects = ref<OracleInvalidObject[]>([]);
const inspection = ref<OracleObjectInspection | null>(null);
const outcome = ref<OracleCompileResult | null>(null);
const previousErrors = ref<OracleCompileError[]>([]);
const loadError = ref("");
const detailError = ref("");
const loading = ref(false);
const reading = ref(false);
const applying = ref(false);
const hasMore = ref(false);
const offset = ref(0);
const preview = ref<OracleInvalidObject | null>(null);
const previewOpen = ref(false);
const selectedError = ref<OracleCompileError | null>(null);
const sourceRoot = ref<HTMLElement>();
const activeQueries = new Set<string>();
let listEpoch = 0;
let detailEpoch = 0;
let alive = true;
let cancellationRequested = false;
const selected = computed(() => objects.value.find((item) => oracleObjectKey(item) === selectedKey.value));
const selectedObject = computed(() => inspection.value?.object ?? selected.value);
const previewSql = computed(() => preview.value ? oracleCompileSql(props.connection.db_type, preview.value) : null);
const busy = computed(() => loading.value || reading.value || applying.value);
const types = ["PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE_BODY", "TYPE", "TYPE_BODY", "TRIGGER", "VIEW"];

function queryFor(connection: ConnectionConfig): OracleMetadataQuery {
  const database = connection.database || "";
  return async (sql) => {
    const id = `oracle-invalid-${uuid()}`;
    activeQueries.add(id);
    try { return await api.executeQuery(connection.id, database, sql, undefined, id, { maxRows: 100000, timeoutSecs: 30 }); }
    finally { activeQueries.delete(id); }
  };
}

function cancel() {
  cancellationRequested = true;
  for (const id of activeQueries) void api.cancelQuery(id).catch(() => undefined);
  if (!applying.value) {
    ++listEpoch;
    ++detailEpoch;
    loading.value = reading.value = false;
    loadError.value = t("cancelled");
  }
}

async function load(more = false) {
  if (!supportsOracleInvalidObjects(props.connection.db_type) || applying.value) return;
  const epoch = ++listEpoch;
  const connection = props.connection;
  loading.value = true;
  loadError.value = "";
  cancellationRequested = false;
  const nextOffset = more ? offset.value + 100 : 0;
  try {
    await store.ensureConnected(connection.id);
    const result = await listOracleInvalidObjects(queryFor(connection), schema.value, kind.value, nextOffset);
    if (!alive || epoch !== listEpoch) return;
    objects.value = more ? [...objects.value, ...result.objects] : result.objects;
    hasMore.value = result.has_more;
    offset.value = nextOffset;
    if (!selected.value) { selectedKey.value = ""; inspection.value = null; ++detailEpoch; }
    else if (!more) await readSelected();
  } catch (cause) { if (alive && epoch === listEpoch) loadError.value = String(cause instanceof Error ? cause.message : cause); }
  finally { if (alive && epoch === listEpoch) loading.value = false; }
}

async function readSelected() {
  const target = selected.value;
  if (!target || applying.value) return;
  const epoch = ++detailEpoch;
  const connection = props.connection;
  reading.value = true;
  detailError.value = "";
  inspection.value = null;
  outcome.value = null;
  selectedError.value = null;
  previousErrors.value = [];
  try {
    const result = await inspectOracleObject(queryFor(connection), target);
    if (alive && epoch === detailEpoch) inspection.value = result;
  } catch (cause) { if (alive && epoch === detailEpoch) detailError.value = String(cause instanceof Error ? cause.message : cause); }
  finally { if (alive && epoch === detailEpoch) reading.value = false; }
}

function select(item: OracleInvalidObject) { selectedKey.value = oracleObjectKey(item); void readSelected(); }
function openPreview() { if (selectedObject.value) { preview.value = { ...selectedObject.value }; previewOpen.value = true; } }

async function apply() {
  const target = preview.value;
  const sql = previewSql.value;
  if (!target || !sql || applying.value) return;
  const connection = props.connection;
  const epoch = detailEpoch;
  applying.value = true;
  cancellationRequested = false;
  previousErrors.value = [...(inspection.value?.errors.rows ?? [])];
  try {
    const query = queryFor(connection);
    const result = await executeWithProductionContextGuard({ connection, database: connection.database, reviewText: sql, source: t("title"), execute: () => compileOracleObject({
      databaseType: connection.db_type, target, query, cancelled: () => cancellationRequested || !alive || epoch !== detailEpoch,
      execute: async (statement) => { const response = await query(statement); if (response.execution_error) throw new Error(response.error ? formatError(response.error) : String(response.rows[0]?.[0] ?? "Compile failed")); return true; },
    }) });
    if (!alive || epoch !== detailEpoch) return;
    if (result) {
      outcome.value = result;
      inspection.value = { object: result.object, errors: result.errors, source: result.object?.object_id === target.object_id && result.outcome !== "changed" ? inspection.value?.source ?? { state: "unavailable", rows: [] } : { state: "unavailable", rows: [] } };
    }
    previewOpen.value = false;
  } catch (cause) { if (alive && epoch === detailEpoch) detailError.value = String(cause instanceof Error ? cause.message : cause); }
  finally { if (alive) { applying.value = false; if (epoch !== detailEpoch) void load(); } }
}

async function reveal(error: OracleCompileError) {
  selectedError.value = error;
  await nextTick();
  sourceRoot.value?.querySelector(`[data-source-line="${Math.max(0, error.line)}"]`)?.scrollIntoView({ block: "center" });
}
function sourceParts(line: number, text: string) {
  const position = selectedError.value?.line === line ? selectedError.value.position : 0;
  const characters = Array.from(text);
  return position > 0 ? [characters.slice(0, position - 1).join(""), characters[position - 1] ?? " ", characters.slice(position).join("")] : [text, "", ""];
}

watch(() => [props.connection.id, props.connection.database, props.connection.db_type], () => {
  cancel();
  ++listEpoch;
  ++detailEpoch;
  loading.value = reading.value = false;
  objects.value = [];
  inspection.value = null;
  outcome.value = null;
  previewOpen.value = false;
  preview.value = null;
  selectedKey.value = "";
  detailError.value = "";
  void load();
}, { immediate: true });
onBeforeUnmount(() => { alive = false; cancel(); });
</script>

<template>
  <div class="flex h-full min-h-0 flex-col text-xs">
    <div class="flex flex-wrap items-center gap-2 border-b p-3">
      <span class="font-medium">{{ t("title") }}</span>
      <Input v-model="schema" class="h-7 w-44" :placeholder="t('owner')" :aria-label="t('owner')" :disabled="busy" @keydown.enter="load(false)" />
      <select v-model="kind" class="h-7 rounded border bg-background px-2" :aria-label="t('type')" :disabled="busy"><option value="">{{ t("all") }}</option><option v-for="type in types" :key="type" :value="type">{{ type.replaceAll('_', ' ') }}</option></select>
      <Button size="sm" variant="outline" :disabled="busy" @click="load(false)">{{ t("refresh") }}</Button>
      <Button v-if="busy" size="sm" variant="ghost" @click="cancel">{{ t("cancel") }}</Button>
    </div>
    <p class="px-3 py-2 text-muted-foreground">{{ t("scope") }}</p>
    <p v-if="loadError" role="alert" class="px-3 text-destructive">{{ loadError }}</p>
    <div class="grid min-h-0 flex-1 grid-cols-[minmax(12rem,1fr)_minmax(0,3fr)]">
      <div class="overflow-auto border-r p-2">
        <p v-if="loading">{{ t("loading") }}</p><p v-else-if="!objects.length && !loadError">{{ t("empty") }}</p>
        <button v-for="item in objects" :key="oracleObjectKey(item)" class="block w-full rounded p-2 text-left font-mono break-all hover:bg-muted" :class="{ 'bg-accent': selectedKey === oracleObjectKey(item) }" :disabled="applying" @click="select(item)">{{ item.schema }}.{{ item.name }}<span class="block text-muted-foreground">{{ item.object_type }} · {{ item.status }}</span></button>
        <Button v-if="hasMore" variant="outline" size="sm" :disabled="busy" @click="load(true)">{{ t("more") }}</Button>
      </div>
      <div class="min-h-0 overflow-auto p-3">
        <p v-if="reading">{{ t("loading") }}</p><p v-if="detailError" role="alert" class="text-destructive">{{ detailError }}</p>
        <template v-if="inspection">
          <div class="mb-3 flex items-center gap-2"><span class="flex-1">{{ t("status") }}: {{ inspection.object?.status ?? t(inspection.object ? "unknown" : "unavailable") }}</span><Button size="sm" variant="outline" :disabled="busy || !inspection.object || !oracleCompileSql(connection.db_type, inspection.object)" @click="openPreview">{{ t("compile") }}</Button></div>
          <p v-if="inspection.object && !oracleCompileSql(connection.db_type, inspection.object)" class="mb-2 text-muted-foreground">{{ t("unsupported") }}</p>
          <div v-if="outcome" role="status" class="mb-3 rounded border p-2"><p>{{ t(outcome.outcome) }}</p><p>{{ t(outcome.statement_sent ? "sent" : "notSent") }}</p><pre v-if="outcome.execution_error" class="whitespace-pre-wrap text-destructive">{{ outcome.execution_error }}</pre></div>
          <h3 class="font-medium">{{ t("errors") }}</h3>
          <p v-if="inspection.errors.state !== 'available'">{{ t(inspection.errors.state === 'empty' ? 'noErrors' : inspection.errors.state) }}</p><p v-if="inspection.errors.message" class="text-destructive">{{ inspection.errors.message }}</p>
          <button v-for="error in inspection.errors.rows" :key="error.sequence" class="my-1 block w-full border-b p-1 text-left" :disabled="!inspection.source.rows.some(line => line.line === error.line)" @click="reveal(error)"><span>{{ selectedObject?.schema }}.{{ selectedObject?.name }} ({{ selectedObject?.object_type }}) · #{{ error.sequence }} · {{ error.line }}:{{ error.position }} · {{ error.attribute }}</span><pre class="whitespace-pre-wrap">{{ error.text }}</pre></button>
          <details v-if="previousErrors.length" class="my-3"><summary>{{ t("previous") }}</summary><pre v-for="error in previousErrors" :key="error.sequence" class="whitespace-pre-wrap">{{ error.sequence }} · {{ error.line }}:{{ error.position }} · {{ error.text }}</pre></details>
          <h3 class="mt-3 font-medium">{{ t("source") }}</h3><p v-if="inspection.source.state !== 'available'">{{ t("noSource") }} {{ inspection.source.message }}</p>
          <div ref="sourceRoot" class="mt-2 max-h-96 overflow-auto rounded border font-mono"><div v-for="(line, index) in inspection.source.rows" :key="index" :data-source-line="line.line" class="flex whitespace-pre" :class="{ 'bg-accent': selectedError?.line === line.line }"><span class="w-12 shrink-0 select-none pr-3 text-right text-muted-foreground">{{ line.line }}</span><span>{{ sourceParts(line.line, line.text)[0] }}<mark>{{ sourceParts(line.line, line.text)[1] }}</mark>{{ sourceParts(line.line, line.text)[2] }}</span></div></div>
        </template>
        <p v-else-if="!reading && !detailError">{{ t("select") }}</p>
      </div>
    </div>
    <Dialog v-model:open="previewOpen"><DialogContent><DialogHeader><DialogTitle>{{ t("compile") }}</DialogTitle></DialogHeader><p>{{ t("effect") }}</p><pre class="whitespace-pre-wrap break-all rounded border p-3">{{ previewSql }}</pre><DialogFooter><Button variant="outline" :disabled="applying" @click="previewOpen = false">{{ t("cancel") }}</Button><Button :disabled="applying || !previewSql" @click="apply">{{ t("execute") }}</Button></DialogFooter></DialogContent></Dialog>
  </div>
</template>

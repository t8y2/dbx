<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from "vue";
import { uuid } from "@/lib/common/utils";
import { useI18n } from "vue-i18n";
import { RefreshCw, Trash2, Plus, Save, ChevronLeft, ChevronRight, Table2, Braces, X, Columns3, Check, Search, Wrench, Filter } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import ErrorBanner from "@/components/ui/ErrorBanner.vue";
import DataGrid from "@/components/grid/DataGrid.vue";
import QueryLoadingState from "@/components/common/QueryLoadingState.vue";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { clampSearchSplitWidth } from "@/lib/dataGrid/dataGridSearchSplit";
import { documentViewerFontStyle } from "@/lib/document/documentViewerFontStyle";
import {
  buildDocumentFilterCondition,
  combineDocumentFilterConditions,
  currentDocumentFilterJson,
  currentDocumentSortJson,
  defaultDocumentFilterRule,
  documentFilterModeNeedsValue,
  documentFilterModeOptions,
  documentStoreProviderFor,
  type DocumentFilterMode,
  type DocumentFilterRule,
} from "@/lib/app/documentStoreProvider";
import { buildMongoInsertDocument, buildMongoUpdateDocument, formatMongoShellLiteral, parseMongoDocumentInputValue, type MongoInputValue } from "@/lib/mongo/mongoDocumentValues";
import { normalizeResultPageSize } from "@/lib/dataGrid/paginationPageSize";
import { useSettingsStore } from "@/stores/settingsStore";
import JsonEditNode from "./JsonEditNode.vue";
import type { EditNode } from "@/types/editor";
import type { DatabaseType, QueryResult } from "@/types/database";
import type { CustomSaveHandler } from "@/composables/useDataGridEditor";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";

const { t } = useI18n();
const settingsStore = useSettingsStore();
const connectionStore = useConnectionStore();

const props = defineProps<{
  connectionId: string;
  database: string;
  collection: string;
  databaseType?: DatabaseType;
}>();

type JsonRecord = Record<string, unknown>;
type ViewMode = "document" | "table";

const documents = ref<JsonRecord[]>([]);
const lastGridColumns = ref<string[]>([]);
const total = ref(0);
const loading = ref(false);
const documentLoadExecutionId = ref("");
const documentLoadCancelling = ref(false);
const documentLoadingElapsedSeconds = ref("0.0");
const page = ref(0);
const pageSize = ref(normalizeResultPageSize(settingsStore.editorSettings.pageSize));
const selectedIdx = ref<number | null>(null);
const editJson = ref("");
const isEditing = ref(false);
const isNew = ref(false);
const error = ref("");
const editFields = ref<EditNode[]>([]);
const showDeleteConfirm = ref(false);
const viewMode = computed<ViewMode>({
  get: () => settingsStore.editorSettings.mongoViewMode,
  set: (value) => settingsStore.updateEditorSettings({ mongoViewMode: value }),
});
const filterInput = ref("");
const sortInput = ref("");
const dataGridRef = ref<InstanceType<typeof DataGrid>>();
const columnVisibilitySearch = ref("");
const columnVisibilityOptions = computed(() => dataGridRef.value?.filteredColumnVisibilityOptions(columnVisibilitySearch.value) ?? []);
const tableSearchSplitContainerRef = ref<HTMLDivElement>();
const tableFindPaneWidth = ref<number | null>(null);
const isResizingTableSearchSplit = ref(false);
let tableSearchSplitStartX = 0;
let tableSearchSplitStartWidth = 0;
const documentStoreProvider = computed(() => documentStoreProviderFor(props.databaseType));

const tableFindPaneStyle = computed(() => {
  if (tableFindPaneWidth.value == null) return {};
  return { flex: `0 0 ${tableFindPaneWidth.value}px` };
});
const documentFontStyle = computed(() => documentViewerFontStyle(settingsStore.editorSettings));
const documentStoreLabels = computed(() => ({
  documentsLabel: documentStoreProvider.value.documentsLabel({ total: total.value, t }),
  queryPreview: documentQueryPreview.value,
}));

type PendingDelete = { kind: "document"; index: number } | { kind: "field"; index: number; name: string };
type LocalFilterSummary = {
  columnIndex: number;
  columnName: string;
  values: string[];
  hiddenValueCount: number;
};
type DocumentGridChanges = {
  dirtyRows: Map<number, Map<number, MongoInputValue>>;
  deletedRows: Set<number>;
  newRows: MongoInputValue[][];
  columns: string[];
  rows: MongoInputValue[][];
};
const documentFilterBuilderOpen = ref(false);
const documentFilterRules = ref<DocumentFilterRule[]>([]);
const appliedDocumentFilter = ref<Record<string, unknown> | null>(null);

const pendingDelete = ref<PendingDelete | null>(null);

const selectedDoc = computed(() => {
  if (selectedIdx.value === null) return null;
  return documents.value[selectedIdx.value] ?? null;
});

const editKeyWidth = computed(() => {
  const longest = editFields.value.reduce((max, field) => {
    return Math.max(max, Array.from(field.keyName || "").length);
  }, 0);
  return `${Math.min(Math.max(longest + 4, 8), 36)}ch`;
});

const deleteDetails = computed(() => {
  const pending = pendingDelete.value;
  if (!pending) return "";
  if (pending.kind === "document") {
    const id = documents.value[pending.index]?._id ?? "";
    if (props.databaseType === "elasticsearch") return `Elasticsearch index: ${props.collection}\nDocument _id: ${String(id)}`;
    return t("dangerDialog.mongoDocumentDetails", { collection: props.collection, id: String(id) });
  }
  return t("dangerDialog.mongoFieldDetails", { field: pending.name || t("mongo.field") });
});

const gridResult = computed<QueryResult>(() => {
  const docs = documents.value;
  if (!docs.length) {
    return {
      columns: lastGridColumns.value,
      rows: [],
      affected_rows: 0,
      execution_time_ms: 0,
      truncated: false,
    };
  }

  const keySet = new Set<string>();
  keySet.add("_id");
  for (const doc of docs) {
    for (const key of Object.keys(doc)) {
      if (key !== "_id") keySet.add(key);
    }
  }
  const columns = [...keySet];

  const rows = docs.map((doc) =>
    columns.map((col) => {
      const val = doc[col];
      if (val === undefined || val === null) return null;
      if (typeof val === "object") return JSON.stringify(val);
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") return val;
      return String(val);
    }),
  );

  return { columns, rows, mongo_documents: docs, affected_rows: 0, execution_time_ms: 0, truncated: false };
});
const documentFilterFieldOptions = computed(() => gridResult.value.columns);
const documentStructuredFilterCount = computed(() => (appliedDocumentFilter.value ? 1 : 0));
const documentLoadingLabelKey = computed(() => (documentLoadCancelling.value ? "common.stopping" : "common.loading"));
let documentLoadingTimer: ReturnType<typeof setInterval> | undefined;

function createDocumentFilterRule(): DocumentFilterRule {
  return defaultDocumentFilterRule(uuid(), documentFilterFieldOptions.value[0] ?? "");
}

function ensureDocumentFilterRule() {
  if (documentFilterRules.value.length === 0 && documentFilterFieldOptions.value.length > 0) {
    documentFilterRules.value = [createDocumentFilterRule()];
  }
}

function addDocumentFilterRule() {
  ensureDocumentFilterRule();
  documentFilterRules.value = [...documentFilterRules.value, createDocumentFilterRule()];
}

function removeDocumentFilterRule(ruleId: string) {
  documentFilterRules.value = documentFilterRules.value.filter((rule) => rule.id !== ruleId);
  if (documentFilterRules.value.length === 0) appliedDocumentFilter.value = null;
}

function updateDocumentFilterRule(ruleId: string, patch: Partial<DocumentFilterRule>) {
  documentFilterRules.value = documentFilterRules.value.map((rule) => {
    if (rule.id !== ruleId) return rule;
    const next = { ...rule, ...patch };
    if (!documentFilterModeNeedsValue(next.mode)) next.rawValue = "";
    return next;
  });
}

function resetDocumentFilterBuilder() {
  appliedDocumentFilter.value = null;
  documentFilterRules.value = documentFilterFieldOptions.value.length > 0 ? [createDocumentFilterRule()] : [];
}

function currentDocumentFilter(): string | undefined {
  return currentDocumentFilterJson(filterInput.value, appliedDocumentFilter.value, documentStoreProvider.value.kind);
}

const documentQueryPreview = computed(() => {
  let filter = "{}";
  try {
    filter = currentDocumentFilter() ?? "{}";
  } catch {
    filter = filterInput.value.trim() || "{}";
  }
  return documentStoreProvider.value.queryPreview({
    collection: props.collection,
    filterJson: filter,
    sortJson: sortInput.value.trim(),
    skip: page.value * pageSize.value,
    limit: pageSize.value,
  });
});

async function applyDocumentStructuredFilters() {
  const items = documentFilterRules.value
    .map((rule) => ({
      rule,
      condition: buildDocumentFilterCondition(rule, { kind: documentStoreProvider.value.kind }),
    }))
    .filter((item): item is { rule: DocumentFilterRule; condition: Record<string, unknown> } => !!item.condition);
  const structured = combineDocumentFilterConditions(
    items.map((item) => item.condition),
    items.map((item) => item.rule),
  );
  appliedDocumentFilter.value = structured;
  documentFilterBuilderOpen.value = false;
  applyFilter();
}

function clearDocumentFilters(clearLocalFilter?: (columnIndex?: number) => void) {
  appliedDocumentFilter.value = null;
  resetDocumentFilterBuilder();
  clearLocalFilter?.();
  applyFilter();
}

function documentIdFromGridValue(value: MongoInputValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = parseMongoDocumentInputValue(value);
  if (parsed === null || parsed === undefined) return null;
  const id = typeof parsed === "object" ? JSON.stringify(parsed) : String(parsed);
  return id.trim() ? id : null;
}

function documentRoutingValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const routing = typeof value === "string" ? value : String(value);
  const trimmed = routing.trim();
  return trimmed ? trimmed : undefined;
}

function documentRoutingFromDocument(doc: JsonRecord | undefined): string | undefined {
  return documentRoutingValue(doc?._routing);
}

function documentRoutingFromGridRow(row: MongoInputValue[] | undefined, columns: string[]): string | undefined {
  const routingColIdx = columns.indexOf("_routing");
  return routingColIdx >= 0 ? documentRoutingValue(row?.[routingColIdx]) : undefined;
}

async function gridSave(changes: DocumentGridChanges) {
  const cols = changes.columns;
  const idColIdx = cols.indexOf("_id");
  if (idColIdx < 0) throw new Error("No _id column");
  const isEs = documentStoreProvider.value.kind === "elasticsearch";

  for (const [rowIdx, dirtyCols] of changes.dirtyRows) {
    const row = changes.rows[rowIdx];
    const id = row?.[idColIdx];
    if (id == null) continue;

    if (isEs) {
      const doc = documents.value[rowIdx];
      if (!doc) continue;
      const routing = documentRoutingFromDocument(doc);
      const updated = { ...doc };
      for (const [colIdx, newVal] of dirtyCols) {
        const col = cols[colIdx];
        if (col === "_id" || col === "_routing") continue;
        if (newVal === null) {
          delete updated[col];
        } else {
          updated[col] = parseMongoDocumentInputValue(newVal);
        }
      }
      await api.documentUpdateDocument(props.connectionId, props.database, props.collection, String(id), JSON.stringify(updated), routing);
      continue;
    }

    const updateDoc = buildMongoUpdateDocument(dirtyCols, cols, documents.value[rowIdx]);
    if (Object.keys(updateDoc).length === 0) continue;
    await api.documentUpdateDocument(props.connectionId, props.database, props.collection, String(id), JSON.stringify(updateDoc));
  }

  for (const rowIdx of changes.deletedRows) {
    const row = changes.rows[rowIdx];
    const id = row?.[idColIdx];
    if (id == null) continue;
    const routing = isEs ? documentRoutingFromDocument(documents.value[rowIdx]) : undefined;
    await api.documentDeleteDocument(props.connectionId, props.database, props.collection, String(id), routing);
  }

  for (const newRow of changes.newRows) {
    const doc = buildMongoInsertDocument(newRow, cols);
    if (isEs) {
      const id = documentIdFromGridValue(newRow[idColIdx]);
      if (id) {
        await api.documentUpdateDocument(props.connectionId, props.database, props.collection, id, JSON.stringify(doc), documentRoutingFromGridRow(newRow, cols));
      } else {
        await api.documentInsertDocument(props.connectionId, props.database, props.collection, JSON.stringify(doc));
      }
      continue;
    }
    await api.documentInsertDocument(props.connectionId, props.database, props.collection, JSON.stringify(doc));
  }

  await load();
}

function formatMongoValue(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "number" || typeof val === "boolean") return String(val);
  if (typeof val === "string") return JSON.stringify(val);
  return JSON.stringify(val);
}

function mongoIdPreview(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "string" && /^[a-fA-F0-9]{24}$/.test(val)) return `ObjectId("${val}")`;
  return formatMongoValue(val);
}

function elasticsearchPathIdPreview(id: string): string {
  return encodeURIComponent(id);
}

function elasticsearchRoutingPreview(routing: string | undefined): string {
  return routing ? `?routing=${encodeURIComponent(routing)}` : "";
}

function buildElasticsearchPartialUpdateDocument(changes: Map<number, MongoInputValue>, columns: string[]): Record<string, unknown> {
  const filtered = new Map<number, MongoInputValue>();
  for (const [colIdx, newVal] of changes) {
    const col = columns[colIdx];
    if (col === "_id" || col === "_routing") continue;
    filtered.set(colIdx, newVal);
  }
  return buildMongoUpdateDocument(filtered, columns);
}

async function previewDocumentChanges(changes: DocumentGridChanges): Promise<string[]> {
  const { dirtyRows, deletedRows, newRows, columns, rows } = changes;
  const idColIdx = columns.indexOf("_id");
  const stmts: string[] = [];
  const coll = props.collection;
  const isEs = documentStoreProvider.value.kind === "elasticsearch";

  for (const [rowIdx, dirtyCols] of dirtyRows) {
    const row = rows[rowIdx];
    const id = row?.[idColIdx];
    if (id == null) continue;
    if (isEs) {
      const updateDoc = buildElasticsearchPartialUpdateDocument(dirtyCols, columns);
      const routing = documentRoutingFromGridRow(row, columns);
      stmts.push(`POST /${coll}/_update/${elasticsearchPathIdPreview(String(id))}${elasticsearchRoutingPreview(routing)}\n${JSON.stringify({ doc: updateDoc.$set ?? updateDoc }, null, 2)}`);
    } else {
      const updateDoc = buildMongoUpdateDocument(dirtyCols, columns, documents.value[rowIdx]);
      stmts.push(`db.${coll}.updateOne({_id: ${mongoIdPreview(id)}}, ${formatMongoShellLiteral(updateDoc)})`);
    }
  }

  for (const rowIdx of deletedRows) {
    const row = rows[rowIdx];
    const id = row?.[idColIdx];
    if (id == null) continue;
    if (isEs) {
      const routing = documentRoutingFromGridRow(row, columns);
      stmts.push(`DELETE /${coll}/_doc/${elasticsearchPathIdPreview(String(id))}${elasticsearchRoutingPreview(routing)}`);
    } else {
      stmts.push(`db.${coll}.deleteOne({_id: ${mongoIdPreview(id)}})`);
    }
  }

  for (const newRow of newRows) {
    const doc = buildMongoInsertDocument(newRow, columns);
    if (isEs) {
      const id = idColIdx >= 0 ? documentIdFromGridValue(newRow[idColIdx]) : null;
      if (id) {
        stmts.push(`PUT /${coll}/_doc/${elasticsearchPathIdPreview(id)}\n${JSON.stringify(doc, null, 2)}`);
      } else {
        stmts.push(`POST /${coll}/_doc\n${JSON.stringify(doc, null, 2)}`);
      }
    } else {
      stmts.push(`db.${coll}.insertOne(${formatMongoShellLiteral(doc)})`);
    }
  }

  return stmts;
}

const customSaveHandler = computed<CustomSaveHandler>(() => ({
  save: gridSave,
  preview: previewDocumentChanges,
  supportsInsert: true,
  readonlyColumns: documentStoreProvider.value.kind === "elasticsearch" ? ["_routing"] : undefined,
  targetLabel: props.collection,
}));

function stopDocumentLoadingTimer() {
  if (documentLoadingTimer) clearInterval(documentLoadingTimer);
  documentLoadingTimer = undefined;
}

function startDocumentLoadingTimer() {
  stopDocumentLoadingTimer();
  const startedAt = Date.now();
  documentLoadingElapsedSeconds.value = "0.0";
  documentLoadingTimer = setInterval(() => {
    documentLoadingElapsedSeconds.value = ((Date.now() - startedAt) / 1000).toFixed(1);
  }, 100);
}

async function load() {
  if (documentLoadExecutionId.value) void api.cancelQuery(documentLoadExecutionId.value);
  const executionId = uuid();
  loading.value = true;
  documentLoadExecutionId.value = executionId;
  documentLoadCancelling.value = false;
  startDocumentLoadingTimer();
  error.value = "";
  const previousSelectedIdx = selectedIdx.value;
  const previousSelectedId = previousSelectedIdx === null ? null : documentIdentity(documents.value[previousSelectedIdx]);
  try {
    const filter = currentDocumentFilter();
    const sort = currentDocumentSortJson(sortInput.value);
    const result = await api.documentFindDocuments(props.connectionId, props.database, props.collection, page.value * pageSize.value, pageSize.value, filter, undefined, sort, executionId);
    if (documentLoadExecutionId.value !== executionId) return;
    const nextDocuments = result.documents.map(asRecord);
    documents.value = nextDocuments;
    if (nextDocuments.length > 0) {
      const keySet = new Set<string>();
      keySet.add("_id");
      for (const doc of nextDocuments) {
        for (const key of Object.keys(doc)) {
          if (key !== "_id") keySet.add(key);
        }
      }
      lastGridColumns.value = [...keySet];
    }
    total.value = result.total;
    syncSelectedDocumentAfterLoad(previousSelectedIdx, previousSelectedId);
  } catch (e: unknown) {
    if (documentLoadExecutionId.value === executionId) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (documentLoadExecutionId.value === executionId) {
      loading.value = false;
      documentLoadExecutionId.value = "";
      documentLoadCancelling.value = false;
      stopDocumentLoadingTimer();
    }
  }
}

async function cancelDocumentLoad() {
  const executionId = documentLoadExecutionId.value;
  if (!executionId || documentLoadCancelling.value) return;
  documentLoadCancelling.value = true;
  try {
    await api.cancelQuery(executionId);
  } finally {
    if (documentLoadExecutionId.value === executionId) {
      loading.value = false;
      documentLoadExecutionId.value = "";
      documentLoadCancelling.value = false;
      stopDocumentLoadingTimer();
    }
  }
}

function applyFilter() {
  page.value = 0;
  load();
}

function paginate(offset: number, limit: number) {
  const normalizedLimit = normalizeResultPageSize(limit, pageSize.value);
  pageSize.value = normalizedLimit;
  page.value = Math.floor(Math.max(0, offset) / normalizedLimit);
  load();
}

function onSort(column: string, _columnIndex: number, direction: "asc" | "desc" | null) {
  sortInput.value = documentStoreProvider.value.sortInputForColumn(column, direction);
  page.value = 0;
  load();
}

function asRecord(value: unknown): JsonRecord {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return {};
}

function documentIdentity(doc: JsonRecord | undefined): string | null {
  const id = doc?._id;
  if (id === null || id === undefined) return null;
  return typeof id === "object" ? JSON.stringify(id) : String(id);
}

function syncSelectedDocumentAfterLoad(previousSelectedIdx: number | null, previousSelectedId: string | null) {
  if (isNew.value || previousSelectedIdx === null) return;
  if (!documents.value.length) {
    selectedIdx.value = null;
    if (!isEditing.value) editJson.value = "";
    return;
  }

  const nextIdx = previousSelectedId ? documents.value.findIndex((doc) => documentIdentity(doc) === previousSelectedId) : previousSelectedIdx < documents.value.length ? previousSelectedIdx : -1;
  if (nextIdx < 0) {
    selectedIdx.value = null;
    if (!isEditing.value) editJson.value = "";
    return;
  }

  selectedIdx.value = nextIdx;
  if (!isEditing.value) {
    editJson.value = JSON.stringify(documents.value[nextIdx], null, 2);
  }
}

function selectDoc(idx: number) {
  selectedIdx.value = idx;
  editJson.value = JSON.stringify(documents.value[idx], null, 2);
  isEditing.value = false;
  isNew.value = false;
  editFields.value = [];
}

function startNew() {
  selectedIdx.value = null;
  editJson.value = "";
  editFields.value = [createEditNode("", "", false, false)];
  isEditing.value = true;
  isNew.value = true;
}

function startEdit() {
  const doc = selectedDoc.value;
  if (!doc) return;
  editFields.value = Object.entries(doc).map(([name, value]) => {
    const readonlyMetadata = name === "_id" || (documentStoreProvider.value.kind === "elasticsearch" && name === "_routing");
    return createEditNode(name, value, readonlyMetadata, readonlyMetadata);
  });
  isEditing.value = true;
  isNew.value = false;
}

function cancelEdit() {
  isEditing.value = false;
  if (isNew.value) {
    isNew.value = false;
    editFields.value = [];
    return;
  }
  if (selectedDoc.value) {
    editJson.value = JSON.stringify(selectedDoc.value, null, 2);
  }
  editFields.value = [];
  error.value = "";
}

function createEditNode(keyName: string, value: unknown, readonlyKey: boolean, readonlyValue: boolean): EditNode {
  if (Array.isArray(value)) {
    return {
      key: uuid(),
      keyName,
      kind: "array",
      valueText: "",
      readonlyKey,
      readonlyValue,
      children: value.map((child, idx) => createEditNode(String(idx), child, true, readonlyValue)),
    };
  }

  if (value && typeof value === "object") {
    return {
      key: uuid(),
      keyName,
      kind: "object",
      valueText: "",
      readonlyKey,
      readonlyValue,
      children: Object.entries(value as JsonRecord).map(([childName, child]) => createEditNode(childName, child, readonlyValue, readonlyValue)),
    };
  }

  return {
    key: uuid(),
    keyName,
    kind: "value",
    valueText: formatForEdit(value),
    readonlyKey,
    readonlyValue,
    children: [],
  };
}

function addField() {
  editFields.value.push(createEditNode("", "", false, false));
}

function applyRemoveField(idx: number) {
  if (editFields.value[idx]?.readonlyValue) return;
  editFields.value.splice(idx, 1);
}

function requestRemoveField(idx: number) {
  const field = editFields.value[idx];
  if (!field || field.readonlyValue) return;
  pendingDelete.value = { kind: "field", index: idx, name: field.keyName };
  showDeleteConfirm.value = true;
}

function formatForEdit(value: unknown): string {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function parseFieldValue(raw: string): unknown {
  return parseMongoDocumentInputValue(raw);
}

function buildObjectFromNodes(nodes: EditNode[], path: string): JsonRecord {
  const doc: JsonRecord = {};
  const seen = new Set<string>();

  for (const field of nodes) {
    const name = field.keyName.trim();
    if (!name || (!path && (name === "_id" || (documentStoreProvider.value.kind === "elasticsearch" && name === "_routing")))) continue;
    if (seen.has(name)) throw new Error(t("mongo.duplicateField", { field: name }));
    seen.add(name);
    doc[name] = buildValueFromNode(field, path ? `${path}.${name}` : name);
  }

  return doc;
}

function buildValueFromNode(node: EditNode, path: string): unknown {
  if (node.kind === "value") return parseFieldValue(node.valueText);
  if (node.kind === "array") {
    return node.children.map((child, idx) => buildValueFromNode(child, `${path}[${idx}]`));
  }
  return buildObjectFromNodes(node.children, path);
}

function buildDocumentFromFields(): JsonRecord {
  return buildObjectFromNodes(editFields.value, "");
}

async function saveDoc() {
  error.value = "";
  try {
    const doc = buildDocumentFromFields();
    if (isNew.value) {
      await api.documentInsertDocument(props.connectionId, props.database, props.collection, JSON.stringify(doc));
    } else if (selectedIdx.value !== null) {
      const current = documents.value[selectedIdx.value];
      const id = current?._id;
      if (!id) {
        error.value = "No _id field";
        return;
      }
      await api.documentUpdateDocument(props.connectionId, props.database, props.collection, String(id), JSON.stringify(doc), documentRoutingFromDocument(current));
    }
    isEditing.value = false;
    isNew.value = false;
    editFields.value = [];
    await load();
    if (selectedIdx.value !== null && documents.value[selectedIdx.value]) {
      editJson.value = JSON.stringify(documents.value[selectedIdx.value], null, 2);
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function applyDeleteDoc(idx: number) {
  const doc = documents.value[idx];
  const id = doc._id;
  if (!id) return;
  error.value = "";
  try {
    await api.documentDeleteDocument(props.connectionId, props.database, props.collection, String(id), documentRoutingFromDocument(doc));
    if (selectedIdx.value === idx) {
      selectedIdx.value = null;
      editJson.value = "";
    }
    await load();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function requestDeleteDoc(idx: number) {
  pendingDelete.value = { kind: "document", index: idx };
  showDeleteConfirm.value = true;
}

async function confirmDelete() {
  const pending = pendingDelete.value;
  if (!pending) return;
  if (pending.kind === "document") {
    await applyDeleteDoc(pending.index);
  } else {
    applyRemoveField(pending.index);
  }
  pendingDelete.value = null;
}

function prevPage() {
  if (page.value <= 0) return;
  page.value--;
  load();
}

function nextPage() {
  if ((page.value + 1) * pageSize.value >= total.value) return;
  page.value++;
  load();
}

function docPreview(doc: JsonRecord): string {
  const id = doc._id || "";
  const keys = Object.keys(doc)
    .filter((k) => k !== "_id")
    .slice(0, 3);
  const preview = keys.map((k) => `${k}: ${JSON.stringify(doc[k]).substring(0, 30)}`).join(", ");
  return `${id} - ${preview}`;
}

function highlightedJson(json: string): string {
  const escaped = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return escaped.replace(/("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (match) => {
    let cls = "json-number";
    if (match.startsWith('"')) cls = match.endsWith(":") ? "json-key" : "json-string";
    else if (match === "true" || match === "false") cls = "json-boolean";
    else if (match === "null") cls = "json-null";
    return `<span class="${cls}">${match}</span>`;
  });
}

onMounted(async () => {
  try {
    await connectionStore.ensureConnected(props.connectionId);
  } catch (e) {
    console.warn("[DBX] ensureConnected failed for", props.connectionId, e);
  }
  load();
});
onBeforeUnmount(() => {
  if (documentLoadExecutionId.value) void api.cancelQuery(documentLoadExecutionId.value);
  stopDocumentLoadingTimer();
  endTableSearchSplitResize();
});

function tableSearchSplitContainerWidth(): number {
  return tableSearchSplitContainerRef.value?.getBoundingClientRect().width ?? 0;
}

function startTableSearchSplitResize(event: MouseEvent) {
  const containerWidth = tableSearchSplitContainerWidth();
  if (containerWidth <= 0) return;
  event.preventDefault();
  isResizingTableSearchSplit.value = true;
  tableSearchSplitStartX = event.clientX;
  tableSearchSplitStartWidth = clampSearchSplitWidth({
    containerWidth,
    desiredWidth: tableFindPaneWidth.value ?? undefined,
  });
  tableFindPaneWidth.value = tableSearchSplitStartWidth;
  document.body.classList.add("select-none", "cursor-col-resize");
  window.addEventListener("mousemove", moveTableSearchSplitResize);
  window.addEventListener("mouseup", endTableSearchSplitResize);
}

function moveTableSearchSplitResize(event: MouseEvent) {
  if (!isResizingTableSearchSplit.value) return;
  const containerWidth = tableSearchSplitContainerWidth();
  if (containerWidth <= 0) return;
  tableFindPaneWidth.value = clampSearchSplitWidth({
    containerWidth,
    desiredWidth: tableSearchSplitStartWidth + event.clientX - tableSearchSplitStartX,
  });
}

function endTableSearchSplitResize() {
  isResizingTableSearchSplit.value = false;
  document.body.classList.remove("select-none", "cursor-col-resize");
  window.removeEventListener("mousemove", moveTableSearchSplitResize);
  window.removeEventListener("mouseup", endTableSearchSplitResize);
}

function resetTableSearchSplitWidth() {
  const containerWidth = tableSearchSplitContainerWidth();
  tableFindPaneWidth.value = containerWidth > 0 ? clampSearchSplitWidth({ containerWidth }) : null;
}
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- Top toolbar: view toggle + document count + pagination + actions -->
    <div class="h-9 flex items-center gap-1 px-3 border-b shrink-0 text-xs text-muted-foreground">
      <div class="flex items-center border rounded-md overflow-hidden mr-2">
        <Button variant="ghost" size="icon" class="h-5 w-5 rounded-none" :class="{ 'bg-accent': viewMode === 'document' }" :title="t('mongo.documentView')" @click="viewMode = 'document'">
          <Braces class="h-3 w-3" />
        </Button>
        <Button variant="ghost" size="icon" class="h-5 w-5 rounded-none" :class="{ 'bg-accent': viewMode === 'table' }" :title="t('mongo.tableView')" @click="viewMode = 'table'">
          <Table2 class="h-3 w-3" />
        </Button>
      </div>

      <span class="shrink-0 ml-1">{{ documentStoreLabels.documentsLabel }}</span>

      <Button v-if="viewMode === 'document'" variant="ghost" size="icon" class="h-5 w-5" @click="startNew"><Plus class="h-3 w-3" /></Button>
      <Button v-if="viewMode === 'document'" variant="ghost" size="icon" class="h-5 w-5" @click="load"><RefreshCw class="h-3 w-3" :class="{ 'animate-spin': loading }" /></Button>

      <div v-if="viewMode === 'document'" class="flex items-center gap-1 ml-1">
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="page <= 0" @click="prevPage">
          <ChevronLeft class="h-3 w-3" />
        </Button>
        <span>{{ page + 1 }} / {{ Math.max(1, Math.ceil(total / pageSize)) }}</span>
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="(page + 1) * pageSize >= total" @click="nextPage">
          <ChevronRight class="h-3 w-3" />
        </Button>
      </div>

      <div class="flex-1" />

      <Popover v-if="viewMode === 'table' && gridResult.columns.length">
        <PopoverTrigger as-child>
          <Button variant="ghost" size="sm" class="h-5 shrink-0 gap-1 px-1.5 text-xs text-foreground hover:bg-accent" :class="{ 'bg-accent text-foreground': (dataGridRef?.hiddenColumnCount ?? 0) > 0 }" :title="t('grid.columnVisibility')" :aria-label="t('grid.columnVisibility')">
            <Columns3 class="h-3.5 w-3.5" />
            {{ t("grid.columnVisibility") }}
            <span v-if="(dataGridRef?.hiddenColumnCount ?? 0) > 0" class="tabular-nums"> {{ dataGridRef?.visibleColumnCount }}/{{ dataGridRef?.displayableColumnCount }} </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" class="w-64 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-xl border bg-popover p-0 text-popover-foreground shadow-xl" @click.stop @keydown.stop>
          <div class="border-b bg-muted/40 px-2 py-1.5">
            <div class="flex items-center justify-between gap-2">
              <div class="text-xs font-semibold">{{ t("grid.columnVisibility") }}</div>
              <div class="text-[10px] text-muted-foreground tabular-nums">{{ dataGridRef?.visibleColumnCount ?? 0 }}/{{ dataGridRef?.displayableColumnCount ?? 0 }}</div>
            </div>
          </div>
          <div class="flex items-center gap-1.5 border-b px-2 py-1.5">
            <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input v-model="columnVisibilitySearch" autocapitalize="off" autocorrect="off" spellcheck="false" class="h-6 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground" :placeholder="t('grid.searchColumns')" />
          </div>
          <div class="max-h-72 overflow-auto py-0.5">
            <button v-for="option in columnVisibilityOptions" :key="`${option.index}:${option.column}`" type="button" class="grid w-full grid-cols-[1.5rem_minmax(0,1fr)] items-center px-2 py-1 text-left text-xs hover:bg-accent" @click="dataGridRef?.toggleColumnVisibility(option.index)">
              <span class="flex h-4 w-4 items-center justify-center rounded border" :class="dataGridRef?.isColumnVisible(option.index) ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-transparent'">
                <Check class="h-3 w-3 stroke-[3]" />
              </span>
              <span class="truncate font-mono text-xs" :title="option.column">{{ option.column }}</span>
            </button>
            <div v-if="columnVisibilityOptions.length === 0" class="px-2 py-6 text-center text-xs text-muted-foreground">
              {{ t("grid.noSearchResults") }}
            </div>
          </div>
          <div class="flex flex-col gap-1 border-t bg-muted/30 px-2 py-1.5">
            <span class="text-[11px] leading-4 text-muted-foreground">{{ t("grid.columnVisibilityHint") }}</span>
            <div class="flex items-center justify-end gap-1">
              <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="(dataGridRef?.displayableColumnCount ?? 0) <= 1" @click="dataGridRef?.invertColumnVisibility()">
                {{ t("grid.invertColumnVisibility") }}
              </Button>
              <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="!dataGridRef?.hasCustomColumnOrder" @click="dataGridRef?.resetColumnOrder()">
                {{ t("grid.resetColumnOrder") }}
              </Button>
              <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" :disabled="(dataGridRef?.hiddenColumnCount ?? 0) === 0" @click="dataGridRef?.showAllColumns()">
                {{ t("grid.showAllColumns") }}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <Popover v-if="viewMode === 'table' && gridResult.columns.length">
        <PopoverTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-7 shrink-0 text-foreground hover:bg-accent" :class="{ 'bg-accent text-foreground': dataGridRef?.nullColumnsHidden }" :title="t('grid.viewOptions')" :aria-label="t('grid.viewOptions')">
            <Wrench class="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" class="w-max min-w-44 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-xl border bg-popover p-0 text-popover-foreground shadow-xl" @click.stop @keydown.stop>
          <div class="border-b bg-muted/40 px-3 py-2">
            <div class="text-xs font-semibold">{{ t("grid.viewOptions") }}</div>
          </div>
          <label class="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs hover:bg-accent" :class="{ 'cursor-not-allowed opacity-60': !dataGridRef?.canToggleAllNullColumns }">
            <input type="checkbox" class="h-3.5 w-3.5 shrink-0 accent-primary" :checked="!!dataGridRef?.nullColumnsHidden" :disabled="!dataGridRef?.canToggleAllNullColumns" @change="dataGridRef?.toggleAllNullColumns()" />
            <span class="min-w-0 flex items-center gap-1 font-medium">
              {{ t("grid.hideNullColumns") }}
              <span v-if="(dataGridRef?.allNullColumnCount ?? 0) > 0" class="text-muted-foreground tabular-nums"> ({{ dataGridRef?.allNullColumnCount }}) </span>
            </span>
          </label>
        </PopoverContent>
      </Popover>
    </div>

    <!-- Table view -->
    <QueryLoadingState
      v-if="viewMode === 'table' && loading && gridResult.columns.length === 0"
      class="flex-1 min-h-0"
      :label-key="documentLoadingLabelKey"
      :elapsed-seconds="documentLoadingElapsedSeconds"
      show-cancel
      :cancel-disabled="!documentLoadExecutionId || documentLoadCancelling"
      :cancelling="documentLoadCancelling"
      @cancel="cancelDocumentLoad"
    />
    <DataGrid
      v-else-if="viewMode === 'table'"
      ref="dataGridRef"
      class="flex-1 min-h-0"
      :result="gridResult"
      context="results"
      :database-type="props.databaseType"
      editable
      :custom-save-handler="customSaveHandler"
      :loading="loading"
      :sql="documentStoreLabels.queryPreview"
      :page-offset="page * pageSize"
      :page-limit="pageSize"
      :total-row-count="total"
      @sort="onSort"
      @reload="load"
      @paginate="(offset: number, limit: number) => paginate(offset, limit)"
    >
      <template #search-bar="{ localFilterCount, hasLocalColumnFilters, localFilterSummaries, clearLocalFilter }: { localFilterCount: number; hasLocalColumnFilters: boolean; localFilterSummaries: LocalFilterSummary[]; clearLocalFilter: (columnIndex?: number) => void }">
        <div ref="tableSearchSplitContainerRef" class="flex flex-1 min-w-0">
          <div class="flex flex-1 items-center gap-1 px-2 py-0.5 min-w-0" :style="tableFindPaneStyle">
            <Popover v-model:open="documentFilterBuilderOpen">
              <PopoverTrigger as-child>
                <button
                  type="button"
                  class="relative flex h-5 w-5 shrink-0 items-center justify-center rounded border text-[11px] font-medium transition-colors"
                  :class="hasLocalColumnFilters || appliedDocumentFilter ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground'"
                  @click="ensureDocumentFilterRule"
                >
                  <Filter class="h-3 w-3" />
                  <span v-if="localFilterCount + documentStructuredFilterCount" class="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] leading-none text-primary-foreground">
                    {{ localFilterCount + documentStructuredFilterCount }}
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" class="w-[360px] max-w-[calc(100vw-24px)] gap-3 p-3">
                <div class="flex items-center justify-between gap-3">
                  <div class="text-xs font-medium text-foreground">{{ t("grid.filter") }}</div>
                  <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="addDocumentFilterRule">
                    <Plus class="mr-1 h-3.5 w-3.5" />
                    {{ t("grid.filterBuilderAddRule") }}
                  </Button>
                </div>
                <div v-if="hasLocalColumnFilters" class="space-y-2 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-2">
                  <div class="flex items-center justify-between gap-3">
                    <div class="flex min-w-0 items-center gap-2 text-xs font-medium text-primary">
                      <Filter class="h-3.5 w-3.5 shrink-0" />
                      <span class="truncate">{{ t("grid.localFiltersActive", { count: localFilterCount }) }}</span>
                    </div>
                    <Button variant="ghost" size="sm" class="h-7 shrink-0 px-2 text-xs" @click="clearLocalFilter()">
                      <X class="mr-1 h-3.5 w-3.5" />
                      {{ t("grid.clearLocalFiltersShort") }}
                    </Button>
                  </div>
                  <div class="space-y-1">
                    <div v-for="summary in localFilterSummaries" :key="summary.columnIndex" class="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)_auto] items-center gap-2 rounded border border-primary/10 bg-background/70 px-2 py-1 text-xs">
                      <span class="truncate font-medium text-foreground" :title="summary.columnName">
                        {{ summary.columnName }}
                      </span>
                      <span class="min-w-0 truncate font-mono text-muted-foreground">
                        <template v-for="(value, valueIndex) in summary.values" :key="valueIndex">
                          <span v-if="valueIndex > 0">, </span>
                          <span>{{ value }}</span>
                        </template>
                        <span v-if="summary.hiddenValueCount">
                          {{ t("grid.localFilterMoreValues", { count: summary.hiddenValueCount }) }}
                        </span>
                      </span>
                      <Button variant="ghost" size="icon" class="h-6 w-6 text-muted-foreground hover:text-destructive" :title="t('grid.clearFilter')" @click="clearLocalFilter(summary.columnIndex)">
                        <X class="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>

                <div v-if="documentFilterRules.length" class="space-y-2">
                  <template v-for="(rule, index) in documentFilterRules" :key="rule.id">
                    <div v-if="index > 0" class="flex justify-center">
                      <Button
                        variant="ghost"
                        size="sm"
                        class="h-6 px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                        @click="
                          updateDocumentFilterRule(rule.id, {
                            conjunction: rule.conjunction === 'AND' ? 'OR' : 'AND',
                          })
                        "
                      >
                        {{ rule.conjunction }}
                      </Button>
                    </div>
                    <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,0.95fr)_minmax(0,1fr)_auto] items-center gap-1.5">
                      <Select :model-value="rule.fieldName" @update:model-value="(value: any) => updateDocumentFilterRule(rule.id, { fieldName: String(value) })">
                        <SelectTrigger class="h-8 w-full min-w-0 overflow-hidden text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate">
                          <SelectValue :placeholder="t('grid.filterBuilderColumn')" />
                        </SelectTrigger>
                        <SelectContent position="popper">
                          <SelectItem v-for="fieldName in documentFilterFieldOptions" :key="fieldName" :value="fieldName">
                            {{ fieldName }}
                          </SelectItem>
                        </SelectContent>
                      </Select>

                      <Select :model-value="rule.mode" @update:model-value="(value: any) => updateDocumentFilterRule(rule.id, { mode: value as DocumentFilterMode })">
                        <SelectTrigger class="h-8 w-full min-w-0 overflow-hidden text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper">
                          <SelectItem v-for="option in documentFilterModeOptions" :key="option.value" :value="option.value">
                            {{ t(option.labelKey) }}
                          </SelectItem>
                        </SelectContent>
                      </Select>

                      <Input
                        v-if="documentFilterModeNeedsValue(rule.mode)"
                        :model-value="rule.rawValue"
                        class="h-8 min-w-0 text-xs"
                        :placeholder="t('grid.filterBuilderValue')"
                        @update:model-value="(value) => updateDocumentFilterRule(rule.id, { rawValue: String(value ?? '') })"
                        @keydown.enter.prevent="applyDocumentStructuredFilters"
                      />
                      <div v-else class="flex h-8 min-w-0 items-center overflow-hidden rounded-md border border-dashed px-2 text-xs text-muted-foreground">
                        <span class="truncate">{{ t("grid.filterBuilderNoValue") }}</span>
                      </div>

                      <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive" :disabled="documentFilterRules.length === 1" @click="removeDocumentFilterRule(rule.id)">
                        <Trash2 class="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </template>
                </div>
                <div v-else class="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                  {{ t("grid.filterBuilderEmpty") }}
                </div>

                <div class="flex items-center justify-between gap-2 pt-1">
                  <Button variant="ghost" size="sm" class="h-8 px-2 text-xs" @click="clearDocumentFilters(clearLocalFilter)">
                    {{ t("grid.clearFilter") }}
                  </Button>
                  <div class="flex items-center gap-2">
                    <Button variant="ghost" size="sm" class="h-8 px-2 text-xs" @click="resetDocumentFilterBuilder">
                      {{ t("grid.resetFilterBuilder") }}
                    </Button>
                    <Button size="sm" class="h-8 px-3 text-xs" @click="applyDocumentStructuredFilters">
                      {{ t("grid.applyFilter") }}
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            <span class="text-blue-600 dark:text-blue-400 text-xs font-medium select-none shrink-0">{{ documentStoreProvider.filterInputLabel }}</span>
            <input v-model="filterInput" autocapitalize="off" autocorrect="off" spellcheck="false" class="flex-1 h-5 min-w-0 text-xs bg-transparent outline-none placeholder:text-muted-foreground/60 font-mono" placeholder="{}" @keydown.enter="applyFilter" />
            <button
              v-if="filterInput.trim()"
              class="text-muted-foreground hover:text-foreground shrink-0"
              @click="
                filterInput = '';
                applyFilter();
              "
            >
              <X class="w-3 h-3" />
            </button>
          </div>
          <button
            type="button"
            class="group relative flex w-2 shrink-0 cursor-col-resize items-center justify-center border-l border-r border-border/80 bg-muted/15 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
            aria-label="Resize document filter and sort"
            @mousedown="startTableSearchSplitResize"
            @dblclick.stop="resetTableSearchSplitWidth"
          >
            <span class="h-5 w-px bg-border group-hover:bg-primary/60" />
          </button>
          <div class="flex flex-1 items-center gap-1 px-2 py-0.5 min-w-0">
            <span class="text-orange-600 dark:text-orange-400 text-xs font-medium select-none shrink-0">{{ documentStoreProvider.sortInputLabel }}</span>
            <input v-model="sortInput" autocapitalize="off" autocorrect="off" spellcheck="false" class="flex-1 h-5 min-w-0 text-xs bg-transparent outline-none placeholder:text-muted-foreground/60 font-mono" placeholder="{}" @keydown.enter="applyFilter" />
            <button
              v-if="sortInput.trim()"
              class="text-muted-foreground hover:text-foreground shrink-0"
              @click="
                sortInput = '';
                applyFilter();
              "
            >
              <X class="w-3 h-3" />
            </button>
          </div>
        </div>
      </template>
    </DataGrid>

    <!-- Document view (split pane) -->
    <Splitpanes v-else class="flex-1 min-h-0">
      <!-- Document list (left) -->
      <Pane :size="30" :min-size="15" :max-size="50">
        <div class="h-full flex flex-col overflow-hidden">
          <div class="flex-1 overflow-y-auto">
            <div v-for="(doc, idx) in documents" :key="idx" class="px-3 py-1.5 border-b text-xs font-mono cursor-pointer hover:bg-accent/50 flex items-center gap-2 group" :class="{ 'bg-accent': selectedIdx === idx }" @click="selectDoc(idx)">
              <span class="truncate flex-1">{{ docPreview(doc) }}</span>
              <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive shrink-0" @click.stop="requestDeleteDoc(idx)">
                <Trash2 class="w-3 h-3" />
              </Button>
            </div>
            <div v-if="documents.length === 0 && !loading" class="px-3 py-8 text-center text-muted-foreground text-xs">
              {{ t("mongo.emptyCollection") }}
            </div>
          </div>
        </div>
      </Pane>

      <!-- Document viewer/editor (right) -->
      <Pane :size="70">
        <div class="h-full flex flex-col min-w-0 overflow-hidden">
          <template v-if="selectedIdx !== null || isNew">
            <div class="h-9 flex items-center gap-2 px-4 border-b bg-muted/30 shrink-0">
              <Badge variant="secondary" class="text-xs">{{ isNew ? "New" : selectedDoc?._id }}</Badge>
              <span class="flex-1" />
              <Button v-if="!isEditing" variant="ghost" size="sm" class="h-6 text-xs" @click="startEdit">{{ t("mongo.edit") }}</Button>
              <template v-if="isEditing">
                <Button variant="ghost" size="sm" class="h-6 text-xs" @click="addField"> <Plus class="w-3 h-3 mr-1" /> {{ t("mongo.addField") }} </Button>
                <Button variant="ghost" size="sm" class="h-6 text-xs" @click="cancelEdit">{{ t("grid.discard") }}</Button>
                <Button size="sm" class="h-6 text-xs" @click="saveDoc"><Save class="w-3 h-3 mr-1" />{{ t("grid.save") }}</Button>
              </template>
            </div>

            <div v-if="isEditing" class="flex-1 overflow-auto bg-muted/10">
              <div class="json-edit min-w-fit p-5" :style="{ ...documentFontStyle, '--mongo-key-width': editKeyWidth }">
                <div class="json-edit-brace">{</div>

                <JsonEditNode v-for="(field, idx) in editFields" :key="field.key" :node="field" parent-kind="root" :removable="!field.readonlyValue" @remove="requestRemoveField(idx)" />

                <Button variant="ghost" size="sm" class="json-edit-add" @click="addField"> <Plus class="w-3 h-3 mr-1" /> {{ t("mongo.addField") }} </Button>

                <div class="json-edit-brace">}</div>
              </div>
            </div>

            <div v-else class="flex-1 overflow-auto bg-muted/10">
              <pre class="json-viewer min-w-fit p-5" :style="documentFontStyle" v-html="highlightedJson(editJson)" />
            </div>
          </template>
          <div v-else class="h-full flex items-center justify-center text-muted-foreground text-sm">
            {{ t("mongo.selectDocument") }}
          </div>

          <ErrorBanner v-if="error" :message="error" />
          <DangerConfirmDialog v-model:open="showDeleteConfirm" :message="t('dangerDialog.deleteMessage')" :details="deleteDetails" :confirm-label="t('dangerDialog.deleteConfirm')" @confirm="confirmDelete" />
        </div>
      </Pane>
    </Splitpanes>
  </div>
</template>

<style scoped>
.json-viewer {
  font-family: var(--dbx-editor-font-family);
  font-size: var(--dbx-editor-font-size);
  line-height: 1.6;
  tab-size: 2;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.json-edit {
  font-family: var(--dbx-editor-font-family);
  font-size: var(--dbx-editor-font-size);
  line-height: 1.6;
  tab-size: 2;
  color: var(--foreground);
  white-space: pre-wrap;
}

.json-edit-brace {
  color: var(--muted-foreground);
  font-weight: 700;
}

.json-edit-add {
  margin: 6px 0 6px 2ch;
  font-family: ui-sans-serif, system-ui, sans-serif;
}

:deep(.json-key) {
  color: #7c3aed;
  font-weight: 600;
}

:deep(.json-string) {
  color: #15803d;
}

:deep(.json-number) {
  color: #b45309;
}

:deep(.json-boolean) {
  color: #2563eb;
  font-weight: 600;
}

:deep(.json-null) {
  color: #64748b;
  font-style: italic;
}

:global(.dark) :deep(.json-key) {
  color: #c4b5fd;
}

:global(.dark) :deep(.json-string) {
  color: #86efac;
}

:global(.dark) :deep(.json-number) {
  color: #fbbf24;
}

:global(.dark) :deep(.json-boolean) {
  color: #93c5fd;
}

:global(.dark) :deep(.json-null) {
  color: #94a3b8;
}
</style>

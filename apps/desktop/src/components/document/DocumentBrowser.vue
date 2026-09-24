<script setup lang="ts">
import { computed, ref, shallowRef, nextTick, watch, onMounted, onBeforeUnmount, toRaw } from "vue";
import { uuid } from "@/lib/common/utils";
import { useI18n } from "vue-i18n";
import { RefreshCw, Trash2, Plus, Save, ChevronDown, ChevronLeft, ChevronRight, Table2, Braces, X, Search, Wrench, Filter, Columns3Cog, SquareDashed, Minus, Rows3, AlignLeft, AlignRight, EyeOff, Palette, Copy } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import ErrorBanner from "@/components/ui/ErrorBanner.vue";
import DataGrid from "@/components/grid/DataGrid.vue";
import DataGridColumnLayoutPopover from "@/components/grid/DataGridColumnLayoutPopover.vue";
import DataGridCopyFormatControl from "@/components/grid/DataGridCopyFormatControl.vue";
import DataGridFontFamilyControl from "@/components/grid/DataGridFontFamilyControl.vue";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { Switch } from "@/components/ui/switch";
import QueryLoadingState from "@/components/common/QueryLoadingState.vue";
import * as api from "@/lib/backend/api";
import type { DynamoDbIndexInfo, DynamoDbTableDescription } from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { getDataGridConditionSuggestionPosition, type DataGridConditionSuggestionPosition } from "@/lib/dataGrid/dataGridConditionSuggestionPosition";
import { clampSearchSplitWidth } from "@/lib/dataGrid/dataGridSearchSplit";
import { documentViewerFontStyle } from "@/lib/document/documentViewerFontStyle";
import { ELASTICSEARCH_DEFAULT_MAX_RESULT_WINDOW, clampDocumentPage, resetElasticsearchDocumentTotals, resolveElasticsearchDocumentTotals } from "@/lib/document/elasticsearchDocumentTotals";
import { canGoNextDocumentPage, isSameDocumentQueryTotalCountRequest, resolveDocumentQueryTotals, type DocumentQueryTotalCountRequest } from "@/lib/document/documentQueryTotals";
import {
  arrayObjectAncestorPathForDocumentField,
  buildDocumentFilterCondition,
  buildElasticsearchQueryFromRules,
  combineDocumentFilterConditions,
  currentDocumentFilterJson,
  currentDocumentSortJson,
  defaultDocumentFilterRule,
  documentFieldPathOptionsFromDocuments,
  documentFieldPathTreeFromDocuments,
  flattenDocumentFieldPathTree,
  searchDocumentFieldPathTree,
  documentFilterModeNeedsValue,
  documentFilterModeOptionsFor,
  documentFilterModeUsesList,
  documentFilterModeUsesRange,
  documentFilterValueTypeOptions,
  documentStoreProviderFor,
  elasticsearchBoolClauseOptions,
  elasticsearchFieldPathTreeFromFieldNames,
  elasticsearchQueryTypeNeedsValue,
  elasticsearchQueryTypeOptions,
  elasticsearchStructuredFilter,
  formatDocumentQueryInput,
  searchElasticsearchFieldPathTree,
  type DocumentFieldPathNode,
  type DocumentFilterMode,
  type DocumentFilterRule,
  type DocumentFilterValueType,
  type DocumentStoreKind,
  type ElasticsearchBoolClause,
  type ElasticsearchQueryType,
} from "@/lib/app/documentStoreProvider";
import {
  formatDocumentStoreIdLabel,
  isDocumentStoreIdentityField,
  normalizeDocumentStoreRouting,
  parseDocumentStoreInputValue,
  parseDocumentStoreJsonDocument,
  planDocumentStoreIdentityMigration,
  prepareDocumentStoreWriteDocument,
  resolveDocumentStoreWriteRouting,
  serializeDocumentStoreId,
  stringifyDocumentStoreValue,
  documentStoreValueForGrid,
} from "@/lib/app/documentJsonValues";
import { applyDocumentStoreIdentityPlan, formatMeilisearchDocumentOperationPreview, formatSolrDocumentOperationPreview, insertDocumentStoreDocument as insertDocumentStoreDocumentCore } from "@/lib/app/documentStoreSave";
import { restoreDocumentBrowserState, saveDocumentBrowserState, type DocumentBrowserDataSnapshot } from "@/lib/tabs/documentBrowserStateCache";
import RedisJsonEditor from "@/components/redis/RedisJsonEditor.vue";
import { isLosslessJsonNumber, parseJsonPreservingLargeNumbers } from "@/lib/common/safeJsonFormat";
import {
  buildMongoCopyDocumentFromOriginal,
  buildMongoInsertDocument,
  buildMongoUpdateDocument,
  formatMongoShellLiteral,
  mongoDocumentDisplayValue,
  mongoDocumentGridValue,
  mongoDocumentGridColumnTypes,
  mongoDocumentIdForGrid,
  parseMongoDocumentInputValue,
  serializeMongoDocumentId,
  type MongoInputValue,
} from "@/lib/mongo/mongoDocumentValues";
import {
  buildMongoCompletionItemsFromContext,
  getMongoDocumentQueryCompletionContext,
  inferMongoCompletionFields,
  mongoCompletionNeedsFields,
  plainMongoCompletionInsertion,
  readMongoPropertyPrefix,
  shouldAutoOpenMongoDocumentQueryCompletion,
  type MongoCompletionField,
  type MongoCompletionItem,
  type MongoDocumentQueryKind,
} from "@/lib/mongo/mongoCompletion";
import { mongoDocumentsToQueryResult } from "@/lib/mongo/mongoShellCommand";
import type { GridNewRowMeta } from "@/lib/dataGrid/gridNewRowPlacement";
import { normalizeResultPageSize } from "@/lib/dataGrid/paginationPageSize";
import { documentDataGridColumnLayoutScopeKey } from "@/lib/dataGrid/dataGridColumnLayoutStorage";
import type { SerializedDataGridLocalColumnFilters } from "@/lib/dataGrid/dataGridLocalColumnFilterState";
import { documentGridColumnVisibilityScopeKey, migrateDocumentGridColumnVisibilityToLayout } from "@/lib/document/documentGridColumnVisibilityStorage";
import { matchesElasticsearchIndexPattern, subscribeElasticsearchIndexCleared, type ElasticsearchIndexClearedDetail } from "@/lib/sidebar/elasticsearchIndexActions";
import { TABLE_FONT_SIZE_MAX, TABLE_FONT_SIZE_MIN, useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import DocumentQueryCompletionMenu from "./DocumentQueryCompletionMenu.vue";
import JsonEditNode from "./JsonEditNode.vue";

import type { EditNode } from "@/types/editor";
import type { ColumnInfo, DatabaseType, QueryResult, QueryTab } from "@/types/database";
import type { CustomSaveHandler } from "@/composables/useDataGridEditor";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";

const { t } = useI18n();
const { toast } = useToast();
const settingsStore = useSettingsStore();
const connectionStore = useConnectionStore();

const props = defineProps<{
  connectionId: string;
  database: string;
  collection: string;
  databaseType?: DatabaseType;
  tableMeta?: NonNullable<QueryTab["tableMeta"]>;
  /** Tab id; query conditions are cached per tab and restored on remount. */
  stateKey?: string;
}>();

type JsonRecord = Record<string, unknown>;
type ViewMode = "document" | "table";
const DYNAMODB_DEFAULT_EXPORT_ROW_LIMIT = 10_000;

// This component is keyed by tab in ContentArea and unmounted on every tab
// switch; without restoring from the per-tab cache, coming back to the tab
// would silently drop the user's filter/sort conditions and re-query the
// server. Page position and rows only survive for skip-based paging: cursor
// stores (DynamoDB/Elasticsearch) cannot resume a page without their cursor
// stacks, and infinite scroll always restarts from the first segment.
const restoredDocumentBrowserState = props.stateKey ? restoreDocumentBrowserState(props.stateKey) : undefined;
const skipBasedDocumentStore = ["mongodb", "meilisearch", "solr"].includes(documentStoreProviderFor(props.databaseType).kind);
const restoresSkipBasedPage = !!restoredDocumentBrowserState && !settingsStore.editorSettings.infiniteScroll && skipBasedDocumentStore;

const documents = ref<JsonRecord[]>([]);
const copyDocuments = ref<JsonRecord[]>([]);
const gridRows = shallowRef<QueryResult["rows"]>([]);
// Set only when the most recent load() appended a continuation segment onto
// the existing documents (infinite scroll); undefined for a full replace.
// Mirrors QueryResult.appended_from_row_count so DataGrid's infinite-scroll
// bookkeeping (see appendQueryResultSegment in queryStore.ts) can tell a
// genuine append apart from a stale/failed one.
const appendedFromRowCount = ref<number | undefined>(undefined);
const mongoCopyDocumentsAvailable = ref(false);
const lastGridColumns = ref<string[]>([]);
const lastGridColumnTypes = ref<string[]>([]);
const total = ref<number | undefined>(undefined);
// Logical-result identity for DataGrid's tab-switch view snapshot. A data tab
// gets this from queryStore.publishResultGeneration; document tabs have no
// store-side result, so the browser mints one per completed load and inherits
// it on an infinite-scroll append and on a cache restore.
const documentViewGeneration = ref<string | undefined>(undefined);
const totalIsExact = ref(true);
const paginationTotal = ref<number | undefined>(undefined);
const loading = ref(false);
const documentLoadExecutionId = ref("");
const documentLoadCancelling = ref(false);
const documentLoadingElapsedSeconds = ref("0.0");
const page = ref(restoresSkipBasedPage ? Math.max(0, Math.trunc(restoredDocumentBrowserState!.page)) : 0);
const pageSize = ref(normalizeResultPageSize(settingsStore.editorSettings.tableOpenPageSize));
const selectedIdx = ref<number | null>(null);
const editJson = ref("");
const isEditing = ref(false);
const isNew = ref(false);
const documentEditMode = ref<"fields" | "json">("json");
const isSavingDocument = ref(false);
const error = ref("");
const editFields = ref<EditNode[]>([]);
const showDeleteConfirm = ref(false);
const columnWidthDensity = computed(() => settingsStore.editorSettings.columnWidthDensity);
const dataGridRenderMode = computed(() => settingsStore.editorSettings.dataGridRenderMode);
const tableFontSize = computed(() => settingsStore.editorSettings.tableFontSize);
const numericColumnRightAlign = computed(() => settingsStore.editorSettings.numericColumnRightAlign ?? true);
const colorizeDataGridCellTypes = computed(() => settingsStore.editorSettings.colorizeDataGridCellTypes);
const viewMode = computed<ViewMode>({
  get: () => settingsStore.editorSettings.mongoViewMode,
  set: (value) => settingsStore.updateEditorSettings({ mongoViewMode: value }),
});
const filterInput = ref(restoredDocumentBrowserState?.filterInput ?? "");
const sortInput = ref(restoredDocumentBrowserState?.sortInput ?? "");
const localColumnFilters = ref<SerializedDataGridLocalColumnFilters>(restoredDocumentBrowserState?.localColumnFilters ?? {});
const localColumnFilterColumns = ref<string[] | undefined>(restoredDocumentBrowserState?.localColumnFilterColumns);
const filterInputRef = ref<HTMLTextAreaElement>();
const sortInputRef = ref<HTMLTextAreaElement>();
const dataGridRef = ref<InstanceType<typeof DataGrid>>();
const viewOptionsOpen = ref(false);
const mongoUpdateTarget = computed(() => (props.databaseType === "mongodb" && mongoCopyDocumentsAvailable.value ? { collection: props.collection, idColumn: "_id" as const } : undefined));
const documentJsonEditorRef = ref<{ openSearch: () => boolean }>();
const documentViewerSearchActive = ref(false);

function openDataGridExtractorConfiguration() {
  viewOptionsOpen.value = false;
  void nextTick(() => dataGridRef.value?.openExtractorConfiguration());
}

function setColumnWidthDensity(value: "compact" | "standard" | "comfortable") {
  settingsStore.updateEditorSettings({ columnWidthDensity: value });
}

function setDataGridRenderMode(value: "canvas" | "dom") {
  settingsStore.updateEditorSettings({ dataGridRenderMode: value });
}

function setTableFontSize(value: number) {
  settingsStore.updateEditorSettings({ tableFontSize: value });
}

function decreaseTableFontSize() {
  setTableFontSize(tableFontSize.value - 1);
}

function increaseTableFontSize() {
  setTableFontSize(tableFontSize.value + 1);
}

function setNumericColumnRightAlign(value: boolean) {
  settingsStore.updateEditorSettings({ numericColumnRightAlign: value });
}

function setColorizeDataGridCellTypes(value: boolean) {
  settingsStore.updateEditorSettings({ colorizeDataGridCellTypes: value });
}
const tableSearchSplitContainerRef = ref<HTMLDivElement>();
const tableFindPaneWidth = ref<number | null>(null);
const isResizingTableSearchSplit = ref(false);
let tableSearchSplitStartX = 0;
let tableSearchSplitStartWidth = 0;
let elasticsearchCountKey: string | null = null;
let elasticsearchExactTotal: number | undefined;
let elasticsearchPaginationLowerBound: number | undefined;
let elasticsearchCountExecutionId = "";
let elasticsearchCountGeneration = 0;
type LoadedDocumentQueryTotalCountRequest = DocumentQueryTotalCountRequest & { storeKind: DocumentStoreKind };
let loadedDocumentQueryTotalCountRequest: LoadedDocumentQueryTotalCountRequest | undefined;
let documentRequestGeneration = 0;
const documentStoreProvider = computed(() => documentStoreProviderFor(props.databaseType));
const documentColumnLayoutScopeKey = computed(() =>
  documentDataGridColumnLayoutScopeKey({
    databaseType: props.databaseType ?? "mongodb",
    connectionId: props.connectionId,
    database: props.database,
    collection: props.collection,
  }),
);
const legacyDocumentColumnVisibilityScopeKey = computed(() =>
  documentGridColumnVisibilityScopeKey({
    databaseType: props.databaseType,
    connectionId: props.connectionId,
    database: props.database,
    collection: props.collection,
  }),
);

watch(
  [legacyDocumentColumnVisibilityScopeKey, documentColumnLayoutScopeKey],
  ([legacyScopeKey, layoutScopeKey]) => {
    migrateDocumentGridColumnVisibilityToLayout(legacyScopeKey, layoutScopeKey);
  },
  { immediate: true },
);

const pageTotal = computed(() => paginationTotal.value);
const documentPageCount = computed(() => (pageTotal.value === undefined ? undefined : Math.max(1, Math.ceil(pageTotal.value / pageSize.value))));
const canGoNextPage = computed(() => {
  if (documentStoreProvider.value.kind === "dynamodb") return dynamodbHasNextCursor.value;
  if (documentStoreProvider.value.kind === "elasticsearch") return elasticsearchHasNextCursor.value;
  return canGoNextDocumentPage({
    page: page.value,
    pageSize: pageSize.value,
    rowCount: documents.value.length,
    paginationTotal: pageTotal.value,
  });
});
const documentRequestLimit = computed(() => {
  if (documentStoreProvider.value.kind !== "elasticsearch") return pageSize.value;
  return Math.min(pageSize.value, ELASTICSEARCH_DEFAULT_MAX_RESULT_WINDOW);
});

const tableFindPaneStyle = computed(() => {
  if (tableFindPaneWidth.value == null) return {};
  return { flex: `0 0 ${tableFindPaneWidth.value}px` };
});
const documentFontStyle = computed(() => documentViewerFontStyle(settingsStore.editorSettings));
const documentStoreLabels = computed(() => ({
  documentsLabel: documentStoreProvider.value.documentsLabel({ total: total.value ?? 0, totalIsExact: totalIsExact.value, t }),
  filterInputLabel: documentStoreProvider.value.kind === "dynamodb" ? t("dynamodb.filter") : documentStoreProvider.value.filterInputLabel,
  sortInputLabel: documentStoreProvider.value.kind === "dynamodb" ? t("dynamodb.sortKey") : documentStoreProvider.value.sortInputLabel,
  queryPreview: documentQueryPreview.value,
}));

type PendingDelete = { kind: "document"; index: number } | { kind: "field"; index: number; name: string };
type LocalFilterSummary = {
  columnIndex: number;
  columnName: string;
  values: string[];
  hiddenValueCount: number;
};
type DocumentFilterFieldTreeRow = DocumentFieldPathNode & { depth: number };
type DocumentGridChanges = {
  dirtyRows: Map<number, Map<number, MongoInputValue>>;
  deletedRows: Set<number>;
  newRows: MongoInputValue[][];
  newRowMeta: GridNewRowMeta[];
  columns: string[];
  rows: MongoInputValue[][];
};
const documentFilterBuilderOpen = ref(false);
const documentFilterFieldPopoverOpen = ref<Record<string, boolean>>({});
const documentFilterFieldSearch = ref<Record<string, string>>({});
const documentFilterRules = ref<DocumentFilterRule[]>(restoredDocumentBrowserState?.documentFilterRules ?? []);
const appliedDocumentFilter = ref<Record<string, unknown> | null>(restoredDocumentBrowserState?.appliedDocumentFilter ?? null);

// Identity + conditions the currently held rows were loaded under. Rows are
// only worth replaying while this still matches the live inputs; a filter edit
// with a load still in flight would otherwise pair new conditions with stale
// rows on the next remount.
function documentDataSignature(): string | undefined {
  try {
    return JSON.stringify([documentStoreProvider.value.kind, props.connectionId, props.database, props.collection, currentDocumentFilter() ?? null, currentDocumentSortJson(sortInput.value) ?? null, page.value, pageSize.value, settingsStore.editorSettings.infiniteScroll === true]);
  } catch {
    // Malformed filter/sort JSON: nothing stable to key rows against.
    return undefined;
  }
}

// Local value filters describe column values, not the rows that happen to be
// loaded, so paging and page-size changes must not drop them. Only a new query
// (collection, filter or sort) invalidates the snapshot; restored filters are
// mapped back by column name, so a changed column set is handled as well.
function documentLocalColumnFilterSignature(): string | undefined {
  try {
    return JSON.stringify([documentStoreProvider.value.kind, props.connectionId, props.database, props.collection, currentDocumentFilter() ?? null, currentDocumentSortJson(sortInput.value) ?? null]);
  } catch {
    // Malformed filter/sort JSON: nothing stable to key filters against.
    return undefined;
  }
}

const documentLocalColumnFilterRestoreKey = computed(() => documentLocalColumnFilterSignature());

let loadedDocumentDataSignature: string | undefined;

function captureDocumentBrowserData(): DocumentBrowserDataSnapshot | undefined {
  // Cursor stores (DynamoDB/Elasticsearch) drop their cursor stacks on unmount
  // and cannot resume a page without them, so they keep restarting at page 0.
  if (!skipBasedDocumentStore) return undefined;
  // Never completed a load, mid-flight, or errored — let the remount retry.
  if (lastGridColumns.value.length === 0 || loading.value || error.value) return undefined;
  const signature = documentDataSignature();
  if (!signature || signature !== loadedDocumentDataSignature) return undefined;
  return {
    signature,
    viewGeneration: documentViewGeneration.value,
    // Unwrap the reactive proxies: this snapshot outlives the component.
    documents: toRaw(documents.value),
    copyDocuments: toRaw(copyDocuments.value),
    copyDocumentsAvailable: mongoCopyDocumentsAvailable.value,
    gridColumns: toRaw(lastGridColumns.value),
    gridColumnTypes: toRaw(lastGridColumnTypes.value),
    total: total.value,
    totalIsExact: totalIsExact.value,
    paginationTotal: paginationTotal.value,
    selectedIdx: selectedIdx.value,
  };
}

function persistDocumentBrowserState(options: { includeData?: boolean } = {}) {
  if (!props.stateKey) return;
  saveDocumentBrowserState(props.stateKey, {
    filterInput: filterInput.value,
    sortInput: sortInput.value,
    appliedDocumentFilter: appliedDocumentFilter.value,
    documentFilterRules: documentFilterRules.value,
    page: page.value,
    localColumnFilters: localColumnFilters.value,
    localColumnFilterColumns: localColumnFilterColumns.value,
    // Any condition change drops the payload; only the unmount capture stores
    // rows, so a cached page can never outlive the conditions that produced it.
    data: options.includeData ? captureDocumentBrowserData() : undefined,
  });
}

function handleLocalColumnFiltersChange(filters: SerializedDataGridLocalColumnFilters) {
  localColumnFilters.value = Object.fromEntries(Object.entries(filters).map(([columnIndex, values]) => [columnIndex, [...values]]));
  localColumnFilterColumns.value = Object.keys(filters).length > 0 ? [...gridResult.value.columns] : undefined;
  // Local value filters only change the client-side view. Keep the loaded rows
  // in the tab snapshot so returning to the tab does not trigger a reload.
  persistDocumentBrowserState({ includeData: true });
}

// Keep these sources in lockstep with documentLocalColumnFilterSignature(): a
// changed query means the local-filter snapshot no longer describes what the
// user is looking at.
watch(
  [filterInput, sortInput, appliedDocumentFilter],
  () => {
    localColumnFilters.value = {};
    localColumnFilterColumns.value = undefined;
    persistDocumentBrowserState();
  },
  { deep: true },
);
// Paging and page-size changes reload rows, but the local value filters stay put.
watch([page, pageSize, () => settingsStore.editorSettings.infiniteScroll], () => persistDocumentBrowserState());
watch(documentFilterRules, () => persistDocumentBrowserState(), { deep: true });

// Seed the grid from the cached page so a tab switch costs no round trip
// (#8679). The signature guard rejects a snapshot whose identity or conditions
// no longer match — a changed page-size setting, say — and falls through to a
// normal load.
const restoredDocumentData = skipBasedDocumentStore && restoredDocumentBrowserState?.data && restoredDocumentBrowserState.data.signature === documentDataSignature() ? restoredDocumentBrowserState.data : undefined;
if (restoredDocumentData) {
  // Assign the columns before committing so a collection that loaded empty
  // stays distinguishable from one that never loaded: commitLoadedDocuments
  // reads a non-empty lastGridColumns as "a load has completed", which is what
  // drives the refresh toolbar for an empty collection.
  lastGridColumns.value = restoredDocumentData.gridColumns;
  lastGridColumnTypes.value = restoredDocumentData.gridColumnTypes;
  commitLoadedDocuments(restoredDocumentData.documents, restoredDocumentData.copyDocuments, restoredDocumentData.copyDocumentsAvailable, false, documentStoreProvider.value.kind);
  total.value = restoredDocumentData.total;
  totalIsExact.value = restoredDocumentData.totalIsExact;
  paginationTotal.value = restoredDocumentData.paginationTotal;
  loadedDocumentDataSignature = restoredDocumentData.signature;
  // Same rows as before the switch, so the grid may replay its viewport.
  documentViewGeneration.value = restoredDocumentData.viewGeneration;
  const restoredSelectedIdx = restoredDocumentData.selectedIdx;
  if (restoredSelectedIdx !== null && restoredSelectedIdx >= 0 && restoredSelectedIdx < documents.value.length) {
    selectedIdx.value = restoredSelectedIdx;
    editJson.value = stringifyDocumentStoreValue(documents.value[restoredSelectedIdx], documentStoreProvider.value.kind, 2);
  }
  // Keep the grid's "count total rows" action working without a preceding load.
  loadedDocumentQueryTotalCountRequest = {
    connectionId: props.connectionId,
    database: props.database,
    collection: props.collection,
    filter: currentDocumentFilter(),
    generation: documentRequestGeneration,
    storeKind: documentStoreProvider.value.kind,
  };
}

const elasticsearchMappingFields = ref<ColumnInfo[]>([]);
function elasticsearchGridColumnTypesFor(columns: readonly string[]): string[] {
  const mappingTypes = elasticsearchFieldTypes.value;
  return columns.map((column) => {
    // Elasticsearch metadata fields are not part of an index mapping, but they
    // are textual identifiers in the document grid just like mapped keywords.
    if (column === "_id" || column === "_routing" || column === "_type") return "keyword";
    return mappingTypes.get(column) ?? "";
  });
}
const elasticsearchGridColumnTypes = computed(() => elasticsearchGridColumnTypesFor(lastGridColumns.value));
const solrSchemaFields = ref<ColumnInfo[]>([]);
const solrFieldTypes = computed(() => new Map(solrSchemaFields.value.map((field) => [field.name, field.data_type])));
function solrGridColumnTypesFor(columns: readonly string[]): string[] {
  return columns.map((column) => (column === "_id" ? "string" : (solrFieldTypes.value.get(column) ?? "")));
}
const solrGridColumnTypes = computed(() => solrGridColumnTypesFor(lastGridColumns.value));
const dynamodbTableDescription = ref<DynamoDbTableDescription | null>(null);
const dynamodbIndexName = ref("__table__");
const dynamodbPageCursors = ref<Array<string | undefined>>([undefined]);
const dynamodbHasNextCursor = ref(false);
const dynamodbExactTotal = ref<number | undefined>();
const elasticsearchPageCursors = ref<Array<string | undefined>>([undefined]);
const elasticsearchHasNextCursor = ref(false);
let dynamodbExactCountKey: string | null = null;

const dynamodbIndexOptions = computed<Array<{ value: string; label: string; index?: DynamoDbIndexInfo }>>(() => [
  { value: "__table__", label: t("dynamodb.baseTable") },
  ...(dynamodbTableDescription.value?.indexes ?? []).map((index) => ({
    value: index.name,
    label: `${index.name} (${index.kind === "global" ? "GSI" : "LSI"} · ${index.projectionType})`,
    index,
  })),
]);

const dynamodbSelectedIndex = computed(() => {
  if (dynamodbIndexName.value === "__table__") return undefined;
  return dynamodbTableDescription.value?.indexes.find((index) => index.name === dynamodbIndexName.value);
});

const dynamodbPartialProjectionReadOnly = computed(() => documentStoreProvider.value.kind === "dynamodb" && !!dynamodbSelectedIndex.value && dynamodbSelectedIndex.value.projectionType !== "ALL");
const documentStoreEditable = computed(() => !dynamodbPartialProjectionReadOnly.value);
const documentStoreEditDisabledReason = computed(() => (dynamodbPartialProjectionReadOnly.value ? t("dynamodb.partialProjectionReadOnly", { projection: dynamodbSelectedIndex.value?.projectionType ?? "UNKNOWN" }) : undefined));

const dynamodbSelectedKey = computed(() => {
  const table = dynamodbTableDescription.value;
  if (!table) return null;
  if (dynamodbIndexName.value === "__table__") {
    return { partitionKey: table.partitionKey, sortKey: table.sortKey };
  }
  return dynamodbSelectedIndex.value ?? null;
});

const pendingDelete = ref<PendingDelete | null>(null);
const documentFilterComposingEditors = new Set<string>();
const documentFilterCompositionEndedAt = new Map<string, number>();
const DOCUMENT_FILTER_IME_COMPOSITION_END_GRACE_MS = 120;

const selectedDoc = computed(() => {
  if (selectedIdx.value === null) return null;
  return documents.value[selectedIdx.value] ?? null;
});
const selectedDocumentIdLabel = computed(() => {
  if (isNew.value) return "New";
  return formatDocumentStoreIdLabel(selectedDoc.value?._id, documentStoreProvider.value.kind);
});
const selectedDocumentIdWidth = computed(() => `${Math.min(Math.max(Array.from(selectedDocumentIdLabel.value).length + 2, 5), 52)}ch`);

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
    if (documentStoreProvider.value.kind === "dynamodb") {
      return t("dynamodb.documentDetails", {
        table: props.collection,
        id: formatDocumentStoreIdLabel(id, "dynamodb"),
      });
    }
    const displayId = mongoDocumentIdForGrid(id);
    if (props.databaseType === "solr") {
      return `Solr core: ${props.collection}\nDocument _id: ${String(displayId)}`;
    }
    if (props.databaseType === "elasticsearch" || props.databaseType === "easysearch" || props.databaseType === "meilisearch") {
      const product = props.databaseType === "easysearch" ? "Easysearch" : props.databaseType === "meilisearch" ? "Meilisearch" : "Elasticsearch";
      return `${product} index: ${props.collection}\nDocument _id: ${String(displayId)}`;
    }
    return t("dangerDialog.mongoDocumentDetails", { collection: props.collection, id: String(displayId) });
  }
  return t("dangerDialog.mongoFieldDetails", { field: pending.name || t("mongo.field") });
});

function documentGridColumns(documentsToRender: JsonRecord[]): string[] {
  const keySet = new Set<string>();
  keySet.add("_id");
  for (const doc of documentsToRender) {
    for (const key of Object.keys(doc)) {
      if (key !== "_id") keySet.add(key);
    }
  }
  return [...keySet];
}

function documentGridRow(doc: JsonRecord, columns: string[], kind: DocumentStoreKind): QueryResult["rows"][number] {
  return columns.map((column) => {
    const rawValue = doc[column];
    // MongoDB distinguishes a missing field from an explicit BSON null. Keep a
    // missing field visually blank; the NULL grid sentinel is reserved for an
    // existing field whose BSON value is null.
    if (kind === "mongodb" && rawValue === undefined) return "";
    const value = kind === "mongodb" ? mongoDocumentGridValue(rawValue) : mongoDocumentDisplayValue(rawValue);
    if (value === undefined || value === null) return null;
    if (column === "_id") return kind === "mongodb" ? mongoDocumentIdForGrid(value) : documentStoreValueForGrid(value, kind);
    if (typeof value === "object") return documentStoreValueForGrid(value, kind);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    return String(value);
  });
}

function sameGridColumns(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((column, index) => column === right[index]);
}

function commitLoadedDocuments(nextDocuments: JsonRecord[], nextCopyDocuments: JsonRecord[], hasTypePreservingCopyDocuments: boolean, append: boolean, kind: DocumentStoreKind) {
  const previousDocumentCount = documents.value.length;
  const combinedDocuments = append ? [...documents.value, ...nextDocuments] : nextDocuments;
  // A collection that has never returned any document (as opposed to one that
  // returned documents before and is now empty) would otherwise keep
  // `lastGridColumns` at its initial `[]` forever, which the grid reads as
  // "no query has completed" and renders without a toolbar/refresh button.
  const hasEstablishedColumns = lastGridColumns.value.length > 0;
  const nextColumns = combinedDocuments.length > 0 || !hasEstablishedColumns ? documentGridColumns(combinedDocuments) : lastGridColumns.value;
  const canAppendGridRows = append && gridRows.value.length === previousDocumentCount && sameGridColumns(lastGridColumns.value, nextColumns);

  documents.value = combinedDocuments;
  copyDocuments.value = append ? [...copyDocuments.value, ...nextCopyDocuments] : nextCopyDocuments;
  mongoCopyDocumentsAvailable.value = append ? mongoCopyDocumentsAvailable.value && hasTypePreservingCopyDocuments : hasTypePreservingCopyDocuments;

  if (combinedDocuments.length > 0 || !hasEstablishedColumns) {
    lastGridColumns.value = nextColumns;
    lastGridColumnTypes.value = kind === "mongodb" ? mongoDocumentGridColumnTypes(combinedDocuments, nextColumns) : [];
  }

  if (canAppendGridRows) {
    appendedFromRowCount.value = previousDocumentCount;
    gridRows.value = [...gridRows.value, ...nextDocuments.map((document) => documentGridRow(document, nextColumns, kind))];
    return;
  }

  appendedFromRowCount.value = undefined;
  gridRows.value = combinedDocuments.map((document) => documentGridRow(document, nextColumns, kind));
}

const gridResult = computed<QueryResult>(() => {
  const docs = documents.value;
  const columnTypes = documentStoreProvider.value.kind === "elasticsearch" ? elasticsearchGridColumnTypes.value : documentStoreProvider.value.kind === "solr" ? solrGridColumnTypes.value : lastGridColumnTypes.value;
  if (!docs.length) {
    return {
      columns: lastGridColumns.value,
      column_types: columnTypes,
      rows: [],
      affected_rows: 0,
      execution_time_ms: 0,
      truncated: false,
      local_column_filters: localColumnFilters.value,
    };
  }

  return {
    columns: lastGridColumns.value,
    column_types: columnTypes,
    rows: gridRows.value,
    mongo_documents: docs,
    mongo_copy_documents: copyDocuments.value,
    affected_rows: 0,
    execution_time_ms: 0,
    truncated: false,
    appended_from_row_count: appendedFromRowCount.value,
    local_column_filters: localColumnFilters.value,
  };
});

async function exportAllDocumentStoreDocuments(onProgress?: (info: { rowsExported: number; totalRows: number | null }) => void): Promise<QueryResult | undefined> {
  const kind = documentStoreProvider.value.kind;
  if (kind !== "mongodb" && kind !== "dynamodb" && kind !== "elasticsearch" && kind !== "solr") return undefined;

  const connectionId = props.connectionId;
  const database = props.database;
  const collection = props.collection;
  const filter = currentDocumentFilter();
  const sort = currentDocumentSortJson(sortInput.value);
  const exportSettings = settingsStore.editorSettings;
  const batchSize = Math.max(1, Math.trunc(exportSettings.exportBatchSize));
  const rowLimit = exportSettings.exportRowLimitEnabled ? Math.max(0, Math.trunc(exportSettings.exportRowLimit)) : kind === "dynamodb" ? DYNAMODB_DEFAULT_EXPORT_ROW_LIMIT : Number.POSITIVE_INFINITY;
  const exportExecutionId = uuid();
  const exportStartedAt = performance.now();
  const exportedDocuments: JsonRecord[] = [];
  let exportedCopyDocuments: JsonRecord[] | undefined = kind === "mongodb" ? [] : undefined;
  let totalRows: number | null = null;
  let cursor: string | undefined;
  let lastCursor: string | undefined;
  const seenCursors = new Set<string>();

  try {
    while (exportedDocuments.length < rowLimit) {
      const requestLimit = Math.min(batchSize, kind === "dynamodb" ? 1000 : kind === "elasticsearch" ? ELASTICSEARCH_DEFAULT_MAX_RESULT_WINDOW : Number.POSITIVE_INFINITY, rowLimit - exportedDocuments.length);
      if (requestLimit <= 0) break;
      if (cursor) lastCursor = cursor;
      const result = await api.documentFindDocuments(connectionId, database, collection, kind === "dynamodb" || kind === "elasticsearch" ? 0 : exportedDocuments.length, requestLimit, filter, undefined, sort, undefined, exportExecutionId, cursor, kind === "elasticsearch");
      const pageDocuments = result.documents.slice(0, requestLimit).map(asRecord);
      exportedDocuments.push(...pageDocuments);

      if (kind === "mongodb" && exportedCopyDocuments) {
        if (result.extended_documents?.length === result.documents.length) {
          exportedCopyDocuments.push(...result.extended_documents.slice(0, pageDocuments.length).map(asRecord));
        } else {
          exportedCopyDocuments = undefined;
        }
      }

      if ((kind === "mongodb" || kind === "elasticsearch" || kind === "solr") && result.total_is_exact !== false) totalRows = Math.min(result.total, rowLimit);
      onProgress?.({ rowsExported: exportedDocuments.length, totalRows });

      if (kind === "dynamodb" || kind === "elasticsearch") {
        cursor = result.next_cursor;
        if (!cursor) break;
        if (seenCursors.has(cursor)) throw new Error(kind === "dynamodb" ? t("dynamodb.repeatedCursor") : "Elasticsearch cursor repeated during export");
        seenCursors.add(cursor);
        continue;
      }

      const reachedExactTotal = result.total_is_exact !== false && exportedDocuments.length >= result.total;
      if (pageDocuments.length === 0 || pageDocuments.length < requestLimit || reachedExactTotal) break;
    }
  } finally {
    if (kind === "elasticsearch") {
      const cursorToClose = lastCursor ?? cursor;
      if (cursorToClose) void closeElasticsearchCursor(cursorToClose);
    }
  }

  if (kind === "dynamodb" || kind === "elasticsearch") {
    const truncatedByLimit = !!cursor && exportedDocuments.length >= rowLimit;
    totalRows = truncatedByLimit ? null : exportedDocuments.length;
    onProgress?.({ rowsExported: exportedDocuments.length, totalRows });
    if (truncatedByLimit) {
      toast(kind === "dynamodb" ? t("dynamodb.exportLimitReached", { count: rowLimit }) : `Elasticsearch export limit reached (${rowLimit})`, 6000);
    }
  }

  const result = mongoDocumentsToQueryResult(exportedDocuments, performance.now() - exportStartedAt, totalRows ?? exportedDocuments.length, exportedCopyDocuments, totalRows !== null);
  if (result.columns.length === 0) result.columns = gridResult.value.columns;
  result.column_types = kind === "mongodb" ? mongoDocumentGridColumnTypes(exportedDocuments, result.columns) : kind === "elasticsearch" ? elasticsearchGridColumnTypesFor(result.columns) : kind === "solr" ? solrGridColumnTypesFor(result.columns) : undefined;
  result.affected_rows = exportedDocuments.length;
  result.truncated = (kind === "dynamodb" || kind === "elasticsearch") && !!cursor && exportedDocuments.length >= rowLimit;
  result.has_more = result.truncated;
  return result;
}
const expandedDocumentFilterFieldPaths = ref<Set<string>>(new Set());
const elasticsearchFieldTypes = computed(() => new Map(elasticsearchMappingFields.value.map((field) => [field.name, field.data_type])));
const elasticsearchFilterFieldNames = computed(() => {
  const names = [...elasticsearchMappingFields.value.map((field) => field.name), ...gridResult.value.columns, "_id", "_routing"];
  return [...new Set(names.filter(Boolean))];
});
const solrFilterFieldNames = computed(() => {
  const names = [...solrSchemaFields.value.map((field) => field.name), ...gridResult.value.columns, "_id"];
  return [...new Set(names.filter(Boolean))];
});
const documentFilterFieldTree = computed<DocumentFieldPathNode[]>(() => {
  if (documentStoreProvider.value.kind === "elasticsearch") {
    return elasticsearchFieldPathTreeFromFieldNames(elasticsearchFilterFieldNames.value, elasticsearchFieldTypes.value);
  }
  if (documentStoreProvider.value.kind === "solr") {
    // Schema fields give the filter builder a complete field list even before
    // any document page has loaded; unknown Solr types stay leaf-selectable.
    return elasticsearchFieldPathTreeFromFieldNames(solrFilterFieldNames.value, solrFieldTypes.value);
  }
  const tree = documentFieldPathTreeFromDocuments(documents.value);
  if (tree.length > 0) return tree;
  return gridResult.value.columns.map((column) => ({
    key: column,
    path: column,
    label: column,
    displayPath: column,
    kind: "scalar",
    selectable: true,
    children: [],
  }));
});
const documentFilterFieldOptions = computed(() => {
  if (documentStoreProvider.value.kind === "elasticsearch") {
    return flattenDocumentFieldPathTree(documentFilterFieldTree.value)
      .filter((field) => field.selectable)
      .map((field) => field.path);
  }
  const nestedFields = documentFieldPathOptionsFromDocuments(documents.value);
  return nestedFields.length > 0 ? nestedFields : gridResult.value.columns;
});
const documentFilterFieldRows = computed<DocumentFilterFieldTreeRow[]>(() => visibleDocumentFilterFieldRows(documentFilterFieldTree.value));
const documentFilterFieldByPath = computed(() => new Map(flattenDocumentFieldPathTree(documentFilterFieldTree.value).map((node) => [node.path, node])));
const documentStructuredFilterCount = computed(() => {
  if (!appliedDocumentFilter.value) return 0;
  if (documentStoreProvider.value.kind !== "elasticsearch") return 1;
  const query = appliedDocumentFilter.value.$esQuery;
  if (!query || typeof query !== "object" || Array.isArray(query)) return 0;
  const bool = (query as Record<string, unknown>).bool;
  if (!bool || typeof bool !== "object" || Array.isArray(bool)) return 0;
  return elasticsearchBoolClauseOptions.reduce((count, clause) => {
    const rules = (bool as Record<string, unknown>)[clause];
    return count + (Array.isArray(rules) ? rules.length : 0);
  }, 0);
});
const currentDocumentFilterModeOptions = computed(() => documentFilterModeOptionsFor(documentStoreProvider.value.kind));
const documentLoadingLabelKey = computed(() => (documentLoadCancelling.value ? "common.stopping" : "common.loading"));
let documentLoadingTimer: ReturnType<typeof setInterval> | undefined;

function createDocumentFilterRule(): DocumentFilterRule {
  const fieldName = documentFilterFieldOptions.value[0] ?? "";
  const rule = defaultDocumentFilterRule(uuid(), fieldName);
  if (documentStoreProvider.value.kind === "elasticsearch") {
    rule.elasticsearchQueryType = elasticsearchQueryTypeOptions(elasticsearchFieldTypes.value.get(fieldName))[0];
  }
  return rule;
}

function ensureDocumentFilterRule() {
  if (documentFilterRules.value.length === 0 && documentFilterFieldOptions.value.length > 0) {
    documentFilterRules.value = [createDocumentFilterRule()];
  }
}

function appendDocumentFilterRule(openFieldSelect: boolean) {
  ensureDocumentFilterRule();
  const rule = createDocumentFilterRule();
  documentFilterRules.value = [...documentFilterRules.value, rule];
  if (openFieldSelect) setDocumentFilterFieldPopoverOpen(rule.id, true);
}

function addDocumentFilterRule() {
  appendDocumentFilterRule(false);
}

function addDocumentFilterRuleFromKeyboard() {
  appendDocumentFilterRule(true);
}

function startDocumentFilterImeComposition(editorKey: string) {
  documentFilterComposingEditors.add(editorKey);
  documentFilterCompositionEndedAt.delete(editorKey);
}

function endDocumentFilterImeComposition(editorKey: string) {
  documentFilterComposingEditors.delete(editorKey);
  documentFilterCompositionEndedAt.set(editorKey, Date.now());
}

function isDocumentFilterImeCompositionKey(event: KeyboardEvent, editorKey: string) {
  const endedAt = documentFilterCompositionEndedAt.get(editorKey);
  const justEnded = event.key === "Enter" && endedAt !== undefined && Date.now() - endedAt <= DOCUMENT_FILTER_IME_COMPOSITION_END_GRACE_MS;
  if (justEnded || (endedAt !== undefined && event.key !== "Process")) documentFilterCompositionEndedAt.delete(editorKey);
  return event.isComposing || event.key === "Process" || event.keyCode === 229 || documentFilterComposingEditors.has(editorKey) || justEnded;
}

function handleDocumentFilterValueKeydown(event: KeyboardEvent, ruleId: string) {
  const editorKey = `value:${ruleId}`;
  if (isDocumentFilterImeCompositionKey(event, editorKey)) {
    event.stopPropagation();
    return;
  }
  if (event.key !== "Enter") return;
  event.preventDefault();
  if (!event.shiftKey) {
    void applyDocumentStructuredFilters();
    return;
  }
  event.stopPropagation();
  if (!event.repeat) addDocumentFilterRuleFromKeyboard();
}

function visibleDocumentFilterFieldRows(nodes: readonly DocumentFieldPathNode[], depth = 0): DocumentFilterFieldTreeRow[] {
  const rows: DocumentFilterFieldTreeRow[] = [];
  for (const node of nodes) {
    rows.push({ ...node, depth });
    if (node.children.length > 0 && expandedDocumentFilterFieldPaths.value.has(node.path)) {
      rows.push(...visibleDocumentFilterFieldRows(node.children, depth + 1));
    }
  }
  return rows;
}

function toggleDocumentFilterFieldExpanded(path: string) {
  const next = new Set(expandedDocumentFilterFieldPaths.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expandedDocumentFilterFieldPaths.value = next;
}

function setDocumentFilterFieldPopoverOpen(ruleId: string, open: boolean) {
  const next = { ...documentFilterFieldPopoverOpen.value };
  if (open) next[ruleId] = true;
  else delete next[ruleId];
  documentFilterFieldPopoverOpen.value = next;
  if (open) {
    void nextTick(() => document.getElementById(documentFilterFieldSearchInputId(ruleId))?.focus());
  }
  if (!open) {
    const search = { ...documentFilterFieldSearch.value };
    delete search[ruleId];
    documentFilterFieldSearch.value = search;
  }
}

function documentFilterFieldSearchInputId(ruleId: string): string {
  return `document-filter-field-search-${ruleId}`;
}

function documentFilterFieldSearchActive(ruleId: string): boolean {
  return !!documentFilterFieldSearch.value[ruleId]?.trim();
}

function documentFilterFieldRowsForRule(ruleId: string): DocumentFilterFieldTreeRow[] {
  const query = documentFilterFieldSearch.value[ruleId] ?? "";
  if (!query.trim()) return documentFilterFieldRows.value;
  const matchingFields = documentStoreProvider.value.kind === "elasticsearch" ? searchElasticsearchFieldPathTree(documentFilterFieldTree.value, query) : searchDocumentFieldPathTree(documentFilterFieldTree.value, query);
  return matchingFields.map((node) => ({ ...node, depth: 0 }));
}

function selectDocumentFilterField(ruleId: string, fieldName: string) {
  updateDocumentFilterRule(ruleId, { fieldName });
  setDocumentFilterFieldPopoverOpen(ruleId, false);
}

function documentFilterFieldLabel(path: string): string {
  if (documentStoreProvider.value.kind !== "elasticsearch") {
    return documentFilterFieldByPath.value.get(path)?.displayPath ?? path;
  }
  const fieldType = elasticsearchFieldTypes.value.get(path);
  return fieldType ? `${path} (${fieldType})` : path;
}

function documentFilterFieldKindLabel(kind: DocumentFieldPathNode["kind"]): string {
  if (kind === "array-object") return "array object";
  return kind;
}

function removeDocumentFilterRule(ruleId: string) {
  documentFilterRules.value = documentFilterRules.value.filter((rule) => rule.id !== ruleId);
  setDocumentFilterFieldPopoverOpen(ruleId, false);
  if (documentFilterRules.value.length === 0) appliedDocumentFilter.value = null;
}

function updateDocumentFilterRule(ruleId: string, patch: Partial<DocumentFilterRule>) {
  documentFilterRules.value = documentFilterRules.value.map((rule) => {
    if (rule.id !== ruleId) return rule;
    const next = { ...rule, ...patch };
    if (documentStoreProvider.value.kind === "elasticsearch") {
      const queryTypes = elasticsearchQueryTypeOptions(elasticsearchFieldTypes.value.get(next.fieldName));
      if (!next.elasticsearchQueryType || !queryTypes.includes(next.elasticsearchQueryType)) {
        next.elasticsearchQueryType = queryTypes[0];
      }
      if (!elasticsearchQueryTypeNeedsValue(next.elasticsearchQueryType)) next.rawValue = "";
    } else {
      if (patch.fieldName !== undefined && patch.fieldName !== rule.fieldName) next.valueType = "auto";
      if (!documentFilterModeNeedsValue(next.mode)) next.rawValue = "";
      if (!documentFilterModeUsesRange(next.mode)) next.rawEndValue = "";
    }
    return next;
  });
}

function elasticsearchRuleQueryTypes(rule: DocumentFilterRule): ElasticsearchQueryType[] {
  return elasticsearchQueryTypeOptions(elasticsearchFieldTypes.value.get(rule.fieldName));
}

function elasticsearchQueryTypeLabel(queryType: ElasticsearchQueryType): string {
  const rangeOperator: Partial<Record<ElasticsearchQueryType, string>> = {
    range_gt: "range >",
    range_gte: "range >=",
    range_lt: "range <",
    range_lte: "range <=",
  };
  return rangeOperator[queryType] ?? queryType;
}

function resetDocumentFilterBuilder() {
  appliedDocumentFilter.value = null;
  documentFilterFieldPopoverOpen.value = {};
  documentFilterFieldSearch.value = {};
  documentFilterRules.value = documentFilterFieldOptions.value.length > 0 ? [createDocumentFilterRule()] : [];
}

function dynamodbCountFilterKey(filter: string | undefined): string {
  return JSON.stringify([props.connectionId, props.collection, filter ?? ""]);
}

function resetDynamoDbExactCount() {
  dynamodbExactCountKey = null;
  dynamodbExactTotal.value = undefined;
}

function resetDynamoDbPagination(options: { preserveExactCount?: boolean } = {}) {
  dynamodbPageCursors.value = [undefined];
  dynamodbHasNextCursor.value = false;
  paginationTotal.value = undefined;
  if (!options.preserveExactCount) resetDynamoDbExactCount();
}

async function closeElasticsearchCursor(cursor?: string) {
  if (!cursor) return;
  try {
    await api.closeQuerySession(props.connectionId, props.database, cursor);
  } catch (error) {
    console.warn("[DBX] failed to close Elasticsearch cursor", error);
  }
}

function resetElasticsearchPagination() {
  const cursor = [...elasticsearchPageCursors.value].reverse().find((candidate): candidate is string => !!candidate);
  if (cursor) void closeElasticsearchCursor(cursor);
  elasticsearchPageCursors.value = [undefined];
  elasticsearchHasNextCursor.value = false;
}

function currentDocumentFilter(): string | undefined {
  const filter = currentDocumentFilterJson(filterInput.value, appliedDocumentFilter.value, documentStoreProvider.value.kind);
  if (documentStoreProvider.value.kind !== "dynamodb" || dynamodbIndexName.value === "__table__") return filter;
  const parsed = filter ? JSON.parse(filter) : {};
  return JSON.stringify({ ...parsed, $index: dynamodbIndexName.value });
}

function selectDynamoDbIndex(value: unknown) {
  const next = typeof value === "string" && value ? value : "__table__";
  if (dynamodbIndexName.value === next) return;
  dynamodbIndexName.value = next;
  if (dynamodbPartialProjectionReadOnly.value && isEditing.value) cancelEdit();
  sortInput.value = "";
  page.value = 0;
  resetDynamoDbPagination();
  void load({ page: 0 });
}

function resizeDocumentQueryInput(el: HTMLTextAreaElement | undefined) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(Math.max(el.scrollHeight, 20), 120)}px`;
}

function resizeDocumentQueryInputs() {
  resizeDocumentQueryInput(filterInputRef.value);
  resizeDocumentQueryInput(sortInputRef.value);
  // A bar that just grew a line moved the menu's anchor with it.
  repositionOpenDocumentQueryCompletions();
}

function formatFilterInput() {
  try {
    filterInput.value = formatDocumentQueryInput(filterInput.value, documentStoreProvider.value.kind);
    error.value = "";
    void nextTick(resizeDocumentQueryInputs);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function formatSortInput() {
  try {
    sortInput.value = formatDocumentQueryInput(sortInput.value);
    error.value = "";
    void nextTick(resizeDocumentQueryInputs);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

watch([filterInput, sortInput], () => {
  void nextTick(resizeDocumentQueryInputs);
});

/* ---------------------------------------------------------------- *
 * Filter / sort bar completion (MongoDB)
 *
 * The bars hold a bare query document, so they reuse the same field
 * and operator tables as the query editor's `find({ … })` completion
 * — a collection's field names are exactly what is too long to
 * remember and retype here. Only MongoDB opts in: the other document
 * stores put their own dialects in these inputs.
 * ---------------------------------------------------------------- */

type DocumentQueryCompletionTarget = "filter" | "sort";

const DOCUMENT_QUERY_COMPLETION_MENU_LIMIT = 50;

const documentQueryCompletionTarget = ref<DocumentQueryCompletionTarget | null>(null);
const documentQueryCompletionItems = ref<MongoCompletionItem[]>([]);
const documentQueryCompletionIndex = ref(0);
const documentQueryCompletionPosition = ref<DataGridConditionSuggestionPosition>({ left: 0, top: 0, width: 0 });
const documentQueryCompletionListboxId = `document-query-completions-${uuid()}`;
const documentQueryCompletionEnabled = computed(() => documentStoreProvider.value.kind === "mongodb");
const documentQueryCompletionOpen = computed(() => documentQueryCompletionTarget.value !== null && documentQueryCompletionItems.value.length > 0);
const documentQueryCompletionActiveDescendant = computed(() => (documentQueryCompletionOpen.value ? `${documentQueryCompletionListboxId}-option-${documentQueryCompletionIndex.value}` : undefined));
// Guards the field lookup: a keystroke that lands while a previous refresh is
// still awaiting fields must win, and a dismiss must cancel both.
let documentQueryCompletionRequestId = 0;

function documentQueryCompletionKind(target: DocumentQueryCompletionTarget): MongoDocumentQueryKind {
  return target === "filter" ? "filter" : "sortKeys";
}

function documentQueryCompletionInputEl(target: DocumentQueryCompletionTarget): HTMLTextAreaElement | undefined {
  return target === "filter" ? filterInputRef.value : sortInputRef.value;
}

function documentQueryCompletionText(target: DocumentQueryCompletionTarget): string {
  return target === "filter" ? filterInput.value : sortInput.value;
}

// Walking every loaded document is too much to redo on each keystroke — under
// infinite scroll `documents` holds every page fetched so far — so the page's
// fields are derived once per load and reused until the rows change.
const documentQueryCompletionLocalFields = computed<MongoCompletionField[]>(() => (documentQueryCompletionEnabled.value ? inferMongoCompletionFields(documents.value) : []));

/**
 * Fields the collection is known to have: those visible in the loaded page,
 * which carry the types the grid already inferred, plus the store's cached
 * server-side sample, which also covers fields the current page happens not to
 * contain.
 */
async function documentQueryCompletionFields(): Promise<MongoCompletionField[]> {
  const byName = new Map(documentQueryCompletionLocalFields.value.map((field) => [field.name, field]));
  let sampled: MongoCompletionField[] = [];
  try {
    sampled = await connectionStore.listMongoCompletionFields(props.connectionId, props.database, props.collection);
  } catch {
    sampled = [];
  }
  for (const field of sampled) if (!byName.has(field.name)) byName.set(field.name, field);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function dismissDocumentQueryCompletions() {
  documentQueryCompletionRequestId++;
  documentQueryCompletionTarget.value = null;
  documentQueryCompletionItems.value = [];
  documentQueryCompletionIndex.value = 0;
}

async function refreshDocumentQueryCompletions(target: DocumentQueryCompletionTarget, options: { force?: boolean } = {}) {
  if (!documentQueryCompletionEnabled.value) return;
  const text = documentQueryCompletionText(target);
  const cursor = documentQueryCompletionInputEl(target)?.selectionStart ?? text.length;
  const kind = documentQueryCompletionKind(target);

  // Without `force` (Ctrl/Cmd+Space, or a just-accepted item that opens a new
  // position) the menu only appears for characters that start something.
  if (!options.force && !shouldAutoOpenMongoDocumentQueryCompletion(text, cursor, kind)) {
    dismissDocumentQueryCompletions();
    return;
  }

  const context = getMongoDocumentQueryCompletionContext(text, cursor, kind);
  if (context.mode === "none") {
    dismissDocumentQueryCompletions();
    return;
  }

  const requestId = ++documentQueryCompletionRequestId;
  const fields = mongoCompletionNeedsFields(context.mode) ? await documentQueryCompletionFields() : [];
  if (requestId !== documentQueryCompletionRequestId) return;

  const items = buildMongoCompletionItemsFromContext(context, { fields }).slice(0, DOCUMENT_QUERY_COMPLETION_MENU_LIMIT);
  if (items.length === 0) {
    dismissDocumentQueryCompletions();
    return;
  }
  documentQueryCompletionTarget.value = target;
  documentQueryCompletionItems.value = items;
  documentQueryCompletionIndex.value = 0;
  updateDocumentQueryCompletionPosition(target);
}

/**
 * Anchors the menu to its input in viewport coordinates, which is what a
 * teleported menu needs: the grid's toolbar clips both axes, so the menu cannot
 * live next to the input in the DOM.
 */
function updateDocumentQueryCompletionPosition(target: DocumentQueryCompletionTarget) {
  const input = documentQueryCompletionInputEl(target);
  if (!input) return;
  documentQueryCompletionPosition.value = getDataGridConditionSuggestionPosition(input.getBoundingClientRect(), {
    viewportWidth: window.innerWidth,
    minWidth: 240,
    maxWidth: 460,
  });
}

// Teleported out of the input's box, the menu cannot follow it on its own: the
// toolbar scrolls horizontally and the window resizes without the input ever
// being touched.
function repositionOpenDocumentQueryCompletions() {
  const target = documentQueryCompletionTarget.value;
  if (target) updateDocumentQueryCompletionPosition(target);
}

watch(documentQueryCompletionOpen, (open) => {
  if (open) {
    window.addEventListener("scroll", repositionOpenDocumentQueryCompletions, true);
    window.addEventListener("resize", repositionOpenDocumentQueryCompletions);
  } else {
    window.removeEventListener("scroll", repositionOpenDocumentQueryCompletions, true);
    window.removeEventListener("resize", repositionOpenDocumentQueryCompletions);
  }
});

function selectDocumentQueryCompletion(index: number) {
  if (index < 0 || index >= documentQueryCompletionItems.value.length) return;
  documentQueryCompletionIndex.value = index;
  void nextTick(() => {
    const listbox = document.getElementById(documentQueryCompletionListboxId);
    const option = document.getElementById(`${documentQueryCompletionListboxId}-option-${index}`);
    if (!listbox || !option) return;
    const listboxRect = listbox.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    if (optionRect.top < listboxRect.top) listbox.scrollTop -= listboxRect.top - optionRect.top;
    else if (optionRect.bottom > listboxRect.bottom) listbox.scrollTop += optionRect.bottom - listboxRect.bottom;
  });
}

function moveDocumentQueryCompletionSelection(direction: 1 | -1): boolean {
  if (!documentQueryCompletionOpen.value) return false;
  const count = documentQueryCompletionItems.value.length;
  const next = Math.min(Math.max(documentQueryCompletionIndex.value + direction, 0), count - 1);
  if (next !== documentQueryCompletionIndex.value) selectDocumentQueryCompletion(next);
  return true;
}

function documentQueryCompletionInsertion(index = documentQueryCompletionIndex.value) {
  const target = documentQueryCompletionTarget.value;
  const item = documentQueryCompletionItems.value[index];
  if (!target || !item) return null;

  const input = documentQueryCompletionInputEl(target);
  const text = documentQueryCompletionText(target);
  const cursor = input?.selectionStart ?? text.length;
  const context = getMongoDocumentQueryCompletionContext(text, cursor, documentQueryCompletionKind(target));
  if (context.mode === "none") return null;

  // A quoted key completion writes both of its quotes, so the closing quote the
  // input already holds has to go with the prefix it belongs to.
  const to = Math.min((input?.selectionEnd ?? text.length) + (item.replaceClosingQuote ? 1 : 0), text.length);
  const insertion = plainMongoCompletionInsertion(item.apply ?? item.label, text.slice(to));
  return { target, text, from: context.from, to, insertion };
}

function acceptDocumentQueryCompletion(index = documentQueryCompletionIndex.value): boolean {
  const completion = documentQueryCompletionInsertion(index);
  if (!completion) return false;

  const { target, text, from, to, insertion } = completion;
  const next = `${text.slice(0, from)}${insertion.text}${text.slice(to)}`;
  if (target === "filter") filterInput.value = next;
  else sortInput.value = next;
  dismissDocumentQueryCompletions();

  void nextTick(() => {
    const input = documentQueryCompletionInputEl(target);
    if (!input) return;
    input.focus();
    input.setSelectionRange(from + insertion.selectionStart, from + insertion.selectionEnd);
    // A field completion ends at `field: `, an operator at its value — both are
    // fresh positions with their own suggestions, so open the menu again.
    void refreshDocumentQueryCompletions(target, { force: true });
  });
  return true;
}

/** True when accepting would not change the text, so Enter should run the query instead. */
function documentQueryCompletionMatchesInput(): boolean {
  const completion = documentQueryCompletionInsertion();
  if (!completion) return false;
  return completion.text.slice(completion.from, completion.to) === completion.insertion.text;
}

/**
 * Opens the document around the first character typed into an empty bar, so
 * `d` becomes `{d}` with the caret left between the braces.
 *
 * The bars hold a bare document and a field name only reads as a key once its
 * braces exist, so typing straight into an empty bar used to land in a position
 * that classifies as nothing and suggested nothing — the very case #9427
 * reports. Nothing is lost by writing the braces: an unbraced bar never parses
 * as a filter either, so that text was a dead query, not a shorter spelling of
 * one.
 *
 * Only a lone character that could start a key qualifies. A paste arrives whole
 * and usually brings its own braces, and a typed `{` is the user opening the
 * document themselves — which already suggests.
 *
 * The edit has to be an insertion. Backspacing `ab` down to `a` leaves exactly
 * the same one character and caret as typing `a` into an empty bar, and writing
 * braces around text the user is in the middle of deleting would hand them two
 * more characters to delete.
 */
function openDocumentQueryDocument(event: InputEvent, target: DocumentQueryCompletionTarget): boolean {
  if (!documentQueryCompletionEnabled.value) return false;
  if (!event.inputType?.startsWith("insert")) return false;
  const text = documentQueryCompletionText(target);
  const prefix = readMongoPropertyPrefix(text, text.length);
  if ([...text].length !== 1 || !/^[$_"'\p{L}\p{N}]$/u.test(text) || prefix.from !== 0 || prefix.prefix !== text) return false;
  if (documentQueryCompletionInputEl(target)?.selectionStart !== text.length) return false;

  if (target === "filter") filterInput.value = `{${text}}`;
  else sortInput.value = `{${text}}`;

  // Rewriting the model moves the caret to the end, past the `}` we just added,
  // where there is nothing to complete. Put it back inside before asking.
  void nextTick(() => {
    documentQueryCompletionInputEl(target)?.setSelectionRange(text.length + 1, text.length + 1);
    void refreshDocumentQueryCompletions(target);
  });
  return true;
}

function onDocumentQueryInput(event: Event, target: DocumentQueryCompletionTarget) {
  // `v-model` holds off on the model until the composition is confirmed, so a
  // mid-composition refresh would suggest against the text as it was before the
  // IME opened. Vue re-dispatches `input` once it commits, which is when the
  // suggestions are worth computing.
  if ((event as InputEvent).isComposing) return;
  if (openDocumentQueryDocument(event as InputEvent, target)) return;
  void refreshDocumentQueryCompletions(target);
}

/**
 * Dismissing also cancels whatever refresh is in flight, which is the point:
 * the target is only set once `documentQueryCompletionFields` has resolved, so
 * a bar blurred during that first (uncached) backend round trip would otherwise
 * open its menu afterwards, over a bar that no longer has focus. Nothing else
 * would take it down — the menu is teleported to `body` and there is no
 * outside-click handler.
 */
function onDocumentQueryBlur(target: DocumentQueryCompletionTarget) {
  if (documentQueryCompletionTarget.value === null || documentQueryCompletionTarget.value === target) dismissDocumentQueryCompletions();
}

/**
 * The suggestions describe the position the caret was in when they were built,
 * so a caret moved without an edit leaves them describing somewhere else:
 * accepting one then splices a stale item at a freshly computed offset and
 * garbles the text. Moving the caret closes the menu instead.
 */
function onDocumentQueryCaretMove(target: DocumentQueryCompletionTarget) {
  if (documentQueryCompletionTarget.value === target) dismissDocumentQueryCompletions();
}

function onDocumentQueryKeydown(event: KeyboardEvent, target: DocumentQueryCompletionTarget) {
  if (event.isComposing) return;

  if (documentQueryCompletionEnabled.value) {
    if ((event.ctrlKey || event.metaKey) && event.code === "Space") {
      event.preventDefault();
      void refreshDocumentQueryCompletions(target, { force: true });
      return;
    }
    if (event.key === "Escape" && documentQueryCompletionOpen.value) {
      event.preventDefault();
      dismissDocumentQueryCompletions();
      return;
    }
    // These move the caret rather than the selection, so they leave the open
    // suggestions describing a position the caret has left. The key still does
    // its normal job — only the menu goes.
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
      onDocumentQueryCaretMove(target);
      return;
    }
    if (event.key === "ArrowDown" && moveDocumentQueryCompletionSelection(1)) {
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowUp" && moveDocumentQueryCompletionSelection(-1)) {
      event.preventDefault();
      return;
    }
    if (event.key === "Tab" && !event.shiftKey && documentQueryCompletionOpen.value && acceptDocumentQueryCompletion()) {
      event.preventDefault();
      return;
    }
    // Enter takes the highlighted suggestion first; a second Enter runs the query.
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && documentQueryCompletionOpen.value && !documentQueryCompletionMatchesInput() && acceptDocumentQueryCompletion()) {
      event.preventDefault();
      return;
    }
  }

  if (event.key !== "Enter") return;
  const plainEnter = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
  if (!plainEnter && !((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey)) return;
  event.preventDefault();
  dismissDocumentQueryCompletions();
  applyFilter();
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
    skip: documentStoreProvider.value.kind === "elasticsearch" ? 0 : page.value * pageSize.value,
    limit: documentRequestLimit.value,
  });
});

async function applyDocumentStructuredFilters() {
  if (documentStoreProvider.value.kind === "elasticsearch") {
    appliedDocumentFilter.value = elasticsearchStructuredFilter(buildElasticsearchQueryFromRules(documentFilterRules.value));
    documentFilterBuilderOpen.value = false;
    applyFilter();
    return;
  }
  let items: Array<{ rule: DocumentFilterRule; condition: Record<string, unknown> }>;
  try {
    items = documentFilterRules.value
      .map((rule) => ({
        rule,
        condition: buildDocumentFilterCondition(rule, {
          kind: documentStoreProvider.value.kind,
          sampleValue: documentFilterFieldByPath.value.get(rule.fieldName)?.sampleValue,
        }),
      }))
      .filter((item): item is { rule: DocumentFilterRule; condition: Record<string, unknown> } => !!item.condition);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    return;
  }
  error.value = "";
  const structured = combineDocumentFilterConditions(
    items.map((item) => item.condition),
    items.map((item) => item.rule),
    items.map((item) => arrayObjectAncestorPathForDocumentField(documentFilterFieldTree.value, item.rule.fieldName)),
  );
  appliedDocumentFilter.value = structured;
  documentFilterBuilderOpen.value = false;
  applyFilter();
}

async function loadDocumentStoreSchemaFields() {
  const kind = documentStoreProvider.value.kind;
  if (kind !== "elasticsearch" && kind !== "solr") return;
  try {
    const fields = (await api.getColumns(props.connectionId, props.database, "", props.collection)) ?? [];
    if (kind === "elasticsearch") elasticsearchMappingFields.value = fields;
    else solrSchemaFields.value = fields;
  } catch {
    if (kind === "elasticsearch") elasticsearchMappingFields.value = [];
    else solrSchemaFields.value = [];
  }
}

function clearDocumentFilters(clearLocalFilter?: (columnIndex?: number) => void) {
  appliedDocumentFilter.value = null;
  resetDocumentFilterBuilder();
  clearLocalFilter?.();
  applyFilter();
}

function documentIdFromGridValue(value: MongoInputValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('"')) {
      try {
        const parsed = JSON.parse(trimmed);
        return typeof parsed === "string" && parsed.trim() ? parsed : trimmed;
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  const parsed = parseMongoDocumentInputValue(value);
  if (parsed === null || parsed === undefined) return null;
  const id = typeof parsed === "object" ? JSON.stringify(parsed) : String(parsed);
  return id.trim() ? id : null;
}

function documentRoutingFromDocument(doc: JsonRecord | undefined): string | undefined {
  return normalizeDocumentStoreRouting(doc?._routing);
}

function documentTypeFromDocument(doc: JsonRecord | undefined): string | undefined {
  const documentType = doc?._type;
  return typeof documentType === "string" && documentType.trim() ? documentType.trim() : undefined;
}

function documentRoutingFromGridRow(row: MongoInputValue[] | undefined, columns: string[]): string | undefined {
  const routingColIdx = columns.indexOf("_routing");
  return routingColIdx >= 0 ? normalizeDocumentStoreRouting(row?.[routingColIdx]) : undefined;
}

function documentStoreWriteApis(documentType?: string) {
  return {
    insert: (docJson: string, routing?: string) => api.documentInsertDocument(props.connectionId, props.database, props.collection, docJson, routing),
    update: (id: string, docJson: string, routing?: string) => api.documentUpdateDocument(props.connectionId, props.database, props.collection, id, docJson, routing),
    delete: (id: string, routing?: string) => api.documentDeleteDocument(props.connectionId, props.database, props.collection, id, routing, documentType),
  };
}

function prepareDynamoDbDocumentIdentity(document: JsonRecord): { document: JsonRecord; id: string } {
  const table = dynamodbTableDescription.value;
  if (!table) throw new Error(t("dynamodb.tableMetadataUnavailable"));

  const next = { ...document };
  const metadataId = next._id && typeof next._id === "object" && !Array.isArray(next._id) ? (next._id as JsonRecord) : undefined;
  const identity: JsonRecord = {};
  const keys = [table.partitionKey, table.sortKey].filter((value): value is NonNullable<typeof value> => !!value);
  for (const key of keys) {
    const value = next[key.name] ?? metadataId?.[key.name];
    if (value === undefined || value === null || value === "") {
      throw new Error(t("dynamodb.keyRequired", { key: key.name }));
    }
    next[key.name] = value;
    identity[key.name] = value;
  }
  next._id = identity;
  return { document: next, id: serializeDocumentStoreId(identity, "dynamodb") };
}

async function gridSave(changes: DocumentGridChanges) {
  if (!documentStoreEditable.value) {
    throw new Error(documentStoreEditDisabledReason.value);
  }
  const cols = changes.columns;
  const idColIdx = cols.indexOf("_id");
  if (idColIdx < 0) throw new Error("No _id column");
  const kind = documentStoreProvider.value.kind;
  const isPathIdentityStore = kind !== "mongodb";
  const isEs = kind === "elasticsearch";

  if (kind === "meilisearch") {
    const updates: Array<{ id: string; docJson: string }> = [];
    const deleteIds: string[] = [];
    const inserts: string[] = [];

    for (const [rowIdx, dirtyCols] of changes.dirtyRows) {
      const row = changes.rows[rowIdx];
      const id = row?.[idColIdx];
      const doc = documents.value[rowIdx];
      if (id == null || !doc) continue;
      const updated = buildPathIdentityUpdatedDocument(doc, dirtyCols, cols, kind);
      const writeDocument = prepareDocumentStoreWriteDocument(updated, { kind, mode: "update" });
      updates.push({
        id: serializeDocumentStoreId(doc._id ?? id, kind),
        docJson: stringifyDocumentStoreValue(writeDocument, kind),
      });
    }

    for (const rowIdx of changes.deletedRows) {
      const row = changes.rows[rowIdx];
      const id = row?.[idColIdx];
      if (id == null) continue;
      deleteIds.push(serializeDocumentStoreId(documents.value[rowIdx]?._id ?? id, kind));
    }

    for (const newRow of changes.newRows) {
      const doc = buildPathIdentityInsertDocument(newRow, cols, kind);
      const idValue = newRow[idColIdx];
      if (idValue !== null && idValue !== undefined && idValue !== "") doc._id = parseDocumentStoreInputValue(idValue, kind);
      inserts.push(stringifyDocumentStoreValue(doc, kind));
    }

    await api.documentSaveMeilisearchBatch(props.connectionId, props.collection, updates, deleteIds, inserts);
    await reloadDocumentsAfterMutationOrRefresh();
    return;
  }

  for (const [rowIdx, dirtyCols] of changes.dirtyRows) {
    const row = changes.rows[rowIdx];
    const id = row?.[idColIdx];
    if (id == null) continue;

    if (isPathIdentityStore) {
      const doc = documents.value[rowIdx];
      if (!doc) continue;
      const routing = isEs ? documentRoutingFromDocument(doc) : undefined;
      const updated = buildPathIdentityUpdatedDocument(doc, dirtyCols, cols, kind);
      const documentId = serializeDocumentStoreId(doc._id ?? id, kind);
      if (kind === "dynamodb") {
        const normalized = prepareDynamoDbDocumentIdentity(updated);
        const writeDocument = prepareDocumentStoreWriteDocument(normalized.document, { kind, mode: "update" });
        await api.documentUpdateDocument(props.connectionId, props.database, props.collection, documentId, stringifyDocumentStoreValue(writeDocument, kind));
        continue;
      }
      const writeDocument = prepareDocumentStoreWriteDocument(updated, { kind, mode: "update" });
      await api.documentUpdateDocument(props.connectionId, props.database, props.collection, documentId, stringifyDocumentStoreValue(writeDocument, kind), routing);
      continue;
    }

    const updateDoc = buildMongoUpdateDocument(dirtyCols, cols, documents.value[rowIdx]);
    if (Object.keys(updateDoc).length === 0) continue;
    const documentId = documents.value[rowIdx]?._id ?? id;
    await api.documentUpdateDocument(props.connectionId, props.database, props.collection, serializeMongoDocumentId(documentId), JSON.stringify(updateDoc));
  }

  for (const rowIdx of changes.deletedRows) {
    const row = changes.rows[rowIdx];
    const id = row?.[idColIdx];
    if (id == null) continue;
    const document = documents.value[rowIdx];
    const routing = isEs ? documentRoutingFromDocument(document) : undefined;
    const documentType = isEs ? documentTypeFromDocument(document) : undefined;
    const documentId = document?._id ?? id;
    await api.documentDeleteDocument(props.connectionId, props.database, props.collection, isPathIdentityStore ? serializeDocumentStoreId(documentId, kind) : serializeMongoDocumentId(documentId), routing, documentType);
  }

  for (const [newRowIndex, newRow] of changes.newRows.entries()) {
    const newRowMeta = changes.newRowMeta[newRowIndex];
    const doc = isPathIdentityStore ? buildPathIdentityInsertDocument(newRow, cols, kind) : buildMongoGridInsertDocument(newRow, cols, newRowMeta);
    if (isPathIdentityStore) {
      const idValue = newRow[idColIdx];
      const id = idValue === null || idValue === undefined || idValue === "" ? null : serializeDocumentStoreId(parseDocumentStoreInputValue(idValue, kind), kind);
      const routing = isEs ? documentRoutingFromGridRow(newRow, cols) : undefined;
      if (kind === "dynamodb") {
        if (idValue !== null && idValue !== undefined && idValue !== "") doc._id = parseDocumentStoreInputValue(idValue, kind);
        const normalized = prepareDynamoDbDocumentIdentity(doc);
        const writeDocument = prepareDocumentStoreWriteDocument(normalized.document, { kind, mode: "insert" });
        await api.documentInsertDocument(props.connectionId, props.database, props.collection, stringifyDocumentStoreValue(writeDocument, kind));
      } else if (id) {
        await api.documentUpdateDocument(props.connectionId, props.database, props.collection, id, stringifyDocumentStoreValue(doc, kind), routing);
      } else {
        await api.documentInsertDocument(props.connectionId, props.database, props.collection, stringifyDocumentStoreValue(doc, kind), routing);
      }
      continue;
    }
    const sourceIndex = newRowMeta?.sourceIndex;
    const preserveBsonTypes = sourceIndex !== undefined && copyDocuments.value[sourceIndex] !== undefined;
    await api.documentInsertDocument(props.connectionId, props.database, props.collection, JSON.stringify(doc), undefined, preserveBsonTypes);
  }

  if (isEs) resetElasticsearchTotals({ preservePaginationTotal: true });
  if (kind === "dynamodb") {
    page.value = 0;
    resetDynamoDbPagination();
  }
  await reloadDocumentsAfterMutationOrRefresh();
}

function buildPathIdentityInsertDocument(row: MongoInputValue[], columns: string[], kind: Exclude<DocumentStoreKind, "mongodb">): JsonRecord {
  const doc: JsonRecord = {};
  for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
    const column = columns[columnIndex];
    if (!column || column === "_id" || (kind === "elasticsearch" && column === "_routing")) continue;
    const value = row[columnIndex];
    if (value !== null) doc[column] = parseDocumentStoreInputValue(value, kind);
  }
  return doc;
}

function buildPathIdentityUpdatedDocument(document: JsonRecord, changes: Map<number, MongoInputValue>, columns: string[], kind: Exclude<DocumentStoreKind, "mongodb">): JsonRecord {
  const updated = { ...document };
  for (const [columnIndex, newValue] of changes) {
    const column = columns[columnIndex];
    if (!column || column === "_id" || (kind === "elasticsearch" && column === "_routing")) continue;
    if (newValue === null) delete updated[column];
    else updated[column] = parseDocumentStoreInputValue(newValue, kind);
  }
  return updated;
}

function buildMongoGridInsertDocument(row: MongoInputValue[], columns: string[], meta?: GridNewRowMeta): Record<string, unknown> {
  const sourceIndex = meta?.sourceIndex;
  const sourceDocument = sourceIndex === undefined ? undefined : copyDocuments.value[sourceIndex];
  if (!sourceDocument) return buildMongoInsertDocument(row, columns);
  const editedColumns = new Set(meta?.editedColumns);
  return (
    buildMongoCopyDocumentFromOriginal(
      sourceDocument,
      row,
      columns,
      columns.map((_, index) => editedColumns.has(index)),
      { excludePrimaryKeys: true },
    ) ?? buildMongoInsertDocument(row, columns)
  );
}

function elasticsearchPathIdPreview(id: string): string {
  return encodeURIComponent(id);
}

function elasticsearchRoutingPreview(routing: string | undefined): string {
  return routing ? `?routing=${encodeURIComponent(routing)}` : "";
}

function buildElasticsearchPartialUpdateDocument(changes: Map<number, MongoInputValue>, columns: string[]): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  for (const [colIdx, newVal] of changes) {
    const col = columns[colIdx];
    if (col === "_id" || col === "_routing") continue;
    if (col && newVal !== null) document[col] = parseDocumentStoreInputValue(newVal, "elasticsearch");
  }
  return document;
}

function formatDynamoDbOperationPreview(action: "insert" | "put" | "delete", id: unknown, document?: Record<string, unknown>): string {
  const operation = action === "insert" ? "INSERT ITEM" : action === "put" ? "PUT ITEM" : "DELETE ITEM";
  const lines = [`DBX DYNAMODB ${operation}`, `table: ${JSON.stringify(props.collection)}`];
  if (id !== undefined) lines.push("key:", stringifyDocumentStoreValue(id, "dynamodb", 2));
  if (document) lines.push("item:", stringifyDocumentStoreValue(document, "dynamodb", 2));
  return lines.join("\n");
}

async function previewDocumentChanges(changes: DocumentGridChanges): Promise<string[]> {
  const { dirtyRows, deletedRows, newRows, newRowMeta, columns, rows } = changes;
  const idColIdx = columns.indexOf("_id");
  const stmts: string[] = [];
  const coll = props.collection;
  const kind = documentStoreProvider.value.kind;
  const isPathIdentityStore = kind !== "mongodb";
  const isEs = kind === "elasticsearch";

  for (const [rowIdx, dirtyCols] of dirtyRows) {
    const row = rows[rowIdx];
    const id = row?.[idColIdx];
    if (id == null) continue;
    if (isPathIdentityStore) {
      if (isEs) {
        const updateDoc = buildElasticsearchPartialUpdateDocument(dirtyCols, columns);
        const routing = documentRoutingFromGridRow(row, columns);
        stmts.push(`POST /${coll}/_update/${elasticsearchPathIdPreview(String(id))}${elasticsearchRoutingPreview(routing)}\n${stringifyDocumentStoreValue({ doc: updateDoc.$set ?? updateDoc }, "elasticsearch", 2)}`);
      } else if (kind === "dynamodb") {
        const sourceDocument = documents.value[rowIdx];
        if (!sourceDocument) continue;
        const documentId = sourceDocument._id ?? id;
        const updated = buildPathIdentityUpdatedDocument(sourceDocument, dirtyCols, columns, "dynamodb");
        const normalized = prepareDynamoDbDocumentIdentity(updated);
        const writeDocument = prepareDocumentStoreWriteDocument(normalized.document, { kind: "dynamodb", mode: "update" });
        stmts.push(formatDynamoDbOperationPreview("put", documentId, writeDocument));
      } else {
        const sourceDocument = documents.value[rowIdx];
        if (!sourceDocument) continue;
        const documentId = sourceDocument._id ?? id;
        const updated = buildPathIdentityUpdatedDocument(sourceDocument, dirtyCols, columns, kind === "solr" ? "solr" : "meilisearch");
        const writeDocument = prepareDocumentStoreWriteDocument(updated, { kind: kind === "solr" ? "solr" : "meilisearch", mode: "update" });
        stmts.push(kind === "solr" ? formatSolrDocumentOperationPreview({ action: "update", core: coll, id: documentId, document: writeDocument }) : formatMeilisearchDocumentOperationPreview({ action: "update", index: coll, id: documentId, document: writeDocument }));
      }
    } else {
      const updateDoc = buildMongoUpdateDocument(dirtyCols, columns, documents.value[rowIdx]);
      stmts.push(`db.${coll}.updateOne({_id: ${formatMongoShellLiteral(documents.value[rowIdx]?._id ?? id)}}, ${formatMongoShellLiteral(updateDoc)})`);
    }
  }

  for (const rowIdx of deletedRows) {
    const row = rows[rowIdx];
    const id = row?.[idColIdx];
    if (id == null) continue;
    if (isPathIdentityStore) {
      if (kind === "dynamodb") {
        stmts.push(formatDynamoDbOperationPreview("delete", documents.value[rowIdx]?._id ?? id));
        continue;
      }
      if (!isEs) {
        stmts.push(kind === "solr" ? formatSolrDocumentOperationPreview({ action: "delete", core: coll, id: documents.value[rowIdx]?._id ?? id }) : formatMeilisearchDocumentOperationPreview({ action: "delete", index: coll, id: documents.value[rowIdx]?._id ?? id }));
        continue;
      }
      const routing = documentRoutingFromGridRow(row, columns);
      stmts.push(`DELETE /${coll}/_doc/${elasticsearchPathIdPreview(String(id))}${elasticsearchRoutingPreview(routing)}`);
    } else {
      stmts.push(`db.${coll}.deleteOne({_id: ${formatMongoShellLiteral(documents.value[rowIdx]?._id ?? id)}})`);
    }
  }

  for (const [newRowIndex, newRow] of newRows.entries()) {
    const doc = isPathIdentityStore ? buildPathIdentityInsertDocument(newRow, columns, kind) : buildMongoGridInsertDocument(newRow, columns, newRowMeta[newRowIndex]);
    if (isPathIdentityStore) {
      if (kind === "dynamodb") {
        const idValue = idColIdx >= 0 ? newRow[idColIdx] : undefined;
        if (idValue !== null && idValue !== undefined && idValue !== "") doc._id = parseDocumentStoreInputValue(idValue, "dynamodb");
        const normalized = prepareDynamoDbDocumentIdentity(doc);
        const writeDocument = prepareDocumentStoreWriteDocument(normalized.document, { kind: "dynamodb", mode: "insert" });
        stmts.push(formatDynamoDbOperationPreview("insert", JSON.parse(normalized.id), writeDocument));
        continue;
      }
      if (!isEs) {
        const idValue = idColIdx >= 0 ? newRow[idColIdx] : null;
        const id = idValue === null || idValue === undefined || idValue === "" ? undefined : parseDocumentStoreInputValue(idValue, kind === "solr" ? "solr" : "meilisearch");
        stmts.push(kind === "solr" ? formatSolrDocumentOperationPreview({ action: id === undefined ? "insert" : "upsert", core: coll, id, document: doc }) : formatMeilisearchDocumentOperationPreview({ action: id === undefined ? "insert" : "upsert", index: coll, id, document: doc }));
        continue;
      }
      const id = idColIdx >= 0 ? documentIdFromGridValue(newRow[idColIdx]) : null;
      if (id) {
        stmts.push(`PUT /${coll}/_doc/${elasticsearchPathIdPreview(id)}\n${stringifyDocumentStoreValue(doc, "elasticsearch", 2)}`);
      } else {
        stmts.push(`POST /${coll}/_doc\n${stringifyDocumentStoreValue(doc, "elasticsearch", 2)}`);
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

function elasticsearchCountFilterKey(filter: string | undefined): string {
  return JSON.stringify([props.connectionId, props.database, props.collection, filter ?? ""]);
}

function isCurrentDocumentQueryTotalCountRequest(request: LoadedDocumentQueryTotalCountRequest): boolean {
  if (request.generation !== documentRequestGeneration || request.connectionId !== props.connectionId || request.database !== props.database || request.collection !== props.collection || request.storeKind !== documentStoreProvider.value.kind) {
    return false;
  }
  return loadedDocumentQueryTotalCountRequest !== undefined && isSameDocumentQueryTotalCountRequest(request, loadedDocumentQueryTotalCountRequest) && request.storeKind === loadedDocumentQueryTotalCountRequest.storeKind;
}

function cancelElasticsearchCount() {
  elasticsearchCountGeneration++;
  const executionId = elasticsearchCountExecutionId;
  elasticsearchCountExecutionId = "";
  if (executionId) void api.cancelQuery(executionId);
}

function resetElasticsearchTotals(options: { preservePaginationTotal?: boolean } = {}) {
  const nextTotals = resetElasticsearchDocumentTotals(paginationTotal.value, options.preservePaginationTotal);
  cancelElasticsearchCount();
  elasticsearchCountKey = null;
  elasticsearchExactTotal = undefined;
  elasticsearchPaginationLowerBound = undefined;
  paginationTotal.value = nextTotals.paginationTotal;
  total.value = nextTotals.total;
  totalIsExact.value = nextTotals.totalIsExact;
  resetElasticsearchPagination();
}

function clampPageToPaginationTotal(): number | undefined {
  const cap = paginationTotal.value;
  if (cap === undefined) return undefined;
  const nextPage = clampDocumentPage(page.value, pageSize.value, cap);
  if (page.value === nextPage) return undefined;
  return nextPage;
}

function startElasticsearchExactCount(filter: string | undefined) {
  if (elasticsearchCountExecutionId || elasticsearchExactTotal !== undefined || !elasticsearchCountKey) return;
  const key = elasticsearchCountKey;
  const executionId = uuid();
  const generation = elasticsearchCountGeneration;
  elasticsearchCountExecutionId = executionId;

  void api
    .elasticsearchCountDocuments(props.connectionId, props.collection, filter, executionId)
    .then((exactCount) => {
      if (generation !== elasticsearchCountGeneration || key !== elasticsearchCountKey || executionId !== elasticsearchCountExecutionId || !Number.isFinite(exactCount) || exactCount < 0) {
        return;
      }
      elasticsearchExactTotal = exactCount;
      const totals = resolveElasticsearchDocumentTotals(elasticsearchPaginationLowerBound ?? exactCount, false, exactCount);
      total.value = totals.total;
      totalIsExact.value = totals.totalIsExact;
      paginationTotal.value = totals.paginationTotal;
      const clampedPage = clampPageToPaginationTotal();
      if (clampedPage !== undefined) void load({ page: clampedPage });
    })
    .catch(() => {
      // The lower-bound result remains truthful when a background count fails.
    })
    .finally(() => {
      if (generation === elasticsearchCountGeneration && executionId === elasticsearchCountExecutionId) {
        elasticsearchCountExecutionId = "";
      }
    });
}

function applyElasticsearchSearchTotal(searchTotal: number, isExact: boolean, filter: string | undefined) {
  const key = elasticsearchCountFilterKey(filter);
  if (key !== elasticsearchCountKey) {
    cancelElasticsearchCount();
    elasticsearchCountKey = key;
    elasticsearchExactTotal = undefined;
    elasticsearchPaginationLowerBound = undefined;
  }

  elasticsearchPaginationLowerBound = searchTotal;
  const totals = resolveElasticsearchDocumentTotals(searchTotal, isExact, elasticsearchExactTotal);
  if (isExact) {
    cancelElasticsearchCount();
    elasticsearchExactTotal = searchTotal;
    total.value = totals.total;
    totalIsExact.value = totals.totalIsExact;
    paginationTotal.value = totals.paginationTotal;
    return;
  }

  if (elasticsearchExactTotal !== undefined) {
    total.value = totals.total;
    totalIsExact.value = totals.totalIsExact;
    paginationTotal.value = totals.paginationTotal;
    return;
  }

  total.value = totals.total;
  totalIsExact.value = totals.totalIsExact;
  paginationTotal.value = totals.paginationTotal;
  startElasticsearchExactCount(filter);
}

async function load(options: { page?: number; append?: boolean; offset?: number; limit?: number } = {}) {
  if (documentLoadExecutionId.value) void api.cancelQuery(documentLoadExecutionId.value);
  const requestGeneration = ++documentRequestGeneration;
  const executionId = uuid();
  loading.value = true;
  documentLoadExecutionId.value = executionId;
  documentLoadCancelling.value = false;
  startDocumentLoadingTimer();
  error.value = "";
  const requestPage = options.page ?? page.value;
  const previousSelectedIdx = selectedIdx.value;
  const previousSelectedId = previousSelectedIdx === null ? null : documentIdentity(documents.value[previousSelectedIdx]);
  try {
    const connectionId = props.connectionId;
    const database = props.database;
    const collection = props.collection;
    const storeKind = documentStoreProvider.value.kind;
    const filter = currentDocumentFilter();
    if (storeKind === "dynamodb") {
      const countKey = dynamodbCountFilterKey(filter);
      if (dynamodbExactCountKey !== countKey) {
        dynamodbExactCountKey = countKey;
        dynamodbExactTotal.value = undefined;
      }
    }
    const countRequest: LoadedDocumentQueryTotalCountRequest = { connectionId, database, collection, filter, generation: requestGeneration, storeKind };
    if (storeKind === "elasticsearch" && elasticsearchCountKey !== null && elasticsearchCountKey !== elasticsearchCountFilterKey(filter)) {
      resetElasticsearchTotals();
    }
    const sort = currentDocumentSortJson(sortInput.value);
    const cursor = storeKind === "dynamodb" ? dynamodbPageCursors.value[requestPage] : storeKind === "elasticsearch" ? elasticsearchPageCursors.value[requestPage] : undefined;
    if ((storeKind === "dynamodb" || storeKind === "elasticsearch") && requestPage > 0 && !cursor) {
      throw new Error(storeKind === "dynamodb" ? t("dynamodb.pageCursorUnavailable") : "Elasticsearch page cursor unavailable; go back to the first page and page forward again");
    }
    // Starting a fresh ES first page invalidates any previous PIT cursor stack.
    if (storeKind === "elasticsearch" && !cursor && requestPage === 0) {
      resetElasticsearchPagination();
    }
    const skip = storeKind === "dynamodb" || storeKind === "elasticsearch" ? 0 : (options.offset ?? requestPage * pageSize.value);
    const requestedLimit = options.limit ?? pageSize.value;
    const requestLimit = storeKind === "elasticsearch" ? Math.min(requestedLimit, ELASTICSEARCH_DEFAULT_MAX_RESULT_WINDOW) : requestedLimit;
    const result = await api.documentFindDocuments(connectionId, database, collection, skip, requestLimit, filter, undefined, sort, undefined, executionId, cursor, storeKind === "elasticsearch");
    if (documentLoadExecutionId.value !== executionId) return;
    if (connectionId !== props.connectionId || database !== props.database || collection !== props.collection || storeKind !== documentStoreProvider.value.kind) return;
    const nextDocuments =
      (storeKind === "elasticsearch" || storeKind === "solr") && result.raw_documents?.length === result.documents.length
        ? result.raw_documents.map((raw, index) => {
            try {
              return asRecord(parseJsonPreservingLargeNumbers(raw));
            } catch {
              return asRecord(result.documents[index]);
            }
          })
        : result.documents.map(asRecord);
    const hasTypePreservingCopyDocuments = result.extended_documents?.length === nextDocuments.length;
    const nextCopyDocuments = hasTypePreservingCopyDocuments ? result.extended_documents!.map(asRecord) : nextDocuments;
    // Commit page + rows together so stale rows never briefly show last-page indexes.
    if (options.page !== undefined) page.value = options.page;
    commitLoadedDocuments(nextDocuments, nextCopyDocuments, hasTypePreservingCopyDocuments, options.append === true, storeKind);
    // Mark which conditions these rows belong to, so the unmount capture can
    // tell a still-valid page from one the user has since edited away.
    loadedDocumentDataSignature = documentDataSignature();
    // A replacement dataset must not adopt the previous viewport; an
    // infinite-scroll append keeps rendering the same logical result.
    if (options.append !== true || !documentViewGeneration.value) documentViewGeneration.value = uuid();
    loadedDocumentQueryTotalCountRequest = countRequest;
    if (storeKind === "dynamodb") {
      const nextCursors = dynamodbPageCursors.value.slice(0, requestPage + 1);
      nextCursors[requestPage + 1] = result.next_cursor;
      dynamodbPageCursors.value = nextCursors;
      dynamodbHasNextCursor.value = !!result.next_cursor;
    }
    if (storeKind === "elasticsearch") {
      const nextCursors = elasticsearchPageCursors.value.slice(0, requestPage + 1);
      nextCursors[requestPage + 1] = result.next_cursor ?? undefined;
      elasticsearchPageCursors.value = nextCursors;
      elasticsearchHasNextCursor.value = !!result.next_cursor;
      applyElasticsearchSearchTotal(result.total, result.total_is_exact !== false, filter);
    } else if (storeKind === "dynamodb") {
      cancelElasticsearchCount();
      const lowerBound = requestPage * pageSize.value + nextDocuments.length + (result.next_cursor ? 1 : 0);
      const exactTotal = dynamodbExactTotal.value ?? (!result.next_cursor ? lowerBound : undefined);
      total.value = exactTotal ?? lowerBound;
      totalIsExact.value = exactTotal !== undefined;
      paginationTotal.value = exactTotal;
    } else {
      cancelElasticsearchCount();
      const totals = resolveDocumentQueryTotals(result.total, result.total_is_exact !== false, {
        page: requestPage,
        pageSize: pageSize.value,
        rowCount: nextDocuments.length,
      });
      total.value = totals.total;
      totalIsExact.value = totals.totalIsExact;
      paginationTotal.value = totals.paginationTotal;
    }
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

async function countExactDocumentTotal(): Promise<number | undefined> {
  const request = loadedDocumentQueryTotalCountRequest;
  if (!request || !isCurrentDocumentQueryTotalCountRequest(request)) return undefined;
  if (request.storeKind === "elasticsearch") {
    const exactCount = await api.elasticsearchCountDocuments(request.connectionId, request.collection, request.filter);
    if (!isCurrentDocumentQueryTotalCountRequest(request)) return undefined;
    if (!Number.isFinite(exactCount) || exactCount < 0) {
      throw new Error("invalid count");
    }
    elasticsearchExactTotal = exactCount;
    const totals = resolveElasticsearchDocumentTotals(elasticsearchPaginationLowerBound ?? exactCount, false, exactCount);
    total.value = totals.total;
    totalIsExact.value = totals.totalIsExact;
    paginationTotal.value = totals.paginationTotal;
    return exactCount;
  }
  const exactCount = request.storeKind === "dynamodb" || request.storeKind === "solr" ? await api.documentCountDocuments(request.connectionId, request.collection, request.filter) : await api.mongoCountDocuments(request.connectionId, request.database, request.collection, request.filter, "accurate");
  if (!isCurrentDocumentQueryTotalCountRequest(request)) return undefined;
  if (!Number.isFinite(exactCount) || exactCount < 0) {
    throw new Error("invalid count");
  }
  if (request.storeKind === "dynamodb") {
    dynamodbExactCountKey = dynamodbCountFilterKey(request.filter);
    dynamodbExactTotal.value = exactCount;
  }
  const totals = resolveDocumentQueryTotals(exactCount, true);
  total.value = totals.total;
  totalIsExact.value = totals.totalIsExact;
  paginationTotal.value = totals.paginationTotal;
  return exactCount;
}

async function refreshDocuments() {
  if (documentStoreProvider.value.kind === "elasticsearch") resetElasticsearchTotals({ preservePaginationTotal: true });
  if (documentStoreProvider.value.kind === "dynamodb") resetDynamoDbExactCount();
  await reloadDocumentsAfterMutationOrRefresh();
}

async function reloadDocumentsAfterMutationOrRefresh() {
  if (!settingsStore.editorSettings.infiniteScroll) {
    await load();
    return;
  }
  page.value = 0;
  dataGridRef.value?.resetInfiniteScrollState?.();
  await load({ page: 0, offset: 0 });
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
  if (documentStoreProvider.value.kind === "elasticsearch") resetElasticsearchTotals();
  if (documentStoreProvider.value.kind === "dynamodb") resetDynamoDbPagination();
  void load();
}

async function paginate(offset: number, limit: number) {
  const normalizedOffset = Math.max(0, Math.trunc(offset));
  const normalizedLimit = normalizeResultPageSize(limit, pageSize.value);
  if (documentStoreProvider.value.kind !== "dynamodb" && settingsStore.editorSettings.infiniteScroll && normalizedOffset > 0 && normalizedOffset === documents.value.length) {
    const requestedPage = Math.floor(normalizedOffset / pageSize.value);
    const nextPage = clampDocumentPage(requestedPage, pageSize.value, paginationTotal.value);
    await load({ page: nextPage, append: true, offset: normalizedOffset, limit: normalizedLimit });
    return;
  }
  const pageSizeChanged = normalizedLimit !== pageSize.value;
  pageSize.value = normalizedLimit;
  if (pageSizeChanged && (documentStoreProvider.value.kind === "dynamodb" || documentStoreProvider.value.kind === "elasticsearch")) {
    page.value = 0;
    if (documentStoreProvider.value.kind === "dynamodb") {
      resetDynamoDbPagination({ preserveExactCount: true });
    } else {
      resetElasticsearchPagination();
    }
    await load({ page: 0 });
    return;
  }
  const requestedPage = Math.floor(normalizedOffset / normalizedLimit);
  const nextPage = clampDocumentPage(requestedPage, normalizedLimit, paginationTotal.value);
  if (documentStoreProvider.value.kind !== "dynamodb" && documentStoreProvider.value.kind !== "elasticsearch") {
    await load({ page: nextPage, offset: nextPage * normalizedLimit, limit: normalizedLimit });
    return;
  }
  for (let cursorPage = 0; cursorPage <= nextPage; cursorPage += 1) {
    const pageCursor = documentStoreProvider.value.kind === "dynamodb" ? dynamodbPageCursors.value[cursorPage] : elasticsearchPageCursors.value[cursorPage];
    if (cursorPage > 0 && !pageCursor) {
      error.value = documentStoreProvider.value.kind === "dynamodb" ? t("dynamodb.pageCursorUnavailable") : "Elasticsearch page cursor unavailable; go back to the first page and page forward again";
      return;
    }
    if (cursorPage === nextPage) {
      await load({ page: cursorPage });
      return;
    }
    const nextCursor = documentStoreProvider.value.kind === "dynamodb" ? dynamodbPageCursors.value[cursorPage + 1] : elasticsearchPageCursors.value[cursorPage + 1];
    if (!nextCursor) {
      await load({ page: cursorPage });
    }
  }
}

function onSort(column: string, _columnIndex: number, direction: "asc" | "desc" | null) {
  if (documentStoreProvider.value.kind === "dynamodb" && direction && dynamodbSelectedKey.value?.sortKey?.name !== column) {
    error.value = t("dynamodb.sortKeyOnly", { key: dynamodbSelectedKey.value?.sortKey?.name || t("dynamodb.none") });
    return;
  }
  sortInput.value = documentStoreProvider.value.sortInputForColumn(column, direction);
  page.value = 0;
  if (documentStoreProvider.value.kind === "dynamodb") resetDynamoDbPagination({ preserveExactCount: true });
  void load();
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
  return serializeDocumentStoreId(id, documentStoreProvider.value.kind);
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
    editJson.value = stringifyDocumentStoreValue(documents.value[nextIdx], documentStoreProvider.value.kind, 2);
  }
}

function emptyDocumentJson(): string {
  return stringifyDocumentStoreValue({}, documentStoreProvider.value.kind, 2);
}

function documentEditErrorMessage(result: { error: "empty" | "invalid" | "not-object" | "unsupported-number" } | { error: "duplicate-key"; field: string }): string {
  if (result.error === "not-object") return t("mongo.documentMustBeObject");
  if (result.error === "unsupported-number") return t("mongo.unsupportedJsonNumber");
  if (result.error === "duplicate-key") return t("mongo.duplicateJsonKey", { field: result.field });
  return t("mongo.invalidJson");
}

function buildEditFieldsFromDocument(doc: JsonRecord): EditNode[] {
  return Object.entries(doc).map(([name, value]) => {
    const isMetadata = isDocumentStoreIdentityField(documentStoreProvider.value.kind, name);
    // Metadata field names stay fixed; values are editable so _id / routing rekey is possible.
    return createEditNode(name, value, isMetadata, false);
  });
}

function metadataFieldsFromDocument(doc: JsonRecord | undefined): JsonRecord {
  const metadata: JsonRecord = {};
  if (!doc) return metadata;
  if (Object.prototype.hasOwnProperty.call(doc, "_id")) metadata._id = doc._id;
  if (documentStoreProvider.value.kind === "elasticsearch" && Object.prototype.hasOwnProperty.call(doc, "_routing")) {
    metadata._routing = doc._routing;
  }
  return metadata;
}

function currentDocumentMetadata(): JsonRecord {
  if (selectedDoc.value) return metadataFieldsFromDocument(selectedDoc.value);
  // New documents keep metadata that already exists in either editor mode.
  if (documentEditMode.value === "json") {
    const parsed = parseDocumentStoreJsonDocument(editJson.value, documentStoreProvider.value.kind);
    return parsed.ok ? metadataFieldsFromDocument(parsed.document) : {};
  }
  const metadata: JsonRecord = {};
  for (const field of editFields.value) {
    const name = field.keyName.trim();
    if (isDocumentStoreIdentityField(documentStoreProvider.value.kind, name)) {
      metadata[name] = buildValueFromNode(field, name);
    }
  }
  return metadata;
}

function syncEditJsonFromFields() {
  const doc = buildDocumentFromFields();
  // Field mode omits root metadata keys; restore them for JSON round-trips (new + existing).
  Object.assign(doc, currentDocumentMetadata());
  editJson.value = stringifyDocumentStoreValue(doc, documentStoreProvider.value.kind, 2);
}

function setDocumentEditMode(mode: "fields" | "json") {
  if (!isEditing.value || documentEditMode.value === mode) return;
  error.value = "";
  if (mode === "json") {
    try {
      syncEditJsonFromFields();
      documentEditMode.value = "json";
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message : String(e);
    }
    return;
  }

  const parsed = parseDocumentStoreJsonDocument(editJson.value, documentStoreProvider.value.kind);
  if (!parsed.ok) {
    error.value = documentEditErrorMessage(parsed);
    return;
  }
  editFields.value = buildEditFieldsFromDocument(parsed.document);
  documentEditMode.value = "fields";
}

function selectDoc(idx: number) {
  selectedIdx.value = idx;
  editJson.value = stringifyDocumentStoreValue(documents.value[idx], documentStoreProvider.value.kind, 2);
  isEditing.value = false;
  isNew.value = false;
  documentEditMode.value = "fields";
  editFields.value = [];
  error.value = "";
}

function startNew() {
  if (!documentStoreEditable.value) return;
  selectedIdx.value = null;
  editJson.value = emptyDocumentJson();
  editFields.value = [createEditNode("", "", false, false)];
  documentEditMode.value = "json";
  isEditing.value = true;
  isNew.value = true;
  error.value = "";
}

function startEdit() {
  if (!documentStoreEditable.value) return;
  const doc = selectedDoc.value;
  if (!doc) return;
  // Issue #2952: open whole-document JSON editing by default (DBeaver-style), not field tree.
  editJson.value = stringifyDocumentStoreValue(doc, documentStoreProvider.value.kind, 2);
  editFields.value = buildEditFieldsFromDocument(doc);
  documentEditMode.value = "json";
  isEditing.value = true;
  isNew.value = false;
  error.value = "";
}

function cancelEdit() {
  isEditing.value = false;
  documentEditMode.value = "fields";
  if (isNew.value) {
    isNew.value = false;
    editFields.value = [];
    editJson.value = "";
    error.value = "";
    return;
  }
  if (selectedDoc.value) {
    editJson.value = stringifyDocumentStoreValue(selectedDoc.value, documentStoreProvider.value.kind, 2);
  }
  editFields.value = [];
  documentEditMode.value = "fields";
  error.value = "";
}

function createEditNode(keyName: string, value: unknown, readonlyKey: boolean, readonlyValue: boolean): EditNode {
  if (isLosslessJsonNumber(value)) {
    return {
      key: uuid(),
      keyName,
      kind: "value",
      valueText: value.raw,
      readonlyKey,
      readonlyValue,
      children: [],
    };
  }
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
  value = mongoDocumentDisplayValue(value);
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object") return stringifyDocumentStoreValue(value, documentStoreProvider.value.kind, 2);
  return String(value);
}

function parseFieldValue(raw: string): unknown {
  return parseDocumentStoreInputValue(raw, documentStoreProvider.value.kind);
}

function buildObjectFromNodes(nodes: EditNode[], path: string): JsonRecord {
  const doc: JsonRecord = {};
  const seen = new Set<string>();

  for (const field of nodes) {
    const name = field.keyName.trim();
    if (!name || (!path && isDocumentStoreIdentityField(documentStoreProvider.value.kind, name))) continue;
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

function buildDocumentFromEditor(): JsonRecord | null {
  if (documentEditMode.value === "json") {
    const parsed = parseDocumentStoreJsonDocument(editJson.value, documentStoreProvider.value.kind);
    if (!parsed.ok) {
      error.value = documentEditErrorMessage(parsed);
      return null;
    }
    return parsed.document;
  }

  // Field mode skips root metadata in buildDocumentFromFields(); reattach identity field values.
  const doc = buildDocumentFromFields();
  for (const field of editFields.value) {
    const name = field.keyName.trim();
    if (isDocumentStoreIdentityField(documentStoreProvider.value.kind, name)) {
      doc[name] = buildValueFromNode(field, name);
    }
  }
  return doc;
}

function resolveDocumentStorePathId(id: unknown): string | null {
  if (documentStoreProvider.value.kind === "elasticsearch") {
    return documentIdFromGridValue(documentStoreValueForGrid(id, "elasticsearch"));
  }
  if (id === undefined || id === null || id === "") return null;
  try {
    const serialized = serializeDocumentStoreId(id, documentStoreProvider.value.kind);
    return serialized.trim() ? serialized : null;
  } catch {
    return null;
  }
}

function resolveWriteIdentityFromEditor(doc: JsonRecord, currentId: unknown, currentRouting: string | undefined): { writeId: string; writeRouting?: string } | null {
  const kind = documentStoreProvider.value.kind;
  if (kind === "dynamodb") {
    return { writeId: prepareDynamoDbDocumentIdentity(doc).id };
  }
  const hasPayloadId = Object.prototype.hasOwnProperty.call(doc, "_id");
  const writeId = hasPayloadId ? resolveDocumentStorePathId(doc._id) : resolveDocumentStorePathId(currentId);
  if (!writeId) return null;
  const writeRouting = kind === "elasticsearch" ? resolveDocumentStoreWriteRouting(doc, currentRouting) : undefined;
  return { writeId, writeRouting };
}

async function saveDoc() {
  if (isSavingDocument.value || !documentStoreEditable.value) return;
  error.value = "";
  isSavingDocument.value = true;
  try {
    const doc = buildDocumentFromEditor();
    if (!doc) return;

    const kind = documentStoreProvider.value.kind;
    const writeDocument = kind === "dynamodb" ? prepareDynamoDbDocumentIdentity(doc).document : doc;

    if (isNew.value) {
      const apis = documentStoreWriteApis();
      const explicitId = kind === "mongodb" || writeDocument._id === undefined || writeDocument._id === null || writeDocument._id === "" ? null : resolveDocumentStorePathId(writeDocument._id);
      await insertDocumentStoreDocumentCore({
        kind,
        document: writeDocument,
        explicitId,
        routing: normalizeDocumentStoreRouting(doc._routing),
        apis,
      });
    } else if (selectedIdx.value !== null) {
      const current = documents.value[selectedIdx.value];
      const currentId = current?._id;
      if (currentId === undefined || currentId === null) {
        error.value = "No _id field";
        return;
      }

      const deleteId = resolveDocumentStorePathId(currentId);
      if (!deleteId) {
        error.value = "No _id field";
        return;
      }
      const currentRouting = documentRoutingFromDocument(current);
      const apis = documentStoreWriteApis(kind === "elasticsearch" ? documentTypeFromDocument(current) : undefined);
      const write = resolveWriteIdentityFromEditor(writeDocument, currentId, currentRouting);
      if (!write) {
        error.value = t("mongo.jsonIdRequired");
        return;
      }

      const plan = planDocumentStoreIdentityMigration({
        write: { id: write.writeId, routing: write.writeRouting },
        current: { id: deleteId, routing: kind === "elasticsearch" ? currentRouting : undefined },
      });
      await applyDocumentStoreIdentityPlan({ kind, plan, document: writeDocument, apis });
    } else {
      return;
    }

    isEditing.value = false;
    isNew.value = false;
    documentEditMode.value = "fields";
    editFields.value = [];
    if (kind === "elasticsearch") resetElasticsearchTotals({ preservePaginationTotal: true });
    if (kind === "dynamodb") {
      page.value = 0;
      resetDynamoDbPagination();
    }
    await reloadDocumentsAfterMutationOrRefresh();
    if (selectedIdx.value !== null && documents.value[selectedIdx.value]) {
      editJson.value = stringifyDocumentStoreValue(documents.value[selectedIdx.value], documentStoreProvider.value.kind, 2);
    }
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    isSavingDocument.value = false;
  }
}

async function applyDeleteDoc(idx: number) {
  const doc = documents.value[idx];
  const id = doc._id;
  if (id === undefined || id === null || id === "") return;
  error.value = "";
  try {
    await api.documentDeleteDocument(props.connectionId, props.database, props.collection, serializeDocumentStoreId(id, documentStoreProvider.value.kind), documentRoutingFromDocument(doc), documentStoreProvider.value.kind === "elasticsearch" ? documentTypeFromDocument(doc) : undefined);
    if (selectedIdx.value === idx) {
      selectedIdx.value = null;
      editJson.value = "";
    }
    if (documentStoreProvider.value.kind === "elasticsearch") resetElasticsearchTotals({ preservePaginationTotal: true });
    if (documentStoreProvider.value.kind === "dynamodb") {
      page.value = 0;
      resetDynamoDbPagination();
    }
    await load();
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function requestDeleteDoc(idx: number) {
  if (!documentStoreEditable.value) return;
  if (!settingsStore.editorSettings.confirmDangerousSqlExecution) {
    void applyDeleteDoc(idx);
    return;
  }
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
  void load();
}

function nextPage() {
  if (!canGoNextPage.value) return;
  page.value++;
  void load();
}

function docPreview(doc: JsonRecord): string {
  const id = formatDocumentStoreIdLabel(doc._id, documentStoreProvider.value.kind);
  const keys = Object.keys(doc)
    .filter((k) => k !== "_id")
    .slice(0, 3);
  const preview = keys.map((k) => `${k}: ${stringifyDocumentStoreValue(doc[k], documentStoreProvider.value.kind).substring(0, 30)}`).join(", ");
  return `${id} - ${preview}`;
}

async function copyDocument() {
  try {
    await copyToClipboard(editJson.value);
    toast(t("grid.copied"), 1500);
  } catch (error: unknown) {
    toast(t("grid.copyFailed", { message: error instanceof Error ? error.message : String(error) }), 3000);
  }
}

function handleDocumentViewerDoubleClick(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  // CodeMirror uses .cm-line for rendered document content. Preserve the
  // existing shortcut only for whitespace around the source, not text itself.
  if (target.closest(".cm-line")) return;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.toString()) return;
  startEdit();
}

function handleDocumentBrowserPointerDown(event: PointerEvent) {
  const target = event.target;
  documentViewerSearchActive.value = target instanceof Element && !!target.closest("[data-document-json-viewer], [data-document-search]");
}

function focusSearch(): boolean {
  if (viewMode.value !== "document" || !documentViewerSearchActive.value) return false;
  if (isEditing.value) return false;
  if (!isNew.value && selectedIdx.value === null) return false;
  return documentJsonEditorRef.value?.openSearch() ?? false;
}

watch(
  () => connectionStore.mongoImportCompleted,
  (completed) => {
    if (!completed) return;
    if (completed.connectionId !== props.connectionId || completed.database !== props.database || completed.collection !== props.collection) return;
    void refreshDocuments();
  },
);

watch([viewMode, isEditing, selectedIdx], ([mode, editing, index]) => {
  if (mode === "document" && !editing && index !== null) return;
  documentViewerSearchActive.value = false;
});

async function loadDynamoDbTableDescription() {
  if (documentStoreProvider.value.kind !== "dynamodb") return;
  try {
    dynamodbTableDescription.value = await api.dynamodbDescribeTable(props.connectionId, props.collection);
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * The sidebar's "clear index data" action deletes documents behind this tab's
 * back, so an open browser would keep listing rows that no longer exist.
 * Reload when the cleared index is the one on screen.
 */
function handleElasticsearchIndexCleared(detail: ElasticsearchIndexClearedDetail) {
  if (detail.connectionId !== props.connectionId) return;
  // Clearing a grouped node deletes from every index its pattern matches, so a
  // tab open on any concrete index under the pattern must refresh as well.
  if (detail.index !== props.collection && !matchesElasticsearchIndexPattern(detail.index, props.collection)) return;
  void refreshDocuments();
}

let unsubscribeElasticsearchIndexCleared: (() => void) | undefined;

onMounted(async () => {
  window.addEventListener("pointerdown", handleDocumentBrowserPointerDown, true);
  unsubscribeElasticsearchIndexCleared = subscribeElasticsearchIndexCleared(handleElasticsearchIndexCleared);
  try {
    // A restored tab issues no query, so a blocking health probe here would be
    // the only round trip left on the switch.
    await connectionStore.ensureConnected(props.connectionId, restoredDocumentData ? { verifyHealth: false } : {});
  } catch (e) {
    console.warn("[DBX] ensureConnected failed for", props.connectionId, e);
  }
  await loadDynamoDbTableDescription();
  // Schema metadata enriches the filter builder, but it must not delay the
  // first page of documents when the schema endpoint is slow.
  void loadDocumentStoreSchemaFields();
  // A restored snapshot already holds the rows the last load produced, so a tab
  // switch must not re-issue the collection query (#8679). Refresh and every
  // mutation path still force a real load.
  if (!restoredDocumentData) void load();
  void nextTick(resizeDocumentQueryInputs);
});
onBeforeUnmount(() => {
  persistDocumentBrowserState({ includeData: true });
  // The open/close watcher cannot run on unmount, so drop the menu's listeners here.
  window.removeEventListener("scroll", repositionOpenDocumentQueryCompletions, true);
  window.removeEventListener("resize", repositionOpenDocumentQueryCompletions);
  window.removeEventListener("pointerdown", handleDocumentBrowserPointerDown, true);
  unsubscribeElasticsearchIndexCleared?.();
  unsubscribeElasticsearchIndexCleared = undefined;
  if (documentLoadExecutionId.value) void api.cancelQuery(documentLoadExecutionId.value);
  documentRequestGeneration++;
  loadedDocumentQueryTotalCountRequest = undefined;
  cancelElasticsearchCount();
  resetElasticsearchPagination();
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

defineExpose({ focusSearch });
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden" :class="{ 'select-none': viewMode === 'document' }">
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

      <div v-if="documentStoreProvider.kind === 'dynamodb' && dynamodbTableDescription" class="ml-1 flex min-w-0 items-center gap-1.5">
        <Select :model-value="dynamodbIndexName" @update:model-value="selectDynamoDbIndex">
          <SelectTrigger class="h-6 w-44 min-w-0 text-xs" :title="t('dynamodb.index')">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in dynamodbIndexOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </SelectItem>
          </SelectContent>
        </Select>
        <span v-if="dynamodbSelectedKey" class="max-w-64 truncate font-mono text-[11px] text-muted-foreground" :title="t('dynamodb.keySummary', { partitionKey: dynamodbSelectedKey.partitionKey.name, sortKey: dynamodbSelectedKey.sortKey?.name || t('dynamodb.none') })">
          PK: {{ dynamodbSelectedKey.partitionKey.name }}<template v-if="dynamodbSelectedKey.sortKey"> · SK: {{ dynamodbSelectedKey.sortKey.name }}</template>
        </span>
        <Badge v-if="dynamodbPartialProjectionReadOnly" variant="outline" class="h-5 rounded border-amber-500/50 px-1.5 text-[10px] text-amber-600 dark:text-amber-400" :title="documentStoreEditDisabledReason">
          {{ dynamodbSelectedIndex?.projectionType }}
        </Badge>
      </div>

      <Button v-if="viewMode === 'document'" variant="ghost" size="icon" class="h-5 w-5" :disabled="!documentStoreEditable" :title="documentStoreEditDisabledReason" @click="startNew"><Plus class="h-3 w-3" /></Button>
      <Button v-if="viewMode === 'document'" variant="ghost" size="icon" class="h-5 w-5" @click="refreshDocuments"><RefreshCw class="h-3 w-3" :class="{ 'animate-spin': loading }" /></Button>

      <div v-if="viewMode === 'document'" class="flex items-center gap-1 ml-1">
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="page <= 0" @click="prevPage">
          <ChevronLeft class="h-3 w-3" />
        </Button>
        <span v-if="documentPageCount !== undefined">{{ page + 1 }} / {{ documentPageCount }}</span>
        <span v-else>{{ page + 1 }}</span>
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="!canGoNextPage" @click="nextPage">
          <ChevronRight class="h-3 w-3" />
        </Button>
      </div>

      <div class="flex-1" />

      <DataGridColumnLayoutPopover v-if="viewMode === 'table' && gridResult.columns.length" :grid="dataGridRef" />

      <Popover v-if="viewMode === 'table' && gridResult.columns.length" v-model:open="viewOptionsOpen">
        <PopoverTrigger as-child>
          <Button variant="ghost" size="icon" class="h-6 w-7 shrink-0 text-foreground hover:bg-accent" :class="{ 'bg-accent text-foreground': dataGridRef?.nullColumnsHidden }" :title="t('grid.viewOptions')" :aria-label="t('grid.viewOptions')">
            <Wrench class="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" :collision-padding="8" class="w-max min-w-44 max-h-[var(--reka-popover-content-available-height)] max-w-[calc(100vw-2rem)] gap-0 overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-0 text-popover-foreground shadow-xl" @click.stop @keydown.stop>
          <div class="border-b bg-muted/40 px-3 py-2">
            <div class="text-xs font-semibold">{{ t("grid.viewOptions") }}</div>
          </div>
          <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
            <div class="min-w-0 flex items-center gap-2 font-medium">
              <SquareDashed class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>{{ t("grid.renderMode") }}</span>
            </div>
            <LightTooltip :text="t('grid.renderModeHint')" side="left" :side-offset="6" :delay="0" :open-on-focus="false">
              <div class="grid w-32 grid-cols-2 rounded-md border bg-muted/40 p-0.5">
                <button
                  v-for="mode in ['canvas', 'dom'] as const"
                  :key="mode"
                  type="button"
                  class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-2 text-xs transition-colors"
                  :class="dataGridRenderMode === mode ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                  @click="setDataGridRenderMode(mode)"
                >
                  {{ t(mode === "canvas" ? "grid.canvasRenderMode" : "grid.domRenderMode") }}
                </button>
              </div>
            </LightTooltip>
          </div>
          <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
            <div class="min-w-0 flex items-center gap-2 font-medium">
              <Columns3Cog class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>{{ t("grid.columnWidth") }}</span>
            </div>
            <div class="grid w-48 grid-cols-3 rounded-md border bg-muted/40 p-0.5">
              <button
                v-for="density in ['compact', 'standard', 'comfortable'] as const"
                :key="density"
                type="button"
                class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-1.5 text-xs transition-colors"
                :class="columnWidthDensity === density ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                @click="setColumnWidthDensity(density)"
              >
                {{ t(`grid.columnWidth${density.charAt(0).toUpperCase()}${density.slice(1)}`) }}
              </button>
            </div>
          </div>
          <DataGridFontFamilyControl />
          <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
            <div class="min-w-0 flex items-center gap-2 font-medium">
              <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[11px] font-semibold text-muted-foreground">A</span>
              <span>{{ t("grid.tableFontSize") }}</span>
            </div>
            <div class="flex h-6 w-32 items-center rounded-md border bg-muted/40 p-0.5">
              <button
                type="button"
                class="flex h-5 w-8 items-center justify-center rounded-[5px] bg-background text-foreground shadow-sm transition-colors hover:text-foreground disabled:pointer-events-none disabled:bg-muted/40 disabled:text-muted-foreground disabled:opacity-50 disabled:shadow-none"
                :disabled="tableFontSize <= TABLE_FONT_SIZE_MIN"
                :aria-label="t('common.decrease')"
                @click="decreaseTableFontSize"
              >
                <Minus class="h-3.5 w-3.5" />
              </button>
              <span class="flex-1 text-center text-xs font-semibold tabular-nums">{{ tableFontSize }}</span>
              <button
                type="button"
                class="flex h-5 w-8 items-center justify-center rounded-[5px] bg-background text-foreground shadow-sm transition-colors hover:text-foreground disabled:pointer-events-none disabled:bg-muted/40 disabled:text-muted-foreground disabled:opacity-50 disabled:shadow-none"
                :disabled="tableFontSize >= TABLE_FONT_SIZE_MAX"
                :aria-label="t('common.increase')"
                @click="increaseTableFontSize"
              >
                <Plus class="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
            <div class="min-w-0 flex items-center gap-2 font-medium">
              <Rows3 class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>{{ t("grid.transposeMultiRowToggle") }}</span>
            </div>
            <LightTooltip :text="t('grid.transposeMultiRowHint')" side="left" :side-offset="6" :delay="0" :open-on-focus="false">
              <div class="grid w-32 grid-cols-2 rounded-md border bg-muted/40 p-0.5">
                <button
                  v-for="multiRow in [false, true]"
                  :key="String(multiRow)"
                  type="button"
                  class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-2 text-xs transition-colors"
                  :class="dataGridRef?.multiRowTranspose === multiRow ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                  @click="dataGridRef?.setMultiRowTranspose(multiRow)"
                >
                  {{ t(multiRow ? "grid.transposeMultiRow" : "grid.transposeSingleRow") }}
                </button>
              </div>
            </LightTooltip>
          </div>
          <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
            <div class="min-w-0 flex items-center gap-2 font-medium">
              <component :is="numericColumnRightAlign ? AlignRight : AlignLeft" class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>{{ t("grid.numericColumnAlign") }}</span>
            </div>
            <div class="grid w-32 grid-cols-2 rounded-md border bg-muted/40 p-0.5">
              <button
                v-for="rightAlign in [false, true]"
                :key="String(rightAlign)"
                type="button"
                class="h-5 min-w-0 truncate whitespace-nowrap rounded-[5px] px-2 text-xs transition-colors"
                :class="numericColumnRightAlign === rightAlign ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
                @click="setNumericColumnRightAlign(rightAlign)"
              >
                {{ t(rightAlign ? "grid.numericColumnAlignRight" : "grid.numericColumnAlignLeft") }}
              </button>
            </div>
          </div>
          <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
            <div class="min-w-0 flex items-center gap-2 font-medium">
              <Palette class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>{{ t("grid.colorizeDataTypes") }}</span>
            </div>
            <Switch size="sm" :model-value="colorizeDataGridCellTypes" :aria-label="t('grid.colorizeDataTypes')" @update:model-value="setColorizeDataGridCellTypes" />
          </div>
          <div class="flex items-center justify-between gap-3 px-3 py-1.5 text-xs" :class="{ 'opacity-60': !dataGridRef?.canToggleAllNullColumns }">
            <span class="min-w-0 flex items-center gap-2 font-medium">
              <EyeOff class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {{ t("grid.hideNullColumns") }}
              <span v-if="(dataGridRef?.allNullColumnCount ?? 0) > 0" class="text-muted-foreground tabular-nums"> ({{ dataGridRef?.allNullColumnCount }}) </span>
            </span>
            <Switch size="sm" :model-value="!!dataGridRef?.nullColumnsHidden" :disabled="!dataGridRef?.canToggleAllNullColumns" :aria-label="t('grid.hideNullColumns')" @update:model-value="dataGridRef?.toggleAllNullColumns()" />
          </div>
          <DataGridCopyFormatControl
            :current-label="dataGridRef?.defaultCopyPreferenceLabel ?? '-'"
            :current-value="dataGridRef?.defaultCopyPreference ?? ''"
            :items="dataGridRef?.copyPreferenceMenuItems ?? []"
            @select="dataGridRef?.setDefaultCopyPreference($event)"
            @configure="openDataGridExtractorConfiguration"
          />
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
      :connection-id="props.connectionId"
      :database="props.database"
      :table-meta="props.tableMeta"
      :column-layout-scope-key="documentColumnLayoutScopeKey"
      :view-state-key="props.stateKey"
      :view-generation="documentViewGeneration"
      :local-column-filter-restore-key="documentLocalColumnFilterRestoreKey"
      :local-column-filter-columns="localColumnFilterColumns"
      context="results"
      page-size-preference="table-open"
      :database-type="props.databaseType"
      :mongo-collection-grid="documentStoreProvider.kind === 'mongodb'"
      :mongo-update-target="mongoUpdateTarget"
      :editable="documentStoreEditable"
      :custom-save-handler="customSaveHandler"
      :loading="loading"
      :sql="documentStoreLabels.queryPreview"
      :page-offset="page * pageSize"
      :page-limit="pageSize"
      :total-row-count="total"
      :total-row-count-is-exact="totalIsExact"
      :inexact-total-row-count-mode="documentStoreProvider.kind === 'mongodb' ? 'estimated' : 'at-least'"
      :pagination-total-row-count="pageTotal"
      :load-all-rows-enabled="false"
      :count-total-rows="countExactDocumentTotal"
      :full-export-result="documentStoreProvider.kind === 'mongodb' || documentStoreProvider.kind === 'dynamodb' || documentStoreProvider.kind === 'elasticsearch' ? exportAllDocumentStoreDocuments : undefined"
      @sort="onSort"
      @reload="refreshDocuments"
      @paginate="(offset: number, limit: number) => paginate(offset, limit)"
      @local-column-filters-change="handleLocalColumnFiltersChange"
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
              <PopoverContent align="start" class="max-w-[calc(100vw-32px)] gap-3 p-3" :class="documentStoreProvider.kind === 'elasticsearch' ? 'w-[680px]' : 'w-[468px]'">
                <div class="flex items-center justify-between gap-2">
                  <div class="text-xs font-medium text-foreground">{{ t("grid.filter") }}</div>
                  <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="clearDocumentFilters(clearLocalFilter)">
                    <Trash2 class="mr-1 h-3.5 w-3.5" />
                    {{ t("grid.clearFilter") }}
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
                    <div v-if="index > 0 && documentStoreProvider.kind !== 'elasticsearch'" class="flex justify-center">
                      <Button
                        variant="ghost"
                        size="sm"
                        class="h-5 px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                        @click="
                          updateDocumentFilterRule(rule.id, {
                            conjunction: rule.conjunction === 'AND' ? 'OR' : 'AND',
                          })
                        "
                      >
                        {{ rule.conjunction }}
                      </Button>
                    </div>
                    <div class="grid items-center gap-1.5" :class="documentStoreProvider.kind === 'elasticsearch' ? 'grid-cols-[minmax(0,0.75fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]' : 'grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)_88px_minmax(0,1fr)_auto]'">
                      <Select v-if="documentStoreProvider.kind === 'elasticsearch'" :model-value="rule.elasticsearchClause || 'filter'" @update:model-value="(value: any) => updateDocumentFilterRule(rule.id, { elasticsearchClause: value as ElasticsearchBoolClause })">
                        <SelectTrigger class="h-8 w-full min-w-0 overflow-hidden text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper">
                          <SelectItem v-for="clause in elasticsearchBoolClauseOptions" :key="clause" :value="clause">
                            {{ clause }}
                          </SelectItem>
                        </SelectContent>
                      </Select>

                      <Popover :open="!!documentFilterFieldPopoverOpen[rule.id]" @update:open="(open) => setDocumentFilterFieldPopoverOpen(rule.id, open)">
                        <PopoverTrigger as-child>
                          <button type="button" class="flex h-8 w-full min-w-0 items-center justify-between gap-1 rounded-md border bg-background px-2 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                            <span class="min-w-0 truncate font-mono" :title="documentFilterFieldLabel(rule.fieldName)">{{ documentFilterFieldLabel(rule.fieldName) || t("grid.filterBuilderColumn") }}</span>
                            <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent align="start" class="w-72 max-w-[calc(100vw-32px)] gap-0 overflow-hidden rounded-md border bg-popover p-0 text-popover-foreground shadow-lg" @click.stop @keydown.stop>
                          <div class="border-b bg-muted/40 px-2 py-1.5 text-xs font-medium text-foreground">{{ t("grid.filterBuilderColumn") }}</div>
                          <div class="relative border-b p-2">
                            <Search class="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                            <Input :id="documentFilterFieldSearchInputId(rule.id)" v-model="documentFilterFieldSearch[rule.id]" autofocus class="h-7 pl-7 text-xs" :placeholder="t('grid.filterBuilderSearchColumns')" />
                          </div>
                          <div class="max-h-72 overflow-auto py-1">
                            <div v-for="field in documentFilterFieldRowsForRule(rule.id)" :key="field.path" class="flex items-center gap-1 px-1.5">
                              <button
                                type="button"
                                class="flex h-7 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                                :class="{ invisible: field.children.length === 0 || documentFilterFieldSearchActive(rule.id) }"
                                :style="{ marginLeft: `${field.depth * 14}px` }"
                                @click.stop="toggleDocumentFilterFieldExpanded(field.path)"
                              >
                                <ChevronRight v-if="!expandedDocumentFilterFieldPaths.has(field.path)" class="h-3.5 w-3.5" />
                                <ChevronDown v-else class="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                class="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 text-left text-xs hover:bg-accent disabled:cursor-default disabled:text-muted-foreground disabled:hover:bg-transparent"
                                :class="rule.fieldName === field.path ? 'bg-accent text-foreground' : ''"
                                :disabled="!field.selectable"
                                @click="selectDocumentFilterField(rule.id, field.path)"
                              >
                                <span class="min-w-0 flex-1 truncate font-mono" :title="documentStoreProvider.kind === 'elasticsearch' ? field.path : field.displayPath">
                                  {{ documentFilterFieldSearchActive(rule.id) ? (documentStoreProvider.kind === "elasticsearch" ? field.path : field.displayPath) : field.label }}
                                </span>
                                <span v-if="documentStoreProvider.kind === 'elasticsearch' && field.selectable && elasticsearchFieldTypes.get(field.path)" class="shrink-0 text-[10px] text-muted-foreground"> ({{ elasticsearchFieldTypes.get(field.path) }}) </span>
                                <span v-else-if="documentStoreProvider.kind !== 'elasticsearch' && field.kind !== 'scalar'" class="shrink-0 rounded border px-1 py-0 text-[10px] leading-4 text-muted-foreground">
                                  {{ documentFilterFieldKindLabel(field.kind) }}
                                </span>
                              </button>
                            </div>
                            <div v-if="documentFilterFieldRowsForRule(rule.id).length === 0" class="px-3 py-6 text-center text-xs text-muted-foreground">
                              {{ t("grid.noSearchResults") }}
                            </div>
                          </div>
                        </PopoverContent>
                      </Popover>

                      <Select v-if="documentStoreProvider.kind === 'elasticsearch'" :model-value="rule.elasticsearchQueryType || elasticsearchRuleQueryTypes(rule)[0]" @update:model-value="(value: any) => updateDocumentFilterRule(rule.id, { elasticsearchQueryType: value as ElasticsearchQueryType })">
                        <SelectTrigger class="h-8 w-full min-w-0 overflow-hidden text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper">
                          <SelectItem v-for="queryType in elasticsearchRuleQueryTypes(rule)" :key="queryType" :value="queryType">
                            {{ elasticsearchQueryTypeLabel(queryType) }}
                          </SelectItem>
                        </SelectContent>
                      </Select>

                      <Select v-else :model-value="rule.mode" @update:model-value="(value: any) => updateDocumentFilterRule(rule.id, { mode: value as DocumentFilterMode })">
                        <SelectTrigger class="h-8 w-full min-w-0 overflow-hidden text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper">
                          <SelectItem v-for="option in currentDocumentFilterModeOptions" :key="option.value" :value="option.value">
                            {{ t(option.labelKey) }}
                          </SelectItem>
                        </SelectContent>
                      </Select>

                      <Select v-if="documentStoreProvider.kind === 'mongodb'" :model-value="rule.valueType || 'auto'" :disabled="!documentFilterModeNeedsValue(rule.mode)" @update:model-value="(value: any) => updateDocumentFilterRule(rule.id, { valueType: value as DocumentFilterValueType })">
                        <SelectTrigger class="h-8 w-full min-w-0 overflow-hidden text-xs [&_[data-slot=select-value]]:min-w-0 [&_[data-slot=select-value]]:truncate">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent position="popper">
                          <SelectItem v-for="option in documentFilterValueTypeOptions" :key="option.value" :value="option.value">
                            {{ t(option.labelKey) }}
                          </SelectItem>
                        </SelectContent>
                      </Select>

                      <div v-if="documentStoreProvider.kind !== 'elasticsearch' && documentFilterModeUsesRange(rule.mode)" class="flex min-w-0 items-center gap-1.5">
                        <Input
                          :model-value="rule.rawValue"
                          class="h-8 min-w-0 flex-1 text-xs"
                          :placeholder="t('grid.filterBuilderRangeStart')"
                          @update:model-value="(value) => updateDocumentFilterRule(rule.id, { rawValue: String(value ?? '') })"
                          @compositionend="endDocumentFilterImeComposition(`value-start:${rule.id}`)"
                          @compositionstart="startDocumentFilterImeComposition(`value-start:${rule.id}`)"
                          @keydown="handleDocumentFilterValueKeydown($event, rule.id)"
                        />
                        <span class="shrink-0 text-[10px] text-muted-foreground">—</span>
                        <Input
                          :model-value="rule.rawEndValue"
                          class="h-8 min-w-0 flex-1 text-xs"
                          :placeholder="t('grid.filterBuilderRangeEnd')"
                          @update:model-value="(value) => updateDocumentFilterRule(rule.id, { rawEndValue: String(value ?? '') })"
                          @compositionend="endDocumentFilterImeComposition(`value-end:${rule.id}`)"
                          @compositionstart="startDocumentFilterImeComposition(`value-end:${rule.id}`)"
                          @keydown="handleDocumentFilterValueKeydown($event, rule.id)"
                        />
                      </div>
                      <textarea
                        v-else-if="documentStoreProvider.kind !== 'elasticsearch' && documentFilterModeUsesList(rule.mode)"
                        :value="rule.rawValue"
                        rows="2"
                        class="min-h-8 w-full min-w-0 resize-y rounded-md border bg-background px-2 py-1 text-xs outline-none"
                        :placeholder="t('grid.filterBuilderValues')"
                        @input="updateDocumentFilterRule(rule.id, { rawValue: ($event.target as HTMLTextAreaElement).value })"
                        @keydown.ctrl.enter.prevent="applyDocumentStructuredFilters"
                        @keydown.meta.enter.prevent="applyDocumentStructuredFilters"
                      />
                      <Input
                        v-else-if="documentStoreProvider.kind === 'elasticsearch' ? elasticsearchQueryTypeNeedsValue(rule.elasticsearchQueryType) : documentFilterModeNeedsValue(rule.mode)"
                        :model-value="rule.rawValue"
                        class="h-8 min-w-0 text-xs"
                        :placeholder="t('grid.filterBuilderValue')"
                        @update:model-value="(value) => updateDocumentFilterRule(rule.id, { rawValue: String(value ?? '') })"
                        @compositionend="endDocumentFilterImeComposition(`value:${rule.id}`)"
                        @compositionstart="startDocumentFilterImeComposition(`value:${rule.id}`)"
                        @keydown="handleDocumentFilterValueKeydown($event, rule.id)"
                      />
                      <div v-else class="flex h-8 min-w-0 items-center overflow-hidden rounded-md border border-dashed px-2 text-xs text-muted-foreground">
                        <span class="truncate">{{ t("grid.filterBuilderNoValue") }}</span>
                      </div>

                      <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive" :disabled="documentFilterRules.length === 1" @click="removeDocumentFilterRule(rule.id)">
                        <X class="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </template>
                </div>
                <div v-else class="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                  {{ t("grid.filterBuilderEmpty") }}
                </div>

                <div class="flex items-center justify-between gap-2">
                  <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="addDocumentFilterRule">
                    <Plus class="mr-1 h-3.5 w-3.5" />
                    {{ t("grid.filterBuilderAddRule") }}
                  </Button>
                  <div class="flex items-center gap-1.5">
                    <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="resetDocumentFilterBuilder">
                      {{ t("grid.resetFilterBuilder") }}
                    </Button>
                    <Button size="sm" class="h-7 px-3 text-xs" @click="applyDocumentStructuredFilters">
                      {{ t("grid.applyFilter") }}
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            <span class="text-blue-600 dark:text-blue-400 text-xs font-medium select-none shrink-0">{{ documentStoreLabels.filterInputLabel }}</span>
            <textarea
              ref="filterInputRef"
              v-model="filterInput"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              rows="1"
              class="document-query-input flex-1 min-w-0 text-xs bg-transparent outline-none placeholder:text-muted-foreground/60 font-mono"
              placeholder="{}"
              :aria-autocomplete="documentQueryCompletionEnabled ? 'list' : undefined"
              :aria-controls="documentQueryCompletionTarget === 'filter' ? documentQueryCompletionListboxId : undefined"
              :aria-activedescendant="documentQueryCompletionTarget === 'filter' ? documentQueryCompletionActiveDescendant : undefined"
              :aria-expanded="documentQueryCompletionEnabled ? documentQueryCompletionTarget === 'filter' : undefined"
              @blur="onDocumentQueryBlur('filter')"
              @click="onDocumentQueryCaretMove('filter')"
              @input="onDocumentQueryInput($event, 'filter')"
              @keydown="onDocumentQueryKeydown($event, 'filter')"
            />
            <DocumentQueryCompletionMenu
              v-if="documentQueryCompletionOpen && documentQueryCompletionTarget === 'filter'"
              :items="documentQueryCompletionItems"
              :selected-index="documentQueryCompletionIndex"
              :listbox-id="documentQueryCompletionListboxId"
              :label="documentStoreLabels.filterInputLabel"
              :position="documentQueryCompletionPosition"
              @select="selectDocumentQueryCompletion"
              @accept="acceptDocumentQueryCompletion"
            />
            <button v-if="filterInput.trim()" type="button" class="flex h-5 shrink-0 items-center text-muted-foreground hover:text-foreground" title="Format JSON" aria-label="Format JSON" @click="formatFilterInput">
              <Braces class="w-3 h-3" />
            </button>
            <button
              v-if="filterInput.trim()"
              type="button"
              class="flex h-5 shrink-0 items-center text-muted-foreground hover:text-foreground"
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
            <span class="text-orange-600 dark:text-orange-400 text-xs font-medium select-none shrink-0">{{ documentStoreLabels.sortInputLabel }}</span>
            <textarea
              ref="sortInputRef"
              v-model="sortInput"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              rows="1"
              class="document-query-input flex-1 min-w-0 text-xs bg-transparent outline-none placeholder:text-muted-foreground/60 font-mono"
              placeholder="{}"
              :aria-autocomplete="documentQueryCompletionEnabled ? 'list' : undefined"
              :aria-controls="documentQueryCompletionTarget === 'sort' ? documentQueryCompletionListboxId : undefined"
              :aria-activedescendant="documentQueryCompletionTarget === 'sort' ? documentQueryCompletionActiveDescendant : undefined"
              :aria-expanded="documentQueryCompletionEnabled ? documentQueryCompletionTarget === 'sort' : undefined"
              @blur="onDocumentQueryBlur('sort')"
              @click="onDocumentQueryCaretMove('sort')"
              @input="onDocumentQueryInput($event, 'sort')"
              @keydown="onDocumentQueryKeydown($event, 'sort')"
            />
            <DocumentQueryCompletionMenu
              v-if="documentQueryCompletionOpen && documentQueryCompletionTarget === 'sort'"
              :items="documentQueryCompletionItems"
              :selected-index="documentQueryCompletionIndex"
              :listbox-id="documentQueryCompletionListboxId"
              :label="documentStoreLabels.sortInputLabel"
              :position="documentQueryCompletionPosition"
              @select="selectDocumentQueryCompletion"
              @accept="acceptDocumentQueryCompletion"
            />
            <button v-if="sortInput.trim()" type="button" class="flex h-5 shrink-0 items-center text-muted-foreground hover:text-foreground" title="Format JSON" aria-label="Format JSON" @click="formatSortInput">
              <Braces class="w-3 h-3" />
            </button>
            <button
              v-if="sortInput.trim()"
              type="button"
              class="flex h-5 shrink-0 items-center text-muted-foreground hover:text-foreground"
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
              <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive shrink-0" :disabled="!documentStoreEditable" :title="documentStoreEditDisabledReason" @click.stop="requestDeleteDoc(idx)">
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
              <Badge variant="secondary" class="max-w-[50%] rounded text-xs" :style="{ width: selectedDocumentIdWidth }">
                <input class="min-w-0 w-full cursor-text select-text appearance-none border-0 bg-transparent p-0 text-inherit outline-none focus:ring-0" :value="selectedDocumentIdLabel" :aria-label="`_id: ${selectedDocumentIdLabel}`" readonly spellcheck="false" />
              </Badge>
              <span class="flex-1" />
              <Button v-if="!isEditing" variant="ghost" size="icon" class="h-6 w-7" :title="t('grid.copy')" @click="copyDocument">
                <Copy class="h-3.5 w-3.5" />
              </Button>
              <Button v-if="!isEditing" variant="ghost" size="sm" class="h-6 text-xs" :disabled="!documentStoreEditable" :title="documentStoreEditDisabledReason" @click="startEdit">{{ t("mongo.edit") }}</Button>
              <template v-if="isEditing">
                <div class="flex items-center border rounded-md overflow-hidden mr-1">
                  <Button variant="ghost" size="sm" class="h-6 rounded-none px-2 text-xs" :class="{ 'bg-accent': documentEditMode === 'json' }" :disabled="isSavingDocument" @click="setDocumentEditMode('json')">{{ t("mongo.editModeJson") }}</Button>
                  <Button variant="ghost" size="sm" class="h-6 rounded-none px-2 text-xs" :class="{ 'bg-accent': documentEditMode === 'fields' }" :disabled="isSavingDocument" @click="setDocumentEditMode('fields')">{{ t("mongo.editModeFields") }}</Button>
                </div>
                <Button v-if="documentEditMode === 'fields'" variant="ghost" size="sm" class="h-6 text-xs" :disabled="isSavingDocument" @click="addField"> <Plus class="w-3 h-3 mr-1" /> {{ t("mongo.addField") }} </Button>
                <Button variant="ghost" size="sm" class="h-6 text-xs" :disabled="isSavingDocument" @click="cancelEdit">{{ t("grid.discard") }}</Button>
                <Button size="sm" class="h-6 text-xs" :disabled="isSavingDocument" @click="saveDoc"><Save class="w-3 h-3 mr-1" />{{ t("grid.save") }}</Button>
              </template>
            </div>

            <div v-if="isEditing && documentEditMode === 'json' && !isNew" class="px-4 py-1.5 text-[11px] text-muted-foreground border-b bg-muted/20 shrink-0">
              {{ t("mongo.jsonReplaceHint") }}
            </div>

            <div v-if="isEditing" class="flex-1 min-h-0 overflow-hidden bg-muted/10">
              <div v-if="documentEditMode === 'json'" class="h-full min-h-0 select-text p-2">
                <RedisJsonEditor v-model="editJson" class="h-full rounded border bg-background" :save-disabled="isSavingDocument" :read-only="isSavingDocument" @save="saveDoc" />
              </div>
              <div v-else class="h-full overflow-auto">
                <div class="json-edit min-w-fit select-text p-5" :class="{ 'pointer-events-none opacity-60': isSavingDocument }" :style="{ ...documentFontStyle, '--mongo-key-width': editKeyWidth }" :aria-disabled="isSavingDocument ? 'true' : undefined">
                  <div class="json-edit-brace">{</div>

                  <JsonEditNode v-for="(field, idx) in editFields" :key="field.key" :node="field" parent-kind="root" :removable="!isSavingDocument && !field.readonlyValue" @remove="requestRemoveField(idx)" />

                  <Button variant="ghost" size="sm" class="json-edit-add" :disabled="isSavingDocument" @click="addField"> <Plus class="w-3 h-3 mr-1" /> {{ t("mongo.addField") }} </Button>

                  <div class="json-edit-brace">}</div>
                </div>
              </div>
            </div>

            <div v-else data-document-json-viewer class="flex-1 min-h-0 select-text bg-muted/10 outline-none" @dblclick="handleDocumentViewerDoubleClick">
              <RedisJsonEditor ref="documentJsonEditorRef" :model-value="editJson" read-only :line-numbers="false" presentation="viewer" class="h-full" />
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
.document-query-input {
  min-height: 20px;
  max-height: 120px;
  line-height: 1.25rem;
  resize: none;
  overflow-y: auto;
  white-space: pre-wrap;
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

.native-document-editor {
  width: 100%;
  min-height: 0;
  resize: none;
  border: 1px solid var(--border);
  border-radius: var(--dbx-radius-fixed-4);
  background: var(--background);
  color: var(--foreground);
  padding: 14px 16px;
  line-height: 1.6;
  tab-size: 2;
  outline: none;
  white-space: pre;
  overflow: auto;
}

.native-document-editor:focus {
  border-color: var(--ring);
  box-shadow: 0 0 0 2px color-mix(in oklab, var(--ring) 28%, transparent);
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

:deep(.document-search-match) {
  border-radius: 2px;
  background: #fde68a;
  color: inherit;
  padding: 0;
}

:deep(.document-search-match-active) {
  background: #f59e0b;
  color: #111827;
  outline: 1px solid #d97706;
}

:global(.dark) :deep(.document-search-match) {
  background: #854d0e;
}

:global(.dark) :deep(.document-search-match-active) {
  background: #fbbf24;
  color: #111827;
}
</style>

<script setup lang="ts">
import { computed, ref, defineAsyncComponent, watch, nextTick, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  Check,
  Columns3,
  Loader2,
  Search,
  Square,
  Bot,
  Table2,
  GitBranch,
  BarChart3,
  TableProperties,
  ChevronDown,
  ChevronUp,
  RefreshCcw,
  Wrench,
} from "@lucide/vue";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import QueryEditor from "@/components/editor/QueryEditor.vue";
import ColumnInfoPanel from "@/components/editor/ColumnInfoPanel.vue";
import type { ColumnInfo } from "@/components/editor/ColumnInfoPanel.vue";
let dataGridComponentPromise: Promise<typeof import("@/components/grid/DataGrid.vue")> | undefined;
function loadDataGridComponent() {
  if (!dataGridComponentPromise) {
    dataGridComponentPromise = (async () => {
      const startedAt = performance.now();
      console.info("[DBX][DataGrid:load:start]");
      const component = await import("@/components/grid/DataGrid.vue");
      console.info("[DBX][DataGrid:load:done]", { elapsed: `${Math.round(performance.now() - startedAt)}ms` });
      return component;
    })();
  }
  return dataGridComponentPromise;
}

function preloadDataGridComponent() {
  void loadDataGridComponent();
}

const DataGrid = defineAsyncComponent(loadDataGridComponent);
const RedisKeyBrowser = defineAsyncComponent(() => import("@/components/redis/RedisKeyBrowser.vue"));
const MongoDocBrowser = defineAsyncComponent(() => import("@/components/mongo/MongoDocBrowser.vue"));
const ObjectBrowser = defineAsyncComponent(() => import("@/components/objects/ObjectBrowser.vue"));
const TableStructureEditor = defineAsyncComponent(() => import("@/components/structure/TableStructureEditor.vue"));
const ExplainPlanViewer = defineAsyncComponent(() => import("@/components/explain/ExplainPlanViewer.vue"));
const QueryChart = defineAsyncComponent(() => import("@/components/chart/QueryChart.vue"));
import { useQueryStore } from "@/stores/queryStore";
import { canCancelQueryExecution, queryExecutionLabelKey } from "@/lib/queryExecutionState";
import { databaseDisplayNameForTab } from "@/lib/tabPresentation";
import { isTableDataEditable } from "@/lib/tableEditing";
import { tableMetaForDataTab } from "@/lib/tableDataTabMeta";
import { effectiveDatabaseTypeForConnection } from "@/lib/jdbcDialect";
import type { QueryTab, ConnectionConfig } from "@/types/database";
import type { SqlFormatDialect } from "@/lib/sqlFormatter";

type DataGridHandle = {
  onToolbarRefresh: () => Promise<void> | void;
  focusSearch: () => boolean;
  openCellDetailSearch: () => boolean;
  visibleColumnCount: number;
  displayableColumnCount: number;
  hiddenColumnCount: number;
  filteredColumnVisibilityOptions: (search: string) => Array<{ index: number; column: string }>;
  isColumnVisible: (columnIndex: number) => boolean;
  toggleColumnVisibility: (columnIndex: number) => void;
  showAllColumns: () => void;
  invertColumnVisibility: () => void;
  nullColumnsHidden: boolean;
  allNullColumnCount: number;
  canToggleAllNullColumns: boolean;
  toggleAllNullColumns: () => void;
  showDdl: boolean;
  toggleDdl: () => void;
};

type SearchableBrowserHandle = {
  focusSearch: () => boolean;
};

const props = defineProps<{
  activeTab: QueryTab;
  activeConnection?: ConnectionConfig;
  executableSql: string;
  activeOutputView: "result" | "explain" | "chart";
  formatSqlRequestId: number;
  selectedSql: string;
  cursorPos: number;
}>();

const emit = defineEmits<{
  "update:activeOutputView": [value: "result" | "explain" | "chart"];
  fixWithAi: [errorMessage: string];
  execute: [sqlOverride?: string];
  saveSql: [];
  cancel: [];
  explain: [];
  editorUpdate: [value: string];
  editorSelectionChange: [value: string];
  editorCursorChange: [pos: number];
  formatError: [];
  reload: [sql?: string, searchText?: string, whereInput?: string, orderBy?: string, limit?: number, offset?: number];
  paginate: [offset: number, limit: number, whereInput?: string, orderBy?: string];
  sort: [column: string, columnIndex: number, direction: "asc" | "desc" | null, whereInput?: string];
  executeSql: [sql: string];
  clickTable: [tableName: string];
  openObjectTable: [target: { tableName: string; schema?: string }];
  objectSchemaChange: [schema: string | undefined];
  structureEditorSaved: [commentChanged: boolean];
  structureEditorClose: [];
}>();

const { t } = useI18n();
const queryStore = useQueryStore();

onMounted(() => {
  const preload = () => preloadDataGridComponent();
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(preload, { timeout: 1500 });
  } else {
    setTimeout(preload, 300);
  }
});

watch(
  () => [props.activeTab.mode, !!props.activeTab.result] as const,
  ([mode, hasResult]) => {
    if (mode === "data" || hasResult) preloadDataGridComponent();
  },
  { immediate: true },
);

// Column info panel state
const showColumnInfo = ref(false);
const columnInfoColumns = ref<ColumnInfo[]>([]);
const columnInfoLoading = ref(false);
const columnInfoError = ref<string | undefined>(undefined);
const dataGridRef = ref<DataGridHandle>();
const queryEditorRef = ref<InstanceType<typeof QueryEditor>>();
const columnVisibilitySearch = ref("");
const columnVisibilityOptions = computed(
  () => dataGridRef.value?.filteredColumnVisibilityOptions(columnVisibilitySearch.value) ?? [],
);
const redisKeyBrowserRef = ref<SearchableBrowserHandle>();
const objectBrowserRef = ref<SearchableBrowserHandle>();
const activeTableMeta = computed(() => props.activeTab.tableMeta);
const activeDataTabTableMeta = computed(() => tableMetaForDataTab(props.activeTab));
const activeEffectiveDatabaseType = computed(() => effectiveDatabaseTypeForConnection(props.activeConnection));

const activeSqlFormatDialect = computed<SqlFormatDialect>(() => {
  switch (activeEffectiveDatabaseType.value) {
    case "mysql":
      return "mysql";
    case "postgres":
    case "kwdb":
      return "postgres";
    case "sqlite":
    case "rqlite":
      return "sqlite";
    case "sqlserver":
      return "sqlserver";
    default:
      return "generic";
  }
});

const editorDialect = computed<"mysql" | "postgres" | "sqlserver">(() => {
  if (activeEffectiveDatabaseType.value === "postgres" || activeEffectiveDatabaseType.value === "kwdb")
    return "postgres";
  if (activeEffectiveDatabaseType.value === "sqlserver") return "sqlserver";
  return "mysql";
});

const shortcutModifier = computed(() => (navigator.platform.toLowerCase().includes("mac") ? "Cmd" : "Ctrl"));

const hasNumericData = computed(() => {
  const r = props.activeTab.result;
  if (!r || r.rows.length === 0) return false;
  return r.columns.some((_, idx) => r.rows.some((row) => typeof row[idx] === "number"));
});

const activeQueryError = computed(() => {
  const result = props.activeTab.result;
  if (!result?.columns.includes("Error")) return "";
  return String(result.rows[0]?.[0] ?? "");
});
const hasQueryOutput = computed(
  () =>
    !!props.activeTab.result ||
    !!props.activeTab.explainPlan ||
    !!props.activeTab.explainError ||
    props.activeTab.isExecuting === true ||
    props.activeTab.isExplaining === true,
);
const resultsPaneOpen = ref(false);

watch(
  hasQueryOutput,
  (hasOutput) => {
    resultsPaneOpen.value = hasOutput ? true : false;
  },
  { immediate: true },
);

watch(
  () => props.activeTab.id,
  () => {
    resultsPaneOpen.value = hasQueryOutput.value;
  },
);

watch(
  () => [props.activeTab.isExecuting, props.activeTab.isExplaining],
  ([isExecuting, isExplaining]) => {
    if (isExecuting || isExplaining) resultsPaneOpen.value = true;
  },
);

watch(
  () => props.activeTab.result,
  (result) => {
    if (!result) return;
    const startedAt = performance.now();
    console.info("[DBX][ContentArea:result:observed]", {
      tabId: props.activeTab.id,
      rowCount: result.rows.length,
      columnCount: result.columns.length,
      backendMs: result.execution_time_ms,
      isExecuting: props.activeTab.isExecuting,
    });
    nextTick(() => {
      console.info("[DBX][ContentArea:result:nextTick]", {
        tabId: props.activeTab.id,
        elapsed: `${Math.round(performance.now() - startedAt)}ms`,
        isExecuting: props.activeTab.isExecuting,
      });
      requestAnimationFrame(() => {
        console.info("[DBX][ContentArea:result:first-frame]", {
          tabId: props.activeTab.id,
          elapsed: `${Math.round(performance.now() - startedAt)}ms`,
          isExecuting: props.activeTab.isExecuting,
        });
      });
    });
  },
);

watch(
  () => props.activeTab.isExecuting,
  (isExecuting, wasExecuting) => {
    if (!isExecuting && wasExecuting) {
      nextTick(() => {
        requestAnimationFrame(() => {
          queryEditorRef.value?.scrollCursorIntoView();
        });
      });
    }
  },
);

// Column info panel handlers
async function onHandleClickColumn(
  matchedCols: Array<{ name: string; table: string; schema?: string }>,
  errorMsg?: string,
) {
  if (!props.activeTab.connectionId || !props.activeTab.database) return;

  // If error or no columns, silently ignore — don't show the panel
  if (errorMsg || matchedCols.length === 0) return;

  columnInfoLoading.value = true;
  columnInfoError.value = undefined;

  try {
    // Fetch full column details from API
    const apiModule = await import("@/lib/api");
    const results: ColumnInfo[] = [];

    for (const matchedCol of matchedCols) {
      const querySchema = matchedCol.schema || props.activeTab.database || "";
      try {
        const fullColumns = await apiModule.getColumns(
          props.activeTab.connectionId,
          props.activeTab.database,
          querySchema,
          matchedCol.table,
        );
        for (const col of fullColumns) {
          if (col.name === matchedCol.name) {
            results.push({
              name: col.name,
              table: matchedCol.table,
              dataType: col.data_type,
              isNullable: col.is_nullable,
              columnDefault: col.column_default,
              isPrimaryKey: col.is_primary_key,
              comment: col.comment,
              extra: col.extra,
            });
          }
        }
      } catch {
        // Skip tables that fail
      }
    }

    columnInfoColumns.value = results;
  } catch (e: any) {
    // Silently ignore errors
    console.error("[DBX] Failed to fetch column info:", e);
    return;
  } finally {
    columnInfoLoading.value = false;
    showColumnInfo.value = true;
  }
}

function closeColumnInfo() {
  showColumnInfo.value = false;
  columnInfoColumns.value = [];
  columnInfoError.value = undefined;
}

function onHandleClickTable(tableName: string) {
  emit("clickTable", tableName);
}

function onHandleCloseColumnPanel() {
  showColumnInfo.value = false;
  columnInfoColumns.value = [];
  columnInfoError.value = undefined;
}

function focusSearch(): boolean {
  if (props.activeTab.mode === "redis") return redisKeyBrowserRef.value?.focusSearch() ?? false;
  if (props.activeTab.mode === "objects") return objectBrowserRef.value?.focusSearch() ?? false;
  if (props.activeTab.mode === "query") return queryEditorRef.value?.openSearch() ?? false;
  return dataGridRef.value?.focusSearch() ?? false;
}

function refreshData(): boolean {
  if (!dataGridRef.value) return false;
  void dataGridRef.value.onToolbarRefresh();
  return true;
}

function handleModRTarget(target: Element): boolean {
  if (target.closest("[data-query-editor-root]")) return queryEditorRef.value?.openReplace() ?? false;
  if (target.closest("[data-cell-detail-editor-root]")) return dataGridRef.value?.openCellDetailSearch() ?? false;
  if (target.closest("[data-grid-root]")) return refreshData();
  return false;
}

defineExpose({ focusSearch, refreshData, handleModRTarget });
</script>

<template>
  <div class="flex flex-col flex-1 min-h-0">
    <!-- Query mode: editor + results -->
    <template v-if="activeTab.mode === 'query'">
      <Splitpanes horizontal class="flex-1">
        <Pane :size="resultsPaneOpen ? 40 : 100" :min-size="resultsPaneOpen ? 15 : 100">
          <div class="h-full flex flex-col relative">
            <QueryEditor
              ref="queryEditorRef"
              class="flex-1"
              :model-value="activeTab.sql"
              :connection-id="activeTab.connectionId"
              :database="activeTab.database"
              :schema="activeTab.schema"
              :database-type="activeEffectiveDatabaseType"
              :dialect="editorDialect"
              :format-dialect="activeSqlFormatDialect"
              :format-request-id="formatSqlRequestId"
              :execution-error="activeQueryError"
              @update:model-value="emit('editorUpdate', $event)"
              @selection-change="emit('editorSelectionChange', $event)"
              @cursor-change="emit('editorCursorChange', $event)"
              @format-error="emit('formatError')"
              @execute="emit('execute')"
              @save="emit('saveSql')"
              @click-table="onHandleClickTable"
              @click-column="onHandleClickColumn"
              @close-column-panel="onHandleCloseColumnPanel"
            />
            <ColumnInfoPanel
              v-if="showColumnInfo"
              :columns="columnInfoColumns"
              :loading="columnInfoLoading"
              :error="columnInfoError"
              @close="closeColumnInfo"
            />
            <Button
              v-if="hasQueryOutput && !resultsPaneOpen"
              variant="secondary"
              size="sm"
              class="absolute bottom-3 right-3 z-20 h-7 gap-1.5 rounded-full border bg-background/95 px-3 text-xs shadow-lg backdrop-blur hover:bg-accent"
              @click="resultsPaneOpen = true"
            >
              <ChevronUp class="h-3.5 w-3.5" />
              {{ t("editor.showResultsPane") }}
            </Button>
          </div>
        </Pane>
        <Pane v-if="resultsPaneOpen" :size="60" :min-size="20">
          <div class="h-full flex flex-col">
            <div
              v-if="hasQueryOutput"
              class="h-8 shrink-0 border-b bg-muted/20 px-2 flex items-center gap-1 overflow-x-auto"
              style="scrollbar-width: none; -ms-overflow-style: none; -webkit-overflow-scrolling: touch"
            >
              <Button
                size="sm"
                :variant="activeOutputView === 'result' ? 'secondary' : 'ghost'"
                class="h-6 px-2 text-xs"
                :disabled="!activeTab.result && !activeTab.isExecuting"
                @click="emit('update:activeOutputView', 'result')"
              >
                {{ t("tabs.tableData") }}
              </Button>
              <template v-if="activeOutputView === 'result' && activeTab.results && activeTab.results.length > 1">
                <span class="mx-1 h-4 w-px bg-border" />
                <Button
                  v-for="(_, rIdx) in activeTab.results"
                  :key="rIdx"
                  size="sm"
                  :variant="activeTab.activeResultIndex === rIdx ? 'default' : 'ghost'"
                  class="h-6 px-2 text-xs shrink-0"
                  @click="queryStore.setActiveResultIndex(activeTab.id, rIdx)"
                >
                  {{ t("tabs.resultN", { n: rIdx + 1 }) }}
                </Button>
              </template>
              <Button
                size="sm"
                :variant="activeOutputView === 'explain' ? 'secondary' : 'ghost'"
                class="h-6 px-2 text-xs gap-1"
                :disabled="!activeTab.explainPlan && !activeTab.explainError && !activeTab.isExplaining"
                @click="emit('update:activeOutputView', 'explain')"
              >
                <GitBranch class="h-3.5 w-3.5" />
                {{ t("explain.title") }}
              </Button>
              <Button
                size="sm"
                :variant="activeOutputView === 'chart' ? 'secondary' : 'ghost'"
                class="h-6 px-2 text-xs gap-1"
                :disabled="!hasNumericData"
                @click="emit('update:activeOutputView', 'chart')"
              >
                <BarChart3 class="h-3.5 w-3.5" />
                {{ t("chart.title") }}
              </Button>
              <Popover v-if="activeOutputView === 'result' && activeTab.result">
                <PopoverTrigger as-child>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="ml-auto h-6 w-7 shrink-0 text-foreground hover:bg-accent"
                    :class="{ 'bg-accent text-foreground': dataGridRef?.nullColumnsHidden }"
                    :title="t('grid.viewOptions')"
                    :aria-label="t('grid.viewOptions')"
                  >
                    <Wrench class="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  class="w-max min-w-44 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-xl border bg-popover p-0 text-popover-foreground shadow-xl"
                  @click.stop
                  @keydown.stop
                >
                  <div class="border-b bg-muted/40 px-3 py-2">
                    <div class="text-xs font-semibold">{{ t("grid.viewOptions") }}</div>
                  </div>
                  <label
                    class="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs hover:bg-accent"
                    :class="{ 'cursor-not-allowed opacity-60': !dataGridRef?.canToggleAllNullColumns }"
                  >
                    <input
                      type="checkbox"
                      class="h-3.5 w-3.5 shrink-0 accent-primary"
                      :checked="!!dataGridRef?.nullColumnsHidden"
                      :disabled="!dataGridRef?.canToggleAllNullColumns"
                      @change="dataGridRef?.toggleAllNullColumns()"
                    />
                    <span class="min-w-0 flex items-center gap-1 font-medium">
                      {{ t("grid.hideNullColumns") }}
                      <span
                        v-if="(dataGridRef?.allNullColumnCount ?? 0) > 0"
                        class="text-muted-foreground tabular-nums"
                      >
                        ({{ dataGridRef?.allNullColumnCount }})
                      </span>
                    </span>
                  </label>
                </PopoverContent>
              </Popover>
              <Button
                v-if="activeOutputView === 'result' && activeTab.result"
                variant="ghost"
                size="sm"
                class="h-6 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                :disabled="activeTab.isExecuting"
                @click="refreshData"
              >
                <Loader2 v-if="activeTab.isExecuting" class="h-3.5 w-3.5 animate-spin" />
                <RefreshCcw v-else class="h-3.5 w-3.5" />
                {{ t("grid.refresh") }}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                class="h-6 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                :class="{ 'ml-auto': activeOutputView !== 'result' || !activeTab.result }"
                @click="resultsPaneOpen = false"
              >
                <ChevronDown class="h-3.5 w-3.5" />
                {{ t("editor.hideResultsPane") }}
              </Button>
            </div>

            <ExplainPlanViewer
              v-if="activeOutputView === 'explain'"
              class="flex-1 min-h-0"
              :plan="activeTab.explainPlan"
              :error="activeTab.explainError"
              :loading="activeTab.isExplaining"
              :source-sql="activeTab.lastExplainedSql"
              :explain-sql="activeTab.explainSql"
            />

            <QueryChart
              v-else-if="activeOutputView === 'chart' && activeTab.result"
              class="flex-1 min-h-0"
              :result="activeTab.result"
            />

            <template v-else>
              <DataGrid
                v-if="activeTab.result"
                ref="dataGridRef"
                :key="`${activeTab.id}-${activeTab.activeResultIndex ?? 0}`"
                :cache-key="`${activeTab.id}-${activeTab.activeResultIndex ?? 0}`"
                class="flex-1 min-h-0"
                :result="activeTab.result"
                :sort-column="activeTab.resultSortColumn"
                :sort-column-index="activeTab.resultSortColumnIndex"
                :sort-direction="activeTab.resultSortDirection"
                :initial-order-by-input="activeTab.orderByInput"
                :sql="activeTab.lastExecutedSql || activeTab.sql"
                :loading="activeTab.isExecuting"
                :editable="!!activeTab.queryAnalysis"
                :source-columns="activeTab.querySourceColumns"
                context="results"
                :database-type="activeEffectiveDatabaseType"
                :connection-id="activeTab.connectionId"
                :database="activeTab.database"
                :schema="activeTab.schema"
                :table-meta="activeTab.tableMeta"
                :page-offset="activeTab.resultPageOffset"
                :page-limit="activeTab.resultPageLimit"
                :count-sql="activeTab.resultCountSql"
                :total-row-count="activeTab.resultTotalRowCount"
                :on-execute-sql="async (sql: string) => emit('executeSql', sql)"
                :full-export-result="() => queryStore.fetchTabResultForExport(activeTab.id)"
                @update:order-by-input="(v: string) => (activeTab.orderByInput = v)"
                @reload="
                  (
                    sql?: string,
                    searchText?: string,
                    whereInput?: string,
                    orderBy?: string,
                    limit?: number,
                    offset?: number,
                  ) => emit('reload', sql, searchText, whereInput, orderBy, limit, offset)
                "
                @paginate="
                  (offset: number, limit: number, whereInput?: string, orderBy?: string) =>
                    emit('paginate', offset, limit, whereInput, orderBy)
                "
                @sort="
                  (column: string, columnIndex: number, direction: 'asc' | 'desc' | null, whereInput?: string) =>
                    emit('sort', column, columnIndex, direction, whereInput)
                "
              >
                <template v-if="activeTab.result?.columns.includes('Error')" #error-actions="{ errorMessage }">
                  <Button
                    variant="outline"
                    size="sm"
                    class="mt-2 h-7 gap-1.5 border-destructive/30 bg-background px-2.5 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                    @click="emit('fixWithAi', String(errorMessage))"
                  >
                    <Bot class="h-3.5 w-3.5" />
                    {{ t("ai.fixWithAi") }}
                  </Button>
                </template>
              </DataGrid>
              <div
                v-else-if="!activeTab.result && activeTab.isExecuting"
                class="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-muted-foreground text-sm"
              >
                <div class="flex items-center">
                  <Loader2 class="h-5 w-5 animate-spin mr-2" />
                  {{ t(queryExecutionLabelKey(activeTab)) }}
                </div>
              </div>
              <div
                v-else-if="!activeTab.result"
                class="flex-1 min-h-0 flex flex-col items-center justify-center gap-1 text-muted-foreground text-sm"
              >
                <div>{{ t("editor.pressToExecute", { mod: shortcutModifier }) }}</div>
                <div>{{ t("editor.pressToSaveSql", { mod: shortcutModifier }) }}</div>
              </div>
            </template>
          </div>
        </Pane>
      </Splitpanes>
    </template>

    <!-- Data mode: full-height grid -->
    <template v-else-if="activeTab.mode === 'data'">
      <div class="flex-1 min-h-0 flex flex-col">
        <div class="h-9 shrink-0 border-b bg-background/80 px-3 flex items-center gap-2 text-xs">
          <span
            class="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
          >
            <Table2 class="h-3.5 w-3.5" />
            {{ t("tabs.tableData") }}
          </span>
          <span
            class="inline-flex items-center rounded border border-border bg-muted/50 px-2 py-0.5 font-medium truncate"
          >
            {{ activeTab.tableMeta?.tableName || activeTab.title }}
          </span>
          <span
            class="inline-flex items-center rounded border border-border bg-muted/30 px-2 py-0.5 text-muted-foreground truncate"
          >
            <template v-if="activeTab.tableMeta?.schema">{{ activeTab.tableMeta.schema }}@</template
            >{{ databaseDisplayNameForTab(activeTab.connectionId, activeTab.database, t) }}
          </span>
          <span v-if="activeTab.tableMeta" class="ml-auto text-muted-foreground">
            {{ activeTab.tableMeta.columns.length }} {{ t("tree.columns") }}
          </span>
          <Popover v-if="activeTab.result?.columns.length">
            <PopoverTrigger as-child>
              <Button
                variant="ghost"
                size="sm"
                class="h-5 text-xs px-1.5 shrink-0"
                :class="{ 'bg-accent text-foreground': (dataGridRef?.hiddenColumnCount ?? 0) > 0 }"
              >
                <Columns3 class="h-3.5 w-3.5" />
                {{ t("grid.columnVisibility") }}
                <span v-if="(dataGridRef?.hiddenColumnCount ?? 0) > 0" class="tabular-nums">
                  {{ dataGridRef?.visibleColumnCount }}/{{ dataGridRef?.displayableColumnCount }}
                </span>
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              class="w-64 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-xl border bg-popover p-0 text-popover-foreground shadow-xl"
              @click.stop
              @keydown.stop
            >
              <div class="border-b bg-muted/40 px-2 py-1.5">
                <div class="flex items-center justify-between gap-2">
                  <div class="text-xs font-semibold">{{ t("grid.columnVisibility") }}</div>
                  <div class="text-[10px] text-muted-foreground tabular-nums">
                    {{ dataGridRef?.visibleColumnCount ?? 0 }}/{{ dataGridRef?.displayableColumnCount ?? 0 }}
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-1.5 border-b px-2 py-1.5">
                <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <input
                  v-model="columnVisibilitySearch"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck="false"
                  class="h-6 min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                  :placeholder="t('grid.searchColumns')"
                />
              </div>
              <div class="max-h-72 overflow-auto py-0.5">
                <button
                  v-for="option in columnVisibilityOptions"
                  :key="`${option.index}:${option.column}`"
                  type="button"
                  class="grid w-full grid-cols-[1.5rem_minmax(0,1fr)] items-center px-2 py-1 text-left text-xs hover:bg-accent"
                  @click="dataGridRef?.toggleColumnVisibility(option.index)"
                >
                  <span
                    class="flex h-4 w-4 items-center justify-center rounded border"
                    :class="
                      dataGridRef?.isColumnVisible(option.index)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background text-transparent'
                    "
                  >
                    <Check class="h-3 w-3 stroke-[3]" />
                  </span>
                  <span class="truncate font-mono text-xs" :title="option.column">{{ option.column }}</span>
                </button>
                <div
                  v-if="columnVisibilityOptions.length === 0"
                  class="px-2 py-6 text-center text-xs text-muted-foreground"
                >
                  {{ t("grid.noSearchResults") }}
                </div>
              </div>
              <div class="flex items-center justify-between gap-2 border-t bg-muted/30 px-2 py-1.5">
                <span class="text-[11px] text-muted-foreground">{{ t("grid.columnVisibilityHint") }}</span>
                <div class="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-7 px-2 text-xs"
                    :disabled="(dataGridRef?.displayableColumnCount ?? 0) <= 1"
                    @click="dataGridRef?.invertColumnVisibility()"
                  >
                    {{ t("grid.invertColumnVisibility") }}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    class="h-7 px-2 text-xs"
                    :disabled="(dataGridRef?.hiddenColumnCount ?? 0) === 0"
                    @click="dataGridRef?.showAllColumns()"
                  >
                    {{ t("grid.showAllColumns") }}
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
          <Button
            v-if="activeTab.tableMeta && activeTab.connectionId"
            variant="ghost"
            size="sm"
            class="h-5 text-xs px-1.5 shrink-0"
            :class="{ 'bg-accent': dataGridRef?.showDdl }"
            @click="dataGridRef?.toggleDdl()"
          >
            <TableProperties class="h-3.5 w-3.5" /> {{ t("grid.tableInfo") }}
          </Button>
          <Popover v-if="activeTab.result?.columns.length">
            <PopoverTrigger as-child>
              <Button
                variant="ghost"
                size="icon"
                class="h-6 w-7 shrink-0 text-foreground hover:bg-accent"
                :class="{ 'bg-accent text-foreground': dataGridRef?.nullColumnsHidden }"
                :title="t('grid.viewOptions')"
                :aria-label="t('grid.viewOptions')"
              >
                <Wrench class="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              class="w-max min-w-44 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden rounded-xl border bg-popover p-0 text-popover-foreground shadow-xl"
              @click.stop
              @keydown.stop
            >
              <div class="border-b bg-muted/40 px-3 py-2">
                <div class="text-xs font-semibold">{{ t("grid.viewOptions") }}</div>
              </div>
              <label
                class="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs hover:bg-accent"
                :class="{ 'cursor-not-allowed opacity-60': !dataGridRef?.canToggleAllNullColumns }"
              >
                <input
                  type="checkbox"
                  class="h-3.5 w-3.5 shrink-0 accent-primary"
                  :checked="!!dataGridRef?.nullColumnsHidden"
                  :disabled="!dataGridRef?.canToggleAllNullColumns"
                  @change="dataGridRef?.toggleAllNullColumns()"
                />
                <span class="min-w-0 flex items-center gap-1 font-medium">
                  {{ t("grid.hideNullColumns") }}
                  <span v-if="(dataGridRef?.allNullColumnCount ?? 0) > 0" class="text-muted-foreground tabular-nums">
                    ({{ dataGridRef?.allNullColumnCount }})
                  </span>
                </span>
              </label>
            </PopoverContent>
          </Popover>
        </div>
        <DataGrid
          v-if="activeTab.result"
          ref="dataGridRef"
          class="flex-1 min-h-0"
          :key="activeTab.id"
          :cache-key="activeTab.id"
          :result="activeTab.result"
          :sort-column="activeTab.resultSortColumn"
          :sort-column-index="activeTab.resultSortColumnIndex"
          :sort-direction="activeTab.resultSortDirection"
          :initial-order-by-input="activeTab.orderByInput"
          :sql="activeTab.sql"
          :loading="activeTab.isExecuting"
          :editable="isTableDataEditable(activeEffectiveDatabaseType, activeTableMeta?.primaryKeys ?? [])"
          context="table-data"
          :initial-where-input="activeTab.whereInput"
          :database-type="activeEffectiveDatabaseType"
          :connection-id="activeTab.connectionId"
          :database="activeTab.database"
          :table-meta="activeDataTabTableMeta"
          :page-offset="activeTab.resultPageOffset"
          :page-limit="activeTab.resultPageLimit"
          :on-execute-sql="async (sql: string) => emit('executeSql', sql)"
          :full-export-result="() => queryStore.fetchTabResultForExport(activeTab.id)"
          @update:where-input="(v: string) => (activeTab.whereInput = v)"
          @update:order-by-input="(v: string) => (activeTab.orderByInput = v)"
          @reload="
            (
              sql?: string,
              searchText?: string,
              whereInput?: string,
              orderBy?: string,
              limit?: number,
              offset?: number,
            ) => emit('reload', sql, searchText, whereInput, orderBy, limit, offset)
          "
          @paginate="
            (offset: number, limit: number, whereInput?: string, orderBy?: string) =>
              emit('paginate', offset, limit, whereInput, orderBy)
          "
          @sort="
            (column: string, columnIndex: number, direction: 'asc' | 'desc' | null, whereInput?: string) =>
              emit('sort', column, columnIndex, direction, whereInput)
          "
        />
        <div
          v-else-if="activeTab.isExecuting"
          class="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground text-sm"
        >
          <div class="flex items-center">
            <Loader2 class="h-5 w-5 animate-spin mr-2" />
            {{ t(queryExecutionLabelKey(activeTab)) }}
          </div>
          <Button
            variant="destructive"
            size="sm"
            class="h-7 gap-1.5"
            :disabled="!canCancelQueryExecution(activeTab)"
            @click="emit('cancel')"
          >
            <Loader2 v-if="activeTab.isCancelling" class="h-3.5 w-3.5 animate-spin" />
            <Square v-else class="h-3.5 w-3.5 fill-current" />
            {{ t("toolbar.stopQuery") }}
          </Button>
        </div>
        <div v-else class="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground text-sm">
          <Inbox class="h-8 w-8 opacity-60" />
          <div>{{ t("grid.dataUnavailable") }}</div>
          <Button variant="outline" size="sm" class="h-7 gap-1.5" @click="emit('reload')">
            <RefreshCcw class="h-3.5 w-3.5" />
            {{ t("grid.refresh") }}
          </Button>
        </div>
      </div>
    </template>

    <!-- Redis mode: key browser -->
    <template v-else-if="activeTab.mode === 'redis'">
      <div class="flex-1 min-h-0">
        <RedisKeyBrowser
          ref="redisKeyBrowserRef"
          :key="activeTab.id"
          :connection-id="activeTab.connectionId"
          :db="Number(activeTab.database)"
        />
      </div>
    </template>

    <!-- MongoDB mode: document browser -->
    <template v-else-if="activeTab.mode === 'mongo'">
      <div class="flex-1 min-h-0">
        <MongoDocBrowser
          :key="activeTab.id"
          :connection-id="activeTab.connectionId"
          :database="activeTab.database"
          :collection="activeTab.sql"
        />
      </div>
    </template>

    <!-- Objects mode: virtualized database object browser -->
    <template v-else-if="activeTab.mode === 'objects' && activeConnection">
      <ObjectBrowser
        ref="objectBrowserRef"
        :key="`${activeTab.id}-${activeTab.objectBrowser?.schema || ''}`"
        :connection="activeConnection"
        :database="activeTab.database"
        :schema="activeTab.objectBrowser?.schema"
        @open-table="emit('openObjectTable', $event)"
        @schema-change="emit('objectSchemaChange', $event)"
      />
    </template>

    <!-- Structure mode: table structure editor -->
    <template v-else-if="activeTab.mode === 'structure'">
      <TableStructureEditor
        :key="activeTab.id"
        :connection-id="activeTab.connectionId"
        :database="activeTab.database"
        :schema="activeTab.schema"
        :table-name="activeTab.structureTableName || ''"
        @saved="(commentChanged) => emit('structureEditorSaved', commentChanged)"
        @close="emit('structureEditorClose')"
      />
    </template>
  </div>
</template>

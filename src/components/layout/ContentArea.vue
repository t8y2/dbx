<script setup lang="ts">
import { computed, ref, defineAsyncComponent } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2, Square, Bot, Table2, GitBranch, BarChart3 } from "lucide-vue-next";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { Button } from "@/components/ui/button";
import QueryEditor from "@/components/editor/QueryEditor.vue";
import DataGrid from "@/components/grid/DataGrid.vue";
import RedisKeyBrowser from "@/components/redis/RedisKeyBrowser.vue";
import MongoDocBrowser from "@/components/mongo/MongoDocBrowser.vue";
import ColumnInfoPanel from "@/components/editor/ColumnInfoPanel.vue";
import type { ColumnInfo } from "@/components/editor/ColumnInfoPanel.vue";
const ExplainPlanViewer = defineAsyncComponent(() => import("@/components/explain/ExplainPlanViewer.vue"));
const QueryChart = defineAsyncComponent(() => import("@/components/chart/QueryChart.vue"));
import { useQueryStore } from "@/stores/queryStore";
import { canCancelQueryExecution, queryExecutionLabelKey } from "@/lib/queryExecutionState";
import { databaseDisplayNameForTab } from "@/lib/tabPresentation";
import type { QueryTab, ConnectionConfig } from "@/types/database";
import type { SqlFormatDialect } from "@/lib/sqlFormatter";

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
  cancel: [];
  explain: [];
  editorUpdate: [value: string];
  editorSelectionChange: [value: string];
  editorCursorChange: [pos: number];
  formatError: [];
  reload: [];
  paginate: [offset: number, limit: number, whereInput?: string];
  sort: [column: string, direction: "asc" | "desc" | null, whereInput?: string];
  executeSql: [sql: string];
  clickTable: [tableName: string];
}>();

const { t } = useI18n();
const queryStore = useQueryStore();

// Column info panel state
const showColumnInfo = ref(false);
const columnInfoColumns = ref<ColumnInfo[]>([]);
const columnInfoLoading = ref(false);
const columnInfoError = ref<string | undefined>(undefined);

const activeSqlFormatDialect = computed<SqlFormatDialect>(() => {
  switch (props.activeConnection?.db_type) {
    case "mysql":
      return "mysql";
    case "postgres":
      return "postgres";
    case "sqlite":
      return "sqlite";
    case "sqlserver":
      return "sqlserver";
    default:
      return "generic";
  }
});

const editorDialect = computed<"mysql" | "postgres">(() =>
  props.activeConnection?.db_type === "postgres" ? "postgres" : "mysql",
);

const hasNumericData = computed(() => {
  const r = props.activeTab.result;
  if (!r || r.rows.length === 0) return false;
  return r.columns.some((_, idx) => r.rows.some((row) => typeof row[idx] === "number"));
});

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
</script>

<template>
  <div class="flex flex-col flex-1 min-h-0">
    <!-- Query mode: editor + results -->
    <template v-if="activeTab.mode === 'query'">
      <Splitpanes horizontal class="flex-1">
        <Pane :size="40" :min-size="15">
          <div class="h-full flex flex-col relative">
            <QueryEditor
              class="flex-1"
              :model-value="activeTab.sql"
              :connection-id="activeTab.connectionId"
              :database="activeTab.database"
              :dialect="editorDialect"
              :format-dialect="activeSqlFormatDialect"
              :format-request-id="formatSqlRequestId"
              @update:model-value="emit('editorUpdate', $event)"
              @selection-change="emit('editorSelectionChange', $event)"
              @cursor-change="emit('editorCursorChange', $event)"
              @format-error="emit('formatError')"
              @execute="emit('execute')"
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
          </div>
        </Pane>
        <Pane :size="60" :min-size="20">
          <div class="h-full flex flex-col">
            <div
              v-if="
                activeTab.result ||
                activeTab.explainPlan ||
                activeTab.explainError ||
                activeTab.isExecuting ||
                activeTab.isExplaining
              "
              class="h-8 shrink-0 border-b bg-muted/20 px-2 flex items-center gap-1"
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
                  class="h-6 px-2 text-xs"
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
                :key="`${activeTab.id}-${activeTab.activeResultIndex ?? 0}`"
                class="flex-1 min-h-0"
                :result="activeTab.result"
                :sql="activeTab.lastExecutedSql || activeTab.sql"
                :loading="activeTab.isExecuting"
              />
              <div
                v-if="activeTab.result?.columns.includes('Error')"
                class="flex items-center gap-2 px-3 py-1.5 border-t bg-destructive/5"
              >
                <Bot class="h-3.5 w-3.5 text-destructive" />
                <button
                  class="text-xs text-destructive hover:underline"
                  @click="emit('fixWithAi', String(activeTab.result?.rows?.[0]?.[0] ?? ''))"
                >
                  {{ t("ai.fixWithAi") }}
                </button>
              </div>
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
                class="flex-1 min-h-0 flex items-center justify-center text-muted-foreground text-sm"
              >
                {{ t("editor.pressToExecute") }}
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
            {{ databaseDisplayNameForTab(activeTab.connectionId, activeTab.database) }}
            <template v-if="activeTab.tableMeta?.schema"> &middot; {{ activeTab.tableMeta.schema }}</template>
          </span>
          <span v-if="activeTab.tableMeta" class="ml-auto text-muted-foreground">
            {{ activeTab.tableMeta.columns.length }} {{ t("tree.columns") }}
          </span>
        </div>
        <DataGrid
          v-if="activeTab.result"
          class="flex-1 min-h-0"
          :key="activeTab.id"
          :result="activeTab.result"
          :sql="activeTab.sql"
          :loading="activeTab.isExecuting"
          :editable="!!activeTab.tableMeta?.primaryKeys?.length"
          :database-type="activeConnection?.db_type"
          :connection-id="activeTab.connectionId"
          :database="activeTab.database"
          :table-meta="activeTab.tableMeta"
          :on-execute-sql="async (sql: string) => emit('executeSql', sql)"
          @reload="emit('reload')"
          @paginate="
            (offset: number, limit: number, whereInput?: string) => emit('paginate', offset, limit, whereInput)
          "
          @sort="
            (column: string, direction: 'asc' | 'desc' | null, whereInput?: string) =>
              emit('sort', column, direction, whereInput)
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
      </div>
    </template>

    <!-- Redis mode: key browser -->
    <template v-else-if="activeTab.mode === 'redis'">
      <div class="flex-1 min-h-0">
        <RedisKeyBrowser :key="activeTab.id" :connection-id="activeTab.connectionId" :db="Number(activeTab.database)" />
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
  </div>
</template>

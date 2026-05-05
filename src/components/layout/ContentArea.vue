<script setup lang="ts">
import { computed, defineAsyncComponent } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2, Square, Bot, Table2, GitBranch } from "lucide-vue-next";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { Button } from "@/components/ui/button";
import QueryEditor from "@/components/editor/QueryEditor.vue";
import DataGrid from "@/components/grid/DataGrid.vue";
import RedisKeyBrowser from "@/components/redis/RedisKeyBrowser.vue";
import MongoDocBrowser from "@/components/mongo/MongoDocBrowser.vue";
const ExplainPlanViewer = defineAsyncComponent(() => import("@/components/explain/ExplainPlanViewer.vue"));
import { useQueryStore } from "@/stores/queryStore";
import { canCancelQueryExecution, queryExecutionLabelKey } from "@/lib/queryExecutionState";
import { databaseDisplayNameForTab } from "@/lib/tabPresentation";
import type { QueryTab, ConnectionConfig } from "@/types/database";
import type { SqlFormatDialect } from "@/lib/sqlFormatter";

const props = defineProps<{
  activeTab: QueryTab;
  activeConnection?: ConnectionConfig;
  executableSql: string;
  activeOutputView: "result" | "explain";
  formatSqlRequestId: number;
  selectedSql: string;
  cursorPos: number;
}>();

const emit = defineEmits<{
  "update:activeOutputView": [value: "result" | "explain"];
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
}>();

const { t } = useI18n();
const queryStore = useQueryStore();

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
  props.activeConnection?.db_type === "postgres" ? "postgres" : "mysql"
);
</script>

<template>
  <div class="flex flex-col flex-1 min-h-0">
    <!-- Query mode: editor + results -->
    <template v-if="activeTab.mode === 'query'">
      <Splitpanes horizontal class="flex-1">
        <Pane :size="40" :min-size="15">
          <div class="h-full flex flex-col">
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
            />
          </div>
        </Pane>
        <Pane :size="60" :min-size="20">
          <div class="h-full flex flex-col">
            <div
              v-if="activeTab.result || activeTab.explainPlan || activeTab.explainError || activeTab.isExecuting || activeTab.isExplaining"
              class="h-8 shrink-0 border-b bg-muted/20 px-2 flex items-center gap-1"
            >
              <Button
                size="sm"
                :variant="activeOutputView === 'result' ? 'secondary' : 'ghost'"
                class="h-6 px-2 text-xs"
                :disabled="!activeTab.result && !activeTab.isExecuting"
                @click="emit('update:activeOutputView', 'result')"
              >
                {{ t('tabs.tableData') }}
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
                  {{ t('tabs.resultN', { n: rIdx + 1 }) }}
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
                {{ t('explain.title') }}
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

            <template v-else>
              <DataGrid v-if="activeTab.result" :key="`${activeTab.id}-${activeTab.activeResultIndex ?? 0}`" class="flex-1 min-h-0" :result="activeTab.result" :sql="activeTab.lastExecutedSql || activeTab.sql" :loading="activeTab.isExecuting" />
              <div v-if="activeTab.result?.columns.includes('Error')" class="flex items-center gap-2 px-3 py-1.5 border-t bg-destructive/5">
                <Bot class="h-3.5 w-3.5 text-destructive" />
                <button class="text-xs text-destructive hover:underline" @click="emit('fixWithAi', String(activeTab.result?.rows?.[0]?.[0] ?? ''))">
                  {{ t('ai.fixWithAi') }}
                </button>
              </div>
              <div v-else-if="!activeTab.result && activeTab.isExecuting" class="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-muted-foreground text-sm">
                <div class="flex items-center">
                  <Loader2 class="h-5 w-5 animate-spin mr-2" />
                  {{ t(queryExecutionLabelKey(activeTab)) }}
                </div>
              </div>
              <div v-else-if="!activeTab.result" class="flex-1 min-h-0 flex items-center justify-center text-muted-foreground text-sm">
                {{ t('editor.pressToExecute') }}
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
          <span class="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
            <Table2 class="h-3.5 w-3.5" />
            {{ t('tabs.tableData') }}
          </span>
          <span class="font-medium truncate">{{ activeTab.tableMeta?.tableName || activeTab.title }}</span>
          <span class="text-muted-foreground truncate">
            {{ databaseDisplayNameForTab(activeTab.connectionId, activeTab.database) }}
            <template v-if="activeTab.tableMeta?.schema"> &middot; {{ activeTab.tableMeta.schema }}</template>
          </span>
          <span v-if="activeTab.tableMeta" class="ml-auto text-muted-foreground">
            {{ activeTab.tableMeta.columns.length }} {{ t('tree.columns') }}
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
          @paginate="(offset: number, limit: number, whereInput?: string) => emit('paginate', offset, limit, whereInput)"
          @sort="(column: string, direction: 'asc' | 'desc' | null, whereInput?: string) => emit('sort', column, direction, whereInput)"
        />
        <div v-else-if="activeTab.isExecuting" class="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground text-sm">
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
            {{ t('toolbar.stopQuery') }}
          </Button>
        </div>
      </div>
    </template>

    <!-- Redis mode: key browser -->
    <template v-else-if="activeTab.mode === 'redis'">
      <div class="flex-1 min-h-0">
        <RedisKeyBrowser
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
  </div>
</template>

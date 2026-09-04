<script setup lang="ts">
import { computed, inject, ref, useAttrs } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import EditorGroupTabBar from "./EditorGroupTabBar.vue";
import EditorToolbar from "./EditorToolbar.vue";
import QueryEditorSurface from "./QueryEditorSurface.vue";
import ContentArea from "./ContentArea.vue";
import { createNoopEditorToolbarActions, EDITOR_TOOLBAR_ACTIONS } from "./editorToolbarActions";
import { createContentSurfaceEventForwarders } from "@/lib/tabs/contentSurfaceEvents";
import { isPreviewTab } from "@/lib/tabs/tabPresentation";
import { resolveExecutableSql } from "@/lib/sql/sqlExecutionTarget";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import type { ContentAreaSurfaceEmits, ContentAreaSurfaceProps, QueryEditorSurfaceHandle, StatementRange } from "./querySurfaces";
import type { QueryTab } from "@/types/database";

defineOptions({ inheritAttrs: false });

const props = defineProps<
  ContentAreaSurfaceProps & {
    groupId: string;
    tabIds: string[];
    activeTabId: string | null;
    tabBarWidth?: number;
    tabBarCollapsed?: boolean;
    canDetachTabs?: boolean;
    detachedDropTarget?: boolean;
  }
>();

const emit = defineEmits<
  ContentAreaSurfaceEmits & {
    "focus-group": [groupId: string];
    "activate-tab": [tabId: string];
    "locate-tab": [tab: QueryTab];
    "toggle-zen-mode": [];
    "start-resize": [event: MouseEvent];
    "toggle-collapse": [];
    "detach-tab": [tab: QueryTab];
  }
>();

const attrs = useAttrs();
const groupClass = computed(() => (typeof attrs.class === "string" ? attrs.class : undefined));
const surfaceProps = computed<ContentAreaSurfaceProps>(() => ({
  activeTab: activeTab.value!,
  activeConnection: activeConnection.value,
  executableSql: props.executableSql,
  activeOutputView: props.activeOutputView,
  formatSqlRequest: props.formatSqlRequest,
  compressSqlRequest: props.compressSqlRequest,
  selectedSql: props.selectedSql,
  cursorPos: props.cursorPos,
  blockDangerousRedisCommands: props.blockDangerousRedisCommands,
  zenMode: props.zenMode,
}));
const contentEmits = createContentSurfaceEventForwarders(emit);
const surfaceBindings = computed(() => ({ ...surfaceProps.value, ...contentEmits }));

const activeSurfaceRef = ref<QueryEditorSurfaceHandle | null>(null);

defineExpose({
  focusSearch: () => activeSurfaceRef.value?.focusSearch() ?? false,
  openGoToColumn: () => activeSurfaceRef.value?.openGoToColumn() ?? false,
  refreshData: () => activeSurfaceRef.value?.refreshData() ?? false,
  toggleResultsPane: () => activeSurfaceRef.value?.toggleResultsPane() ?? false,
  refreshQueryEditorCompletionCache: () => activeSurfaceRef.value?.refreshQueryEditorCompletionCache() ?? false,
  handleModRTarget: (target: Element) => activeSurfaceRef.value?.handleModRTarget(target) ?? false,
  requestQueryEditorExecute: () => activeSurfaceRef.value?.requestQueryEditorExecute() ?? false,
  captureQueryEditorExecutionSnapshot: () => activeSurfaceRef.value?.captureQueryEditorExecutionSnapshot(),
  requestQueryEditorExecuteInNewResultTab: () => activeSurfaceRef.value?.requestQueryEditorExecuteInNewResultTab() ?? false,
  requestQueryEditorPreviewChanges: async (stackSql?: string) => (await activeSurfaceRef.value?.requestQueryEditorPreviewChanges(stackSql)) ?? false,
  shouldBlockQueryEditorExecutionShortcut: (event: KeyboardEvent) => activeSurfaceRef.value?.shouldBlockQueryEditorExecutionShortcut(event) ?? false,
  cancelQueryEditorExecutionViewport: (requestId: number) => activeSurfaceRef.value?.cancelQueryEditorExecutionViewport(requestId) ?? false,
  acceptQueryEditorExecutionViewport: (requestId: number) => activeSurfaceRef.value?.acceptQueryEditorExecutionViewport(requestId) ?? false,
  pasteClipboardAsSqlInCondition: () => activeSurfaceRef.value?.pasteClipboardAsSqlInCondition() ?? Promise.resolve(false),
  applyTableStructureChanges: () => activeSurfaceRef.value?.applyTableStructureChanges() ?? Promise.resolve(false),
  insertRedisCommand: (command: string) => activeSurfaceRef.value?.insertRedisCommand(command) ?? Promise.resolve(false),
  executeRedisCommand: (command: string) => activeSurfaceRef.value?.executeRedisCommand(command) ?? Promise.resolve(false),
  previewStatementRange: (tabId: string, range: StatementRange | null) => (activeTab.value?.id === tabId ? (activeSurfaceRef.value?.previewStatementRange(range) ?? false) : false),
  focusStatementRange: (tabId: string, range: StatementRange | null) => (activeTab.value?.id === tabId ? (activeSurfaceRef.value?.focusStatementRange(range) ?? false) : false),
});

const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const toolbar = inject(EDITOR_TOOLBAR_ACTIONS, createNoopEditorToolbarActions());
const groupTabs = computed(() => {
  const byId = new Map(queryStore.tabs.map((tab) => [tab.id, tab]));
  return props.tabIds.map((id) => byId.get(id)).filter((tab): tab is QueryTab => !!tab);
});
const activeTab = computed(() => groupTabs.value.find((tab) => tab.id === props.activeTabId) ?? groupTabs.value[0] ?? null);
const activeConnection = computed(() => (activeTab.value ? connectionStore.getConfig(activeTab.value.connectionId) : undefined));
const showGroupToolbar = computed(() => activeTab.value?.mode === "query" && !isPreviewTab(activeTab.value));
const isGroupOracleManualTransaction = computed(() => effectiveDatabaseTypeForConnection(activeConnection.value) === "oracle" && (activeTab.value?.autoCommit ?? true) === false);
// Each group previews the executable SQL of its own active tab (selection
// stored on the tab), not the focused tab's global selection.
// tabPlacement drives each pane's own bar position: the strip sits above,
// below, left, or right of the pane's content, uniformly across panes.
const groupLayoutClass = computed(() => {
  switch (settingsStore.editorSettings.tabPlacement) {
    case "bottom":
      return "flex-col-reverse";
    case "left":
      return "flex-row";
    case "right":
      return "flex-row-reverse";
    default:
      return "flex-col";
  }
});

const groupExecutableSql = computed(() => {
  const tab = activeTab.value;
  if (!tab || tab.mode !== "query") {
    return "";
  }
  const selection = tab.editorSelection;
  const selectedSql = selection && selection.anchor !== selection.head ? tab.sql.slice(Math.min(selection.anchor, selection.head), Math.max(selection.anchor, selection.head)) : "";
  return resolveExecutableSql(tab.sql, selectedSql, {
    mode: settingsStore.editorSettings.executeMode,
    cursorPos: selection?.head ?? 0,
  });
});
</script>

<template>
  <div class="editor-group flex h-full min-h-0 min-w-0 overflow-hidden" :class="[groupClass, groupLayoutClass]" :data-group-id="groupId" @pointerdown.capture="$emit('focus-group', groupId)" @focusin="$emit('focus-group', groupId)">
    <EditorGroupTabBar
      :group-id="groupId"
      :tabs="groupTabs"
      :active-tab-id="activeTabId"
      :tab-bar-width="tabBarWidth"
      :tab-bar-collapsed="tabBarCollapsed"
      :can-detach-tabs="canDetachTabs"
      :detached-drop-target="detachedDropTarget"
      @activate-tab="$emit('activate-tab', $event)"
      @locate-tab="$emit('locate-tab', $event)"
      @toggle-zen-mode="$emit('toggle-zen-mode')"
      @start-resize="$emit('start-resize', $event)"
      @toggle-collapse="$emit('toggle-collapse')"
      @detach-tab="$emit('detach-tab', $event)"
    />
    <!-- The toolbar stays at the top of the pane's content column in every
         placement; only the tab bar moves around it. -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <EditorToolbar
        v-if="activeTab && showGroupToolbar"
        :active-tab="activeTab"
        :active-connection="activeConnection"
        :executable-sql="groupExecutableSql"
        :explain-mode="toolbar.explainMode.value"
        :block-dangerous-redis-commands="toolbar.blockDangerousRedisCommands.value"
        :sql-keyword-case="settingsStore.editorSettings.sqlFormatter.keywordCase"
        :database-required-signal="toolbar.databaseRequiredSignalFor(activeTab.id)"
        :auto-commit="activeTab.autoCommit ?? true"
        :txn-session-id="activeTab.txnSessionId"
        :txn-auto-rolled-back="activeTab.txnAutoRolledBack"
        :oracle-txn-possibly-dirty="activeTab.oracleTxnPossiblyDirty"
        :is-oracle-manual-transaction="isGroupOracleManualTransaction"
        @update:explain-mode="(m: 'explain' | 'autotrace') => (toolbar.explainMode.value = m)"
        @update:block-dangerous-redis-commands="(v: boolean) => (toolbar.blockDangerousRedisCommands.value = v)"
        @update:auto-commit="
          (v: boolean) => {
            if (activeTab) {
              queryStore.setAutoCommit(activeTab.id, v);
            }
          }
        "
        @commit="activeTab && queryStore.commitTransaction(activeTab.id)"
        @rollback="activeTab && queryStore.rollbackTransaction(activeTab.id)"
        @dismiss-txn-rolled-back="activeTab && (activeTab.txnAutoRolledBack = false)"
        @execute-pointer-down="toolbar.captureExecutionSnapshot()"
        @toolbar-execute="toolbar.toolbarExecute($event)"
        @multi-execute="toolbar.multiExecute()"
        @preview-changes="activeTab && toolbar.previewChanges(activeTab.id)"
        @cancel="activeTab && toolbar.cancelExecution(activeTab.id)"
        @explain="activeTab && toolbar.explain(activeTab.id)"
        @format-sql="activeTab && toolbar.formatSql(activeTab.id)"
        @compress-sql="activeTab && toolbar.compressSql(activeTab.id)"
        @toggle-sql-keyword-case="toolbar.toggleSqlKeywordCase()"
        @save-sql="(tabId: string) => toolbar.saveSql(tabId)"
        @open-sql="toolbar.openSqlFile()"
        @import-result-archive="toolbar.importResultArchive()"
        @paste-sql-in-condition="toolbar.pasteSqlInCondition()"
        @change-connection="(connectionId: string) => activeTab && toolbar.changeConnection(activeTab.id, connectionId)"
        @change-database="(database: string) => activeTab && toolbar.changeDatabase(activeTab.id, database)"
        @change-catalog="(catalog: string | undefined, database: string) => activeTab && toolbar.changeCatalog(activeTab.id, catalog, database)"
        @change-schema="(schema: string | undefined) => activeTab && toolbar.changeSchema(activeTab.id, schema)"
        @set-default-database="activeTab && toolbar.setDefaultDatabase(activeTab.id)"
        @clear-default-database="activeTab && toolbar.clearDefaultDatabase(activeTab.id)"
      />
      <div class="relative flex-1 min-h-0">
        <QueryEditorSurface v-if="activeTab?.mode === 'query'" ref="activeSurfaceRef" v-bind="surfaceBindings" :auto-focus="groupId === queryStore.focusedGroupId" class="h-full" />
        <ContentArea v-else-if="activeTab" ref="activeSurfaceRef" v-bind="surfaceBindings" class="h-full" />
        <div v-else class="flex h-full items-center justify-center text-sm text-muted-foreground">
          {{ t("tabs.emptyGroup") }}
        </div>
      </div>
    </div>
  </div>
</template>

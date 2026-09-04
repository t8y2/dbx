<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useAttrs } from "vue";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import "./sqlEditorWorkspace.css";
import { useQueryStore } from "@/stores/queryStore";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import EditorGroup from "./EditorGroup.vue";
import QueryResultSurface from "./QueryResultSurface.vue";
import { createContentSurfaceEventForwarders } from "@/lib/tabs/contentSurfaceEvents";
import type { ContentAreaSurfaceEmits, ContentAreaSurfaceProps, StatementRange } from "./querySurfaces";
import type { QueryTab } from "@/types/database";

defineOptions({ inheritAttrs: false });

const props = defineProps<
  ContentAreaSurfaceProps & {
    tabBarWidth?: number;
    tabBarCollapsed?: boolean;
    canDetachTabs?: boolean;
    detachedDropTarget?: boolean;
  }
>();
const emit = defineEmits<
  ContentAreaSurfaceEmits & {
    "locate-tab": [tab: QueryTab];
    "toggle-zen-mode": [];
    "start-resize": [event: MouseEvent];
    "toggle-collapse": [];
    "detach-tab": [tab: QueryTab];
  }
>();

const attrs = useAttrs();
const workspaceClass = computed(() => (typeof attrs.class === "string" ? attrs.class : undefined));
const surfaceProps = computed<ContentAreaSurfaceProps>(() => ({
  activeTab: props.activeTab,
  activeConnection: props.activeConnection,
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
const editorGroupBindings = computed(() => ({ ...surfaceProps.value, ...contentEmits }));
const resultSurfaceBindings = computed(() => ({ ...surfaceProps.value, ...contentEmits }));

defineExpose({
  focusSearch: (target: Element | null = null) => {
    const element = commandTargetElement(target);
    // The shared result pane (and its Teleported cell-detail dialog) lives
    // outside the group DOM, so route its search before the group fallback.
    // A data-mode cell-detail dialog is portaled to body too but belongs to
    // the group's grid — indistinguishable in the DOM, hence the gate.
    if (element?.closest("[data-shared-result-surface]") || (showSharedResult.value && element?.closest("[data-cell-detail-editor-root]"))) {
      return resultSurfaceRef.value?.focusSearch() ?? false;
    }
    const group = groupForElement(element) ?? activeEditorGroup();
    return group?.focusSearch() ?? false;
  },
  openGoToColumn: () => activeEditorGroup()?.openGoToColumn() ?? false,
  refreshData: (target: Element | null = null) => {
    const element = commandTargetElement(target);
    if (element?.closest("[data-shared-result-surface]")) {
      return resultSurfaceRef.value?.refreshData() ?? false;
    }
    const group = groupForElement(element) ?? activeEditorGroup();
    return group?.refreshData() ?? resultSurfaceRef.value?.refreshData() ?? false;
  },
  toggleResultsPane: () => {
    if (!showSharedResult.value) {
      return activeEditorGroup()?.toggleResultsPane() ?? false;
    }
    showResultPane.value = !showResultPane.value;
    return true;
  },
  refreshQueryEditorCompletionCache: () => activeEditorGroup()?.refreshQueryEditorCompletionCache() ?? false,
  handleModRTarget: (target: Element) => {
    // DataGrid, Elasticsearch JSON, and the cell-detail editor (Teleported
    // outside the grid DOM) belong to the shared result surface while a query
    // tab is active. Data-mode grids live inside a group's ContentArea and
    // their cell-detail dialogs are portaled to body just the same, so route
    // those to the group instead of the (unmounted) shared result surface.
    if (showSharedResult.value && target.closest("[data-grid-root], [data-elasticsearch-json-response-root], [data-cell-detail-editor-root]")) {
      return resultSurfaceRef.value?.handleModRTarget(target) ?? false;
    }
    const group = groupForElement(target) ?? activeEditorGroup();
    return group?.handleModRTarget(target) ?? false;
  },
  requestQueryEditorExecute: () => activeEditorGroup()?.requestQueryEditorExecute() ?? false,
  captureQueryEditorExecutionSnapshot: () => activeEditorGroup()?.captureQueryEditorExecutionSnapshot(),
  requestQueryEditorExecuteInNewResultTab: () => activeEditorGroup()?.requestQueryEditorExecuteInNewResultTab() ?? false,
  requestQueryEditorPreviewChanges: (stackSql?: string) => activeEditorGroup()?.requestQueryEditorPreviewChanges(stackSql) ?? false,
  shouldBlockQueryEditorExecutionShortcut: (event: KeyboardEvent) => activeEditorGroup()?.shouldBlockQueryEditorExecutionShortcut(event) ?? false,
  cancelQueryEditorExecutionViewport: (requestId: number) => activeEditorGroup()?.cancelQueryEditorExecutionViewport(requestId) ?? false,
  acceptQueryEditorExecutionViewport: (requestId: number) => activeEditorGroup()?.acceptQueryEditorExecutionViewport(requestId) ?? false,
  pasteClipboardAsSqlInCondition: () => activeEditorGroup()?.pasteClipboardAsSqlInCondition() ?? Promise.resolve(false),
  applyTableStructureChanges: () => {
    const group = groupForElement(commandTargetElement(null));
    return group?.applyTableStructureChanges() ?? activeEditorGroup()?.applyTableStructureChanges() ?? Promise.resolve(false);
  },
  insertRedisCommand: (command: string) => (groupForElement(commandTargetElement(null)) ?? activeEditorGroup())?.insertRedisCommand(command) ?? Promise.resolve(false),
  executeRedisCommand: (command: string) => (groupForElement(commandTargetElement(null)) ?? activeEditorGroup())?.executeRedisCommand(command) ?? Promise.resolve(false),
});

const queryStore = useQueryStore();
const activeTab = computed(() => queryStore.tabs.find((tab) => tab.id === queryStore.activeTabId));
const showSharedResult = computed(() => activeTab.value?.mode === "query");

const SHARED_RESULT_PANE_MIN_SIZE = 12;
const SHARED_RESULT_PANE_MAX_SIZE = 80;
const SHARED_RESULT_PANE_DEFAULT_SIZE = 32;
const SHARED_RESULT_PANE_STORAGE_KEY = "dbx-shared-results-pane-size";
const storedResultPaneSize = Number(safeLocalStorageGet(SHARED_RESULT_PANE_STORAGE_KEY));
const resultPaneSize = ref(Number.isFinite(storedResultPaneSize) && storedResultPaneSize >= SHARED_RESULT_PANE_MIN_SIZE && storedResultPaneSize <= SHARED_RESULT_PANE_MAX_SIZE ? storedResultPaneSize : SHARED_RESULT_PANE_DEFAULT_SIZE);
const showResultPane = ref(true);
// The result pane stays mounted and animates its size between the stored
// split and 0, so collapsing/expanding glides instead of jumping: the stock
// splitpanes pane transition is re-enabled for this workspace in
// sqlEditorWorkspace.css (globals.css kills it for horizontal splitpanes).
const resultPaneTargetSize = computed(() => (showSharedResult.value && showResultPane.value ? resultPaneSize.value : 0));
const editorPaneSize = computed(() => 100 - resultPaneTargetSize.value);
// Entrance choreography is hydration-gated: groups present at first render
// never animate (no load choreography); only groups created later — by a
// split — materialize from their owner's side of the divider.
const hydrated = ref(false);
const initialGroupIds = new Set(queryStore.groups.map((group) => group.id));
onMounted(() => {
  void nextTick(() => {
    hydrated.value = true;
  });
});
function paneEnterClass(groupId: string): string | undefined {
  if (!hydrated.value || initialGroupIds.has(groupId)) {
    return undefined;
  }
  return queryStore.orientation === "horizontal" ? "workspace-pane-enter workspace-pane-enter--from-top" : "workspace-pane-enter workspace-pane-enter--from-left";
}
function onSharedResultResized(payload: { panes: { size: number }[] }) {
  const resultPane = payload.panes[1];
  if (resultPane?.size != null && resultPane.size >= SHARED_RESULT_PANE_MIN_SIZE && resultPane.size <= SHARED_RESULT_PANE_MAX_SIZE) {
    resultPaneSize.value = resultPane.size;
    safeLocalStorageSet(SHARED_RESULT_PANE_STORAGE_KEY, String(resultPane.size));
  }
}
const groupRefs = new Map<string, InstanceType<typeof EditorGroup>>();
const resultSurfaceRef = ref<InstanceType<typeof QueryResultSurface> | null>(null);
function setGroupRef(groupId: string, el: unknown) {
  if (el) {
    groupRefs.set(groupId, el as InstanceType<typeof EditorGroup>);
  } else {
    groupRefs.delete(groupId);
  }
}
function activeEditorGroup() {
  const group = queryStore.groups.find((item) => item.id === queryStore.focusedGroupId) ?? queryStore.groups[0];
  return group ? (groupRefs.get(group.id) ?? null) : null;
}
function groupForElement(element: Element | null): InstanceType<typeof EditorGroup> | null {
  const groupElement = element?.closest<HTMLElement>("[data-group-id]");
  const groupId = groupElement?.dataset.groupId;
  return groupId ? (groupRefs.get(groupId) ?? null) : null;
}

/**
 * Resolves the command target element for a global keyboard command: the
 * caller-supplied event target when available, otherwise the live focus.
 */
function commandTargetElement(target: Element | null): Element | null {
  if (target) {
    return target;
  }
  return document.activeElement instanceof Element ? document.activeElement : null;
}
function handlePreviewStatement(tabId: string, range: StatementRange | null): boolean {
  for (const group of groupRefs.values()) {
    if (group.previewStatementRange(tabId, range)) {
      return true;
    }
  }
  return false;
}
function handleFocusStatement(tabId: string, range: StatementRange | null): boolean {
  for (const group of groupRefs.values()) {
    if (group.focusStatementRange(tabId, range)) {
      return true;
    }
  }
  return false;
}
</script>

<template>
  <div class="sql-editor-workspace flex h-full min-h-0 flex-1 flex-col overflow-hidden" :class="workspaceClass">
    <Splitpanes horizontal class="sql-editor-workspace-split flex-1 min-h-0" :class="{ 'result-pane-collapsed': resultPaneTargetSize === 0 }" @resized="onSharedResultResized">
      <Pane class="min-h-0 min-w-0" :size="editorPaneSize" :min-size="100 - SHARED_RESULT_PANE_MAX_SIZE">
        <Splitpanes
          :horizontal="queryStore.orientation === 'horizontal'"
          class="sql-editor-groups h-full min-h-0"
          @resized="
            (event: { panes: Array<{ size: number }> }) => {
              queryStore.sizes = event.panes.map((pane) => pane.size);
            }
          "
        >
          <Pane v-for="group in queryStore.groups" :key="group.id" :size="queryStore.sizes[queryStore.groups.indexOf(group)] ?? undefined" :min-size="10" class="min-h-0 min-w-0" :class="paneEnterClass(group.id)">
            <EditorGroup
              :ref="(el: unknown) => setGroupRef(group.id, el)"
              :group-id="group.id"
              :tab-ids="group.tabIds"
              :active-tab-id="group.activeTabId"
              :tab-bar-width="tabBarWidth"
              :tab-bar-collapsed="tabBarCollapsed"
              :can-detach-tabs="canDetachTabs"
              :detached-drop-target="detachedDropTarget"
              class="h-full"
              v-bind="editorGroupBindings"
              @focus-group="queryStore.focusGroup($event)"
              @activate-tab="queryStore.activateTabInGroup(group.id, $event)"
              @locate-tab="emit('locate-tab', $event)"
              @toggle-zen-mode="emit('toggle-zen-mode')"
              @start-resize="emit('start-resize', $event)"
              @toggle-collapse="emit('toggle-collapse')"
              @detach-tab="emit('detach-tab', $event)"
            />
          </Pane>
        </Splitpanes>
      </Pane>
      <Pane class="min-h-0" :size="resultPaneTargetSize" :min-size="resultPaneTargetSize > 0 ? SHARED_RESULT_PANE_MIN_SIZE : 0" :max-size="SHARED_RESULT_PANE_MAX_SIZE">
        <Transition name="result-surface">
          <div v-if="showSharedResult && showResultPane" data-shared-result-surface class="h-full min-h-0 overflow-hidden">
            <QueryResultSurface
              ref="resultSurfaceRef"
              v-bind="resultSurfaceBindings"
              class="h-full"
              @preview-statement="
                (tabId: string, range: { from: number; to: number } | null) => {
                  handlePreviewStatement(tabId, range);
                }
              "
              @focus-statement="
                (tabId: string, range: { from: number; to: number } | null) => {
                  handleFocusStatement(tabId, range);
                }
              "
            />
          </div>
        </Transition>
      </Pane>
    </Splitpanes>
  </div>
</template>

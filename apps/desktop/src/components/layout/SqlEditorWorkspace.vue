<script setup lang="ts">
import { computed, inject, nextTick, onMounted, provide, ref, useAttrs, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import "./sqlEditorWorkspace.css";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { createGroupTabBarPortal, GROUP_TAB_BAR_PORTAL } from "./groupTabBarPortal";
import { hasQueryOutput } from "@/lib/query/queryOutput";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { Button } from "@/components/ui/button";
import EditorGroup from "./EditorGroup.vue";
import QueryResultSurface from "./QueryResultSurface.vue";
import { createContentSurfaceEventForwarders } from "@/lib/tabs/contentSurfaceEvents";
import type { ContentAreaSurfaceEmits, ContentAreaSurfaceProps, StatementRange } from "./querySurfaces";
import type { QueryTab } from "@/types/database";

defineOptions({ inheritAttrs: false });

const props = defineProps<
  Omit<ContentAreaSurfaceProps, "activeTab"> & {
    activeTab?: QueryTab;
    showTabNavigation?: boolean;
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
const surfaceProps = computed(() => ({
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
const resultSurfaceBindings = computed(() => ({ ...surfaceProps.value, ...contentEmits, activeTab: activeTab.value! }));

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
  toggleResultsPane: () => toggleSharedResultsPane(),
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

const { t } = useI18n();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const isVerticalTabLayout = computed(() => settingsStore.editorSettings.tabPlacement === "left" || settingsStore.editorSettings.tabPlacement === "right");
const globalTabBarPortal = inject(GROUP_TAB_BAR_PORTAL, null);
const workspaceTabBarPortal = createGroupTabBarPortal(isVerticalTabLayout);
// A special page owns navigation while active. Otherwise side tabs stay
// outside the editor/result split, and horizontal tabs return to their group.
provide(GROUP_TAB_BAR_PORTAL, {
  active: computed(() => !!globalTabBarPortal?.active.value || isVerticalTabLayout.value),
  get targets() {
    return globalTabBarPortal?.active.value ? globalTabBarPortal.targets : workspaceTabBarPortal.targets;
  },
});
const tabNavigationStyle = computed(() => {
  const width = props.tabBarCollapsed ? "3.5rem" : `${props.tabBarWidth ?? 240}px`;
  return { width, flex: `0 0 ${width}` };
});
function setTabBarTarget(groupId: string, element: unknown) {
  if (element instanceof HTMLElement) workspaceTabBarPortal.targets.set(groupId, element);
  else workspaceTabBarPortal.targets.delete(groupId);
}
const activeTab = computed(() => queryStore.tabs.find((tab) => tab.id === queryStore.activeTabId));
const showSharedResult = computed(() => activeTab.value?.mode === "query");
const hasSharedOutput = computed(() => showSharedResult.value && hasQueryOutput(activeTab.value));

const SHARED_RESULT_PANE_MIN_SIZE = 12;
const SHARED_RESULT_PANE_MAX_SIZE = 80;
const SHARED_RESULT_PANE_DEFAULT_SIZE = 32;
const SHARED_RESULT_PANE_STORAGE_KEY = "dbx-shared-results-pane-size";
const storedResultPaneSize = Number(safeLocalStorageGet(SHARED_RESULT_PANE_STORAGE_KEY));
const resultPaneSize = ref(Number.isFinite(storedResultPaneSize) && storedResultPaneSize >= SHARED_RESULT_PANE_MIN_SIZE && storedResultPaneSize <= SHARED_RESULT_PANE_MAX_SIZE ? storedResultPaneSize : SHARED_RESULT_PANE_DEFAULT_SIZE);
const showResultPane = ref(true);
const isResultPaneVisible = computed(() => hasSharedOutput.value && showResultPane.value);
// Keep the pane mounted, but apply its target size immediately so available
// results never wait for an expansion animation before becoming visible.
const resultPaneTargetSize = computed(() => (isResultPaneVisible.value ? resultPaneSize.value : 0));
const editorPaneSize = computed(() => 100 - resultPaneTargetSize.value);

/**
 * Single toggle entry point for the shared result pane. Reached from the
 * keyboard shortcut (exposed toggleResultsPane) and from the shared surface's
 * "hide results" chevron, which bubbles a toggleResultsPane event up through
 * ContentArea → QueryResultSurface. Non-query tabs (data etc.) render a plain
 * ContentArea and keep their own per-tab resultsPaneOpen collapse behavior.
 */
function toggleSharedResultsPane(): boolean {
  if (!showSharedResult.value) {
    return activeEditorGroup()?.toggleResultsPane() ?? false;
  }
  if (!hasSharedOutput.value) return false;
  showResultPane.value = !showResultPane.value;
  return true;
}

// Restores the pre-split "running a query re-expands the results pane"
// behavior (see issue #6193): a collapsed shared pane comes back when the
// active tab starts executing.
watch(
  () => [activeTab.value?.id, activeTab.value?.isExecuting, activeTab.value?.isExplaining] as const,
  ([, isExecuting, isExplaining]) => {
    if (isExecuting || isExplaining) showResultPane.value = true;
  },
);
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
  <div class="sql-editor-workspace relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden" :class="[workspaceClass, settingsStore.editorSettings.tabPlacement === 'right' ? 'flex-row-reverse' : 'flex-row']">
    <div v-show="isVerticalTabLayout && showTabNavigation !== false" data-workspace-tab-navigation class="flex min-h-0 shrink-0 flex-col overflow-hidden" :style="tabNavigationStyle">
      <div v-for="group in queryStore.groups" :key="group.id" :ref="(element) => setTabBarTarget(group.id, element)" :data-workspace-tab-target="group.id" class="flex min-h-0 min-w-0 flex-1" @pointerdown.capture="queryStore.focusGroup(group.id)" @focusin="queryStore.focusGroup(group.id)" />
    </div>
    <div data-workspace-content class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
                :show-tab-navigation="showTabNavigation"
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
              >
                <template #empty><slot name="empty" /></template>
              </EditorGroup>
            </Pane>
          </Splitpanes>
        </Pane>
        <Pane class="min-h-0" :size="resultPaneTargetSize" :min-size="resultPaneTargetSize > 0 ? SHARED_RESULT_PANE_MIN_SIZE : 0" :max-size="SHARED_RESULT_PANE_MAX_SIZE">
          <div v-if="isResultPaneVisible" data-shared-result-surface class="h-full min-h-0 overflow-hidden">
            <QueryResultSurface
              ref="resultSurfaceRef"
              v-bind="resultSurfaceBindings"
              class="h-full"
              @toggle-results-pane="toggleSharedResultsPane"
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
        </Pane>
      </Splitpanes>
      <!-- The shared surface unmounts when collapsed, so the mouse re-show
         affordance lives here, outside the collapsible pane. -->
      <Button
        v-if="hasSharedOutput && !showResultPane"
        type="button"
        variant="secondary"
        size="sm"
        class="absolute bottom-3 right-3 z-20 h-7 gap-1.5 rounded-full border bg-background/95 px-3 text-xs shadow-lg hover:bg-accent"
        :title="t('editor.showResultsPane')"
        :aria-label="t('editor.showResultsPane')"
        @click="showResultPane = true"
      >
        {{ t("editor.showResultsPane") }}
      </Button>
    </div>
  </div>
</template>

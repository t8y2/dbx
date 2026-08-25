<script setup lang="ts">
// 分离面板的独立子窗口外壳：只渲染目标内容，复用主窗口的 Rust 后端数据源，
// 通过 detachedPanel 事件总线与主窗口交互（打开标签页、恢复历史等动作均在主窗口执行）。
// 窗口以 visible: false 创建，本组件挂载完成后负责 show，并持久化窗口位置供下次直接定位。
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import QueryHistory from "@/components/editor/QueryHistory.vue";
import SqlFilePanel from "@/components/layout/SqlFilePanel.vue";
import SqlLibraryPanel from "@/components/layout/SqlLibraryPanel.vue";
import TableInfoPanel from "@/components/objects/TableInfoPanel.vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTheme } from "@/composables/useTheme";
import { useToast } from "@/composables/useToast";
import { applyLocaleFromStorage } from "@/i18n";
import {
  DETACHED_SAVED_SQL_TABS_KEY,
  MAIN_WINDOW_LABEL,
  getDetachedPanelFromLocation,
  listenDetachedPanelMessages,
  saveDetachedWindowPlacement,
  sendDetachedPanelMessage,
  sendDetachedPanelMessageOrThrow,
  type AiPanelContextSnapshot,
  type AiTabContext,
  type SavedSqlTabsSnapshot,
  type TableInfoContextSnapshot,
} from "@/lib/detached/detachedPanel";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { QueryResult, TableInfoTab } from "@/types/database";
import type { AiAction } from "@/lib/ai/ai";

// AI 助手体积大且仅 ai 面板需要，异步加载以保持其他子窗口轻量。
const AiAssistant = defineAsyncComponent(() => import("@/components/editor/AiAssistant.vue"));

const panel = getDetachedPanelFromLocation();

const { t } = useI18n();

const { applyTheme, reloadThemeFromStorage } = useTheme();
const { message: toastMessage, visible: toastVisible } = useToast();
const settingsStore = useSettingsStore();
const connectionStore = useConnectionStore();
const savedSqlStore = useSavedSqlStore();

// 主窗口广播的标签页快照（SQL 库面板高亮/脏标记）。
const savedSqlTabsSnapshot = ref<SavedSqlTabsSnapshot>({ activeSavedSqlId: null, dirtySavedSqlIds: [], activeTargetConnectionId: null });
provide(DETACHED_SAVED_SQL_TABS_KEY, savedSqlTabsSnapshot);

// 主窗口推送的 AI 面板上下文（活动标签 + 连接）。
const aiContext = ref<AiPanelContextSnapshot>({ tab: null, connection: null });

// 主窗口推送的表信息面板上下文（当前选中的表 + 连接）。
const tableInfoContext = ref<TableInfoContextSnapshot | null>(null);
const tableInfoPanelRef = ref<InstanceType<typeof TableInfoPanel> | null>(null);

/** 表信息目标的唯一 key，用于判断快照是否换表（换表时采用主窗口快照中的页签）。 */
function tableInfoRowKey(snapshot: TableInfoContextSnapshot | null): string {
  const row = snapshot?.row;
  if (!snapshot || !row) return "";
  return [snapshot.connection?.id ?? "", snapshot.database, snapshot.catalog ?? "", row.schema ?? "", row.name, row.type].join("\0");
}

type AiAssistantHandle = {
  triggerAction: (action: AiAction, instruction?: string) => void;
  setPrompt: (text: string) => void;
};
const aiAssistantRef = ref<AiAssistantHandle | null>(null);

/** AiAssistant 是异步组件，挂载完成前收到的动作先等 ref 就绪再调用。 */
function invokeAiWhenReady(invoke: (handle: AiAssistantHandle) => void) {
  if (aiAssistantRef.value) {
    invoke(aiAssistantRef.value);
    return;
  }
  const stop = watch(aiAssistantRef, (handle) => {
    if (handle) {
      stop();
      invoke(handle);
    }
  });
}

/** 由主窗口快照重建 AI 面板的标签上下文（fix 动作用到执行错误，此处按标记重建）。 */
const aiTabContext = computed<AiTabContext | undefined>(() => {
  const tab = aiContext.value.tab;
  if (!tab) return undefined;
  return {
    id: tab.id,
    connectionId: tab.connectionId,
    database: tab.database,
    schema: tab.schema ?? undefined,
    sql: tab.sql,
    result: tab.lastError != null ? ({ columns: ["Error"], rows: [[tab.lastError]], execution_error: true } as QueryResult) : undefined,
    resultPreview: tab.resultPreview ?? undefined,
    tableMeta: tab.tableMeta ?? undefined,
  };
});
const aiConnection = computed(() => aiContext.value.connection ?? undefined);

let unlisten: (() => void) | null = null;
const unlistenWindowEvents: Array<() => void> = [];
let placementSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** 移动/缩放后防抖保存窗口位置，供下次打开时创建即定位。 */
function schedulePlacementSave() {
  if (!panel) return;
  if (placementSaveTimer) clearTimeout(placementSaveTimer);
  placementSaveTimer = setTimeout(() => {
    placementSaveTimer = null;
    void saveDetachedWindowPlacement(panel);
  }, 300);
}

/** 注册窗口移动/缩放监听，并在渲染完成后显示窗口（创建时 visible: false）。 */
async function initWindowLifecycle() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  unlistenWindowEvents.push(await win.onMoved(schedulePlacementSave), await win.onResized(schedulePlacementSave));
  // 等首帧渲染完成再显示，避免白屏/未渲染内容闪现。
  await nextTick();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await win.show();
  await win.setFocus();
}

/** 应用 UI 缩放到本窗口（不回写设置存储，避免与主窗口的保存竞态）。 */
async function applyUiScaleToWindow(scale: number) {
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(scale);
    window.dispatchEvent(new CustomEvent("dbx:ui-scale-applied", { detail: { scale } }));
  } catch (error) {
    console.warn("[detached-panel] apply ui scale failed", { scale, error });
  }
}

// 与主窗口保持一致：启动时应用一次持久化的缩放，后续由 app-settings-sync 消息驱动更新。
watch(
  () => settingsStore.editorSettings.uiScale,
  (scale) => {
    void applyUiScaleToWindow(scale);
  },
  { immediate: true },
);

/** 主窗口设置变更同步：主题/语言从 localStorage 重读，缩放值随消息携带直接应用。 */
function applySyncedAppSettings(uiScale?: number) {
  reloadThemeFromStorage();
  void applyLocaleFromStorage().catch((error) => console.error("[detached-panel] sync locale failed", error));
  if (typeof uiScale === "number") void applyUiScaleToWindow(uiScale);
}

async function closeWindow() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  } catch (error) {
    console.error("[detached-panel] close window failed", error);
  }
}

/** 合并回主窗口：由主窗口重置状态、打开停靠面板并关闭本窗口。 */
function dockToMainWindow() {
  if (!panel) return;
  void sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: "dock-panel", panel });
}

onMounted(async () => {
  applyTheme();
  await settingsStore.initEditorSettings().catch(() => {});
  if (panel === "ai") void settingsStore.initAiConfigs().catch((error) => console.error("[detached-panel] init ai configs failed", error));
  void connectionStore.initFromDisk().catch((error) => console.error("[detached-panel] init connections failed", error));
  void savedSqlStore.initFromStorage().catch((error) => console.error("[detached-panel] init saved sql failed", error));

  unlisten = await listenDetachedPanelMessages((message) => {
    if (message.action === "saved-sql-changed") {
      void savedSqlStore.reloadFromStorage().catch((error) => console.error("[detached-panel] reload saved sql failed", error));
    } else if (message.action === "saved-sql-tabs") {
      savedSqlTabsSnapshot.value = message.snapshot;
    } else if (message.action === "ai-context") {
      aiContext.value = message.snapshot;
    } else if (message.action === "table-info-context") {
      const previousKey = tableInfoRowKey(tableInfoContext.value);
      tableInfoContext.value = message.snapshot;
      // 换表时采用主窗口快照中的页签；同一张表保留子窗口内用户选择的页签。
      if (message.snapshot.row && message.snapshot.tab && tableInfoRowKey(message.snapshot) !== previousKey) {
        const tab: TableInfoTab = message.snapshot.tab;
        void nextTick(() => tableInfoPanelRef.value?.selectTab(tab));
      }
    } else if (message.action === "ai-trigger-action") {
      invokeAiWhenReady((handle) => handle.triggerAction(message.aiAction, message.instruction));
    } else if (message.action === "ai-set-prompt") {
      invokeAiWhenReady((handle) => handle.setPrompt(message.text));
    } else if (message.action === "app-settings-sync") {
      applySyncedAppSettings(message.uiScale);
    }
  });
  // 请求主窗口推送一次当前标签页快照（watch 的立即推送发生在子窗口就绪之前）。
  if (panel === "sqlLibrary") {
    void sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: "request-saved-sql-tabs" });
  }
  // AI 面板：请求主窗口推送上下文快照，并触发主窗口冲刷待处理的入口动作。
  if (panel === "ai") {
    void sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: "request-ai-context" });
  }
  // 表信息面板：请求主窗口推送一次当前选中的表。
  if (panel === "tableInfo") {
    void sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: "request-table-info-context" });
  }

  try {
    await initWindowLifecycle();
    if (panel) await sendDetachedPanelMessageOrThrow(MAIN_WINDOW_LABEL, { action: "detached-panel-ready", panel });
  } catch (error) {
    console.error("[detached-panel] init window lifecycle failed", error);
    await closeWindow();
  }
});

onBeforeUnmount(() => {
  unlisten?.();
  unlisten = null;
  for (const unlistenFn of unlistenWindowEvents) unlistenFn();
  unlistenWindowEvents.length = 0;
  if (placementSaveTimer) clearTimeout(placementSaveTimer);
  placementSaveTimer = null;
  // 关闭前兜底保存一次（防抖可能尚未触发）。
  if (panel) void saveDetachedWindowPlacement(panel);
});
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <div class="h-screen w-screen overflow-hidden bg-background text-foreground">
      <template v-if="panel === 'history'">
        <QueryHistory @restore="(sql, entry) => sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: 'restore-history', sql, entry })" @analyze-ai="(entry) => sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: 'analyze-history-ai', entry })" @dock="dockToMainWindow" @close="closeWindow" />
      </template>
      <SqlLibraryPanel v-else-if="panel === 'sqlLibrary'" @dock="dockToMainWindow" @close="closeWindow" />
      <SqlFilePanel v-else-if="panel === 'sqlFile'" @dock="dockToMainWindow" @close="closeWindow" />
      <template v-else-if="panel === 'tableInfo'">
        <TableInfoPanel
          v-if="tableInfoContext?.row && tableInfoContext.connection"
          ref="tableInfoPanelRef"
          :connection="tableInfoContext.connection"
          :database="tableInfoContext.database"
          :catalog="tableInfoContext.catalog ?? undefined"
          :fallback-schema="tableInfoContext.fallbackSchema ?? undefined"
          :table-name="tableInfoContext.row.name"
          :table-schema="tableInfoContext.row.schema ?? undefined"
          :table-type="tableInfoContext.row.type"
          :initial-tab="tableInfoContext.tab ?? undefined"
          @close="closeWindow"
          @dock="dockToMainWindow"
          @open-structure="
            (payload) =>
              tableInfoContext?.connection &&
              tableInfoContext.row &&
              sendDetachedPanelMessage(MAIN_WINDOW_LABEL, {
                action: 'table-info-open-structure',
                connectionId: tableInfoContext.connection.id,
                database: tableInfoContext.database,
                catalog: tableInfoContext.catalog ?? undefined,
                schema: tableInfoContext.row.schema ?? tableInfoContext.fallbackSchema ?? undefined,
                tableName: tableInfoContext.row.name,
                tab: payload.tab,
              })
          "
        />
        <div v-else class="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">{{ t("panelDetach.tableInfoEmpty") }}</div>
      </template>
      <AiAssistant
        v-else-if="panel === 'ai'"
        ref="aiAssistantRef"
        :tab="aiTabContext"
        :connection="aiConnection"
        @replace-sql="(sql: string) => sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: 'ai-sql', kind: 'replace', sql })"
        @execute-sql="(sql: string) => sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: 'ai-sql', kind: 'execute', sql })"
        @temp-run-sql="(sql: string) => sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: 'ai-sql', kind: 'temp-run', sql })"
        @request-auto-execute-sql="(sql: string) => sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: 'ai-sql', kind: 'auto-execute', sql })"
        @insert-redis-command="(command: string) => sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: 'ai-redis-command', command, execute: false })"
        @execute-redis-command="(command: string) => sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: 'ai-redis-command', command, execute: true })"
        @open-explain-plan="(sql: string) => sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: 'ai-open-explain-plan', sql })"
        @dock="dockToMainWindow"
        @close="closeWindow"
      />
      <div v-else class="flex h-full items-center justify-center text-sm text-muted-foreground">Unknown panel</div>
      <Transition name="toast">
        <div v-if="toastVisible" class="fixed bottom-6 inset-x-0 w-max max-w-[90vw] sm:max-w-3xl mx-auto z-99999 px-4 py-2 rounded-lg bg-foreground text-background text-sm shadow-lg select-text whitespace-pre-wrap break-words">
          {{ toastMessage }}
        </div>
      </Transition>
    </div>
  </TooltipProvider>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: 0.25s ease;
  transition-property: transform, opacity;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(100%) scale(0.95);
}
</style>

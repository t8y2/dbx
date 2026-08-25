<script setup lang="ts">
// 分离页签的独立子窗口外壳：复用主窗口 ContentArea/EditorToolbar 与执行 composables，
// 页签状态由本窗口 queryStore 全权持有（查询执行走 Tauri invoke，进程级共享后端）。
// 快照经 localStorage registry 与主窗口交换：分离/合并（dock）双向转移所有权；
// 编辑过程防抖同步快照，主窗口异常退出后下次启动可从 registry 恢复页签。
// 预热 shell 模式（?detached-tab-shell=1）：待命隐藏窗口，收到 assign 后渲染目标页签。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Activity, AlertTriangle, CalendarClock, Code2, Database, Gauge, KeyRound, Network, PencilRuler, PictureInPicture2, ShieldCheck, Table2, TableProperties, X } from "@lucide/vue";
import ContentArea from "@/components/layout/ContentArea.vue";
import EditorToolbar from "@/components/layout/EditorToolbar.vue";
import DetachedWindowControls from "@/components/layout/DetachedWindowControls.vue";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import SqlParameterDialog from "@/components/editor/SqlParameterDialog.vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useQueryStore } from "@/stores/queryStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { useSqlExecutionDangerStore } from "@/stores/sqlExecutionDangerStore";
import { useSqlExecution } from "@/composables/useSqlExecution";
import { useDataGridActions } from "@/composables/useDataGridActions";
import { useDatabaseOptions } from "@/composables/useDatabaseOptions";
import { useTheme } from "@/composables/useTheme";
import { useToast } from "@/composables/useToast";
import { applyLocaleFromStorage } from "@/i18n";
import { translateBackendError } from "@/i18n/backend-errors";
import { isMacOS } from "@/lib/backend/platform";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import * as api from "@/lib/backend/api";
import {
  broadcastDetachedPanelMessage,
  clampRectToVisibleMonitor,
  listenDetachedPanelMessages,
  loadDetachedWindowPlacement,
  resolveMainWindowAnchoredPosition,
  saveDetachedWindowPlacement,
  sendDetachedPanelMessage,
  sendDetachedPanelMessageOrThrow,
  MAIN_WINDOW_LABEL,
} from "@/lib/detached/detachedPanel";
import { detachedTabPlacementKey, getDetachedTabModeFromLocation, readDetachedTabEntry, removeDetachedTabEntry, requestDockDetachedTab, restoreDetachedTabSnapshot, serializeDetachedTab, updateDetachedTabSnapshot } from "@/lib/detached/detachedTabs";
import { collectDataGridPendingSnapshotsForTab, stageDataGridPendingSnapshotsForTab } from "@/composables/useDataGridEditor";
import { buildTabResultSnapshot, tabResultCacheKey, writeTabResultSnapshot } from "@/lib/tabs/tabResultCache";
import { resolveExecutableSql, resolveExecutableSqlWithBackend, type SqlExecutionOverride } from "@/lib/sql/sqlExecutionTarget";
import { tabDisplayTitle } from "@/lib/tabs/tabPresentation";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { schemaAfterConnectionSwitch } from "@/lib/schema/connectionSchemaInitialization";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { rememberExternalSqlFileTarget } from "@/lib/sql/externalSqlFileTarget";
import { savedSqlDefaultTargetForWrite } from "@/lib/savedSql/savedSqlExecutionTarget";
import { savedSqlErrorMessage } from "@/lib/savedSql/savedSqlErrors";
import { buildExecutableObjectSourceStatements, executeObjectSourceSave } from "@/lib/table/objectSourceEditor";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { invalidateTableMetadataCache } from "@/lib/metadata/tableMetadataCache";
import type { NavigationTarget } from "@/composables/useNavigationTargets";
import type { QueryTab } from "@/types/database";
import { sqlObjectNavigationSourceKind, sqlObjectNavigationTableType, type SqlObjectNavigationTarget } from "@/lib/sql/sqlNavigation";

const windowMode = getDetachedTabModeFromLocation();
const { t } = useI18n();
const { applyTheme, reloadThemeFromStorage } = useTheme();
const queryStore = useQueryStore();
const connectionStore = useConnectionStore();
const settingsStore = useSettingsStore();
const savedSqlStore = useSavedSqlStore();
const productionSafetyStore = useProductionSafetyStore();
const sqlExecutionDangerStore = useSqlExecutionDangerStore();
const { toast, message: toastMessage, visible: toastVisible } = useToast();
const { getDatabaseOptions } = useDatabaseOptions();
const isMac = isMacOS();

// ---------------------------------------------------------------------------
// 页签状态
// ---------------------------------------------------------------------------

const tabId = ref<string | null>(windowMode?.kind === "tab" ? windowMode.tabId : null);
const tab = computed<QueryTab | undefined>(() => (tabId.value ? queryStore.tabs.find((item) => item.id === tabId.value) : undefined));
const activeConnection = computed(() => (tab.value ? (connectionStore.getConfig(tab.value.connectionId) ?? undefined) : undefined));
const displayTitle = computed(() => (tab.value ? tabDisplayTitle(tab.value, t) : ""));

function tabIcon(tabValue: QueryTab) {
  if (tabValue.externalSqlFileMissing) return Table2;
  if (tabValue.mode === "data" || tabValue.mode === "mongo" || tabValue.mode === "redis" || tabValue.mode === "hbase") return Table2;
  if (tabValue.mode === "vector") return TableProperties;
  if (tabValue.mode === "etcd" || tabValue.mode === "zookeeper" || tabValue.mode === "consul") return KeyRound;
  if (tabValue.mode === "consul-overview" || tabValue.mode === "etcd-dashboard") return Gauge;
  if (tabValue.mode === "etcd-access-control") return ShieldCheck;
  if (tabValue.mode === "nacos") return Network;
  if (tabValue.mode === "databases") return Database;
  if (tabValue.mode === "objects") return TableProperties;
  if (tabValue.mode === "structure") return PencilRuler;
  if (tabValue.mode === "dameng-jobs") return CalendarClock;
  if (tabValue.mode === "processlist" || tabValue.mode === "sqlserver-trace") return Activity;
  if (tabValue.mode === "mysql-dashboard" || tabValue.mode === "postgres-dashboard" || tabValue.mode === "nacos-dashboard") return Gauge;
  return Code2;
}

// ---------------------------------------------------------------------------
// 编辑器/执行状态（本窗口本地）
// ---------------------------------------------------------------------------

const contentAreaRef = ref<InstanceType<typeof ContentArea> | null>(null);
const selectedSql = ref("");
const cursorPos = ref(0);
const activeOutputView = ref<"result" | "summary" | "explain" | "chart" | "messages">("result");
const formatSqlRequest = ref<{ id: number; tabId: string } | null>(null);
const compressSqlRequest = ref<{ id: number; tabId: string } | null>(null);
const blockDangerousRedisCommands = ref(true);

const executableSql = computed(() => {
  const tabValue = tab.value;
  return tabValue ? resolveExecutableSql(tabValue.sql, selectedSql.value, { mode: settingsStore.editorSettings.executeMode, cursorPos: cursorPos.value }) : "";
});

async function resolveActiveExecutableSql(snapshot?: { fullSql: string; selectedSql: string; selectionFrom: number; selectionTo: number; cursorPos?: number }) {
  const tabValue = tab.value;
  return tabValue
    ? await resolveExecutableSqlWithBackend(snapshot?.fullSql ?? tabValue.sql, snapshot?.selectedSql ?? selectedSql.value, {
        mode: settingsStore.editorSettings.executeMode,
        cursorPos: snapshot?.cursorPos ?? cursorPos.value,
        databaseType: activeConnection.value?.db_type,
      })
    : "";
}

const {
  dangerSql,
  pendingDangerSql: _pendingDangerSql,
  showDangerDialog,
  suppressDangerConfirm,
  tryExecute,
  tryExecuteInNewResultTab,
  cancelActiveExecution,
  tryExplain,
  onDangerConfirm,
  showSqlParameterDialog,
  sqlParameterSourceSql,
  sqlParameterNames,
  sqlParameterDatabaseType,
  sqlParameterEnabledSyntaxes,
  onSqlParametersConfirm,
  explainMode,
} = useSqlExecution({
  activeTab: tab,
  activeConnection,
  executableSql,
  resolveExecutableSql: resolveActiveExecutableSql,
  activeOutputView,
  blockDangerousRedisCommands,
  onMissingDatabase: () => toast(t("editor.selectDatabaseRequired"), 2500),
  requestDangerConfirmation: (request) => sqlExecutionDangerStore.requestConfirmation(request),
});

const { onExecuteSql, onReloadData, onPaginate, onSort } = useDataGridActions(tab);

function requestActiveEditorExecute() {
  if (contentAreaRef.value?.requestQueryEditorExecute?.()) return;
  void tryExecute();
}

function formatActiveSql() {
  const tabValue = tab.value;
  if (!tabValue || tabValue.mode !== "query" || !tabValue.sql.trim()) return;
  formatSqlRequest.value = { id: (formatSqlRequest.value?.id ?? 0) + 1, tabId: tabValue.id };
}

function compressActiveSql() {
  const tabValue = tab.value;
  if (!tabValue || tabValue.mode !== "query" || !tabValue.sql.trim()) return;
  compressSqlRequest.value = { id: (compressSqlRequest.value?.id ?? 0) + 1, tabId: tabValue.id };
}

function toggleSqlKeywordCase() {
  const sqlFormatter = settingsStore.editorSettings.sqlFormatter;
  settingsStore.updateEditorSettings({ sqlFormatter: { ...sqlFormatter, keywordCase: sqlFormatter.keywordCase === "lower" ? "upper" : "lower" } });
}

// ---------------------------------------------------------------------------
// 快照同步（防抖写 registry；结果数据按需落 IndexedDB 缓存）
// ---------------------------------------------------------------------------

let snapshotSyncTimer: ReturnType<typeof setTimeout> | null = null;
let lastResultStamp = "";

/** 结果内容指纹：变化时才重写 IndexedDB 结果缓存（避免每次编辑都写大对象）。 */
function resultPayloadStamp(tabValue: QueryTab): string {
  return [tabValue.resultAccessedAt ?? 0, tabValue.resultGridRevision ?? "", tabValue.activeResultRunId ?? "", tabValue.resultRuns?.length ?? 0].join(":");
}

function tabHasResultPayload(tabValue: QueryTab): boolean {
  return !!tabValue.result || !!tabValue.results?.length || !!tabValue.resultRuns?.some((run) => run.result || run.results?.length);
}

/** 立即同步一次快照到 registry（dock 前、防抖驱动均走这里）。 */
async function syncSnapshotNow(): Promise<void> {
  const tabValue = tab.value;
  if (!tabValue || !tabId.value) return;
  // 所有页签（含 data）结果都写缓存：dock 回主窗口后凭 cacheKey 读回的是最新数据。
  if (tabHasResultPayload(tabValue)) {
    const stamp = resultPayloadStamp(tabValue);
    if (stamp !== lastResultStamp) {
      const cacheKey = tabResultCacheKey(tabValue.id);
      const cached = await writeTabResultSnapshot(cacheKey, buildTabResultSnapshot(tabValue), tabValue.connectionId);
      if (cached) tabValue.resultCacheKey = cacheKey;
      lastResultStamp = stamp;
    }
  }
  const snapshot = serializeDetachedTab(tabValue);
  // DataGrid 未保存编辑（newRows/dirtyRows/deletedRows 等窗口级缓存）随快照一并转移。
  const dataGridPending = collectDataGridPendingSnapshotsForTab(tabValue.id);
  if (dataGridPending) snapshot.dataGridPending = dataGridPending;
  updateDetachedTabSnapshot(tabId.value, snapshot);
}

function scheduleSnapshotSync() {
  if (snapshotSyncTimer) clearTimeout(snapshotSyncTimer);
  snapshotSyncTimer = setTimeout(() => {
    snapshotSyncTimer = null;
    void syncSnapshotNow();
  }, 500);
}

// 页签关键字段变化 → 防抖同步（JSON 指纹避免深度 watch 开销）。
watch(() => {
  const tabValue = tab.value;
  if (!tabValue) return "";
  return JSON.stringify({
    title: tabValue.title,
    sql: tabValue.sql,
    originalSql: tabValue.originalSql,
    connectionId: tabValue.connectionId,
    database: tabValue.database,
    catalog: tabValue.catalog,
    schema: tabValue.schema,
    whereInput: tabValue.whereInput,
    orderByInput: tabValue.orderByInput,
    resultPageLimit: tabValue.resultPageLimit,
    resultPageOffset: tabValue.resultPageOffset,
    structureDraft: tabValue.structureDraft,
    tableInfoTab: tabValue.tableInfoTab,
    objectBrowser: tabValue.objectBrowser,
    // data 页签的 grid 编辑计数（崩溃保护同步的触发信号；实际状态同步时现取）。
    pendingDataChangeCount: tabValue.pendingDataChangeCount ?? 0,
    pendingDataEditorDraft: tabValue.hasPendingDataEditorDraft === true,
    stamp: resultPayloadStamp(tabValue),
  });
}, scheduleSnapshotSync);

// ---------------------------------------------------------------------------
// 页签装载（URL 直开 / shell 收到 assign）
// ---------------------------------------------------------------------------

const windowReady = ref(false);

async function currentWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

/** 按显式坐标或记忆位置定位窗口（show 之前调用，避免跳动）。 */
async function placeWindow(x?: number, y?: number) {
  if (!isTauriRuntime()) return;
  try {
    const win = await currentWindow();
    if (x !== undefined && y !== undefined) {
      // 显式鼠标定位：鼠标在屏幕边缘时窗口会部分溢出屏幕，clamp 回鼠标所在显示器。
      const { LogicalPosition } = await import("@tauri-apps/api/dpi");
      const [size, scale] = await Promise.all([win.outerSize(), win.scaleFactor()]);
      const clamped = await clampRectToVisibleMonitor({ x: Math.round(x), y: Math.round(y), width: size.width / scale, height: size.height / scale });
      await win.setPosition(new LogicalPosition(clamped.x, clamped.y));
      return;
    }
    const remembered = tabId.value ? await loadDetachedWindowPlacement(detachedTabPlacementKey(tabId.value)) : null;
    if (remembered) {
      const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/dpi");
      await win.setSize(new LogicalSize(remembered.width, remembered.height));
      await win.setPosition(new LogicalPosition(remembered.x, remembered.y));
      return;
    }
    // 无显式位置且无记忆位置：锚定主窗口所在屏幕（预热 shell 创建于系统默认位置，
    // 双屏且主窗口在副屏时窗口会出现在主显示器上）。
    const [size, scale] = await Promise.all([win.outerSize(), win.scaleFactor()]);
    const anchored = await resolveMainWindowAnchoredPosition(size.width / scale, size.height / scale);
    if (anchored) {
      const { LogicalPosition } = await import("@tauri-apps/api/dpi");
      await win.setPosition(new LogicalPosition(anchored.x, anchored.y));
    }
  } catch (error) {
    console.error("[detached-tab] place window failed", error);
  }
}

/** 销毁本窗口（跳过 onCloseRequested，程序性关闭的确认通道；失败仅记日志）。 */
async function destroyWindow() {
  try {
    const win = await currentWindow();
    await win.destroy();
  } catch (error) {
    console.error("[detached-tab] destroy window failed", error);
  }
}

/** 从 registry 快照装载页签到本窗口，渲染完成后显示窗口，并向主窗口回执 adopt 结果。 */
async function adoptTab(targetTabId: string, x?: number, y?: number): Promise<boolean> {
  const entry = readDetachedTabEntry(targetTabId);
  const restored = entry ? restoreDetachedTabSnapshot(entry.snapshot) : null;
  if (!entry || !restored) {
    console.error("[detached-tab] adopt failed", targetTabId, entry ? "restore snapshot failed" : "registry entry missing");
    // 回执失败原因并自毁：主窗口据此回滚（不移除页签），本窗口不滞留为空壳。
    await sendDetachedPanelMessageOrThrow(MAIN_WINDOW_LABEL, { action: "detached-tab-adopt-failed", tabId: targetTabId, reason: entry ? "restore-failed" : "entry-missing" }).catch((error) => console.error("[detached-tab] send adopt-failed ack failed", error));
    await destroyWindow();
    return false;
  }
  // DataGrid 待保存状态先于页签落地（grid 挂载/结果读回后按 cacheKey 取回）。
  stageDataGridPendingSnapshotsForTab(targetTabId, entry.snapshot.dataGridPending);
  tabId.value = targetTabId;
  queryStore.adoptDetachedTab(restored);
  lastResultStamp = restored.resultCacheKey ? resultPayloadStamp(restored) : "";
  // 结果统一从 IndexedDB 结果缓存读回（含 data 页签：分离不丢已加载的数据）。
  if (restored.resultEvicted && restored.resultCacheKey) void queryStore.reloadEvictedTab(restored.id);
  await placeWindow(x, y);
  await nextTick();
  windowReady.value = true;
  // 等首帧渲染完成再显示，避免白屏。
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try {
    const win = await currentWindow();
    await win.show();
    await win.setFocus();
  } catch (error) {
    console.error("[detached-tab] show window failed", error);
  }
  // adopt 完成回执：主窗口收到后才 finalize 移除主窗口页签；发送失败说明主窗口不可达，自毁避免孤儿窗口。
  try {
    await sendDetachedPanelMessageOrThrow(MAIN_WINDOW_LABEL, { action: "detached-tab-adopted", tabId: targetTabId });
  } catch (error) {
    console.error("[detached-tab] send adopted ack failed", error);
    await destroyWindow();
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 合并回主窗口（dock）与统一关闭路径
// ---------------------------------------------------------------------------

let dockRequested = false;

async function dockToMainWindow() {
  if (!tabId.value || dockRequested) return;
  dockRequested = true;
  try {
    await syncSnapshotNow();
    await requestDockDetachedTab(tabId.value);
    // 主窗口收到 dock 消息后恢复页签并关闭本窗口。
  } catch (error) {
    dockRequested = false;
    console.error("[detached-tab] dock failed", error);
  }
}

/**
 * 页签已在 store 中关闭（事务回滚/会话清理由 closeTab 完成）后的窗口收尾：
 * 移除 registry 快照（避免下次启动被当作崩溃残留复活），随后销毁窗口。
 */
async function finalizeWindowClose() {
  if (tabId.value) removeDetachedTabEntry(tabId.value);
  await destroyWindow();
}

/**
 * 统一关闭入口——标题栏 X 与系统级关闭（Alt+F4/任务栏关闭/macOS 红绿灯）都走这里，
 * 复用主窗口 dirty-tab 策略（queryStore.closeTab）：脏页签先弹未保存确认
 * （保存/放弃/取消），干净页签直接关闭。确认关闭才移除 registry 并销毁窗口。
 */
function requestCloseWindow() {
  // dock 进行中：窗口即将由主窗口关闭，不重复处理。
  if (dockRequested) return;
  const tabValue = tab.value;
  if (!tabValue) {
    // 无页签（待命 shell）：直接销毁。
    void finalizeWindowClose();
    return;
  }
  // 孤儿窗口（registry 已被主窗口回滚/超时清理）：页签仍归主窗口所有，
  // 本窗口静默关闭（后端会话/事务经 closeTab 清理），不再弹未保存确认。
  if (tabId.value && !readDetachedTabEntry(tabId.value)) {
    queryStore.closeTab(tabValue.id, { force: true });
    void finalizeWindowClose();
    return;
  }
  queryStore.closeTab(tabValue.id); // 脏页签仅触发未保存确认弹窗；干净页签同步移除
  if (!tab.value) void finalizeWindowClose();
}

/** 关闭确认「取消」：仅关弹窗，窗口与页签保持不动。 */
function onCloseConfirmCancel() {
  queryStore.cancelClosePendingTab();
}

/** 关闭确认「放弃修改」：强制关闭页签（丢弃未保存内容）并销毁窗口。 */
async function onCloseConfirmDiscard() {
  const id = queryStore.pendingCloseTabId;
  queryStore.forceClosePendingTab();
  if (id && !queryStore.tabs.some((item) => item.id === id)) await finalizeWindowClose();
}

/** 关闭确认「保存」：按页签类型走对应保存路径，保存成功后关闭窗口；失败/取消则中止关闭。 */
async function onCloseConfirmSave() {
  const id = queryStore.saveAndClosePendingTab();
  if (!id) return;
  const tabValue = queryStore.tabs.find((item) => item.id === id);
  if (!tabValue) return;
  if (await saveTabForClose(tabValue)) {
    queryStore.closeTab(id, { force: true });
    await finalizeWindowClose();
  }
}

// ---------------------------------------------------------------------------
// 保存（SQL 库 / 外部文件 / 对象源码）
// ---------------------------------------------------------------------------

const showSaveSqlDialog = ref(false);
const saveSqlName = ref("");
/** 关闭确认「保存」且无已存 SQL 文件时置位：保存对话框保存成功后继续关闭窗口。 */
let closeAfterSaveRequested = false;

/** 保存当前页签。返回 saved/failed/dialog（dialog = 已打开保存对话框，结果待用户确认）。 */
async function saveActiveSql(options: { closeAfterSave?: boolean } = {}): Promise<"saved" | "failed" | "dialog"> {
  const tabValue = tab.value;
  if (!tabValue) return "failed";
  if (tabValue.objectSource) {
    return (await saveActiveObjectSource(tabValue)) ? "saved" : "failed";
  }
  if (tabValue.externalSqlPath) {
    return (await saveExternalSqlTab(tabValue)) ? "saved" : "failed";
  }
  const existing = tabValue.savedSqlId ? savedSqlStore.getFile(tabValue.savedSqlId) : undefined;
  if (existing) {
    try {
      const target = savedSqlDefaultTargetForWrite({ connectionId: tabValue.connectionId, database: tabValue.database, schema: tabValue.schema, catalog: tabValue.catalog });
      const updated = await savedSqlStore.saveFile({
        id: existing.id,
        connectionId: target.connectionId,
        folderId: existing.folderId,
        name: existing.name,
        database: target.database,
        catalog: target.catalog,
        schema: target.schema,
        sql: tabValue.sql,
      });
      queryStore.linkSavedSql(tabValue.id, updated.id, updated.name);
      queryStore.markTabClean(tabValue);
      toast(t("savedSql.saved"), 2000);
      void broadcastDetachedPanelMessage({ action: "saved-sql-changed" });
      return "saved";
    } catch (error) {
      toast(t("savedSql.saveFailed", { message: savedSqlErrorMessage(error, t) }), 5000);
      return "failed";
    }
  }
  closeAfterSaveRequested = options.closeAfterSave === true;
  saveSqlName.value = (tabValue.title.trim() || "query").replace(/\s+/g, "_") + ".sql";
  showSaveSqlDialog.value = true;
  return "dialog";
}

/** 关闭确认中的「保存」：结构页签走结构编辑器保存，其余走 SQL 保存。返回是否已保存（可继续关闭）。 */
async function saveTabForClose(tabValue: QueryTab): Promise<boolean> {
  if (tabValue.mode === "structure") {
    return (await contentAreaRef.value?.applyTableStructureChanges?.()) === true;
  }
  return (await saveActiveSql({ closeAfterSave: true })) === "saved";
}

/** 保存对话框关闭（含取消）：中止「保存后关闭」。 */
function onSaveSqlDialogOpenChange(open: boolean) {
  showSaveSqlDialog.value = open;
  if (!open) closeAfterSaveRequested = false;
}

async function confirmSaveSqlToLibrary() {
  const tabValue = tab.value;
  const name = saveSqlName.value.trim();
  if (!tabValue || !tabValue.sql.trim() || !name) return;
  try {
    const target = savedSqlDefaultTargetForWrite({ connectionId: tabValue.connectionId, database: tabValue.database, schema: tabValue.schema, catalog: tabValue.catalog });
    const saved = await savedSqlStore.saveFile({
      id: tabValue.savedSqlId,
      connectionId: target.connectionId,
      name,
      database: target.database,
      catalog: target.catalog,
      schema: target.schema,
      sql: tabValue.sql,
    });
    queryStore.linkSavedSql(tabValue.id, saved.id, saved.name);
    queryStore.markTabClean(tabValue);
    showSaveSqlDialog.value = false;
    toast(t("savedSql.saved"), 2000);
    void broadcastDetachedPanelMessage({ action: "saved-sql-changed" });
    // 关闭确认链路：保存成功后继续关闭窗口。
    if (closeAfterSaveRequested) {
      closeAfterSaveRequested = false;
      queryStore.closeTab(tabValue.id, { force: true });
      await finalizeWindowClose();
    }
  } catch (error) {
    toast(t("savedSql.saveFailed", { message: savedSqlErrorMessage(error, t) }), 5000);
  }
}

async function saveExternalSqlTab(tabValue: QueryTab): Promise<boolean> {
  if (!tabValue.externalSqlPath || !isTauriRuntime()) return false;
  try {
    const result = await api.writeExternalSqlFile(tabValue.externalSqlPath, tabValue.sql, {});
    if (result.kind !== "written") {
      toast(t("externalSqlFile.checkFailed", { message: t("externalSqlFile.changedAgain") }), 5000);
      return false;
    }
    rememberExternalSqlFileTarget(tabValue.externalSqlPath, { connectionId: tabValue.connectionId, database: tabValue.database, catalog: tabValue.catalog });
    queryStore.markExternalSqlFileSaved(tabValue.id, result.version);
    toast(t("savedSql.saved"), 2000);
    return true;
  } catch (error: any) {
    toast(t("toolbar.sqlSaveFailed", { message: error?.message || String(error) }), 5000);
    return false;
  }
}

async function saveActiveObjectSource(tabValue: QueryTab): Promise<boolean> {
  const connection = connectionStore.getConfig(tabValue.connectionId);
  const source = tabValue.objectSource;
  if (!connection || !source) return false;
  try {
    const databaseType = effectiveDatabaseTypeForConnection(connection) ?? connection.db_type;
    const statements = await buildExecutableObjectSourceStatements({
      databaseType,
      objectType: source.objectType,
      schema: source.schema || tabValue.schema || tabValue.database,
      name: source.name,
      source: tabValue.sql,
    });
    const executable = statements.filter((sql) => sql.trim()).join(";\n");
    if (executable.trim()) {
      const saved = await executeWithProductionSqlGuard({
        connection,
        database: tabValue.database,
        sql: executable,
        source: t("production.sourceObjectSource"),
        execute: async () => {
          await executeObjectSourceSave(tabValue.connectionId, tabValue.database, databaseType, statements, source.schema || tabValue.schema);
          return true;
        },
      });
      if (!saved) return false;
    } else {
      await executeObjectSourceSave(tabValue.connectionId, tabValue.database, databaseType, statements, source.schema || tabValue.schema);
    }
    queryStore.markTabClean(tabValue);
    toast(t("objects.sourceSaved"), 2000);
    return true;
  } catch (error: any) {
    toast(t("objects.sourceSaveFailed", { message: error?.message || String(error) }), 5000);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 导航类动作：转发主窗口（表数据/DDL/结构/源码在主窗口打开）
// ---------------------------------------------------------------------------

function forwardNavigate(kind: "data" | "ddl" | "structure" | "source", table: SqlObjectNavigationTarget & { catalog?: string; tableType?: string }, initialEditing?: boolean) {
  const tabValue = tab.value;
  if (!tabValue) return;
  const target: NavigationTarget = {
    connectionId: tabValue.connectionId,
    database: table.database || tabValue.database,
    catalog: table.catalog ?? tabValue.tableMeta?.catalog ?? tabValue.catalog,
    schema: table.schema || tabValue.schema,
    tableName: table.name,
    tableType: table.tableType ?? (table.type ? sqlObjectNavigationTableType(table) : undefined),
  };
  void sendDetachedPanelMessage(MAIN_WINDOW_LABEL, {
    action: "detached-tab-navigate",
    kind,
    target,
    objectType: sqlObjectNavigationSourceKind(table),
    sourceName: table.name,
    sourceSchema: table.schema || tabValue.schema || tabValue.database,
    signature: table.signature,
    initialEditing,
  });
}

function onStructureEditorSaved(commentChanged: boolean) {
  const tabValue = tab.value;
  if (!tabValue) return;
  const tableName = tabValue.structureTableName || "";
  // 本窗口缓存先失效；主窗口侧的对象树/数据页签刷新由消息驱动。
  invalidateTableMetadataCache({ connectionId: tabValue.connectionId, database: tabValue.database, tableName });
  connectionStore.invalidateCompletionTableCache(tabValue.connectionId, tabValue.database, tableName, tabValue.schema, tabValue.catalog);
  void sendDetachedPanelMessage(MAIN_WINDOW_LABEL, {
    action: "detached-tab-structure-saved",
    connectionId: tabValue.connectionId,
    database: tabValue.database,
    catalog: tabValue.catalog,
    schema: tabValue.schema,
    tableName,
    commentChanged,
  });
}

/** 结构编辑器内"关闭"：合并回主窗口（草稿随快照转移，主窗口可继续编辑）。 */
function onStructureEditorClose() {
  void dockToMainWindow();
}

// 工具箱对话框（数据导入/生成）由主窗口对话框层承载：子窗口清除本地源并转发主窗口打开。
watch(
  () => connectionStore.tableImportSource,
  (source) => {
    if (!source) return;
    connectionStore.tableImportSource = null;
    void sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: "object-browser-open-tool", tool: "tableImport", connectionId: source.connectionId, database: source.database, schema: source.schema, tableName: source.tableName });
  },
);
watch(
  () => connectionStore.tableDataGenerateSource,
  (source) => {
    if (!source) return;
    connectionStore.tableDataGenerateSource = null;
    void sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: "object-browser-open-tool", tool: "tableDataGenerate", connectionId: source.connectionId, database: source.database, schema: source.schema, tableName: source.tableName });
  },
);

// ---------------------------------------------------------------------------
// EditorToolbar 事件（连接/数据库/catalog/schema 切换，本窗口本地）
// ---------------------------------------------------------------------------

async function changeActiveConnection(connectionId: string) {
  const tabValue = tab.value;
  if (!tabValue) return;
  const connection = connectionStore.getConfig(connectionId);
  if (!connection) return;
  queryStore.updateConnection(tabValue.id, connectionId, resolveDefaultDatabase(connection, []));
  if (tabValue.externalSqlPath) rememberExternalSqlFileTarget(tabValue.externalSqlPath, { connectionId, database: tabValue.database, catalog: undefined });
  connectionStore.activeConnectionId = connectionId;
  try {
    await connectionStore.ensureConnected(connectionId);
    const options = await getDatabaseOptions(connectionId);
    const database = resolveDefaultDatabase(connection, options);
    queryStore.updateDatabase(tabValue.id, database);
    if (tabValue.externalSqlPath) rememberExternalSqlFileTarget(tabValue.externalSqlPath, { connectionId, database, catalog: undefined });
    if (connection.default_schema || connection.db_type === "oracle") {
      try {
        const orderedSchemas = connection.default_schema ? [] : await api.listSchemas(connectionId, database);
        const schema = schemaAfterConnectionSwitch(connection.db_type, orderedSchemas, connection.default_schema);
        if (schema && tab.value?.id === tabValue.id && tab.value.connectionId === connectionId) queryStore.updateSchema(tabValue.id, schema);
      } catch {
        // schema 元数据失败不影响连接切换本身。
      }
    }
  } catch (error: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, error) }), 5000);
  }
}

function changeActiveDatabase(database: string) {
  const tabValue = tab.value;
  if (!tabValue) return;
  queryStore.updateDatabase(tabValue.id, database);
  if (tabValue.externalSqlPath) rememberExternalSqlFileTarget(tabValue.externalSqlPath, { connectionId: tabValue.connectionId, database, catalog: tabValue.catalog });
}

function changeActiveCatalog(catalog: string | undefined, database: string) {
  const tabValue = tab.value;
  if (!tabValue) return;
  queryStore.updateCatalog(tabValue.id, catalog, database);
  if (tabValue.externalSqlPath) rememberExternalSqlFileTarget(tabValue.externalSqlPath, { connectionId: tabValue.connectionId, database, catalog });
}

function changeActiveSchema(schema: string | undefined) {
  const tabValue = tab.value;
  if (tabValue) queryStore.updateSchema(tabValue.id, schema);
}

// ---------------------------------------------------------------------------
// 窗口生命周期 / 消息总线 / 设置同步
// ---------------------------------------------------------------------------

let unlistenMessages: (() => void) | null = null;
const unlistenWindowEvents: Array<() => void> = [];
let placementSaveTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePlacementSave() {
  if (!tabId.value) return;
  if (placementSaveTimer) clearTimeout(placementSaveTimer);
  placementSaveTimer = setTimeout(() => {
    placementSaveTimer = null;
    if (tabId.value) void saveDetachedWindowPlacement(detachedTabPlacementKey(tabId.value));
  }, 300);
}

/** 应用 UI 缩放到本窗口（不回写设置存储，避免与主窗口保存竞态）。 */
async function applyUiScaleToWindow(scale: number) {
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(scale);
    window.dispatchEvent(new CustomEvent("dbx:ui-scale-applied", { detail: { scale } }));
  } catch (error) {
    console.warn("[detached-tab] apply ui scale failed", { scale, error });
  }
}

watch(
  () => settingsStore.editorSettings.uiScale,
  (scale) => {
    void applyUiScaleToWindow(scale);
  },
  { immediate: true },
);

async function applySyncedAppSettings(uiScale?: number) {
  reloadThemeFromStorage();
  void applyLocaleFromStorage().catch((error) => console.error("[detached-tab] sync locale failed", error));
  if (typeof uiScale === "number") void applyUiScaleToWindow(uiScale);
  await settingsStore.initEditorSettings().catch(() => {});
}

async function toggleWindowMaximize(event: MouseEvent) {
  if ((event.target as HTMLElement | null)?.closest("button")) return;
  try {
    const win = await currentWindow();
    await win.toggleMaximize();
  } catch (error) {
    console.error("[detached-tab] toggle maximize failed", error);
  }
}

onMounted(async () => {
  applyTheme();
  await settingsStore.initEditorSettings().catch(() => {});
  const connectionInit = connectionStore.initFromDisk().catch((error) => console.error("[detached-tab] init connections failed", error));
  void savedSqlStore.initFromStorage().catch((error) => console.error("[detached-tab] init saved sql failed", error));

  unlistenMessages = await listenDetachedPanelMessages((message) => {
    if (message.action === "detached-tab-assign") {
      void adoptTab(message.tabId, message.x, message.y);
    } else if (message.action === "detached-tab-dock-failed") {
      // 主窗口找不到 registry 条目（异常清理/存储清空）：复位 dock 状态，恢复窗口可用性
      // （标题栏 X/系统关闭在 dockRequested 期间被屏蔽）。
      if (message.tabId === tabId.value) dockRequested = false;
    } else if (message.action === "app-settings-sync") {
      void applySyncedAppSettings(message.uiScale);
    }
  });

  if (isTauriRuntime()) {
    const win = await currentWindow();
    unlistenWindowEvents.push(await win.onMoved(schedulePlacementSave), await win.onResized(schedulePlacementSave));
    // 系统级关闭路径（Alt+F4/任务栏关闭/macOS 红绿灯）与标题栏 X 统一走 requestCloseWindow
    // （复用 dirty-tab 确认策略；确认关闭才移除 registry 并销毁窗口）。
    // dock 合并时主窗口经 close() 关闭本窗口——dockRequested 放行。
    unlistenWindowEvents.push(
      await win.onCloseRequested((event) => {
        if (dockRequested) return;
        event.preventDefault();
        requestCloseWindow();
      }),
    );
  }

  if (windowMode?.kind === "tab") {
    // 慢路径直开：连接配置就绪后再装载（表数据/对象浏览器依赖连接信息）。
    await connectionInit;
    await adoptTab(windowMode.tabId);
  } else {
    // 预热 shell：待命隐藏，广播就绪（主窗口记录可复用窗口）。
    await connectionInit;
    const win = await currentWindow();
    void broadcastDetachedPanelMessage({ action: "detached-tab-shell-ready", label: win.label });
  }
});

onBeforeUnmount(() => {
  unlistenMessages?.();
  unlistenMessages = null;
  for (const unlisten of unlistenWindowEvents) unlisten();
  unlistenWindowEvents.length = 0;
  if (placementSaveTimer) clearTimeout(placementSaveTimer);
  placementSaveTimer = null;
  if (snapshotSyncTimer) clearTimeout(snapshotSyncTimer);
  snapshotSyncTimer = null;
  // 关闭前兜底：最终快照 + 位置保存。
  void syncSnapshotNow();
  if (tabId.value) void saveDetachedWindowPlacement(detachedTabPlacementKey(tabId.value));
});
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <div class="h-screen w-screen overflow-hidden bg-background text-foreground">
      <div v-if="tab" class="flex h-full min-h-0 flex-col" v-show="windowReady">
        <div class="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/20 px-3" :class="{ 'pl-20': isMac }" data-tauri-drag-region="deep" @dblclick="toggleWindowMaximize">
          <component :is="tabIcon(tab)" class="h-3.5 w-3.5 shrink-0 text-amber-500 dark:text-amber-400" />
          <span class="min-w-0 flex-1 truncate text-xs font-medium" :title="displayTitle">{{ displayTitle }}</span>
          <DetachedWindowControls v-if="!isMac" />
          <Button variant="ghost" size="icon" class="h-5 w-5" :title="t('panelDetach.dock')" :aria-label="t('panelDetach.dock')" @click="dockToMainWindow">
            <PictureInPicture2 class="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" class="h-5 w-5" :aria-label="t('common.close')" :title="t('common.close')" @click="requestCloseWindow">
            <X class="h-3 w-3" />
          </Button>
        </div>
        <EditorToolbar
          v-if="tab.mode === 'query'"
          :active-tab="tab"
          :active-connection="activeConnection"
          :executable-sql="executableSql"
          :explain-mode="explainMode"
          :block-dangerous-redis-commands="blockDangerousRedisCommands"
          :sql-keyword-case="settingsStore.editorSettings.sqlFormatter.keywordCase"
          :auto-commit="tab.autoCommit ?? true"
          :txn-session-id="tab.txnSessionId"
          :txn-auto-rolled-back="tab.txnAutoRolledBack"
          @update:explain-mode="(m: 'explain' | 'autotrace') => (explainMode = m)"
          @update:block-dangerous-redis-commands="(v: boolean) => (blockDangerousRedisCommands = v)"
          @update:auto-commit="(v: boolean) => tab && queryStore.setAutoCommit(tab.id, v)"
          @commit="tab && queryStore.commitTransaction(tab.id)"
          @rollback="tab && queryStore.rollbackTransaction(tab.id)"
          @dismiss-txn-rolled-back="tab && (tab.txnAutoRolledBack = false)"
          @execute="requestActiveEditorExecute()"
          @multi-execute="toast(t('panelDetach.multiExecuteUnsupported'), 3000)"
          @cancel="cancelActiveExecution()"
          @explain="tryExplain()"
          @format-sql="formatActiveSql"
          @compress-sql="compressActiveSql"
          @toggle-sql-keyword-case="toggleSqlKeywordCase"
          @save-sql="void saveActiveSql()"
          @open-sql="void sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: 'detached-tab-open-sql-file' })"
          @import-result-archive="void sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: 'detached-tab-import-result-archive' })"
          @paste-sql-in-condition="contentAreaRef?.pasteClipboardAsSqlInCondition()"
          @change-connection="changeActiveConnection"
          @change-database="changeActiveDatabase"
          @change-catalog="changeActiveCatalog"
          @change-schema="changeActiveSchema"
          @set-default-database="tab && tab.connectionId && tab.database && !tab.catalog && connectionStore.setDefaultDatabase(tab.connectionId, tab.database)"
          @clear-default-database="tab && tab.connectionId && connectionStore.clearDefaultDatabase(tab.connectionId)"
        />
        <ContentArea
          ref="contentAreaRef"
          :key="tab.id"
          :active-tab="tab"
          :active-connection="activeConnection"
          :executable-sql="executableSql"
          :active-output-view="activeOutputView"
          :format-sql-request="formatSqlRequest"
          :compress-sql-request="compressSqlRequest"
          :selected-sql="selectedSql"
          :cursor-pos="cursorPos"
          :block-dangerous-redis-commands="blockDangerousRedisCommands"
          @update:active-output-view="activeOutputView = $event"
          @fix-with-ai="(errorMessage: string) => void sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: 'detached-tab-ai-fix', errorMessage })"
          @send-selection-to-ai="(sql: string) => void sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: 'detached-tab-ai-set-prompt', text: sql })"
          @execute="tryExecute($event as SqlExecutionOverride)"
          @execute-in-new-result-tab="tryExecuteInNewResultTab($event as SqlExecutionOverride)"
          @cancel="cancelActiveExecution()"
          @explain="tryExplain()"
          @editor-update="(id: string, v: string) => queryStore.updateSql(id, v)"
          @editor-selection-change="(v: string) => (selectedSql = v)"
          @editor-cursor-change="(p: number) => (cursorPos = p)"
          @editor-viewport-change="(id: string, viewport: { scrollTop: number; scrollLeft: number }) => queryStore.updateEditorViewport(id, viewport)"
          @editor-selection-state-change="(id: string, selection: { anchor: number; head: number }) => queryStore.updateEditorSelection(id, selection)"
          @format-error="toast(t('toolbar.formatSqlFailed'))"
          @save-sql="void saveActiveSql()"
          @reload="(sql, searchText, whereInput, orderBy, limit, offset, intent) => onReloadData(sql, searchText, whereInput, orderBy, limit, offset, intent)"
          @paginate="onPaginate"
          @sort="onSort"
          @execute-sql="onExecuteSql"
          @click-table="(target: SqlObjectNavigationTarget) => forwardNavigate('data', target)"
          @view-table-data="(target: SqlObjectNavigationTarget) => forwardNavigate('data', target)"
          @view-table-ddl="(target: SqlObjectNavigationTarget) => forwardNavigate('ddl', target)"
          @edit-table-structure="(target: SqlObjectNavigationTarget) => forwardNavigate('structure', target)"
          @open-object-source="(target: SqlObjectNavigationTarget, initialEditing: boolean) => forwardNavigate('source', target, initialEditing)"
          @open-object-table="(target: { tableName: string; schema?: string; tableType?: string; catalog?: string }) => forwardNavigate('data', { name: target.tableName, schema: target.schema, catalog: target.catalog, tableType: target.tableType })"
          @object-schema-change="(schema: string | undefined) => tab && queryStore.updateSchema(tab.id, schema)"
          @object-browser-viewport-change="(id: string, viewport: any) => queryStore.updateObjectBrowserViewport(id, viewport)"
          @structure-editor-saved="onStructureEditorSaved"
          @structure-editor-close="onStructureEditorClose"
          @open-settings="(initialTab?: string, initialSection?: string) => void sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: 'detached-tab-open-settings', initialTab, initialSection })"
          @open-connection-settings="(connectionId: string, initialTab: 'advanced') => void sendDetachedPanelMessage(MAIN_WINDOW_LABEL, { action: 'detached-tab-open-connection-settings', connectionId, initialTab })"
        />
      </div>

      <DangerConfirmDialog
        v-if="showDangerDialog"
        :open="showDangerDialog"
        :sql="dangerSql"
        :show-suppress-toggle="activeConnection?.db_type !== 'redis'"
        :suppress-future-prompts="suppressDangerConfirm"
        @update:open="showDangerDialog = $event"
        @update:suppress-future-prompts="suppressDangerConfirm = $event"
        @confirm="onDangerConfirm"
      />
      <DangerConfirmDialog
        v-if="productionSafetyStore.pending"
        :open="true"
        :title="t('production.confirmTitle')"
        :message="t('production.confirmMessage')"
        :details-text="t('production.confirmDetails', { connection: productionSafetyStore.pending.connectionName || '-', database: productionSafetyStore.pending.productionDatabases?.join(', ') || productionSafetyStore.pending.database || '-', source: productionSafetyStore.pending.source || '-' })"
        :sql="productionSafetyStore.pending.sql"
        :confirm-label="t('production.confirmAction')"
        :close-on-confirm="false"
        @update:open="(open: boolean) => !open && productionSafetyStore.cancel()"
        @confirm="productionSafetyStore.confirm()"
      />
      <DangerConfirmDialog
        v-if="sqlExecutionDangerStore.pending"
        :open="true"
        :title="t('multiDbExecute.dangerTitle')"
        :message="sqlExecutionDangerStore.pending.kind === 'redis' ? t('dangerDialog.redisCommandMessage') : t('dangerDialog.message')"
        :details-text="[sqlExecutionDangerStore.pending.targetLabel || sqlExecutionDangerStore.pending.connectionName, sqlExecutionDangerStore.pending.database].filter(Boolean).join('\n')"
        :sql="sqlExecutionDangerStore.pending.sql"
        :confirm-label="t('multiDbExecute.dangerConfirm')"
        :show-suppress-toggle="false"
        :close-on-confirm="false"
        @update:open="(open: boolean) => !open && sqlExecutionDangerStore.cancel()"
        @confirm="sqlExecutionDangerStore.confirm()"
      />
      <SqlParameterDialog
        v-if="showSqlParameterDialog"
        :open="showSqlParameterDialog"
        :sql="sqlParameterSourceSql"
        :parameters="sqlParameterNames"
        :database-type="sqlParameterDatabaseType"
        :enabled-syntaxes="sqlParameterEnabledSyntaxes"
        @update:open="showSqlParameterDialog = $event"
        @execute="onSqlParametersConfirm"
      />
      <Dialog :open="showSaveSqlDialog" @update:open="onSaveSqlDialogOpenChange">
        <DialogContent class="max-w-md">
          <DialogHeader>
            <DialogTitle>{{ t("savedSql.saveToLibrary") }}</DialogTitle>
          </DialogHeader>
          <Input v-model="saveSqlName" :placeholder="t('savedSql.fileName')" @keydown.enter="confirmSaveSqlToLibrary" />
          <DialogFooter>
            <Button variant="outline" @click="onSaveSqlDialogOpenChange(false)">{{ t("common.cancel") }}</Button>
            <Button :disabled="!saveSqlName.trim()" @click="confirmSaveSqlToLibrary">{{ t("common.save") }}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <!-- 未保存关闭确认：复用主窗口 dirty-tab 策略（保存/放弃/取消），标题栏 X 与系统级关闭共用 -->
      <Dialog
        :open="queryStore.showCloseConfirm"
        @update:open="
          (open: boolean) => {
            if (!open) onCloseConfirmCancel();
          }
        "
      >
        <DialogContent class="min-w-0 sm:max-w-md">
          <DialogHeader>
            <DialogTitle class="flex items-center gap-2">
              <AlertTriangle class="h-5 w-5 text-amber-500" />
              {{ t("editor.unsavedChangesTitle") }}
            </DialogTitle>
          </DialogHeader>
          <div class="max-h-120 min-h-0 min-w-0 overflow-y-auto">
            <p class="wrap-anywhere text-sm text-muted-foreground">{{ t("editor.unsavedChangesMessage", { count: 1, title: displayTitle }) }}</p>
          </div>
          <DialogFooter class="min-w-0 sm:flex-wrap">
            <Button variant="outline" @click="onCloseConfirmCancel">{{ t("common.cancel") }}</Button>
            <Button variant="secondary" class="border-border" @click="onCloseConfirmDiscard">{{ t("editor.discardChanges") }}</Button>
            <Button @click="onCloseConfirmSave">{{ t("savedSql.save") }}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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

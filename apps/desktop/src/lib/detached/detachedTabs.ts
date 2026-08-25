/**
 * 主窗口页签分离为独立子窗口的通用机制。
 *
 * 模型：所有权转移。分离时主窗口把页签快照（serializeOpenTabs 格式，结果数据经
 * IndexedDB 结果缓存共享）写入 localStorage registry 并关闭主窗口页签；子窗口从
 * registry 恢复快照后全权持有该页签（本地执行、本地编辑）。合并（dock）时子窗口
 * 写回最新快照，主窗口恢复页签并关闭子窗口。
 *
 * registry 同时充当崩溃保护：主窗口退出时子窗口随之销毁，registry 中未 dock 的
 * 页签在下次启动时恢复回主窗口。
 *
 * 延迟优化：主窗口空闲时预热一个隐藏 shell 子窗口（完成前端 bundle 加载与 store
 * 初始化），分离时直接分配页签并 show，省掉 webview 冷启动开销。
 */
import { safeLocalStorageGet, safeLocalStorageKeysWithPrefix, safeLocalStorageRemove, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { DETACHED_TAB_PARAM, DETACHED_TAB_SHELL_PARAM } from "@/lib/detached/detachedWindowContext";
import { MAIN_WINDOW_LABEL, loadDetachedWindowPlacement, openDetachedWebviewWindow, sendDetachedPanelMessageOrThrow } from "@/lib/detached/detachedPanel";
import { restoreOpenTabsPayload, serializeOpenTabs, type SavedOpenTab } from "@/lib/app/openTabsPersistence";
import type { SerializedDataGridPendingSnapshot } from "@/composables/useDataGridEditor";
import type { QueryTab } from "@/types/database";

// ---------------------------------------------------------------------------
// 页签快照（SavedOpenTab + 分离场景需要往返的额外字段）
// ---------------------------------------------------------------------------

/**
 * 分离页签快照：在 open-tabs 持久化格式之上，附加结构编辑草稿、编辑器视口、
 * DataGrid 待保存状态等 open-tabs 持久化不覆盖、但分离/合并往返必须保留的字段。
 */
export type DetachedTabSnapshot = SavedOpenTab & {
  structureDraft?: QueryTab["structureDraft"];
  tableInfoTab?: QueryTab["tableInfoTab"];
  editorViewport?: QueryTab["editorViewport"];
  editorSelection?: QueryTab["editorSelection"];
  /** DataGrid 未保存的编辑状态（newRows/dirtyRows/deletedRows 等，按 cacheKey 分组）。 */
  dataGridPending?: Record<string, SerializedDataGridPendingSnapshot>;
};

/** 序列化页签为分离快照（结果数据不内嵌，经 resultCacheKey 引用 IndexedDB 结果缓存）。 */
export function serializeDetachedTab(tab: QueryTab): DetachedTabSnapshot {
  const saved = serializeOpenTabs([tab])[0] as DetachedTabSnapshot;
  if (tab.structureDraft) saved.structureDraft = tab.structureDraft;
  if (tab.tableInfoTab) saved.tableInfoTab = tab.tableInfoTab;
  if (tab.editorViewport) saved.editorViewport = { ...tab.editorViewport };
  if (tab.editorSelection) saved.editorSelection = { ...tab.editorSelection };
  // 结果已落缓存的页签（含 data 页签）：强制快照携带 cacheKey + evicted 标记，
  // 使恢复端走缓存读回路径（serializeOpenTabs 仅在 tab.resultEvicted 时携带，
  // 且对 data 页签剔除——分离场景与重启恢复不同，结果需要在窗口间无损转移）。
  if (tab.resultCacheKey) {
    saved.resultCacheKey = tab.resultCacheKey;
    saved.resultEvicted = true;
  }
  return saved;
}

/** 从分离快照重建页签（瞬时执行态由 restoreOpenTabsPayload 剥离；额外字段在此合入）。 */
export function restoreDetachedTabSnapshot(snapshot: DetachedTabSnapshot): QueryTab | null {
  const restored = restoreOpenTabsPayload({ tabs: [snapshot], activeTabId: snapshot.id }).tabs[0];
  if (!restored) return null;
  if (snapshot.structureDraft) restored.structureDraft = snapshot.structureDraft;
  if (snapshot.tableInfoTab) restored.tableInfoTab = snapshot.tableInfoTab;
  if (snapshot.editorViewport) restored.editorViewport = { ...snapshot.editorViewport };
  if (snapshot.editorSelection) restored.editorSelection = { ...snapshot.editorSelection };
  // data 页签的结果缓存引用由 restoreOpenTabsPayload 剔除（重启恢复语义），分离场景补回。
  if (restored.mode === "data" && snapshot.resultCacheKey) {
    restored.resultCacheKey = snapshot.resultCacheKey;
    restored.resultEvicted = true;
    restored.resultCacheState = "disk";
  }
  return restored;
}

// ---------------------------------------------------------------------------
// 子窗口 URL 模式
// ---------------------------------------------------------------------------

/** 子窗口模式：直开指定页签（慢路径）或待命 shell（预热窗口）。 */
export type DetachedTabWindowMode = { kind: "tab"; tabId: string } | { kind: "shell" } | null;

/** 解析当前窗口 URL 中的分离页签参数（仅子窗口有）。 */
export function getDetachedTabModeFromLocation(): DetachedTabWindowMode {
  if (typeof window === "undefined") return null;
  const search = window.location?.search;
  if (!search) return null;
  const params = new URLSearchParams(search);
  const tabId = params.get(DETACHED_TAB_PARAM);
  if (tabId) return { kind: "tab", tabId };
  if (params.has(DETACHED_TAB_SHELL_PARAM)) return { kind: "shell" };
  return null;
}

function detachedTabUrl(tabId: string): string {
  return `index.html?${DETACHED_TAB_PARAM}=${encodeURIComponent(tabId)}`;
}

function detachedTabShellUrl(): string {
  return `index.html?${DETACHED_TAB_SHELL_PARAM}=1`;
}

// ---------------------------------------------------------------------------
// registry（localStorage，跨窗口共享；主窗口 localStorage 为权威）
//
// 按页签分 key 存储：主窗口（分离写入/dock 移除/启动清理）与子窗口（防抖同步快照）
// 都只读写各自页签的 key，避免单一 JSON map 的读-改-写在跨窗口并发下丢失整个条目
// （曾导致 dock 时主窗口读不到条目、子窗口 dockRequested 卡死、标题栏 X 失效）。
// 同一页签 key 上的写者序为 last-writer-wins（dock 时序：子窗口先同步快照再发消息，
// 主窗口随后读取并移除）；子窗口的防抖更新带「条目缺失则跳过」守卫，不会在主窗口
// 移除后复活幻影条目。
// ---------------------------------------------------------------------------

/** 旧版合并 registry key（仅用于启动时迁移到按页签分 key）。 */
const DETACHED_TABS_REGISTRY_KEY = "dbx-detached-tabs-registry";
const DETACHED_TAB_ENTRY_PREFIX = "dbx-detached-tab:";

const detachedTabEntryKey = (tabId: string) => `${DETACHED_TAB_ENTRY_PREFIX}${tabId}`;

export interface DetachedTabRegistryEntry {
  /** 页签快照（结果数据经 resultCacheKey 引用 IndexedDB 缓存）。 */
  snapshot: DetachedTabSnapshot;
  /** 当前持有该页签的子窗口 label。 */
  label: string;
  /** 页签显示标题（子窗口标题栏/registry 恢复展示用）。 */
  title: string;
  detachedAt: number;
  updatedAt: number;
}

function parseDetachedTabEntry(raw: string | null): DetachedTabRegistryEntry | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as DetachedTabRegistryEntry;
  } catch {
    return null;
  }
}

/** 旧版合并 registry（单 key JSON map）迁移为按页签分 key；幂等，启动恢复时调用。 */
function migrateLegacyDetachedTabsRegistry(): void {
  const raw = safeLocalStorageGet(DETACHED_TABS_REGISTRY_KEY);
  if (!raw) return;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [tabId, entry] of Object.entries(parsed as Record<string, unknown>)) {
        if (entry && typeof entry === "object") safeLocalStorageSet(detachedTabEntryKey(tabId), JSON.stringify(entry));
      }
    }
  } catch {
    // 损坏的旧格式直接丢弃（与旧版 readRegistry 的容错语义一致）。
  }
  safeLocalStorageRemove(DETACHED_TABS_REGISTRY_KEY);
}

/** 写入/更新页签的分离快照（子窗口防抖同步最新状态时复用）。 */
export function writeDetachedTabEntry(tabId: string, entry: DetachedTabRegistryEntry): void {
  safeLocalStorageSet(detachedTabEntryKey(tabId), JSON.stringify(entry));
}

/** 子窗口防抖同步：仅更新快照与 updatedAt，保留 label/title/detachedAt。条目缺失时跳过（不复活已 dock/回滚的条目）。 */
export function updateDetachedTabSnapshot(tabId: string, snapshot: DetachedTabSnapshot): void {
  const existing = readDetachedTabEntry(tabId);
  if (!existing) return;
  writeDetachedTabEntry(tabId, { ...existing, snapshot, updatedAt: Date.now() });
}

export function readDetachedTabEntry(tabId: string): DetachedTabRegistryEntry | null {
  return parseDetachedTabEntry(safeLocalStorageGet(detachedTabEntryKey(tabId)));
}

export function removeDetachedTabEntry(tabId: string): void {
  safeLocalStorageRemove(detachedTabEntryKey(tabId));
}

/** 列出全部分离中的页签（主窗口启动时恢复用）。 */
export function listDetachedTabEntries(): DetachedTabRegistryEntry[] {
  migrateLegacyDetachedTabsRegistry();
  const entries: DetachedTabRegistryEntry[] = [];
  for (const key of safeLocalStorageKeysWithPrefix(DETACHED_TAB_ENTRY_PREFIX)) {
    const entry = parseDetachedTabEntry(safeLocalStorageGet(key));
    if (entry) entries.push(entry);
  }
  return entries;
}

export function clearDetachedTabsRegistry(): void {
  for (const key of safeLocalStorageKeysWithPrefix(DETACHED_TAB_ENTRY_PREFIX)) {
    safeLocalStorageRemove(key);
  }
  safeLocalStorageRemove(DETACHED_TABS_REGISTRY_KEY);
}

// ---------------------------------------------------------------------------
// 子窗口管理（含预热 shell 池）
// ---------------------------------------------------------------------------

/** 每个页签窗口单独记忆位置/尺寸。 */
export function detachedTabPlacementKey(tabId: string): string {
  return `tab-${tabId}`;
}

function sanitizeWindowLabel(tabId: string): string {
  return tabId.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** 慢路径直开窗口 label（与页签绑定，保证单例）。 */
export function detachedTabWindowLabel(tabId: string): string {
  return `panel-tab-${sanitizeWindowLabel(tabId)}`;
}

interface WarmShellState {
  label: string;
  ready: boolean;
}

let warmShell: WarmShellState | null = null;
let warmShellCounter = 0;
let warmShellCreating = false;

/** shell 子窗口广播 ready 时由主窗口调用，标记预热窗口可用。 */
export function markWarmShellReady(label: string): void {
  if (warmShell && warmShell.label === label) warmShell.ready = true;
}

/** 主窗口空闲时确保有一个待命 shell 窗口（隐藏创建，bundle/store 已预热）。 */
export async function ensureWarmDetachedTabShell(): Promise<void> {
  if (!isTauriRuntime() || warmShell || warmShellCreating) return;
  warmShellCreating = true;
  const label = `panel-tab-warm-${++warmShellCounter}`;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) {
      warmShell = { label, ready: false };
      return;
    }
    const { isMacOS } = await import("@/lib/backend/platform");
    const win = new WebviewWindow(label, {
      url: detachedTabShellUrl(),
      title: "DBX",
      width: 1100,
      height: 720,
      minWidth: 480,
      minHeight: 360,
      ...(isMacOS() ? { titleBarStyle: "overlay" as const, hiddenTitle: true } : { decorations: false }),
      visible: false,
    });
    win.once("tauri://error", (error: unknown) => {
      console.error("[detached-tab] create warm shell failed", error);
      if (warmShell?.label === label) warmShell = null;
    });
    win.once("tauri://destroyed", () => {
      if (warmShell?.label === label) warmShell = null;
    });
    warmShell = { label, ready: false };
  } catch (error) {
    console.error("[detached-tab] create warm shell failed", error);
  } finally {
    warmShellCreating = false;
  }
}

// ---------------------------------------------------------------------------
// adopt 握手：子窗口恢复/渲染完成后回执，主窗口确认成功才 finalize（移除主窗口页签）
// ---------------------------------------------------------------------------

/** 子窗口 adopt 回执超时：覆盖冷启动 bundle 加载 + 连接配置初始化。 */
export const DETACHED_TAB_ADOPT_ACK_TIMEOUT_MS = 20_000;

interface PendingAdoptAck {
  label: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingAdoptAcks = new Map<string, PendingAdoptAck>();

function settleAdoptAck(tabId: string, sourceLabel: string | undefined, settle: (pending: PendingAdoptAck) => void): void {
  const pending = pendingAdoptAcks.get(tabId);
  if (!pending || (sourceLabel !== undefined && pending.label !== sourceLabel)) return;
  clearTimeout(pending.timer);
  pendingAdoptAcks.delete(tabId);
  settle(pending);
}

/** 子窗口 adopt 成功回执（App.vue 收到 detached-tab-adopted 时调用）。 */
export function resolveDetachedTabAdoptAck(tabId: string, sourceLabel: string): void {
  settleAdoptAck(tabId, sourceLabel, (pending) => pending.resolve());
}

/** 子窗口 adopt 失败/窗口创建失败/回滚中止时拒绝等待（幂等：无等待器时 no-op）。 */
export function rejectDetachedTabAdoptAck(tabId: string, reason: string, sourceLabel?: string): void {
  settleAdoptAck(tabId, sourceLabel, (pending) => pending.reject(new Error(reason)));
}

/**
 * 等待子窗口 adopt 回执。必须先于窗口创建/assign 发送注册——tauri://error 等失败
 * 可能早于 await 返回触发，后注册会漏掉快速失败退化为整段超时。
 */
export function waitForDetachedTabAdoptAck(tabId: string, label: string): Promise<void> {
  // 同一页签的重复分离：旧等待按取代失败处理，避免悬挂。
  settleAdoptAck(tabId, undefined, (pending) => pending.reject(new Error("superseded by a new detach attempt")));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingAdoptAcks.delete(tabId);
      reject(new Error(`adopt ack timeout after ${DETACHED_TAB_ADOPT_ACK_TIMEOUT_MS}ms`));
    }, DETACHED_TAB_ADOPT_ACK_TIMEOUT_MS);
    pendingAdoptAcks.set(tabId, { label, resolve, reject, timer });
  });
}

/** 是否有进行中的分离（adopt 回执未达）。 */
export function hasPendingDetachedTabAdoptAck(tabId: string): boolean {
  return pendingAdoptAcks.has(tabId);
}

export interface DetachedTabOpenPlacement {
  /** 分离瞬间的鼠标屏幕逻辑坐标（拖拽/右键触发位置）。 */
  x?: number;
  y?: number;
}

/**
 * 打开（或聚焦已存在的）页签子窗口。
 * 快照随调用写入 registry（子窗口从 registry 读取）；优先复用预热 shell（秒开），否则新建窗口（慢路径）。
 * 两种路径都等待子窗口 adopt 回执（含超时回滚），确认成功后调用方才 finalize 移除主窗口页签。
 * 返回窗口 label；失败时清理 registry 并关闭半成品窗口，返回 null（调用方负责恢复页签）。
 */
export async function openDetachedTabWindow(options: { tabId: string; title: string; snapshot: DetachedTabSnapshot; placement?: DetachedTabOpenPlacement }): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { tabId, title, snapshot } = options;
  const placement = options.placement ?? {};
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");

  // 分离进行中（adopt 回执未达）：避免重复创建/清理打挂前一次调用。
  if (hasPendingDetachedTabAdoptAck(tabId)) {
    console.warn("[detached-tab] detach already in flight", tabId);
    return null;
  }

  // 该页签已在分离中：聚焦既有窗口。
  const existingEntry = readDetachedTabEntry(tabId);
  if (existingEntry) {
    try {
      const existing = await WebviewWindow.getByLabel(existingEntry.label);
      if (existing) {
        if (await existing.isMinimized()) await existing.unminimize();
        await existing.setFocus();
        return existingEntry.label;
      }
    } catch (error) {
      console.error("[detached-tab] focus existing window failed", error);
    }
    // 窗口已不在（异常退出）：清理残留 registry，按新分离处理。
    removeDetachedTabEntry(tabId);
  }

  // 快路径：分配预热 shell（label 先确定，registry 写完再发 assign，最后等 adopt 回执）。
  if (warmShell?.ready) {
    const shell = warmShell;
    warmShell = null;
    const adoptAck = waitForDetachedTabAdoptAck(tabId, shell.label);
    try {
      const win = await WebviewWindow.getByLabel(shell.label);
      if (!win) throw new Error("warm shell window missing");
      writeDetachedTabEntry(tabId, { snapshot, label: shell.label, title, detachedAt: Date.now(), updatedAt: Date.now() });
      // 标题更新失败不阻断分配（标题仅影响任务栏/Alt+Tab 展示）。
      await win.setTitle(`DBX - ${title}`).catch((error) => console.warn("[detached-tab] set title failed", error));
      // assign 是关键握手消息：发送失败立即回滚，不等超时。
      await sendDetachedPanelMessageOrThrow(shell.label, { action: "detached-tab-assign", tabId, x: placement.x, y: placement.y });
      await adoptAck;
      // 预热窗口被消耗，后台补充下一个。
      void ensureWarmDetachedTabShell();
      return shell.label;
    } catch (error) {
      console.error("[detached-tab] assign warm shell failed", error);
      rejectDetachedTabAdoptAck(tabId, "detach aborted");
      removeDetachedTabEntry(tabId);
      await closeDetachedTabWindow(shell.label);
      void ensureWarmDetachedTabShell();
      return null;
    }
  }

  // 慢路径：新建窗口（位置/尺寸按记忆或鼠标位置创建即定位）。
  const label = detachedTabWindowLabel(tabId);
  writeDetachedTabEntry(tabId, { snapshot, label, title, detachedAt: Date.now(), updatedAt: Date.now() });
  const adoptAck = waitForDetachedTabAdoptAck(tabId, label);
  try {
    const remembered = placement.x === undefined || placement.y === undefined ? await loadDetachedWindowPlacement(detachedTabPlacementKey(tabId)) : null;
    const opened = await openDetachedWebviewWindow({
      label,
      title: `DBX - ${title}`,
      url: detachedTabUrl(tabId),
      placementKey: detachedTabPlacementKey(tabId),
      placement: { ...placement, ...(remembered && placement.x === undefined ? { x: remembered.x, y: remembered.y } : {}) },
      defaultWidth: 1100,
      defaultHeight: 720,
      minWidth: 480,
      minHeight: 360,
      // 窗口创建失败（tauri://error）立刻拒绝回执等待，避免整段超时。
      onCreateError: (error) => rejectDetachedTabAdoptAck(tabId, `create window failed: ${String(error)}`),
    });
    if (!opened) throw new Error("window not opened");
    await adoptAck;
    return label;
  } catch (error) {
    console.error("[detached-tab] create/adopt window failed", error);
    rejectDetachedTabAdoptAck(tabId, "detach aborted");
    removeDetachedTabEntry(tabId);
    await closeDetachedTabWindow(label);
    return null;
  }
}

/** 关闭指定页签的子窗口（dock 完成后由主窗口调用）。 */
export async function closeDetachedTabWindow(label: string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const win = await WebviewWindow.getByLabel(label);
    await win?.close();
  } catch (error) {
    console.error("[detached-tab] close window failed", error);
  }
}

/** 通知主窗口合并页签（子窗口调用；最新快照需已写入 registry）。发送失败抛错，调用方重置 dock 状态。 */
export async function requestDockDetachedTab(tabId: string): Promise<void> {
  await sendDetachedPanelMessageOrThrow(MAIN_WINDOW_LABEL, { action: "detached-tab-dock", tabId });
}

import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { isMacOS } from "@/lib/backend/platform";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import type { SavedSqlOpenTargetMode } from "@/lib/savedSql/savedSqlExecutionTarget";
import type { HistoryEntry } from "@/lib/backend/api";
import type { ConnectionConfig, ExternalSqlFileVersion, QueryResult, QueryTab, SavedSqlFile, TableInfoTab } from "@/types/database";
import type { InjectionKey, Ref } from "vue";
import type { AiAction } from "@/lib/ai/ai";
import type { NavigationTarget } from "@/composables/useNavigationTargets";

/**
 * 可分离为独立子窗口的右侧面板。
 */
export const DETACHED_PANEL_IDS = ["history", "sqlLibrary", "sqlFile", "ai", "tableInfo"] as const;
export type DetachedPanelId = (typeof DETACHED_PANEL_IDS)[number];

/** 子窗口 label，固定值保证同一面板单例。 */
export function detachedPanelWindowLabel(panel: DetachedPanelId): string {
  return `panel-${panel}`;
}

/** 解析当前窗口 URL 中的 detached 参数（仅子窗口有）。 */
export function getDetachedPanelFromLocation(): DetachedPanelId | null {
  if (typeof window === "undefined") return null;
  const search = window.location?.search;
  if (!search) return null;
  const value = new URLSearchParams(search).get("detached");
  return (DETACHED_PANEL_IDS as readonly string[]).includes(value ?? "") ? (value as DetachedPanelId) : null;
}

const detachedStorageKey = (panel: DetachedPanelId) => `dbx-panel-detached-${panel}`;

/** 面板是否处于"独立窗口"模式（持久化，主窗口 localStorage 权威）。 */
export function isPanelDetached(panel: DetachedPanelId): boolean {
  return safeLocalStorageGet(detachedStorageKey(panel)) === "true";
}

export function setPanelDetached(panel: DetachedPanelId, detached: boolean): void {
  safeLocalStorageSet(detachedStorageKey(panel), String(detached));
}

// ---------------------------------------------------------------------------
// 跨窗口事件总线
// ---------------------------------------------------------------------------

const DETACHED_PANEL_EVENT = "dbx://detached-panel";

/** 主窗口标签页快照，供分离的 SQL 库面板渲染高亮/脏标记。 */
export interface SavedSqlTabsSnapshot {
  activeSavedSqlId: string | null;
  dirtySavedSqlIds: string[];
  activeTargetConnectionId: string | null;
}

/** 分离窗口中注入的主窗口标签页快照（主窗口内渲染时为 null，回退到本地 queryStore）。 */
export const DETACHED_SAVED_SQL_TABS_KEY: InjectionKey<Ref<SavedSqlTabsSnapshot>> = Symbol("detached-saved-sql-tabs");

/** AI 面板实际依赖的标签字段子集；主窗口传完整 QueryTab，分离子窗口由快照重建。 */
export interface AiTabContext {
  id: string;
  connectionId: string;
  database: string;
  /** dameng 等 schema 级命名空间（对应 QueryTab.schema）。 */
  schema?: string;
  /** 编辑器当前 SQL（向量库集合 ID、currentSql 上下文）。 */
  sql: string;
  result?: QueryResult;
  /** 预计算的结果预览文本（分离子窗口由主窗口计算后下发，替代完整 result）。 */
  resultPreview?: string;
  tableMeta?: QueryTab["tableMeta"];
}

/** 主窗口推送给分离 AI 子窗口的活动标签快照（可序列化）。 */
export interface AiPanelTabSnapshot {
  id: string;
  connectionId: string;
  database: string;
  /** QueryTab.schema，缺省为 null。 */
  schema: string | null;
  /** 编辑器当前 SQL。 */
  sql: string;
  /** QueryTab.tableMeta，缺省为 null。 */
  tableMeta: QueryTab["tableMeta"] | null;
  /** 最近一次执行错误（QueryTab.result 为执行错误时取 rows[0][0]），供 fix 动作。 */
  lastError: string | null;
  /** formatResultPreview(QueryTab.result) 的预计算结果，缺省为 null。 */
  resultPreview: string | null;
}

export interface AiPanelContextSnapshot {
  tab: AiPanelTabSnapshot | null;
  connection: ConnectionConfig | null;
}

/** 对象浏览器表信息面板的目标表（可序列化）。 */
export interface TableInfoRowSnapshot {
  name: string;
  /** ObjectBrowserRow.schema，缺省为 null（回退到 fallbackSchema/database）。 */
  schema: string | null;
  /** ObjectBrowserRow.type（TABLE/VIEW/MATERIALIZED_VIEW 等）。 */
  type: string;
}

/** 主窗口推送给分离表信息子窗口的上下文快照（当前选中的表 + 连接上下文）。 */
export interface TableInfoContextSnapshot {
  connection: ConnectionConfig | null;
  database: string;
  catalog: string | null;
  /** 对象浏览器当前选择的 schema（row.schema 缺省时的回退）。 */
  fallbackSchema: string | null;
  row: TableInfoRowSnapshot | null;
  /** 主窗口内嵌面板当前页签（仅子窗口首次/换表时采用）。 */
  tab: TableInfoTab | null;
}

export type DetachedPanelMessage =
  | { action: "open-saved-sql"; file: SavedSqlFile; targetMode?: SavedSqlOpenTargetMode }
  | { action: "open-external-sql-file"; connectionId: string; database: string; catalog?: string; path: string; sql: string; version?: ExternalSqlFileVersion }
  | { action: "execute-external-sql-file"; connectionId: string; database: string; catalog?: string; path: string }
  | { action: "restore-history"; sql: string; entry: HistoryEntry }
  | { action: "analyze-history-ai"; entry: HistoryEntry }
  | { action: "dock-panel"; panel: DetachedPanelId }
  | { action: "saved-sql-changed" }
  | { action: "history-changed" }
  /** 子窗口就绪后请求主窗口推送一次标签页快照。 */
  | { action: "request-saved-sql-tabs" }
  | { action: "saved-sql-tabs"; snapshot: SavedSqlTabsSnapshot }
  /** AI 子窗口 → 主窗口：SQL 动作（替换/执行/临时运行/自动执行）。 */
  | { action: "ai-sql"; kind: "replace" | "execute" | "temp-run" | "auto-execute"; sql: string }
  | { action: "ai-redis-command"; command: string; execute: boolean }
  | { action: "ai-open-explain-plan"; sql: string }
  /** AI 子窗口 → 主窗口：切换活动标签的连接/命名空间。 */
  | { action: "ai-change-connection"; connectionId: string }
  | { action: "ai-change-namespace"; value: string }
  /** AI 子窗口 → 主窗口：打开 @ 提及的表。 */
  | { action: "ai-open-table"; target: NavigationTarget }
  /** AI 子窗口就绪后请求主窗口推送一次上下文快照（并冲刷待处理动作）。 */
  | { action: "request-ai-context" }
  /** 主窗口 → AI 子窗口：活动标签/连接上下文。 */
  | { action: "ai-context"; snapshot: AiPanelContextSnapshot }
  /** 主窗口 → AI 子窗口：入口动作（Fix with AI / 历史分析等）。 */
  | { action: "ai-trigger-action"; aiAction: AiAction; instruction?: string }
  | { action: "ai-set-prompt"; text: string }
  /** 表信息子窗口就绪后请求主窗口推送一次上下文快照。 */
  | { action: "request-table-info-context" }
  /** 主窗口 → 表信息子窗口：当前选中的表 + 连接上下文。 */
  | { action: "table-info-context"; snapshot: TableInfoContextSnapshot }
  /** 表信息子窗口 → 主窗口：在主窗口打开表结构编辑器。 */
  | { action: "table-info-open-structure"; connectionId: string; database: string; catalog?: string; schema?: string; tableName: string; tab: TableInfoTab }
  /** 对象浏览器独立窗口 → 主窗口：按对象浏览器的打开规则打开表数据。 */
  | { action: "object-browser-open-table"; target: NavigationTarget }
  /** 对象浏览器独立窗口 → 主窗口：创建/执行 SQL 查询标签页。 */
  | { action: "object-browser-open-query"; connectionId: string; database: string; catalog?: string; schema?: string; title: string; sql: string; execute?: boolean }
  /** 对象浏览器独立窗口 → 主窗口：打开表结构编辑器。 */
  | { action: "object-browser-open-structure"; connectionId: string; database: string; catalog?: string; schema?: string; tableName: string; tab?: TableInfoTab }
  /** 对象浏览器独立窗口 → 主窗口：打开依赖主窗口状态的工具对话框。 */
  | { action: "object-browser-open-tool"; tool: "diagram" | "tableImport" | "dataCompare" | "databaseExport" | "tableDataGenerate"; connectionId: string; database: string; schema?: string; tableName?: string; tableNames?: string[] }
  /** 对象浏览器独立窗口 → 主窗口：刷新主窗口侧边栏对象树。 */
  | { action: "object-browser-refresh-tree"; connectionId: string; database: string; schema?: string }
  /** 对象浏览器独立窗口 → 主窗口：关闭已删除对象对应的数据标签页。 */
  | { action: "object-browser-close-dropped-tabs"; connectionId: string; database: string; catalog?: string; schema?: string; tableName: string; objectType: "TABLE" | "VIEW" | "MATERIALIZED_VIEW" }
  /** 对象浏览器独立窗口 → 主窗口：刷新已变更对象对应的数据标签页。 */
  | { action: "object-browser-refresh-data-tabs"; connectionId: string; database: string; catalog?: string; schema?: string; schemaCandidates?: Array<string | undefined>; tableName: string }
  /** 主窗口 → 所有子窗口：应用设置（主题/语言/缩放）已变更，子窗口从持久层重读并应用。uiScale 随消息携带，避免与异步保存竞态。 */
  | { action: "app-settings-sync"; uiScale?: number }
  /** 普通面板子窗口 → 主窗口：监听器、首帧与窗口显示均已完成。 */
  | { action: "detached-panel-ready"; panel: DetachedPanelId }
  /** 预热 shell 子窗口 → 广播：shell 已挂载并就绪待命（label 为自身窗口 label）。 */
  | { action: "detached-tab-shell-ready"; label: string }
  /** 主窗口 → 指定 shell 子窗口：分配分离页签（快照已写入 registry，子窗口按 tabId 读取并显示）。x/y 为分离瞬间的鼠标位置（缺省时子窗口用记忆位置）。 */
  | { action: "detached-tab-assign"; tabId: string; x?: number; y?: number }
  /** 分离页签子窗口 → 主窗口：页签已从 registry 恢复并完成首帧渲染（主窗口据此 finalize 移除主窗口页签）。 */
  | { action: "detached-tab-adopted"; tabId: string }
  /** 分离页签子窗口 → 主窗口：页签恢复失败（registry 缺失/快照损坏），子窗口已自毁，主窗口回滚。 */
  | { action: "detached-tab-adopt-failed"; tabId: string; reason?: string }
  /** 分离页签子窗口 → 主窗口：合并回主窗口（最新快照已写入 registry）。 */
  | { action: "detached-tab-dock"; tabId: string }
  | { action: "detached-tab-dock-failed"; tabId: string }
  /** 分离页签子窗口 → 主窗口：在主窗口打开 SQL 文件 / 导入结果归档。 */
  | { action: "detached-tab-open-sql-file" }
  | { action: "detached-tab-import-result-archive" }
  /** 分离页签子窗口 → 主窗口：导航类动作（打开表数据/DDL/结构编辑器/对象源码），target 已由子窗口按其页签上下文补全。 */
  | { action: "detached-tab-navigate"; kind: "data" | "ddl" | "structure" | "source"; target: NavigationTarget; objectType?: string; sourceName?: string; sourceSchema?: string; signature?: string; initialEditing?: boolean }
  /** 分离页签子窗口 → 主窗口：结构编辑器已保存（主窗口刷新对象树/补全缓存/匹配的数据页签）。 */
  | { action: "detached-tab-structure-saved"; connectionId: string; database: string; catalog?: string; schema?: string; tableName: string; commentChanged?: boolean }
  /** 分离页签子窗口 → 主窗口：AI 入口动作（Fix with AI / 发送选区到 AI 面板）。 */
  | { action: "detached-tab-ai-fix"; errorMessage: string }
  | { action: "detached-tab-ai-set-prompt"; text: string }
  /** 分离页签子窗口 → 主窗口：打开应用设置 / 连接设置（对话框在主窗口展示）。 */
  | { action: "detached-tab-open-settings"; initialTab?: string; initialSection?: string }
  | { action: "detached-tab-open-connection-settings"; connectionId: string; initialTab: "advanced" };

interface DetachedPanelEnvelope {
  /** 发送方窗口 label，接收方据此跳过自己发出的事件。 */
  source: string;
  message: DetachedPanelMessage;
}

export const MAIN_WINDOW_LABEL = "main";

async function currentWindowLabel(): Promise<string> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow().label;
}

/** 向所有窗口广播面板事件（携带来源 label，发送方自身会过滤）。 */
export async function broadcastDetachedPanelMessage(message: DetachedPanelMessage): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { emit } = await import("@tauri-apps/api/event");
    const envelope: DetachedPanelEnvelope = { source: await currentWindowLabel(), message };
    await emit(DETACHED_PANEL_EVENT, envelope);
  } catch (error) {
    console.error("[detached-panel] broadcast failed", error);
  }
}

/** 定向发送面板事件到指定窗口。 */
export async function sendDetachedPanelMessage(targetLabel: string, message: DetachedPanelMessage): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { emitTo } = await import("@tauri-apps/api/event");
    const envelope: DetachedPanelEnvelope = { source: await currentWindowLabel(), message };
    await emitTo(targetLabel, DETACHED_PANEL_EVENT, envelope);
  } catch (error) {
    console.error("[detached-panel] send failed", error);
  }
}

/**
 * 定向发送面板事件，失败时抛错（不吞错）。
 * 用于分离窗口的关键握手消息（ready/assign/adopted/adopt-failed/dock）——发送失败时
 * 调用方必须立刻回滚/自毁，而不是静默等待超时。
 */
export async function sendDetachedPanelMessageOrThrow(targetLabel: string, message: DetachedPanelMessage): Promise<void> {
  if (!isTauriRuntime()) throw new Error("[detached-panel] send requires tauri runtime");
  const { emitTo } = await import("@tauri-apps/api/event");
  const envelope: DetachedPanelEnvelope = { source: await currentWindowLabel(), message };
  await emitTo(targetLabel, DETACHED_PANEL_EVENT, envelope);
}

/**
 * 监听面板事件，自动过滤本窗口发出的事件。返回取消监听函数。
 * 必须用当前窗口作用域的 listen：裸 listen() 在 Tauri v2 中是 Any 嗅探器，
 * 会收到 emitTo 发给其他窗口的定向事件（如 detached-tab-assign 被已分配页签的
 * 子窗口再次消费，内容被后打开的窗口覆盖、且 dock 链作用在错误的 tabId 上导致
 * 窗口无法关闭/合并）。窗口作用域下广播（emit）与发向本窗口的定向（emitTo）均可收到。
 */
export async function listenDetachedPanelMessages(handler: (message: DetachedPanelMessage, sourceLabel: string) => void): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const self = getCurrentWindow();
  return self.listen<DetachedPanelEnvelope>(DETACHED_PANEL_EVENT, (event) => {
    if (!event.payload || event.payload.source === self.label) return;
    handler(event.payload.message, event.payload.source);
  });
}

/** 普通面板启动就绪超时：覆盖 bundle 加载、store 初始化与首帧显示。 */
export const DETACHED_PANEL_READY_TIMEOUT_MS = 20_000;

interface PendingPanelReady {
  label: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingPanelReady = new Map<DetachedPanelId, PendingPanelReady>();
const panelOpenAttempts = new Map<DetachedPanelId, Promise<boolean>>();

function settlePanelReady(panel: DetachedPanelId, sourceLabel: string | undefined, settle: (pending: PendingPanelReady) => void): void {
  const pending = pendingPanelReady.get(panel);
  if (!pending || (sourceLabel !== undefined && pending.label !== sourceLabel)) return;
  clearTimeout(pending.timer);
  pendingPanelReady.delete(panel);
  settle(pending);
}

/** 子窗口完成首帧显示后确认就绪；迟到或来自旧窗口的回执会被忽略。 */
export function resolveDetachedPanelReady(panel: DetachedPanelId, sourceLabel: string): void {
  settlePanelReady(panel, sourceLabel, (pending) => pending.resolve());
}

/** 创建失败、超时或回滚时拒绝等待。 */
export function rejectDetachedPanelReady(panel: DetachedPanelId, reason: string, sourceLabel?: string): void {
  settlePanelReady(panel, sourceLabel, (pending) => pending.reject(new Error(reason)));
}

export function waitForDetachedPanelReady(panel: DetachedPanelId, label: string): Promise<void> {
  settlePanelReady(panel, undefined, (pending) => pending.reject(new Error("superseded by a new panel open attempt")));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPanelReady.delete(panel);
      reject(new Error(`panel ready timeout after ${DETACHED_PANEL_READY_TIMEOUT_MS}ms`));
    }, DETACHED_PANEL_READY_TIMEOUT_MS);
    pendingPanelReady.set(panel, { label, resolve, reject, timer });
  });
}

export function hasPendingDetachedPanelReady(panel: DetachedPanelId): boolean {
  return pendingPanelReady.has(panel);
}

// ---------------------------------------------------------------------------
// 子窗口管理
// ---------------------------------------------------------------------------

export interface DetachedWindowPlacement {
  /** 逻辑坐标（鼠标屏幕位置），缺省时读取前端持久化的记忆位置。 */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

// ---------------------------------------------------------------------------
// 子窗口位置持久化（前端接管，窗口创建即定位，避免先显示在默认位置再跳动）
// ---------------------------------------------------------------------------

const placementStorageKey = (key: string) => `dbx-panel-placement-${key}`;

export interface PersistedDetachedWindowRect {
  /** 逻辑坐标与尺寸（CSS 像素，与 WebviewWindow 创建参数一致）。 */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 读取记忆位置；不在任何显示器可见范围内时返回 null（回退系统默认位置）。 */
export async function loadDetachedWindowPlacement(key: string): Promise<PersistedDetachedWindowRect | null> {
  const raw = safeLocalStorageGet(placementStorageKey(key));
  if (!raw) return null;
  let rect: PersistedDetachedWindowRect;
  try {
    rect = JSON.parse(raw) as PersistedDetachedWindowRect;
  } catch {
    return null;
  }
  if (![rect.x, rect.y, rect.width, rect.height].every((v) => Number.isFinite(v))) return null;
  if (!(await isRectVisibleOnAnyMonitor(rect))) return null;
  return rect;
}

/** 校验窗口矩形至少有一部分落在某台显示器内，防止恢复到已拔除的屏幕外。 */
async function isRectVisibleOnAnyMonitor(rect: PersistedDetachedWindowRect): Promise<boolean> {
  try {
    const { availableMonitors } = await import("@tauri-apps/api/window");
    const monitors = await availableMonitors();
    if (monitors.length === 0) return true;
    return monitors.some((monitor) => {
      const scale = monitor.scaleFactor || 1;
      const mx = monitor.position.x / scale;
      const my = monitor.position.y / scale;
      const mw = monitor.size.width / scale;
      const mh = monitor.size.height / scale;
      // 至少有 100px 宽的可见区域，且标题栏高度落在屏幕内。
      const overlapX = Math.min(rect.x + rect.width, mx + mw) - Math.max(rect.x, mx);
      const titleVisible = rect.y >= my && rect.y <= my + mh - 40;
      return overlapX >= 100 && titleVisible;
    });
  } catch {
    return true;
  }
}

/** 保存子窗口当前位置/尺寸（由子窗口在移动/缩放时防抖调用）。 */
export async function saveDetachedWindowPlacement(key: DetachedPanelId | string): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if ((await win.isMaximized()) || (await win.isFullscreen()) || (await win.isMinimized())) return;
    const [position, size, scale] = await Promise.all([win.outerPosition(), win.outerSize(), win.scaleFactor()]);
    const rect: PersistedDetachedWindowRect = {
      x: Math.round(position.x / scale),
      y: Math.round(position.y / scale),
      width: Math.round(size.width / scale),
      height: Math.round(size.height / scale),
    };
    safeLocalStorageSet(placementStorageKey(key), JSON.stringify(rect));
  } catch (error) {
    console.error("[detached-panel] save placement failed", error);
  }
}

/**
 * 计算以主窗口为锚的新窗口默认位置（逻辑坐标）：在主窗口内居中，
 * 并限制在主窗口中心所在的显示器可见区域内。
 * 用于无显式鼠标位置且无记忆位置的场景——不传坐标时系统会把窗口放到主显示器，
 * 双屏下主窗口在副屏时新窗口会跑错屏幕。失败（如主窗口最小化）返回 null，回退系统默认。
 */
export async function resolveMainWindowAnchoredPosition(width: number, height: number): Promise<{ x: number; y: number } | null> {
  if (!isTauriRuntime()) return null;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const main = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);
    if (!main || (await main.isMinimized())) return null;
    const [position, size, scale] = await Promise.all([main.outerPosition(), main.outerSize(), main.scaleFactor()]);
    const mainX = position.x / scale;
    const mainY = position.y / scale;
    const mainW = size.width / scale;
    const mainH = size.height / scale;
    let x = Math.round(mainX + (mainW - width) / 2);
    let y = Math.round(mainY + (mainH - height) / 2);
    // 主窗口贴边/跨屏时居中结果可能溢出屏幕，clamp 回主窗口中心所在的显示器。
    const { availableMonitors } = await import("@tauri-apps/api/window");
    const monitors = await availableMonitors();
    const centerX = mainX + mainW / 2;
    const centerY = mainY + mainH / 2;
    const monitor = monitors.find((m) => {
      const s = m.scaleFactor || 1;
      const mx = m.position.x / s;
      const my = m.position.y / s;
      return centerX >= mx && centerX < mx + m.size.width / s && centerY >= my && centerY < my + m.size.height / s;
    });
    if (monitor) {
      const s = monitor.scaleFactor || 1;
      const mx = monitor.position.x / s;
      const my = monitor.position.y / s;
      const mw = monitor.size.width / s;
      const mh = monitor.size.height / s;
      x = Math.min(Math.max(x, Math.round(mx)), Math.max(Math.round(mx), Math.round(mx + mw - width)));
      y = Math.min(Math.max(y, Math.round(my)), Math.max(Math.round(my), Math.round(my + mh - height)));
    }
    return { x, y };
  } catch (error) {
    console.error("[detached-panel] resolve anchored position failed", error);
    return null;
  }
}

/**
 * 将窗口矩形 clamp 到与其重叠面积最大的显示器边界内（逻辑坐标），
 * 保证显式定位（如鼠标在屏幕边缘触发分离）时窗口完整出现在屏幕内。
 * 仅在创建/定位时调用，不限制用户之后的拖拽。无任何重叠时按窗口中心取最近显示器。
 */
export async function clampRectToVisibleMonitor(rect: { x: number; y: number; width: number; height: number }): Promise<{ x: number; y: number }> {
  if (!isTauriRuntime()) return { x: rect.x, y: rect.y };
  try {
    const { availableMonitors } = await import("@tauri-apps/api/window");
    const monitors = await availableMonitors();
    if (monitors.length === 0) return { x: rect.x, y: rect.y };
    const logical = monitors.map((m) => {
      const s = m.scaleFactor || 1;
      return { x: m.position.x / s, y: m.position.y / s, width: m.size.width / s, height: m.size.height / s };
    });
    const overlapArea = (m: (typeof logical)[number]) => Math.max(0, Math.min(rect.x + rect.width, m.x + m.width) - Math.max(rect.x, m.x)) * Math.max(0, Math.min(rect.y + rect.height, m.y + m.height) - Math.max(rect.y, m.y));
    let target = logical.reduce((best, m) => (overlapArea(m) > overlapArea(best) ? m : best), logical[0]);
    if (overlapArea(target) === 0) {
      // 完全屏外（防御）：取离窗口中心最近的显示器。
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const distance = (m: (typeof logical)[number]) => (Math.max(m.x, Math.min(cx, m.x + m.width)) - cx) ** 2 + (Math.max(m.y, Math.min(cy, m.y + m.height)) - cy) ** 2;
      target = logical.reduce((best, m) => (distance(m) < distance(best) ? m : best), logical[0]);
    }
    return {
      x: Math.round(Math.min(Math.max(rect.x, target.x), Math.max(target.x, target.x + target.width - rect.width))),
      y: Math.round(Math.min(Math.max(rect.y, target.y), Math.max(target.y, target.y + target.height - rect.height))),
    };
  } catch (error) {
    console.error("[detached-panel] clamp rect failed", error);
    return { x: rect.x, y: rect.y };
  }
}

const PANEL_WINDOW_TITLES: Record<DetachedPanelId, string> = {
  history: "History",
  sqlLibrary: "SQL Library",
  sqlFile: "SQL Files",
  ai: "AI Assistant",
  tableInfo: "Table Info",
};

export interface DetachedWebviewWindowOptions {
  /** 唯一窗口 label（capabilities 中需匹配 panel-*）。 */
  label: string;
  title: string;
  url: string;
  /** 前端窗口位置记忆 key。 */
  placementKey: string;
  placement?: DetachedWindowPlacement;
  defaultWidth?: number;
  defaultHeight?: number;
  minWidth?: number;
  minHeight?: number;
  /** 窗口创建失败（tauri://error）回调：调用方可据此快速失败（默认仅记日志）。 */
  onCreateError?: (error: unknown) => void;
}

/**
 * 打开（或聚焦已存在的）无边框子窗口。
 * 窗口位置/尺寸由前端 localStorage 按 placementKey 持久化（创建时直接传入，避免先显示在
 * 默认位置再被恢复的跳动）；窗口以 visible: false 创建，由子窗口渲染完成后自行 show。
 */
export async function openDetachedWebviewWindow(options: DetachedWebviewWindowOptions): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");

  const existing = await WebviewWindow.getByLabel(options.label);
  if (existing) {
    try {
      if (await existing.isMinimized()) await existing.unminimize();
      await existing.setFocus();
    } catch (error) {
      console.error("[detached-panel] focus existing window failed", error);
    }
    return true;
  }

  // 显式传入（分离瞬间的鼠标位置）优先，其次读取记忆位置。
  const placement = options.placement ?? {};
  const remembered = placement.x === undefined || placement.y === undefined ? await loadDetachedWindowPlacement(options.placementKey) : null;
  const width = placement.width ?? remembered?.width ?? options.defaultWidth ?? 420;
  const height = placement.height ?? remembered?.height ?? options.defaultHeight ?? 640;
  let x = placement.x ?? remembered?.x;
  let y = placement.y ?? remembered?.y;

  if (placement.x !== undefined && placement.y !== undefined) {
    // 显式鼠标定位：鼠标在屏幕边缘时窗口会部分溢出屏幕，clamp 回鼠标所在显示器。
    ({ x, y } = await clampRectToVisibleMonitor({ x: placement.x, y: placement.y, width, height }));
  } else if (x === undefined || y === undefined) {
    // 无显式位置且无记忆位置：锚定主窗口所在屏幕（缺省不传坐标时系统会放到主显示器，
    // 双屏且主窗口在副屏时新窗口会出现在错误的屏幕上）。
    const anchored = await resolveMainWindowAnchoredPosition(width, height);
    if (anchored) {
      x = anchored.x;
      y = anchored.y;
    }
  }

  const window = new WebviewWindow(options.label, {
    url: options.url,
    title: options.title,
    width,
    height,
    minWidth: options.minWidth ?? 280,
    minHeight: options.minHeight ?? 320,
    // 无边框：窗口内 header 充当顶栏（含拖拽区与窗口控制按钮），
    // macOS 保留悬浮红绿灯按钮。
    ...(isMacOS() ? { titleBarStyle: "overlay" as const, hiddenTitle: true } : { decorations: false }),
    visible: false,
    ...(x !== undefined && y !== undefined ? { x, y } : {}),
  });
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const unlisteners: Array<() => void> = [];
    const finish = (created: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const unlisten of unlisteners) unlisten();
      if (!created) {
        console.error("[detached-panel] create window failed", error);
        options.onCreateError?.(error);
      }
      resolve(created);
    };
    const register = (promise: Promise<() => void>) => {
      void promise
        .then((unlisten) => {
          if (settled) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch((error) => finish(false, error));
    };
    const timer = setTimeout(() => finish(false, new Error("window create timeout")), DETACHED_PANEL_READY_TIMEOUT_MS);
    register(window.once("tauri://created", () => finish(true)));
    register(window.once("tauri://error", (error: unknown) => finish(false, error)));
  });
}

/** 执行一次面板窗口创建与就绪握手。 */
async function openDetachedPanelWindowOnce(panel: DetachedPanelId, placement: DetachedWindowPlacement): Promise<boolean> {
  const label = detachedPanelWindowLabel(panel);
  const existing = await isDetachedPanelWindowOpen(panel);
  const ready = existing ? null : waitForDetachedPanelReady(panel, label);
  let opened = false;
  try {
    opened = await openDetachedWebviewWindow({
      label,
      title: `DBX - ${PANEL_WINDOW_TITLES[panel]}`,
      url: `index.html?detached=${panel}`,
      placementKey: panel,
      placement,
      onCreateError: (error) => rejectDetachedPanelReady(panel, `create window failed: ${String(error)}`, label),
    });
  } catch (error) {
    console.error("[detached-panel] open window failed", error);
    rejectDetachedPanelReady(panel, `open window failed: ${String(error)}`, label);
  }
  if (!opened) {
    rejectDetachedPanelReady(panel, "window not opened", label);
    await ready?.catch(() => {});
    await closeDetachedPanelWindow(panel);
    return false;
  }
  if (!ready) return true;
  try {
    await ready;
    return true;
  } catch (error) {
    console.error("[detached-panel] window ready failed", error);
    await closeDetachedPanelWindow(panel);
    return false;
  }
}

/** 打开（或聚焦已存在的）面板子窗口；同一面板的并发请求复用一次握手。 */
export function openDetachedPanelWindow(panel: DetachedPanelId, placement: DetachedWindowPlacement = {}): Promise<boolean> {
  const existingAttempt = panelOpenAttempts.get(panel);
  if (existingAttempt) return existingAttempt;
  const attempt = openDetachedPanelWindowOnce(panel, placement).finally(() => {
    if (panelOpenAttempts.get(panel) === attempt) panelOpenAttempts.delete(panel);
  });
  panelOpenAttempts.set(panel, attempt);
  return attempt;
}

/** 关闭指定面板的子窗口（若存在）。 */
export async function closeDetachedPanelWindow(panel: DetachedPanelId): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const existing = await WebviewWindow.getByLabel(detachedPanelWindowLabel(panel));
    await existing?.close();
  } catch (error) {
    console.error("[detached-panel] close window failed", error);
  }
}

/** 判断指定面板的子窗口是否已打开。 */
export async function isDetachedPanelWindowOpen(panel: DetachedPanelId): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    return (await WebviewWindow.getByLabel(detachedPanelWindowLabel(panel))) !== null;
  } catch {
    return false;
  }
}

import { computed, onScopeDispose, provide, ref, type InjectionKey } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { resolveWindowContext } from "@/lib/app/windowContext";
import { acquireUpdateBarrier, assertUpdateSafe, beginUpdateSensitiveOperation } from "@/lib/app/updatePreparation";
import { uuid } from "@/lib/common/utils";
import { acceptWorkspaceTransfer, isWorkspaceTabWindowLabel, lockWorkspaceTransferInput, waitForWorkspaceTransfer, type TransferStatus, type WorkspaceTabHandoff } from "@/lib/tabs/workspaceTabTransfer";
import { showTabDragPreviewWebview, hideTabDragPreviewWebview } from "@/lib/tabs/tabWindowPreviewHost";
import type { TabDragAppearance } from "@/lib/tabs/tabDragAppearance";
import type { QueryTab } from "@/types/database";

const TRANSFER_EVENT = "dbx:workspace-tab-transfer";
const PREVIEW_EVENT = "dbx:workspace-tab-preview";
const CLOSE_PREPARE_EVENT = "dbx:workspace-close-prepare";
const CLOSE_READY_EVENT = "dbx:workspace-close-ready";
const CLOSE_RELEASE_EVENT = "dbx:workspace-close-release";

interface Point {
  x: number;
  y: number;
}
interface DropTarget {
  groupId: string;
  index?: number;
  tabId?: string;
}
interface NativeRelease {
  transferId: string;
  sourceWindowLabel: string;
  cursorX: number;
  cursorY: number;
  cancelled?: boolean;
}

export const WORKSPACE_TAB_WINDOWS: InjectionKey<ReturnType<typeof useWorkspaceTabWindows>> = Symbol("workspace-tab-windows");

export function useWorkspaceTabWindows(options: { requestClose(): void; assertCloseSafe(): void }) {
  const queryStore = useQueryStore();
  const settingsStore = useSettingsStore();
  const { t } = useI18n();
  const { toast } = useToast();
  const context = resolveWindowContext();
  const label = context.windowLabel;
  const enabled = computed(() => isTauriRuntime() && (context.kind === "main" || context.kind === "workspace") && settingsStore.editorSettings.crossWindowTabDragPreviewEnabled);
  const targets = ref<Array<{ label: string; title: string }>>([]);
  const remoteDrop = ref<DropTarget | null>(null);
  const busyTabs = new Set<string>();
  const incoming = new Set<string>();
  const unlisteners: Array<() => void> = [];
  const closeBarriers = new Map<string, () => void>();
  let disposed = false;
  let ready = false;
  let closing = false;
  let drag: { id: string; tab: QueryTab; appearance: TabDragAppearance; release: () => void } | undefined;
  let previewTimer: ReturnType<typeof setInterval> | undefined;
  let remoteTimer: ReturnType<typeof setTimeout> | undefined;
  let previewBusy = false;

  function errorToast(error: unknown) {
    toast(`${t("tabs.openInNewWindowFailed")} ${error instanceof Error ? error.message : String(error)}`, 7000);
  }

  async function transferCommand<T>(operation: string, id: string, extra: Record<string, unknown> = {}): Promise<T> {
    return invoke<T>("workspace_tab_transfer", { operation, id, ...extra });
  }

  async function refreshTargets() {
    if (!enabled.value) {
      targets.value = [];
      return;
    }
    const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
    const windows = (await getAllWebviewWindows()).filter((window) => window.label !== label && isWorkspaceTabWindowLabel(window.label));
    targets.value = await Promise.all(windows.map(async (window) => ({ label: window.label, title: await window.title().catch(() => window.label) })));
  }

  async function dropTarget(point: Point): Promise<DropTarget | null> {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const current = getCurrentWindow();
    const [position, scale] = await Promise.all([current.innerPosition(), current.scaleFactor()]);
    const x = (point.x - position.x) / scale;
    const y = (point.y - position.y) / scale;
    const element = document.elementFromPoint(x, y);
    const bar = element?.closest<HTMLElement>("[data-main-tab-bar][data-group-id]");
    if (!bar?.dataset.groupId) return null;
    const group = queryStore.groups.find((group) => group.id === bar.dataset.groupId);
    if (!group) return null;
    const tab = element?.closest<HTMLElement>("[data-tab-id]");
    const tabId = tab?.dataset.tabId;
    let index: number | undefined;
    if (tab && tabId) {
      const position = group.tabIds.indexOf(tabId);
      const rect = tab.getBoundingClientRect();
      const vertical = settingsStore.editorSettings.tabPlacement === "left" || settingsStore.editorSettings.tabPlacement === "right";
      if (position >= 0) index = position + ((vertical ? y >= rect.top + rect.height / 2 : x >= rect.left + rect.width / 2) ? 1 : 0);
    }
    return { groupId: group.id, index, tabId };
  }

  async function windowAt(point: Point): Promise<string | undefined> {
    const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
    const candidates = await Promise.all(
      (await getAllWebviewWindows())
        .filter((window) => isWorkspaceTabWindowLabel(window.label))
        .map(async (window) => {
          try {
            const [position, size, visible, minimized, focused] = await Promise.all([window.outerPosition(), window.outerSize(), window.isVisible(), window.isMinimized(), window.isFocused()]);
            if (!visible || minimized || point.x < position.x || point.y < position.y || point.x >= position.x + size.width || point.y >= position.y + size.height) return null;
            return { label: window.label, focused };
          } catch {
            return null;
          }
        }),
    );
    return candidates.filter((item): item is { label: string; focused: boolean } => !!item).sort((a, b) => Number(b.focused) - Number(a.focused))[0]?.label;
  }

  async function createWindow(id: string, point?: Point) {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const url = new URL(window.location.href);
    url.search = new URLSearchParams({ dbxWorkspace: id, dbxWorkspaceTransfer: id }).toString();
    url.hash = "";
    let placement: { x: number; y: number } | undefined;
    if (point) {
      const { monitorFromPoint } = await import("@tauri-apps/api/window");
      const scale = (await monitorFromPoint(point.x, point.y))?.scaleFactor ?? 1;
      placement = { x: point.x / scale - 120, y: point.y / scale - 18 };
    }
    const child = new WebviewWindow(`dbx-tab-${id}`, { url: url.toString(), title: "DBX", width: 1200, height: 800, minWidth: 900, minHeight: 600, visible: false, decorations: false, ...placement });
    await new Promise<void>((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(new Error("Workspace window creation timed out"));
      }, 10_000);
      void child.once("tauri://created", () => {
        clearTimeout(timer);
        if (expired) void child.destroy();
        else resolve();
      });
      void child.once("tauri://error", (event) => {
        clearTimeout(timer);
        reject(new Error(String(event.payload)));
      });
    });
  }

  async function moveTab(tab: QueryTab, target?: string, point?: Point) {
    if (!enabled.value || !ready || closing || busyTabs.has(tab.id)) return;
    let release: (() => void) | undefined;
    let unlock: (() => void) | undefined;
    let id: string | undefined;
    let committed = false;
    try {
      release = beginUpdateSensitiveOperation();
      busyTabs.add(tab.id);
      const preparation = queryStore.prepareDetachedTab(tab.id, {}, { workspace: true });
      // 快照生成后到交接终态期间冻结源窗口输入，避免迁走过期的编辑状态。
      unlock = lockWorkspaceTransferInput();
      const handoff: WorkspaceTabHandoff = await preparation;
      if (point && target) handoff.dropCursorPhysical = point;
      id = uuid();
      const destination = target ?? `dbx-tab-${id}`;
      await transferCommand("offer", id, { target: destination, payload: handoff });
      if (target) {
        const { emitTo } = await import("@tauri-apps/api/event");
        await emitTo({ kind: "WebviewWindow", label: destination }, TRANSFER_EVENT, { id, target: destination });
      } else {
        await createWindow(id, point);
      }
      committed = await waitForWorkspaceTransfer({ status: () => transferCommand<TransferStatus>("status", id!), cancel: () => transferCommand<TransferStatus>("cancel", id!), delay: () => new Promise((resolve) => setTimeout(resolve, 100)) });
      if (!committed) throw new Error("Tab transfer was cancelled or the target did not become ready");
      queryStore.removeTabAfterDetachedReady(tab.id);
      await queryStore.flushPendingPersist();
    } catch (error) {
      if (id && !committed) {
        // 取消与提交若发生竞争，以后端终态为准，不能凭超时复制出第二份标签。
        const status = await transferCommand<TransferStatus>("cancel", id).catch(() => undefined);
        if (status === "committed") {
          queryStore.removeTabAfterDetachedReady(tab.id);
          await queryStore.flushPendingPersist().catch(errorToast);
        }
      }
      errorToast(error);
    } finally {
      busyTabs.delete(tab.id);
      unlock?.();
      release?.();
    }
  }

  async function accept(id: string): Promise<boolean> {
    if (incoming.has(id)) return false;
    if (!enabled.value || closing) {
      await transferCommand("reject", id).catch(() => {});
      return false;
    }
    incoming.add(id);
    let release: (() => void) | undefined;
    let unlock: (() => void) | undefined;
    try {
      release = beginUpdateSensitiveOperation();
      unlock = lockWorkspaceTransferInput();
      const handoff = await transferCommand<WorkspaceTabHandoff | null>("read", id);
      if (!handoff) return false;
      const target = handoff.dropCursorPhysical ? await dropTarget(handoff.dropCursorPhysical) : { groupId: queryStore.focusedGroupId };
      if (!target) throw new Error("Drop the tab onto the target window's tab bar");
      const accepted = await acceptWorkspaceTransfer({
        handoff,
        hasTab: (id) => queryStore.tabs.some((tab) => tab.id === id),
        adopt: async (handoff) => {
          await queryStore.adoptDetachedTab(handoff);
          queryStore.moveTabToGroup(handoff.tabId, target.groupId, target.index);
        },
        persist: () => queryStore.flushPendingPersist(),
        commit: () => transferCommand<TransferStatus>("commit", id),
        abort: () => transferCommand<TransferStatus>("reject", id),
        remove: (id) => {
          queryStore.removeTabAfterDetachedReady(id);
        },
      });
      if (accepted) {
        const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        await getCurrentWebviewWindow().show();
        await getCurrentWebviewWindow().setFocus();
      }
      return accepted;
    } catch (error) {
      await transferCommand("reject", id).catch(() => {});
      errorToast(error);
      return false;
    } finally {
      incoming.delete(id);
      unlock?.();
      release?.();
    }
  }

  async function finishDrop(tab: QueryTab, point: Point) {
    const target = await windowAt(point);
    if (target === label) {
      const drop = await dropTarget(point);
      if (drop) queryStore.moveTabToGroup(tab.id, drop.groupId, drop.index);
      return;
    }
    await moveTab(tab, target, point);
  }

  function stopPreview() {
    clearInterval(previewTimer);
    previewTimer = undefined;
    void hideTabDragPreviewWebview().catch(() => {});
  }

  async function updatePreview() {
    const current = drag;
    if (!current || previewBusy) return;
    previewBusy = true;
    try {
      const { cursorPosition } = await import("@tauri-apps/api/window");
      const point = await cursorPosition();
      if (drag !== current) return;
      await showTabDragPreviewWebview(current.appearance, point);
      const { emit } = await import("@tauri-apps/api/event");
      if (drag === current) await emit(PREVIEW_EVENT, { source: label, point });
    } catch {
      /* 预览失败不应改变标签归属。 */
    } finally {
      previewBusy = false;
    }
  }

  function startNativeDrag(tab: QueryTab, event: PointerEvent, appearance: TabDragAppearance): boolean {
    if (!enabled.value || !ready || closing || !navigator.userAgent.toLowerCase().includes("windows")) return false;
    if (drag) return true;
    const margin = 8;
    if (event.clientX > margin && event.clientY > margin && event.clientX < window.innerWidth - margin && event.clientY < window.innerHeight - margin) return false;
    if (tab.isExecuting || tab.isCancelling || tab.isExplaining) return false;
    const current = { id: uuid(), tab, appearance, release: beginUpdateSensitiveOperation() };
    drag = current;
    void invoke("start_tab_drag_preview", { request: { transferId: current.id, sourceWindowLabel: label, title: tab.title, left: 0, top: 0, width: 300, height: 34, grabX: 18, grabY: 17 } })
      .then(() => {
        if (drag !== current) {
          void invoke("stop_tab_drag_preview", { transferId: current.id });
          return;
        }
        previewTimer = setInterval(() => void updatePreview(), 32);
        void updatePreview();
      })
      .catch((error) => {
        if (drag === current) drag = undefined;
        current.release();
        stopPreview();
        errorToast(error);
      });
    return true;
  }

  function finishPointerDrag(tab: QueryTab, event: PointerEvent): boolean {
    if (drag?.tab.id === tab.id) return true;
    if (!enabled.value || !ready || (event.clientX >= 0 && event.clientY >= 0 && event.clientX <= window.innerWidth && event.clientY <= window.innerHeight)) return false;
    void import("@tauri-apps/api/window").then(async ({ cursorPosition }) => finishDrop(tab, await cursorPosition())).catch(errorToast);
    return true;
  }

  function cancelDrag(event?: KeyboardEvent) {
    if (event && event.key !== "Escape") return;
    const current = drag;
    drag = undefined;
    if (current) {
      current.release();
      void invoke("stop_tab_drag_preview", { transferId: current.id }).catch(() => {});
    }
    stopPreview();
  }

  async function setup() {
    if (!isTauriRuntime() || !isWorkspaceTabWindowLabel(label) || ready) return;
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const { emitTo } = await import("@tauri-apps/api/event");
    const current = getCurrentWebviewWindow();
    async function listen<T>(name: string, handler: (payload: T) => void) {
      const unlisten = await current.listen<T>(name, ({ payload }) => {
        if (!disposed) handler(payload);
      });
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    }
    await listen<{ id: string; target: string }>(TRANSFER_EVENT, (payload) => {
      if (payload.target === label) void accept(payload.id);
    });
    await listen<NativeRelease>("dbx:tab-drag-preview-release", (payload) => {
      if (payload.sourceWindowLabel !== label || payload.transferId !== drag?.id) return;
      const current = drag;
      drag = undefined;
      stopPreview();
      current.release();
      if (payload.cancelled) return;
      void finishDrop(current.tab, { x: payload.cursorX, y: payload.cursorY }).catch(errorToast);
    });
    await listen<{ source: string; point: Point }>(PREVIEW_EVENT, (payload) => {
      if (!enabled.value || payload.source === label) return;
      void dropTarget(payload.point).then((target) => {
        remoteDrop.value = target;
        clearTimeout(remoteTimer);
        remoteTimer = setTimeout(() => {
          remoteDrop.value = null;
        }, 150);
      });
    });
    await listen<string>("dbx-workspace-close-requested", (target) => {
      if (target !== label || context.kind !== "workspace") return;
      if (busyTabs.size || incoming.size || drag) {
        toast(t("updates.preparationWindowOperation"), 5000);
        return;
      }
      options.requestClose();
    });
    await listen<{ id: string; targets: string[] }>(CLOSE_PREPARE_EVENT, async (payload) => {
      if (context.kind !== "workspace" || !payload.targets.includes(label)) return;
      let error: string | undefined;
      try {
        options.assertCloseSafe();
        assertUpdateSafe();
        const release = acquireUpdateBarrier();
        const timeout = setTimeout(() => {
          closeBarriers.get(payload.id)?.();
          closeBarriers.delete(payload.id);
        }, 30_000);
        closeBarriers.set(payload.id, () => {
          clearTimeout(timeout);
          release();
        });
        await queryStore.flushPendingPersist();
      } catch (cause) {
        error = String(cause);
        closeBarriers.get(payload.id)?.();
        closeBarriers.delete(payload.id);
      }
      await emitTo("main", CLOSE_READY_EVENT, { id: payload.id, label, error });
    });
    await listen<{ id: string }>(CLOSE_RELEASE_EVENT, ({ id }) => {
      closeBarriers.get(id)?.();
      closeBarriers.delete(id);
    });
    ready = !disposed;
    window.addEventListener("keydown", cancelDrag, true);
    const token = new URLSearchParams(window.location.search).get("dbxWorkspaceTransfer");
    if (context.kind === "workspace" && token) {
      const accepted = await accept(token);
      const url = new URL(window.location.href);
      url.searchParams.delete("dbxWorkspaceTransfer");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      if (!accepted && !queryStore.tabs.length) await invoke("complete_workspace_window_close");
      else await current.show();
    }
  }

  async function prepareAppClose(): Promise<() => void> {
    if (!isTauriRuntime() || label !== "main") return () => {};
    assertUpdateSafe();
    if (closing) throw new Error(t("updates.preparationBusy"));
    const { getAllWebviewWindows, getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const { emit } = await import("@tauri-apps/api/event");
    const labels = (await getAllWebviewWindows()).map((window) => window.label).filter((item) => item !== "main" && isWorkspaceTabWindowLabel(item));
    if (!labels.length) return () => {};
    closing = true;
    const id = uuid();
    const pending = new Set(labels);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    let finished = false;
    const release = () => {
      closing = false;
      void emit(CLOSE_RELEASE_EVENT, { id });
    };
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(t("updates.preparationTimeout"))), 5000);
        void getCurrentWebviewWindow()
          .listen<{ id: string; label: string; error?: string }>(CLOSE_READY_EVENT, ({ payload }) => {
            if (payload.id !== id || !pending.has(payload.label)) return;
            if (payload.error) {
              reject(new Error(payload.error));
              return;
            }
            pending.delete(payload.label);
            if (!pending.size) resolve();
          })
          .then((dispose) => {
            if (finished) {
              dispose();
              return;
            }
            unlisten = dispose;
            return emit(CLOSE_PREPARE_EVENT, { id, targets: labels });
          })
          .catch(reject);
      });
      return release;
    } catch (error) {
      release();
      throw error;
    } finally {
      finished = true;
      clearTimeout(timer);
      unlisten?.();
    }
  }

  onScopeDispose(() => {
    disposed = true;
    ready = false;
    cancelDrag();
    window.removeEventListener("keydown", cancelDrag, true);
    clearTimeout(remoteTimer);
    unlisteners.forEach((unlisten) => unlisten());
    closeBarriers.forEach((release) => release());
    closeBarriers.clear();
  });

  const service = { enabled, targets, remoteDrop, setup, refreshTargets, moveTab, startNativeDrag, finishPointerDrag, prepareAppClose };
  provide(WORKSPACE_TAB_WINDOWS, service);
  return service;
}

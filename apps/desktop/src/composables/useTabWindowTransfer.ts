import { computed, onMounted, onUnmounted, ref, watch, type InjectionKey } from "vue";
import { useI18n } from "vue-i18n";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { tabDisplayTitle } from "@/lib/tabs/tabPresentation";
import { blockTabDragTextSelection } from "@/lib/tabs/tabDragSelection";
import { uuid } from "@/lib/common/utils";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { requestAppClose } from "@/lib/backend/api";
import type { QueryTab } from "@/types/database";
import { invoke } from "@tauri-apps/api/core";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { cursorPosition, getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
import { pointOutsideRect, tabDragPreviewRect, tabWindowPreviewRect } from "@/lib/tabs/tabWindowPreview";
import {
  createDetachedTabWindow,
  createTabWindowTransfer,
  createTabWindowGroupTransfer,
  tabWindowTransferEntries,
  currentTabWindowLabel,
  focusTabWindow,
  listOtherTabWindows,
  notifyTabWindowsChanged,
  WORKSPACE_WINDOWS_CHANGED_EVENT,
  readSharedTabWindowTransfer,
  listenForTabWindowInfoRequest,
  listenForTabWindowInfoResponse,
  listenForTabWindowConsolidation,
  listenForTabWindowTransferAccepted,
  emitTabWindowDragPreview,
  hideTabDragPreviewWebview,
  markTabWindowTransferAccepted,
  storeDetachedTabTransfer,
  clearTabWindowTransfer,
  listenForTabWindowDragPreview,
  listenForNativeTabDragPreviewRelease,
  listenForTabWindowTransfer,
  sendTabWindowTransfer,
  showTabDragPreviewWebview,
  requestTabWindowInfo,
  sendTabWindowInfoResponse,
  sendTabWindowTransferAccepted,
  requestTabWindowConsolidation,
  tabWindowAtCursor,
  tabWindowAtPhysicalPosition,
  waitForTabWindowTransferAccepted,
  type TabWindowPlacement,
  type TabWindowDragPreviewPayload,
  type TabWindowInfoRequest,
  type TabWindowInfoResponse,
  type TabWindowConsolidateRequest,
  type TabWindowTransferAcceptedPayload,
  type TabWindowTarget,
  type NativeTabDragPreviewRelease,
  type TabWindowTransferPayload,
} from "@/lib/tabs/tabWindowTransfer";

// Keep mounted providers reachable when Vite reloads a consumer or this module.
export const TAB_WINDOW_TRANSFER: InjectionKey<ReturnType<typeof useTabWindowTransfer>> = Symbol.for("dbx:tab-window-transfer");

/** One coordinator per workspace; all split tab bars share its native drag session. */
export function useTabWindowTransfer(options: { canCloseEmptyWindow?: () => boolean } = {}) {
  const { t } = useI18n();
  const queryStore = useQueryStore();
  const settingsStore = useSettingsStore();
  let cleanupSourceDrag: (() => void) | undefined;
  const crossWindowTabDragPreviewEnabled = computed(() => settingsStore.editorSettings.crossWindowTabDragPreviewEnabled);
  function tabTitleText(tab: QueryTab) {
    return tabDisplayTitle(tab, t);
  }

  // Tauri resolves the permanent label asynchronously. A per-WebView fallback
  // keeps early drags from mistaking two newly opened windows for the same one.
  const currentWindowLabel = ref(`dbx-webview-${Math.random().toString(36).slice(2)}`);
  const nativeTabDrag = ref<{ payload: TabWindowTransferPayload } | null>(null);
  const otherTabWindows = ref<TabWindowTarget[]>([]);
  let windowListRevision = 0;
  const geometryUnlisteners: (() => void)[] = [];
  let geometryPersistTimer: number | undefined;
  let nativeTabDragPreviewTransferId: string | null = null;
  let removeTabWindowTransferListener: (() => void) | null = null;
  let removeTabWindowInfoRequestListener: (() => void) | null = null;
  let removeTabWindowInfoResponseListener: (() => void) | null = null;
  let removeTabWindowDragPreviewListener: (() => void) | null = null;
  let removeNativeTabDragPreviewReleaseListener: (() => void) | null = null;
  let removeWorkspaceWindowChangeListener: (() => void) | null = null;
  let removeTabWindowConsolidationListener: (() => void) | null = null;
  let removeTabWindowTransferAcceptedListener: (() => void) | null = null;
  let tabWindowTransferListenerUnmounted = false;
  let tabWindowInfoListenerUnmounted = false;
  let tabWindowDragPreviewListenerUnmounted = false;
  const pendingTabWindowInfoRequests = new Map<string, { targetWindowLabel: string; resolve: (title: string | null) => void; timer: number }>();

  const remoteTabWindowPreview = ref<{ transferId: string; sourceWindowLabel: string; title: string; sequence: number; rect?: ReturnType<typeof tabDragPreviewRect> } | null>(null);
  let releaseWindowDragSelection: (() => void) | undefined;
  watch(
    () => !!nativeTabDrag.value || !!remoteTabWindowPreview.value,
    (active) => {
      if (active) releaseWindowDragSelection ??= blockTabDragTextSelection();
      else {
        releaseWindowDragSelection?.();
        releaseWindowDragSelection = undefined;
      }
    },
    { flush: "sync" },
  );
  const remoteTabWindowPreviewSequences = new Map<string, number>();
  let focusedDragPreviewWindowLabel: string | null = null;
  let remoteTabWindowPreviewExpiryTimer: number | null = null;
  let tabPreviewBroadcastFrame: number | null = null;
  let tabPreviewBroadcastTimer: number | null = null;
  let pendingTabPreviewBroadcast: { payload: TabWindowTransferPayload; title: string } | null = null;
  let tabPreviewBroadcastTransferId: string | null = null;
  let tabPreviewBroadcastInFlight = false;
  let tabPreviewDisplayMode: "in-app" | "external" | null = null;
  let tabPreviewBroadcastSequence = 0;
  const finishingTransferIds = new Set<string>();
  const completedTransferIds = new Set<string>();
  let closingEmptyWindow = false;

  async function closeEmptyWorkspaceWindow() {
    const canClose = () => isTauriRuntime() && currentWindowLabel.value.startsWith("dbx-tab-") && queryStore.isOpenTabsLoaded && queryStore.tabs.length === 0 && options.canCloseEmptyWindow?.() !== false && !tabWindowTransferListenerUnmounted;
    if (closingEmptyWindow || !canClose()) return;
    closingEmptyWindow = true;
    try {
      await queryStore.flushPendingPersist();
      if (canClose()) await requestAppClose();
    } catch (error) {
      console.warn("[DBX][workspace:close-empty:error]", error);
    } finally {
      closingEmptyWindow = false;
    }
  }

  function clearRemoteTabWindowPreview(transferId?: string) {
    if (transferId && remoteTabWindowPreview.value?.transferId !== transferId) return;
    if (remoteTabWindowPreviewExpiryTimer !== null) {
      window.clearTimeout(remoteTabWindowPreviewExpiryTimer);
      remoteTabWindowPreviewExpiryTimer = null;
    }
    remoteTabWindowPreview.value = null;
  }

  function refreshRemoteTabWindowPreviewExpiry(transferId: string, sequence: number) {
    if (remoteTabWindowPreviewExpiryTimer !== null) window.clearTimeout(remoteTabWindowPreviewExpiryTimer);
    // Do not leave a stale destination preview behind when a source WebView
    // loses its final mouse-up event or closes during a drag.
    remoteTabWindowPreviewExpiryTimer = window.setTimeout(() => {
      if (remoteTabWindowPreview.value?.transferId === transferId && remoteTabWindowPreview.value.sequence === sequence) {
        clearRemoteTabWindowPreview(transferId);
      }
      remoteTabWindowPreviewExpiryTimer = null;
    }, 500);
  }
  const visibleTabWindowPreview = computed(() => remoteTabWindowPreview.value?.rect);
  const visibleTabWindowPreviewTitle = computed(() => remoteTabWindowPreview.value?.title ?? "");
  onUnmounted(() => {
    if (geometryPersistTimer !== undefined) window.clearTimeout(geometryPersistTimer);
    geometryUnlisteners.forEach((unlisten) => unlisten());
    tabWindowTransferListenerUnmounted = true;
    tabWindowInfoListenerUnmounted = true;
    tabWindowDragPreviewListenerUnmounted = true;
    const activeTransferId = nativeTabDrag.value?.payload.transferId;
    nativeTabDrag.value = null;
    nativeTabDragPreviewTransferId = null;
    if (activeTransferId) void invoke("stop_tab_drag_preview", { transferId: activeTransferId }).catch(() => undefined);
    removeTabWindowTransferListener?.();
    removeTabWindowTransferListener = null;
    removeTabWindowInfoRequestListener?.();
    removeTabWindowInfoRequestListener = null;
    removeTabWindowInfoResponseListener?.();
    removeTabWindowInfoResponseListener = null;
    for (const request of pendingTabWindowInfoRequests.values()) {
      window.clearTimeout(request.timer);
      request.resolve(null);
    }
    pendingTabWindowInfoRequests.clear();
    removeTabWindowDragPreviewListener?.();
    removeTabWindowDragPreviewListener = null;
    removeNativeTabDragPreviewReleaseListener?.();
    removeNativeTabDragPreviewReleaseListener = null;
    removeWorkspaceWindowChangeListener?.();
    removeWorkspaceWindowChangeListener = null;
    removeTabWindowConsolidationListener?.();
    removeTabWindowConsolidationListener = null;
    removeTabWindowTransferAcceptedListener?.();
    removeTabWindowTransferAcceptedListener = null;
    window.removeEventListener("pointerup", handleRemoteTabWindowPointerUp, true);
    stopTabDragPreviewBroadcast();
    clearRemoteTabWindowPreview();
    releaseWindowDragSelection?.();
    releaseWindowDragSelection = undefined;
  });
  onMounted(() => {
    let hadContent = false;
    watch(
      () => [queryStore.isOpenTabsLoaded, queryStore.tabs.length, options.canCloseEmptyWindow?.() !== false, currentWindowLabel.value] as const,
      ([loaded, count, canClose]) => {
        hadContent ||= count > 0 || !canClose;
        // An empty window may still be starting up and awaiting its transfer.
        if (loaded && hadContent && count === 0 && canClose) void closeEmptyWorkspaceWindow();
      },
      { immediate: true, flush: "post" },
    );
    if (isTauriRuntime()) {
      const persistGeometry = () => {
        if (geometryPersistTimer !== undefined) window.clearTimeout(geometryPersistTimer);
        geometryPersistTimer = window.setTimeout(() => {
          if (queryStore.isOpenTabsLoaded) void queryStore.flushPendingPersist().catch((error) => console.warn("[DBX][workspace:geometry-save]", error));
        }, 300);
      };
      void (async () => {
        try {
          const current = getCurrentWindow();
          for (const subscribe of [() => current.onMoved(persistGeometry), () => current.onResized(persistGeometry)]) {
            const unlisten = await subscribe();
            if (tabWindowTransferListenerUnmounted) unlisten();
            else geometryUnlisteners.push(unlisten);
          }
        } catch {
          /* Window events are unavailable in a browser preview. */
        }
      })();
    }
    tabWindowTransferListenerUnmounted = false;
    tabWindowInfoListenerUnmounted = false;
    tabWindowDragPreviewListenerUnmounted = false;
    void currentTabWindowLabel().then((label) => {
      currentWindowLabel.value = label;
    });
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen(WORKSPACE_WINDOWS_CHANGED_EVENT, () => void refreshOtherTabWindows()))
      .then(async (unlisten) => {
        if (tabWindowTransferListenerUnmounted) {
          unlisten();
          return;
        }
        removeWorkspaceWindowChangeListener = unlisten;
        await refreshOtherTabWindows();
        if (!tabWindowTransferListenerUnmounted) await notifyTabWindowsChanged(await currentTabWindowLabel());
      })
      .catch(() => {});
    void listenForTabWindowTransfer(handleIncomingTabWindowTransfer)
      .then((unlisten) => {
        if (tabWindowTransferListenerUnmounted) unlisten();
        else removeTabWindowTransferListener = unlisten;
      })
      .catch((error) => console.warn("[DBX][tab-window-transfer:listen:error]", error));
    void listenForTabWindowInfoRequest(handleIncomingTabWindowInfoRequest)
      .then((unlisten) => {
        if (tabWindowInfoListenerUnmounted) unlisten();
        else removeTabWindowInfoRequestListener = unlisten;
      })
      .catch((error) => console.warn("[DBX][tab-window-info-request:listen:error]", error));
    void listenForTabWindowInfoResponse(handleIncomingTabWindowInfoResponse)
      .then((unlisten) => {
        if (tabWindowInfoListenerUnmounted) unlisten();
        else removeTabWindowInfoResponseListener = unlisten;
      })
      .catch((error) => console.warn("[DBX][tab-window-info-response:listen:error]", error));
    void listenForTabWindowConsolidation(handleIncomingTabWindowConsolidation)
      .then((unlisten) => {
        if (tabWindowTransferListenerUnmounted) unlisten();
        else removeTabWindowConsolidationListener = unlisten;
      })
      .catch((error) => console.warn("[DBX][tab-window-consolidate:listen:error]", error));
    void listenForTabWindowTransferAccepted(handleIncomingTabWindowTransferAccepted)
      .then((unlisten) => {
        if (tabWindowTransferListenerUnmounted) unlisten();
        else removeTabWindowTransferAcceptedListener = unlisten;
      })
      .catch((error) => console.warn("[DBX][tab-window-transfer-accepted:listen:error]", error));
    void listenForTabWindowDragPreview(handleIncomingTabWindowDragPreview)
      .then((unlisten) => {
        if (tabWindowDragPreviewListenerUnmounted) unlisten();
        else removeTabWindowDragPreviewListener = unlisten;
      })
      .catch((error) => console.warn("[DBX][tab-window-preview:listen:error]", error));
    void listenForNativeTabDragPreviewRelease(handleNativeTabDragPreviewRelease)
      .then((unlisten) => {
        if (tabWindowDragPreviewListenerUnmounted) unlisten();
        else removeNativeTabDragPreviewReleaseListener = unlisten;
      })
      .catch((error) => console.warn("[DBX][tab-drag-preview-release:listen:error]", error));
    window.addEventListener("pointerup", handleRemoteTabWindowPointerUp, true);
  });
  function isPointerOutsideTabBar(event: MouseEvent): boolean {
    return !Array.from(document.querySelectorAll<HTMLElement>("[data-main-tab-bar]")).some((bar) => {
      const rect = bar.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && !pointOutsideRect({ x: event.clientX, y: event.clientY }, rect, 8);
    });
  }

  function queueTabDragPreviewBroadcast(payload: TabWindowTransferPayload, title: string) {
    if (!isTauriRuntime() || tabPreviewBroadcastTransferId !== payload.transferId) return;
    pendingTabPreviewBroadcast = { payload, title };
    if (tabPreviewBroadcastFrame !== null || tabPreviewBroadcastInFlight) return;
    tabPreviewBroadcastFrame = window.requestAnimationFrame(() => {
      tabPreviewBroadcastFrame = null;
      const pending = pendingTabPreviewBroadcast;
      pendingTabPreviewBroadcast = null;
      if (!pending || nativeTabDrag.value?.payload.transferId !== pending.payload.transferId || tabPreviewBroadcastTransferId !== pending.payload.transferId) return;
      tabPreviewBroadcastInFlight = true;
      void updateTabDragPreview(pending.payload, pending.title).finally(() => {
        tabPreviewBroadcastInFlight = false;
        const queued = pendingTabPreviewBroadcast;
        if (queued) queueTabDragPreviewBroadcast(queued.payload, queued.title);
      });
    });
  }

  async function updateTabDragPreview(payload: TabWindowTransferPayload, title: string) {
    try {
      const cursor = await cursorPosition();
      if (tabPreviewBroadcastTransferId !== payload.transferId) return;
      const cursorPhysical = { x: cursor.x, y: cursor.y };
      const targetWindowLabel = await tabWindowAtPhysicalPosition(cursorPhysical);
      if (tabPreviewBroadcastTransferId !== payload.transferId) return;

      if (targetWindowLabel) {
        if (tabPreviewDisplayMode !== "in-app") await hideTabDragPreviewWebview();
        if (tabPreviewBroadcastTransferId !== payload.transferId) return;
        tabPreviewDisplayMode = "in-app";
        await emitTabWindowDragPreview({
          transferId: payload.transferId,
          sourceWindowLabel: payload.sourceWindowLabel,
          targetWindowLabel,
          title,
          cursorPhysical,
          sequence: ++tabPreviewBroadcastSequence,
          visible: true,
        });
        return;
      }

      if (tabPreviewDisplayMode !== "external") {
        await emitTabWindowDragPreview({
          transferId: payload.transferId,
          sourceWindowLabel: payload.sourceWindowLabel,
          title: "",
          cursorPhysical,
          sequence: ++tabPreviewBroadcastSequence,
          visible: false,
        });
      }
      if (tabPreviewBroadcastTransferId !== payload.transferId) return;
      tabPreviewDisplayMode = "external";
      await showTabDragPreviewWebview(`${t("contextMenu.openTabInNewWindow")} · ${title}`, cursorPhysical);
    } catch (error) {
      console.warn("[DBX][tab-window-preview:update:error]", error);
    }
  }

  function startTabDragPreviewBroadcast(payload: TabWindowTransferPayload, title: string) {
    tabPreviewBroadcastTransferId = payload.transferId;
    queueTabDragPreviewBroadcast(payload, title);
    if (tabPreviewBroadcastTimer !== null) return;
    // Mouse events can pause while the cursor is above another native WebView.
    // Polling the OS cursor keeps that window's DOM preview following the drag.
    tabPreviewBroadcastTimer = window.setInterval(() => queueTabDragPreviewBroadcast(payload, title), 16);
  }

  function stopTabDragPreviewBroadcast(payload?: TabWindowTransferPayload) {
    if (tabPreviewBroadcastFrame !== null) {
      window.cancelAnimationFrame(tabPreviewBroadcastFrame);
      tabPreviewBroadcastFrame = null;
    }
    if (tabPreviewBroadcastTimer !== null) {
      window.clearInterval(tabPreviewBroadcastTimer);
      tabPreviewBroadcastTimer = null;
    }
    pendingTabPreviewBroadcast = null;
    if (!payload || tabPreviewBroadcastTransferId === payload.transferId) tabPreviewBroadcastTransferId = null;
    tabPreviewDisplayMode = null;
    void hideTabDragPreviewWebview().catch(() => undefined);
    if (!payload || !isTauriRuntime()) return;
    void emitTabWindowDragPreview({
      transferId: payload.transferId,
      sourceWindowLabel: payload.sourceWindowLabel,
      title: "",
      cursorPhysical: { x: 0, y: 0 },
      sequence: ++tabPreviewBroadcastSequence,
      visible: false,
    }).catch(() => undefined);
  }

  async function handleIncomingTabWindowDragPreview(payload: TabWindowDragPreviewPayload) {
    const lastSequence = remoteTabWindowPreviewSequences.get(payload.sourceWindowLabel) ?? -1;
    if (payload.sequence <= lastSequence) return;
    remoteTabWindowPreviewSequences.set(payload.sourceWindowLabel, payload.sequence);
    if (!payload.visible || payload.targetWindowLabel !== currentWindowLabel.value) {
      if (focusedDragPreviewWindowLabel === currentWindowLabel.value) focusedDragPreviewWindowLabel = null;
      clearRemoteTabWindowPreview(payload.transferId);
      return;
    }

    const previousRect = remoteTabWindowPreview.value?.transferId === payload.transferId ? remoteTabWindowPreview.value.rect : undefined;
    // Protect the destination before focusing it or awaiting native geometry.
    remoteTabWindowPreview.value = { transferId: payload.transferId, sourceWindowLabel: payload.sourceWindowLabel, title: payload.title, sequence: payload.sequence, rect: previousRect };
    refreshRemoteTabWindowPreviewExpiry(payload.transferId, payload.sequence);
    try {
      const currentWindow = getCurrentWindow();
      if (focusedDragPreviewWindowLabel !== currentWindow.label) {
        focusedDragPreviewWindowLabel = currentWindow.label;
        await Promise.all([currentWindow.show(), currentWindow.unminimize(), currentWindow.setFocus()]);
      }
      const [innerPosition, scaleFactor] = await Promise.all([currentWindow.innerPosition(), currentWindow.scaleFactor()]);
      if (remoteTabWindowPreview.value?.transferId !== payload.transferId || remoteTabWindowPreview.value.sequence !== payload.sequence) return;
      const cursor = {
        x: (payload.cursorPhysical.x - innerPosition.x) / scaleFactor,
        y: (payload.cursorPhysical.y - innerPosition.y) / scaleFactor,
      };
      if (cursor.x < 0 || cursor.y < 0 || cursor.x >= document.documentElement.clientWidth || cursor.y >= document.documentElement.clientHeight) {
        clearRemoteTabWindowPreview(payload.transferId);
        return;
      }
      remoteTabWindowPreview.value = {
        transferId: payload.transferId,
        sourceWindowLabel: payload.sourceWindowLabel,
        title: payload.title,
        sequence: payload.sequence,
        rect: tabDragPreviewRect(cursor, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }),
      };
    } catch {
      // A destination window may close while the global preview event is in flight.
    }
  }

  async function detachedTabWindowPlacement(event: MouseEvent): Promise<TabWindowPlacement | undefined> {
    try {
      const currentWindow = getCurrentWindow();
      const [innerPosition, scaleFactor] = await Promise.all([currentWindow.innerPosition(), currentWindow.scaleFactor()]);
      const preview = tabWindowPreviewRect({ x: event.clientX, y: event.clientY }, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
      const position = new PhysicalPosition(Math.round(innerPosition.x + preview.left * scaleFactor), Math.round(innerPosition.y + preview.top * scaleFactor)).toLogical(scaleFactor);
      return { x: position.x, y: position.y };
    } catch {
      return undefined;
    }
  }

  async function startNativeTabDragPreview(payload: TabWindowTransferPayload, event: MouseEvent) {
    if (!isTauriRuntime() || !/windows|macintosh|mac os/i.test(navigator.userAgent) || nativeTabDragPreviewTransferId) return;
    nativeTabDragPreviewTransferId = payload.transferId;
    try {
      const currentWindow = getCurrentWindow();
      const [innerPosition, scaleFactor] = await Promise.all([currentWindow.innerPosition(), currentWindow.scaleFactor()]);
      if (nativeTabDragPreviewTransferId !== payload.transferId) return;
      const preview = tabDragPreviewRect({ x: event.clientX, y: event.clientY }, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
      await invoke("start_tab_drag_preview", {
        request: {
          transferId: payload.transferId,
          sourceWindowLabel: payload.sourceWindowLabel,
          title: `${t("contextMenu.openTabInNewWindow")} · ${payload.liveTab?.title ?? payload.tab.title}`,
          left: Math.round(innerPosition.x + preview.left * scaleFactor),
          top: Math.round(innerPosition.y + preview.top * scaleFactor),
          width: Math.round(preview.width * scaleFactor),
          height: Math.round(preview.height * scaleFactor),
          grabX: Math.round((event.clientX - preview.left) * scaleFactor),
          grabY: Math.round((event.clientY - preview.top) * scaleFactor),
        },
      });
    } catch (error) {
      console.warn("[DBX][tab-drag-preview:native-host:error]", error);
      if (nativeTabDragPreviewTransferId === payload.transferId) {
        nativeTabDragPreviewTransferId = null;
      }
    }
  }

  async function reorderNativeDropInSourceTabBar(payload: TabWindowTransferPayload, release: NativeTabDragPreviewRelease): Promise<boolean> {
    try {
      const currentWindow = getCurrentWindow();
      const [innerPosition, scaleFactor] = await Promise.all([currentWindow.innerPosition(), currentWindow.scaleFactor()]);
      const clientX = (release.cursorX - innerPosition.x) / scaleFactor;
      const clientY = (release.cursorY - innerPosition.y) / scaleFactor;
      const element = document.elementFromPoint(clientX, clientY);
      const bar = element?.closest<HTMLElement>("[data-main-tab-bar]");
      if (!bar) return false;
      const groupId = bar.dataset.groupId;
      const tabTarget = element?.closest<HTMLElement>("[data-tab-id]");
      const targetId = tabTarget?.dataset.tabId;
      // Dropping back on an empty part of A's tab strip keeps the tab in place.
      if (!targetId || targetId === payload.tab.id) {
        if (groupId) queryStore.moveTabToGroup(payload.tab.id, groupId);
        return true;
      }

      const draggedTab = queryStore.tabs.find((tab) => tab.id === payload.tab.id);
      const targetTab = queryStore.tabs.find((tab) => tab.id === targetId);
      // A return to the source strip must never turn into a detached window,
      // including when the requested pinned/unpinned reorder is invalid.
      if (!draggedTab || !targetTab || draggedTab.pinned !== targetTab.pinned) return true;

      const targetRect = tabTarget.getBoundingClientRect();
      const vertical = bar.dataset.placement === "left" || bar.dataset.placement === "right";
      const before = vertical ? clientY < targetRect.top + targetRect.height / 2 : clientX < targetRect.left + targetRect.width / 2;
      const targetGroup = queryStore.groups.find((group) => group.id === groupId);
      if (targetGroup) queryStore.moveTabToGroup(payload.tab.id, targetGroup.id, targetGroup.tabIds.indexOf(targetId) + (before ? 0 : 1));
      return true;
    } catch {
      // If the source window is closing, fall through to the normal transfer path.
      return false;
    }
  }

  async function handleNativeTabDragPreviewRelease(release: NativeTabDragPreviewRelease) {
    const drag = nativeTabDrag.value;
    if (!drag || drag.payload.transferId !== release.transferId || release.sourceWindowLabel !== currentWindowLabel.value) return;
    nativeTabDrag.value = null;
    nativeTabDragPreviewTransferId = null;
    stopTabDragPreviewBroadcast(drag.payload);
    // The native host owns the mouse after the pointer leaves this WebView, so
    // its release event is also responsible for clearing the source drag state.
    cleanupSourceDrag?.();
    cleanupSourceDrag = undefined;
    const monitor = await monitorFromPoint(release.cursorX, release.cursorY).catch(() => null);
    const placement = new PhysicalPosition(release.left, release.top).toLogical(monitor?.scaleFactor ?? 1);
    // A visible target window wins in overlap cases. Only when the pointer is
    // not over B/C do we interpret a drop back on A's strip as a local reorder.
    const targetWindowLabel = await tabWindowAtCursor();
    if (!targetWindowLabel && (await reorderNativeDropInSourceTabBar(drag.payload, release))) {
      clearTabWindowTransfer(drag.payload.transferId);
      return;
    }
    await finishTabWindowTransfer(drag.payload, placement, targetWindowLabel, { x: release.cursorX, y: release.cursorY });
  }

  function handleTabPointerMove(tabId: string, event: MouseEvent) {
    if (!crossWindowTabDragPreviewEnabled.value) return;
    if (!isPointerOutsideTabBar(event)) return;
    const tab = queryStore.tabs.find((item) => item.id === tabId);
    if (!tab) return;

    if (!nativeTabDrag.value) {
      const payload = createTabWindowTransfer(tab, currentWindowLabel.value);
      nativeTabDrag.value = { payload };
      storeDetachedTabTransfer(payload);
    }

    startTabDragPreviewBroadcast(nativeTabDrag.value.payload, tabTitleText(tab));
    void startNativeTabDragPreview(nativeTabDrag.value.payload, event);
  }

  function handleTabPointerEnd(tabId: string, event: MouseEvent): boolean {
    const drag = nativeTabDrag.value;
    if (drag && nativeTabDragPreviewTransferId === drag.payload.transferId) {
      stopTabDragPreviewBroadcast(drag.payload);
      return true;
    }
    nativeTabDrag.value = null;
    stopTabDragPreviewBroadcast(drag?.payload);
    if (!drag || drag.payload.tab.id !== tabId) return false;
    if (!isPointerOutsideTabBar(event)) {
      clearTabWindowTransfer(drag.payload.transferId);
      return false;
    }
    void detachedTabWindowPlacement(event).then((placement) => finishTabWindowTransfer(drag.payload, placement));
    return true;
  }

  async function targetTabDropFromTransfer(payload: TabWindowTransferPayload): Promise<{ groupId: string; index?: number } | null> {
    if (!payload.dropCursorPhysical) return null;
    try {
      const currentWindow = getCurrentWindow();
      const [innerPosition, scaleFactor] = await Promise.all([currentWindow.innerPosition(), currentWindow.scaleFactor()]);
      const clientX = (payload.dropCursorPhysical.x - innerPosition.x) / scaleFactor;
      const clientY = (payload.dropCursorPhysical.y - innerPosition.y) / scaleFactor;
      const element = document.elementFromPoint(clientX, clientY);
      const bar = element?.closest<HTMLElement>("[data-main-tab-bar]");
      const groupId = bar?.dataset.groupId;
      if (!bar || !groupId) {
        if (queryStore.tabs.length === 0 && element?.closest("[data-editor-content]")) return { groupId: queryStore.focusedGroupId };
        return null;
      }
      const tabTarget = element?.closest<HTMLElement>("[data-tab-id]");
      const targetId = tabTarget?.dataset.tabId;
      const targetTab = targetId ? queryStore.tabs.find((tab) => tab.id === targetId) : null;
      const transferredPinned = payload.liveTab?.pinned ?? payload.tab.pinned;
      if (!targetId || !targetTab || !!targetTab.pinned !== !!transferredPinned) return { groupId };

      const targetRect = tabTarget.getBoundingClientRect();
      const vertical = bar.dataset.placement === "left" || bar.dataset.placement === "right";
      const before = vertical ? clientY < targetRect.top + targetRect.height / 2 : clientX < targetRect.left + targetRect.width / 2;
      const group = queryStore.groups.find((group) => group.id === groupId);
      return {
        groupId,
        index: group ? group.tabIds.indexOf(targetId) + (before ? 0 : 1) : undefined,
      };
    } catch {
      return null;
    }
  }

  async function acceptTabWindowTransfer(payload: TabWindowTransferPayload): Promise<boolean> {
    if (payload.sourceWindowLabel === currentWindowLabel.value) return false;
    const dropTarget = await targetTabDropFromTransfer(payload);
    if (payload.dropCursorPhysical && !dropTarget) return false;
    const entries = tabWindowTransferEntries(payload);
    if (!queryStore.importTransferredTabs(entries, payload.activeTabId)) return false;
    if (dropTarget) {
      entries.forEach((entry, index) => queryStore.moveTabToGroup(entry.tab.id, dropTarget.groupId, dropTarget.index === undefined ? undefined : dropTarget.index + index));
      queryStore.activateTab(payload.activeTabId ?? payload.tab.id);
    }
    await queryStore.flushPendingPersist();
    // The actual destination tab is now rendered, so any optimistic drag chip
    // in this WebView must disappear even if its final hide event was delayed.
    clearRemoteTabWindowPreview(payload.transferId);
    await markTabWindowTransferAccepted(payload.transferId);
    clearTabWindowTransfer(payload.transferId);
    return true;
  }

  function handleIncomingTabWindowTransfer(payload: TabWindowTransferPayload) {
    void acceptTabWindowTransfer(payload).catch((error) => console.warn("[DBX][workspace:receive-error]", error));
  }

  function activeTabWindowTitle(): string {
    const activeTab = queryStore.tabs.find((tab) => tab.id === queryStore.activeTabId);
    return activeTab ? tabTitleText(activeTab) : "";
  }

  function handleIncomingTabWindowInfoRequest(payload: TabWindowInfoRequest) {
    if (payload.sourceWindowLabel === currentWindowLabel.value) return;
    void sendTabWindowInfoResponse(payload.sourceWindowLabel, {
      requestId: payload.requestId,
      windowLabel: currentWindowLabel.value,
      activeTabTitle: activeTabWindowTitle(),
    });
  }

  function handleIncomingTabWindowInfoResponse(payload: TabWindowInfoResponse) {
    const pending = pendingTabWindowInfoRequests.get(payload.requestId);
    if (!pending || pending.targetWindowLabel !== payload.windowLabel) return;
    pendingTabWindowInfoRequests.delete(payload.requestId);
    window.clearTimeout(pending.timer);
    pending.resolve(payload.activeTabTitle || null);
  }

  function handleIncomingTabWindowConsolidation(payload: TabWindowConsolidateRequest) {
    if (currentWindowLabel.value === "main" || payload.targetWindowLabel === currentWindowLabel.value) return;
    void moveTabsToWindow(queryStore.tabs, payload.targetWindowLabel).catch((error) => console.warn("[DBX][tab-window-consolidate:error]", error));
  }

  function handleIncomingTabWindowTransferAccepted(payload: TabWindowTransferAcceptedPayload) {
    const drag = nativeTabDrag.value;
    if (!drag || drag.payload.transferId !== payload.transferId) return;
    nativeTabDrag.value = null;
    nativeTabDragPreviewTransferId = null;
    stopTabDragPreviewBroadcast(drag.payload);
    cleanupSourceDrag?.();
    cleanupSourceDrag = undefined;
    void finishSourceTransfer(drag.payload).catch((error) => console.warn("[DBX][tab-window-transfer:source-finish-error]", error));
  }

  async function handleRemoteTabWindowPointerUp() {
    const preview = remoteTabWindowPreview.value;
    if (!preview) return;
    const payload = await readSharedTabWindowTransfer(preview.transferId);
    if (!payload) {
      clearRemoteTabWindowPreview(preview.transferId);
      return;
    }
    const cursor = await cursorPosition().catch(() => null);
    const delivered = cursor ? { ...payload, dropCursorPhysical: { x: cursor.x, y: cursor.y } } : payload;
    const accepted = await acceptTabWindowTransfer(delivered);
    if (accepted) {
      await sendTabWindowTransferAccepted(preview.sourceWindowLabel, { transferId: preview.transferId });
    }
  }

  async function finishTabWindowTransfer(payload: TabWindowTransferPayload, placement?: TabWindowPlacement, knownTargetWindowLabel?: string | null, dropCursorPhysical?: { x: number; y: number }) {
    // Resolve the destination from the OS cursor after pointer capture releases.
    // This keeps the move path independent from WebView2 HTML5 drag delivery.
    const targetWindowLabel = knownTargetWindowLabel === undefined ? await tabWindowAtCursor() : knownTargetWindowLabel;
    if (targetWindowLabel) {
      const cursor = dropCursorPhysical ?? (await cursorPosition().catch(() => null));
      const deliveredPayload = cursor ? { ...payload, dropCursorPhysical: { x: cursor.x, y: cursor.y } } : payload;
      const delivered = await sendTabWindowTransfer(targetWindowLabel, deliveredPayload);
      if (delivered && (await waitForTabWindowTransferAccepted(payload.transferId))) {
        await finishSourceTransfer(payload);
        return;
      }
      // The pointer was inside a DBX window. Preserve the source tab rather than
      // creating an unexpected third window if its receiver is not ready.
      clearTabWindowTransfer(payload.transferId);
      return;
    }
    if (!isTauriRuntime()) {
      clearTabWindowTransfer(payload.transferId);
      return;
    }

    const created = await createDetachedTabWindow(payload, placement);
    if (created && (await waitForTabWindowTransferAccepted(payload.transferId, 10_000))) await finishSourceTransfer(payload);
  }

  async function finishSourceTransfer(payload: TabWindowTransferPayload) {
    if (completedTransferIds.has(payload.transferId) || finishingTransferIds.has(payload.transferId)) return;
    finishingTransferIds.add(payload.transferId);
    try {
      for (const entry of tabWindowTransferEntries(payload)) queryStore.detachTabForTransfer(entry.tab.id);
      await queryStore.flushPendingPersist();
      clearTabWindowTransfer(payload.transferId);
      completedTransferIds.add(payload.transferId);
      await closeEmptyWorkspaceWindow();
    } finally {
      finishingTransferIds.delete(payload.transferId);
    }
  }

  async function openTabInNewWindow(tab: QueryTab) {
    await openTabsInNewWindow([tab]);
  }

  async function openTabsInNewWindow(tabs: readonly QueryTab[]) {
    if (!isTauriRuntime()) return;
    const payload = createTabWindowGroupTransfer(tabs, currentWindowLabel.value, queryStore.activeTabId);
    if (!payload) return;
    const created = await createDetachedTabWindow(payload);
    if (created && (await waitForTabWindowTransferAccepted(payload.transferId, 10_000))) {
      await finishSourceTransfer(payload);
    }
  }

  function tabWindowTargetLabel(window: TabWindowTarget): string {
    const detachedWindowIndex = otherTabWindows.value.filter((target) => target.label !== "main").findIndex((target) => target.label === window.label) + 1;
    const windowName = window.label === "main" ? t("contextMenu.mainWindow") : t("contextMenu.detachedWindow", { number: detachedWindowIndex });
    return window.title && window.title !== "DBX" ? `${windowName} · ${window.title}` : windowName;
  }

  async function refreshOtherTabWindows() {
    const revision = ++windowListRevision;
    const windows = await listOtherTabWindows().catch(() => null);
    if (!windows || tabWindowTransferListenerUnmounted || revision !== windowListRevision) return;
    otherTabWindows.value = windows;
    const titledWindows = await Promise.all(
      windows.map(async (window) => ({
        ...window,
        title: (await requestOtherTabWindowTitle(window.label)) ?? window.title,
      })),
    );
    if (!tabWindowTransferListenerUnmounted && revision === windowListRevision) otherTabWindows.value = titledWindows;
  }

  async function requestOtherTabWindowTitle(targetWindowLabel: string): Promise<string | null> {
    const requestId = uuid();
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        const pending = pendingTabWindowInfoRequests.get(requestId);
        if (!pending) return;
        pendingTabWindowInfoRequests.delete(requestId);
        resolve(null);
      }, 300);
      pendingTabWindowInfoRequests.set(requestId, { targetWindowLabel, resolve, timer });
      void requestTabWindowInfo(targetWindowLabel, { requestId, sourceWindowLabel: currentWindowLabel.value }).then((sent) => {
        if (sent) return;
        const pending = pendingTabWindowInfoRequests.get(requestId);
        if (!pending) return;
        pendingTabWindowInfoRequests.delete(requestId);
        window.clearTimeout(timer);
        resolve(null);
      });
    });
  }
  async function moveTabToWindow(tab: QueryTab, targetWindowLabel: string) {
    await moveTabsToWindow([tab], targetWindowLabel);
  }

  async function moveTabsToWindow(tabs: readonly QueryTab[], targetWindowLabel: string) {
    if (!isTauriRuntime()) return;
    const payload = createTabWindowGroupTransfer(tabs, currentWindowLabel.value, queryStore.activeTabId);
    if (!payload) return;
    const delivered = await sendTabWindowTransfer(targetWindowLabel, payload);
    if (delivered && (await waitForTabWindowTransferAccepted(payload.transferId, 2000))) {
      await finishSourceTransfer(payload);
    }
    clearTabWindowTransfer(payload.transferId);
  }

  async function focusWorkspaceWindow(targetWindowLabel: string) {
    await focusTabWindow(targetWindowLabel);
    await refreshOtherTabWindows();
  }

  async function consolidateWorkspaceWindows() {
    if (currentWindowLabel.value !== "main") return;
    const targets = otherTabWindows.value.filter((window) => window.label.startsWith("dbx-tab-"));
    await Promise.all(targets.map((window) => requestTabWindowConsolidation(window.label, { targetWindowLabel: "main" })));
    await refreshOtherTabWindows();
  }

  function move(tabId: string, event: PointerEvent, cleanup: () => void): boolean {
    if (!isTauriRuntime() || !crossWindowTabDragPreviewEnabled.value) return false;
    cleanupSourceDrag = cleanup;
    handleTabPointerMove(tabId, event);
    return !!nativeTabDrag.value && (nativeTabDragPreviewTransferId !== null || isPointerOutsideTabBar(event));
  }

  function end(tabId: string, event: PointerEvent): boolean {
    const handled = handleTabPointerEnd(tabId, event);
    if (!nativeTabDragPreviewTransferId) cleanupSourceDrag = undefined;
    return handled;
  }

  function cancel() {
    const drag = nativeTabDrag.value;
    nativeTabDrag.value = null;
    nativeTabDragPreviewTransferId = null;
    if (drag) {
      void invoke("stop_tab_drag_preview", { transferId: drag.payload.transferId }).catch(() => undefined);
      clearTabWindowTransfer(drag.payload.transferId);
    }
    stopTabDragPreviewBroadcast(drag?.payload);
    cleanupSourceDrag = undefined;
  }

  return { currentWindowLabel, move, end, cancel, otherTabWindows, refreshOtherTabWindows, focusWorkspaceWindow, consolidateWorkspaceWindows, openTabInNewWindow, openTabsInNewWindow, moveTabToWindow, moveTabsToWindow, tabWindowTargetLabel, visibleTabWindowPreview, visibleTabWindowPreviewTitle };
}

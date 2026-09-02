<script setup lang="ts">
import { computed, ref, watch, nextTick, onMounted, onUnmounted } from "vue";
import type { CSSProperties } from "vue";
import { useI18n } from "vue-i18n";
import { X, Pin, ChevronDown, Search, Table2, Code2, TableProperties, PencilRuler, KeyRound, Pencil, Package, Lock, Copy, AlertTriangle, Network, Minimize2, Maximize2, Settings, CalendarClock, Activity, Gauge, ShieldCheck, Database, GitBranch, Crosshair, ExternalLink } from "@lucide/vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import TabExecutionStatus from "@/components/layout/TabExecutionStatus.vue";
import TabDragPreviewChip from "@/components/layout/TabDragPreviewChip.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTabScroll } from "@/composables/useTabScroll";
import { useTabDrag } from "@/composables/useTabDrag";
import { connectionColor, isConnectionReadonly, tabDisplayTitle, tabTooltipLines } from "@/lib/tabs/tabPresentation";
import { hexToRgba } from "@/lib/common/color";
import { copyToClipboard } from "@/lib/common/clipboard";
import { uuid } from "@/lib/common/utils";
import { useToast } from "@/composables/useToast";
import { activeTabSidebarTarget } from "@/lib/sidebar/sidebarActiveTabTarget";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { invoke } from "@tauri-apps/api/core";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import { cursorPosition, getCurrentWindow, monitorFromPoint } from "@tauri-apps/api/window";
import { pointOutsideRect, tabDragPreviewRect, tabWindowPreviewRect } from "@/lib/tabs/tabWindowPreview";
import {
  createDetachedTabWindow,
  createTabWindowTransfer,
  currentTabWindowLabel,
  listOtherTabWindows,
  listenForTabWindowInfoRequest,
  listenForTabWindowInfoResponse,
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
  tabWindowAtCursor,
  waitForTabWindowTransferAccepted,
  type TabWindowPlacement,
  type TabWindowDragPreviewPayload,
  type TabWindowInfoRequest,
  type TabWindowInfoResponse,
  type TabWindowTarget,
  type NativeTabDragPreviewRelease,
  type TabWindowTransferPayload,
} from "@/lib/tabs/tabWindowTransfer";
import type { QueryTab } from "@/types/database";

const props = defineProps<{
  driverStoreOpen?: boolean;
  driverStoreActive?: boolean;
  settingsPageOpen?: boolean;
  settingsPageActive?: boolean;
  agentDriverUpdateCount?: number;
}>();

const emit = defineEmits<{
  "activate-tab": [];
  "locate-tab": [tab: QueryTab];
  "activate-driver-store": [];
  "close-driver-store": [];
  "activate-settings-page": [];
  "close-settings-page": [];
  "save-tab": [tabId: string];
  "discard-tab-close": [];
  "save-all-tab-close": [];
  "discard-all-tab-close": [];
  "cancel-tab-close": [];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const { toast } = useToast();
const tabBarRef = ref<HTMLElement | null>(null);
const tabDrag = useTabDrag(
  (draggedId, targetId, position) => {
    return queryStore.reorderTab(draggedId, targetId, position);
  },
  {
    onMove: handleTabPointerMove,
    onEnd: handleTabPointerEnd,
  },
);
// Tauri resolves the permanent label asynchronously. A per-WebView fallback
// keeps early drags from mistaking two newly opened windows for the same one.
const currentWindowLabel = ref(`dbx-webview-${Math.random().toString(36).slice(2)}`);
const nativeTabDrag = ref<{ payload: TabWindowTransferPayload } | null>(null);
const otherTabWindows = ref<TabWindowTarget[]>([]);
const nativeTabDragPreviewActive = ref(false);
let nativeTabDragPreviewTransferId: string | null = null;
let removeTabWindowTransferListener: (() => void) | null = null;
let removeTabWindowInfoRequestListener: (() => void) | null = null;
let removeTabWindowInfoResponseListener: (() => void) | null = null;
let removeTabWindowDragPreviewListener: (() => void) | null = null;
let removeNativeTabDragPreviewReleaseListener: (() => void) | null = null;
let tabWindowTransferListenerUnmounted = false;
let tabWindowInfoListenerUnmounted = false;
let tabWindowDragPreviewListenerUnmounted = false;
const pendingTabWindowInfoRequests = new Map<string, { targetWindowLabel: string; resolve: (title: string | null) => void; timer: number }>();

const remoteTabWindowPreview = ref<{ transferId: string; title: string; sequence: number; rect: ReturnType<typeof tabDragPreviewRect> } | null>(null);
const remoteTabWindowPreviewSequences = new Map<string, number>();
let remoteTabWindowPreviewExpiryTimer: number | null = null;
let tabPreviewBroadcastFrame: number | null = null;
let tabPreviewBroadcastTimer: number | null = null;
let pendingTabPreviewBroadcast: { payload: TabWindowTransferPayload; title: string } | null = null;
let tabPreviewBroadcastTransferId: string | null = null;
let tabPreviewBroadcastSequence = 0;

function clearRemoteTabWindowPreview(transferId?: string) {
  if (remoteTabWindowPreviewExpiryTimer !== null) {
    window.clearTimeout(remoteTabWindowPreviewExpiryTimer);
    remoteTabWindowPreviewExpiryTimer = null;
  }
  if (!transferId || remoteTabWindowPreview.value?.transferId === transferId) remoteTabWindowPreview.value = null;
}

function refreshRemoteTabWindowPreviewExpiry(transferId: string, sequence: number) {
  if (remoteTabWindowPreviewExpiryTimer !== null) window.clearTimeout(remoteTabWindowPreviewExpiryTimer);
  // Do not leave a stale destination preview behind when a source WebView
  // loses its final mouse-up event or closes during a drag.
  remoteTabWindowPreviewExpiryTimer = window.setTimeout(() => {
    if (remoteTabWindowPreview.value?.transferId === transferId && remoteTabWindowPreview.value.sequence === sequence) {
      remoteTabWindowPreview.value = null;
    }
    remoteTabWindowPreviewExpiryTimer = null;
  }, 500);
}
const tabWindowPreview = computed(() => {
  if (!tabDrag.state.active || !tabDrag.state.draggedId) return null;
  const tabBarRect = tabBarRef.value?.getBoundingClientRect();
  if (!tabBarRect || !pointOutsideRect({ x: tabDrag.state.currentX, y: tabDrag.state.currentY }, tabBarRect, 8)) return null;
  return tabDragPreviewRect({ x: tabDrag.state.currentX, y: tabDrag.state.currentY }, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
});
const tabWindowPreviewTitle = computed(() => {
  const tabId = tabDrag.state.draggedId;
  const tab = tabId ? queryStore.tabs.find((item) => item.id === tabId) : null;
  return tab ? tabTitleText(tab) : "";
});
const visibleTabWindowPreview = computed(() => tabWindowPreview.value ?? remoteTabWindowPreview.value?.rect ?? null);
const visibleTabWindowPreviewTitle = computed(() => (tabWindowPreview.value ? tabWindowPreviewTitle.value : (remoteTabWindowPreview.value?.title ?? "")));
const editingTabId = ref<string | null>(null);
const editingTitle = ref("");
const isClassicLayout = computed(() => settingsStore.editorSettings.appLayout === "classic");
const isWrapLayout = computed(() => settingsStore.editorSettings.tabLayout === "wrap");
const crossWindowTabDragPreviewEnabled = computed(() => settingsStore.editorSettings.crossWindowTabDragPreviewEnabled);
const fixedTabs = computed(() => queryStore.tabs.filter((tab) => tab.pinned));
const regularTabs = computed(() => queryStore.tabs.filter((tab) => !tab.pinned));
const hasFixedTabs = computed(() => fixedTabs.value.length > 0);
const regularSurfaceCount = computed(() => regularTabs.value.length + (props.driverStoreOpen ? 1 : 0) + (props.settingsPageOpen ? 1 : 0));
const closeConfirmDirtyCount = computed(() => queryStore.closeConfirmDirtyTabIds.length);
const showCloseConfirmBulkActions = computed(() => closeConfirmDirtyCount.value > 1);
const closeConfirmDirtyTabs = computed(() => queryStore.closeConfirmDirtyTabIds.map((id) => queryStore.tabs.find((tab) => tab.id === id)).filter((tab): tab is QueryTab => !!tab));
const closeConfirmCurrentTitle = computed(() => {
  const focusedTab = closeConfirmDirtyTabs.value.find((tab) => tab.id === queryStore.pendingCloseTabId) ?? closeConfirmDirtyTabs.value[0];
  return focusedTab ? tabDisplayTitle(focusedTab, t) : "";
});
const closeConfirmMessage = computed(() => {
  const params = {
    count: closeConfirmDirtyCount.value,
    title: closeConfirmCurrentTitle.value,
  };
  if (closeConfirmDirtyCount.value > 1) {
    if (queryStore.closeConfirmContext === "app") return t("editor.unsavedChangesAppCloseMultipleMessage", params);
    return t("editor.unsavedChangesBatchCloseMultipleMessage", params);
  }
  if (queryStore.closeConfirmContext === "app") return t("editor.unsavedChangesAppCloseMessage", params);
  return t("editor.unsavedChangesMessage", params);
});
const closeConfirmListOpen = ref(false);
let closeConfirmListCloseTimer: ReturnType<typeof setTimeout> | null = null;
const compactTabTitle = computed({
  get: () => settingsStore.editorSettings.compactTabTitle,
  set: (checked: boolean | "indeterminate") => {
    settingsStore.updateEditorSettings({ compactTabTitle: checked === true });
  },
});

function openCloseConfirmList() {
  if (closeConfirmListCloseTimer) {
    clearTimeout(closeConfirmListCloseTimer);
    closeConfirmListCloseTimer = null;
  }
  closeConfirmListOpen.value = true;
}

function scheduleCloseConfirmListClose() {
  if (closeConfirmListCloseTimer) clearTimeout(closeConfirmListCloseTimer);
  closeConfirmListCloseTimer = setTimeout(() => {
    closeConfirmListOpen.value = false;
    closeConfirmListCloseTimer = null;
  }, 120);
}

onUnmounted(() => {
  tabWindowTransferListenerUnmounted = true;
  tabWindowInfoListenerUnmounted = true;
  tabWindowDragPreviewListenerUnmounted = true;
  const activeTransferId = nativeTabDrag.value?.payload.transferId;
  nativeTabDrag.value = null;
  nativeTabDragPreviewTransferId = null;
  nativeTabDragPreviewActive.value = false;
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
  stopTabDragPreviewBroadcast();
  clearRemoteTabWindowPreview();
  if (closeConfirmListCloseTimer) {
    clearTimeout(closeConfirmListCloseTimer);
    closeConfirmListCloseTimer = null;
  }
});

onMounted(() => {
  tabWindowTransferListenerUnmounted = false;
  tabWindowInfoListenerUnmounted = false;
  tabWindowDragPreviewListenerUnmounted = false;
  void currentTabWindowLabel().then((label) => {
    currentWindowLabel.value = label;
  });
  void refreshOtherTabWindows();
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
});

watch(
  () => queryStore.showCloseConfirm,
  (open) => {
    if (!open) closeConfirmListOpen.value = false;
  },
);

function toggleCompactTabTitle() {
  compactTabTitle.value = !compactTabTitle.value;
}

function canRenameTab(tab: QueryTab) {
  return tab.mode === "query";
}

function startRenameTab(tab: QueryTab) {
  if (!canRenameTab(tab)) return;
  editingTabId.value = tab.id;
  editingTitle.value = tab.title;
  nextTick(() => {
    const input = document.querySelector<HTMLInputElement>(`[data-tab-title-input="${tab.id}"]`);
    if (input) {
      input.focus();
      const dotIndex = input.value.lastIndexOf(".");
      const selectEnd = dotIndex > 0 ? dotIndex : input.value.length;
      input.setSelectionRange(0, selectEnd);
    }
  });
}

function commitRenameTab(tab: QueryTab) {
  if (editingTabId.value !== tab.id) return;
  const title = editingTitle.value.trim();
  if (title) queryStore.renameTab(tab.id, title);
  editingTabId.value = null;
}

function cancelRenameTab() {
  editingTabId.value = null;
}

function isDirtyTab(tab: QueryTab) {
  return queryStore.isTabDirty(tab);
}

function tabTitleLabel(tab: QueryTab) {
  const title = tabDisplayTitle(tab, t);
  return isDirtyTab(tab) ? `* ${title}` : title;
}

function tabTitleText(tab: QueryTab) {
  return tabDisplayTitle(tab, t);
}

function tabTitleStyle(tab: QueryTab): CSSProperties | undefined {
  if (!isDirtyTab(tab)) return undefined;
  return {
    fontStyle: "italic",
    fontWeight: 700,
    transform: "skewX(-8deg)",
    transformOrigin: "left center",
  };
}

type SpecialRegularSurface = "driverStore" | "settings";

function closeSpecialRegularSurfaces(keep?: SpecialRegularSurface) {
  if (keep !== "driverStore" && props.driverStoreOpen) emit("close-driver-store");
  if (keep !== "settings" && props.settingsPageOpen) emit("close-settings-page");
}

function closeOtherRegularTabsFromTab(tab: QueryTab) {
  queryStore.closeOtherRegularTabs(tab.id);
  closeSpecialRegularSurfaces();
}

function tabsToRightInGroup(tab: QueryTab) {
  const groupedTabs = tab.pinned ? fixedTabs.value : regularTabs.value;
  const targetIndex = groupedTabs.findIndex((item) => item.id === tab.id);
  return targetIndex < 0 ? [] : groupedTabs.slice(targetIndex + 1);
}

function hasTabsToRight(tab: QueryTab) {
  return tabsToRightInGroup(tab).length > 0 || (!tab.pinned && (!!props.settingsPageOpen || !!props.driverStoreOpen));
}

function closeTabsToRightFromTab(tab: QueryTab) {
  const shouldActivateTarget = !tab.pinned && (!!props.settingsPageActive || !!props.driverStoreActive);
  queryStore.closeRightTabs(tab.id, () => {
    if (tab.pinned) return;
    closeSpecialRegularSurfaces();
    if (shouldActivateTarget) activateTab(tab.id);
  });
}

function hasSpecialRegularSurfaceToRight(surface: SpecialRegularSurface) {
  return surface === "settings" && !!props.driverStoreOpen;
}

function closeSpecialRegularSurfacesToRight(surface: SpecialRegularSurface) {
  if (surface !== "settings" || !props.driverStoreOpen) return;
  const shouldActivateSettings = !!props.driverStoreActive;
  emit("close-driver-store");
  if (shouldActivateSettings) emit("activate-settings-page");
}

function closeAllRegularSurfaces() {
  queryStore.closeRegularTabs();
  closeSpecialRegularSurfaces();
}

function closeOtherActiveTabs() {
  if (props.settingsPageActive) {
    queryStore.closeRegularTabs();
    closeSpecialRegularSurfaces("settings");
    return;
  }
  if (props.driverStoreActive) {
    queryStore.closeRegularTabs();
    closeSpecialRegularSurfaces("driverStore");
    return;
  }

  const tab = queryStore.tabs.find((item) => item.id === queryStore.activeTabId);
  if (!tab) return;
  if (tab.pinned) queryStore.closeOtherFixedTabs(tab.id);
  else closeOtherRegularTabsFromTab(tab);
}

defineExpose({ closeOtherActiveTabs });

function getSpecialRegularTabMenuItems(surface: SpecialRegularSurface): ContextMenuItem[] {
  const keep = surface;
  const closeCurrent = surface === "driverStore" ? () => emit("close-driver-store") : () => emit("close-settings-page");
  const closeOtherDisabled = regularSurfaceCount.value <= 1;
  const closeOtherLabel = hasFixedTabs.value ? t("contextMenu.closeOtherRegularTabs") : t("contextMenu.closeOtherTabs");
  const closeAllLabel = hasFixedTabs.value ? t("contextMenu.closeAllRegularTabs") : t("contextMenu.closeAllTabs");

  return [
    {
      label: compactTabTitle.value ? t("contextMenu.fullTabTitle") : t("contextMenu.compactTabTitle"),
      action: toggleCompactTabTitle,
      icon: compactTabTitle.value ? Maximize2 : Minimize2,
    },
    { label: "", separator: true },
    { label: t("contextMenu.closeTab"), action: closeCurrent, icon: X },
    {
      label: closeOtherLabel,
      action: () => {
        queryStore.closeRegularTabs();
        closeSpecialRegularSurfaces(keep);
      },
      disabled: closeOtherDisabled,
      icon: X,
      shortcut: settingsStore.editorSettings.shortcuts.closeOtherTabs,
    },
    {
      label: t("contextMenu.closeRightTabs"),
      action: () => closeSpecialRegularSurfacesToRight(surface),
      disabled: !hasSpecialRegularSurfaceToRight(surface),
      icon: X,
    },
    {
      label: closeAllLabel,
      action: closeAllRegularSurfaces,
      variant: "destructive" as const,
      icon: X,
    },
  ];
}

function getTabMenuItems(tab: QueryTab): ContextMenuItem[] {
  const closeCurrentLabel = tab.pinned ? t("contextMenu.closeFixedTab") : t("contextMenu.closeTab");
  const closeOtherLabel = tab.pinned ? t("contextMenu.closeOtherFixedTabs") : hasFixedTabs.value ? t("contextMenu.closeOtherRegularTabs") : t("contextMenu.closeOtherTabs");
  const closeAllLabel = tab.pinned ? t("contextMenu.closeAllFixedTabs") : hasFixedTabs.value ? t("contextMenu.closeAllRegularTabs") : t("contextMenu.closeAllTabs");
  const closeOtherDisabled = tab.pinned ? fixedTabs.value.length <= 1 : regularSurfaceCount.value <= 1;
  const closeOtherAction = tab.pinned ? () => queryStore.closeOtherFixedTabs(tab.id) : () => closeOtherRegularTabsFromTab(tab);
  const closeAllAction = tab.pinned ? () => queryStore.closeFixedTabs() : closeAllRegularSurfaces;

  return [
    {
      label: compactTabTitle.value ? t("contextMenu.fullTabTitle") : t("contextMenu.compactTabTitle"),
      action: toggleCompactTabTitle,
      icon: compactTabTitle.value ? Maximize2 : Minimize2,
    },
    {
      label: t("contextMenu.renameTab"),
      action: () => startRenameTab(tab),
      icon: Pencil,
      visible: canRenameTab(tab),
    },
    {
      label: t("contextMenu.duplicateTab"),
      action: () => queryStore.duplicateTab(tab.id),
      icon: Copy,
      visible: canRenameTab(tab),
    },
    {
      label: t("contextMenu.openTabInNewWindow"),
      action: () => void openTabInNewWindow(tab),
      icon: ExternalLink,
      visible: isTauriRuntime(),
    },
    {
      label: t("contextMenu.moveTabToAnotherWindow"),
      icon: ExternalLink,
      visible: otherTabWindows.value.length > 0,
      children: otherTabWindows.value.map((window) => ({
        label: tabWindowTargetLabel(window),
        action: () => void moveTabToWindow(tab, window.label),
      })),
    },
    {
      label: t("contextMenu.copyName"),
      action: async () => {
        try {
          await copyToClipboard(tabDisplayTitle(tab, t));
          toast(t("connection.copied"), 2000);
        } catch (e: any) {
          toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
        }
      },
      icon: Copy,
    },
    {
      label: t("sidebar.locateActiveTab"),
      action: () => emit("locate-tab", tab),
      icon: Crosshair,
      visible: !!activeTabSidebarTarget(tab),
    },
    { label: "", separator: true },
    {
      label: tab.pinned ? t("contextMenu.unfixTab") : t("contextMenu.fixTab"),
      action: () => queryStore.togglePinnedTab(tab.id),
      icon: Pin,
      iconClass: tab.pinned ? "fill-current" : "",
    },
    { label: "", separator: true },
    { label: closeCurrentLabel, action: () => queryStore.closeTab(tab.id), icon: X },
    {
      label: closeOtherLabel,
      action: closeOtherAction,
      disabled: closeOtherDisabled,
      icon: X,
      shortcut: settingsStore.editorSettings.shortcuts.closeOtherTabs,
    },
    {
      label: t("contextMenu.closeRightTabs"),
      action: () => closeTabsToRightFromTab(tab),
      disabled: !hasTabsToRight(tab),
      icon: X,
    },
    {
      label: closeAllLabel,
      action: closeAllAction,
      variant: "destructive" as const,
      icon: X,
    },
  ];
}

function handleSaveAndClose() {
  const id = queryStore.saveAndClosePendingTab();
  if (id) emit("save-tab", id);
}

function handleDiscardAndClose() {
  queryStore.forceClosePendingTab();
  emit("discard-tab-close");
}

function handleSaveAllAndClose() {
  emit("save-all-tab-close");
}

function handleDiscardAllAndClose() {
  queryStore.forceCloseAllPendingTabs();
  emit("discard-all-tab-close");
}

function handleCancelClose() {
  queryStore.cancelClosePendingTab();
  emit("cancel-tab-close");
}

const tabsContainerRef = ref<HTMLElement | null>(null);
const { hasTabOverflow, scrollThumbLeftPercent, scrollThumbWidthPercent, isScrollbarDragging, updateScrollButtons, onTabsWheel, startScrollbarDrag } = useTabScroll(tabsContainerRef);
const fixedTabsContainerRef = ref<HTMLElement | null>(null);
const {
  hasTabOverflow: hasFixedTabOverflow,
  scrollThumbLeftPercent: fixedScrollThumbLeftPercent,
  scrollThumbWidthPercent: fixedScrollThumbWidthPercent,
  isScrollbarDragging: isFixedScrollbarDragging,
  updateScrollButtons: updateFixedScrollButtons,
  onTabsWheel: onFixedTabsWheel,
  startScrollbarDrag: startFixedScrollbarDrag,
} = useTabScroll(fixedTabsContainerRef);
const tabScrollBehavior = ref<ScrollBehavior>("smooth");

function updateAllScrollButtons() {
  updateScrollButtons();
  updateFixedScrollButtons();
}

function activeTabScrollInline(container: HTMLElement, tabId: string | null): ScrollLogicalPosition {
  if (!tabId) return "center";
  const lastRegularTab = regularTabs.value[regularTabs.value.length - 1];
  const lastFixedTab = fixedTabs.value[fixedTabs.value.length - 1];
  if (container === tabsContainerRef.value && lastRegularTab?.id === tabId) return "end";
  if (container === fixedTabsContainerRef.value && lastFixedTab?.id === tabId) return "end";
  return "center";
}

watch(
  () => queryStore.tabs.map((tab) => `${tab.id}:${tab.pinned ? "1" : "0"}`).join("|"),
  () => {
    nextTick(updateAllScrollButtons);
  },
);

watch(
  () => queryStore.activeTabId,
  () => {
    nextTick(() => {
      if (!isWrapLayout.value) {
        for (const container of [tabsContainerRef.value, fixedTabsContainerRef.value]) {
          if (!container) continue;
          const activeEl = container.querySelector('[data-active-tab="true"]');
          if (activeEl) {
            activeEl.scrollIntoView({ behavior: tabScrollBehavior.value, block: "nearest", inline: activeTabScrollInline(container, queryStore.activeTabId) });
            break;
          }
        }
      }
      updateAllScrollButtons();
      tabScrollBehavior.value = "smooth";
    });
  },
);

watch(
  () => props.driverStoreActive,
  (show) => {
    if (!show) return;
    nextTick(() => {
      if (isWrapLayout.value) return;
      const container = tabsContainerRef.value;
      if (!container) return;
      const el = container.querySelector("[data-driver-store-tab]");
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      }
      updateAllScrollButtons();
    });
  },
);

watch(
  () => props.settingsPageActive,
  (show) => {
    if (!show) return;
    nextTick(() => {
      if (isWrapLayout.value) return;
      const container = tabsContainerRef.value;
      if (!container) return;
      const el = container.querySelector("[data-settings-page-tab]");
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      }
      updateAllScrollButtons();
    });
  },
);

function tabColorStyle(tab: QueryTab) {
  const color = connectionColor(tab.connectionId);
  const isActive = tab.id === queryStore.activeTabId && !props.driverStoreActive && !props.settingsPageActive;
  const isClassic = isClassicLayout.value;
  if (!color) {
    if (isClassic) {
      return isActive ? { boxShadow: "inset 0 -2px 0 var(--ring)" } : undefined;
    }
    return isActive
      ? {
          borderColor: "var(--ring)",
        }
      : undefined;
  }

  if (isClassic) {
    return {
      "--app-tab-background": hexToRgba(color, isActive ? 0.16 : 0.07),
      "--app-tab-hover-background": hexToRgba(color, 0.14),
      boxShadow: isActive ? `inset 0 -2px 0 ${color}` : undefined,
    };
  }

  return {
    "--app-tab-background": hexToRgba(color, isActive ? 0.16 : 0.09),
    "--app-tab-hover-background": hexToRgba(color, 0.16),
    borderColor: isActive ? hexToRgba(color, 0.72) : hexToRgba(color, 0.18),
  };
}

function specialTabActiveStyle(active: boolean | undefined): CSSProperties | undefined {
  if (!active) return undefined;
  return isClassicLayout.value ? { boxShadow: "inset 0 -2px 0 var(--ring)" } : { borderColor: "var(--ring)" };
}

function tabIconClass(tab: QueryTab) {
  if (tab.externalSqlFileMissing) return "text-amber-600 dark:text-amber-400";
  if (tab.mode === "mq") return "";
  if (tab.mode === "databases" || tab.mode === "objects") return "text-amber-500 dark:text-amber-400";
  if (tab.mode === "data" || tab.mode === "mongo" || tab.mode === "vector" || tab.mode === "redis" || tab.mode === "hbase" || tab.mode === "structure") return "text-emerald-600 dark:text-emerald-400";
  return "text-blue-600 dark:text-blue-400";
}

function tabDatabaseIconType(tab: QueryTab) {
  const connection = connectionStore.getConfig(tab.connectionId);
  if (!connection) return "mq";
  if (connection.db_type === "mq") {
    const externalConfig = connection.external_config as { systemKind?: unknown } | undefined;
    const systemKind = typeof externalConfig?.systemKind === "string" ? externalConfig.systemKind : "";
    if (connection.driver_profile === "kafka" || systemKind === "kafka") return "kafka";
    if (connection.driver_profile === "rocketmq" || systemKind === "rocketmq") return "rocketmq";
    if (connection.driver_profile === "rabbitmq" || systemKind === "rabbitmq") return "rabbitmq";
    if (connection.driver_profile === "pulsar" || systemKind === "pulsar") return "pulsar";
  }
  return connection.driver_profile || connection.db_type;
}

const showRegularTabScrollbar = computed(() => hasTabOverflow.value && !isWrapLayout.value);
const showFixedTabScrollbar = computed(() => hasFixedTabOverflow.value && !isWrapLayout.value);
const showRegularTabOverflowControls = computed(() => regularTabs.value.length > 0 && hasTabOverflow.value && !isWrapLayout.value);
const regularTabOverflowOpen = ref(false);
const fixedTabOverflowOpen = ref(false);
const tabSearchQuery = ref("");
const filteredOpenTabs = computed(() => {
  const query = tabSearchQuery.value.trim().toLocaleLowerCase();
  if (!query) return queryStore.tabs;
  return queryStore.tabs.filter((tab) => tabTitleText(tab).toLocaleLowerCase().includes(query) || tab.title.toLocaleLowerCase().includes(query));
});
const tabBarClass = computed(() => [isClassicLayout.value ? "bg-muted" : "border-b bg-background", hasFixedTabs.value ? "flex-col" : "", isClassicLayout.value && hasFixedTabs.value ? "border-b" : ""]);
const regularTabRowClass = computed(() => [isClassicLayout.value ? "h-9 items-stretch" : "h-10 items-center px-2", isClassicLayout.value && !hasFixedTabs.value ? "border-b" : ""]);

watch(regularTabOverflowOpen, (open) => {
  tabSearchQuery.value = "";
  if (open) nextTick(() => document.querySelector<HTMLInputElement>('[data-tab-search-input="regular"]')?.focus());
});

watch(fixedTabOverflowOpen, (open) => {
  tabSearchQuery.value = "";
  if (open) nextTick(() => document.querySelector<HTMLInputElement>('[data-tab-search-input="fixed"]')?.focus());
});

function tabMenuIcon(tab: QueryTab) {
  if (tab.externalSqlFileMissing) return AlertTriangle;
  if (tab.mode === "data" || tab.mode === "mongo" || tab.mode === "redis" || tab.mode === "hbase") return Table2;
  if (tab.mode === "vector") return TableProperties;
  if (tab.mode === "etcd" || tab.mode === "zookeeper" || tab.mode === "consul") return KeyRound;
  if (tab.mode === "consul-overview") return Gauge;
  if (tab.mode === "etcd-dashboard") return Gauge;
  if (tab.mode === "etcd-access-control") return ShieldCheck;
  if (tab.mode === "nacos") return Network;
  if (tab.mode === "databases") return Database;
  if (tab.mode === "objects") return TableProperties;
  if (tab.mode === "structure") return PencilRuler;
  if (tab.mode === "dameng-jobs") return CalendarClock;
  if (tab.mode === "processlist" || tab.mode === "sqlserver-trace") return Activity;
  if (tab.mode === "mysql-dashboard" || tab.mode === "postgres-dashboard" || tab.mode === "nacos-dashboard") return Gauge;
  if (tab.mode === "dolt-version-control") return GitBranch;
  return Code2;
}

function handleTabClick(tab: QueryTab) {
  if (tabDrag.state.suppressClick) return;
  activateTab(tab.id);
}

function handleTabMouseDown(event: MouseEvent, tabId: string) {
  if (event.button === 0) {
    dispatchBeforeTabSwitch(tabId);
  }
  tabDrag.startDrag(event, tabId);
}

function isPointerOutsideTabBar(event: MouseEvent): boolean {
  const rect = tabBarRef.value?.getBoundingClientRect();
  return !!rect && pointOutsideRect({ x: event.clientX, y: event.clientY }, rect, 8);
}

function queueTabDragPreviewBroadcast(payload: TabWindowTransferPayload, title: string) {
  if (!isTauriRuntime() || tabPreviewBroadcastTransferId !== payload.transferId) return;
  pendingTabPreviewBroadcast = { payload, title };
  if (tabPreviewBroadcastFrame !== null) return;
  tabPreviewBroadcastFrame = window.requestAnimationFrame(() => {
    tabPreviewBroadcastFrame = null;
    const pending = pendingTabPreviewBroadcast;
    pendingTabPreviewBroadcast = null;
    if (!pending || nativeTabDrag.value?.payload.transferId !== pending.payload.transferId || tabPreviewBroadcastTransferId !== pending.payload.transferId) return;
    void cursorPosition()
      .then((cursor) => {
        // 拖动已经结束后，已排队的光标查询不能再次显示独立预览宿主。
        if (tabPreviewBroadcastTransferId !== pending.payload.transferId) return;
        return showTabDragPreviewWebview(pending.title, cursor);
      })
      .catch(() => undefined);
  });
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
  if (payload.sourceWindowLabel === currentWindowLabel.value) return;
  const lastSequence = remoteTabWindowPreviewSequences.get(payload.sourceWindowLabel) ?? -1;
  if (payload.sequence <= lastSequence) return;
  remoteTabWindowPreviewSequences.set(payload.sourceWindowLabel, payload.sequence);
  if (!payload.visible) {
    clearRemoteTabWindowPreview(payload.transferId);
    return;
  }

  try {
    const currentWindow = getCurrentWindow();
    const [innerPosition, scaleFactor] = await Promise.all([currentWindow.innerPosition(), currentWindow.scaleFactor()]);
    if (remoteTabWindowPreviewSequences.get(payload.sourceWindowLabel) !== payload.sequence) return;
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
      title: payload.title,
      sequence: payload.sequence,
      rect: tabDragPreviewRect(cursor, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }),
    };
    refreshRemoteTabWindowPreviewExpiry(payload.transferId, payload.sequence);
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
  if (!isTauriRuntime() || nativeTabDragPreviewTransferId) return;
  nativeTabDragPreviewTransferId = payload.transferId;
  try {
    const currentWindow = getCurrentWindow();
    const [innerPosition, scaleFactor] = await Promise.all([currentWindow.innerPosition(), currentWindow.scaleFactor()]);
    if (nativeTabDragPreviewTransferId !== payload.transferId) return;
    const preview = tabDragPreviewRect({ x: event.clientX, y: event.clientY }, { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight });
    nativeTabDragPreviewActive.value = true;
    await invoke("start_tab_drag_preview", {
      request: {
        transferId: payload.transferId,
        sourceWindowLabel: payload.sourceWindowLabel,
        title: payload.liveTab?.title ?? payload.tab.title,
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
      nativeTabDragPreviewActive.value = false;
    }
  }
}

async function reorderNativeDropInSourceTabBar(payload: TabWindowTransferPayload, release: NativeTabDragPreviewRelease): Promise<boolean> {
  try {
    const currentWindow = getCurrentWindow();
    const [innerPosition, scaleFactor] = await Promise.all([currentWindow.innerPosition(), currentWindow.scaleFactor()]);
    const clientX = (release.cursorX - innerPosition.x) / scaleFactor;
    const clientY = (release.cursorY - innerPosition.y) / scaleFactor;
    const tabBarRect = tabBarRef.value?.getBoundingClientRect();
    if (!tabBarRect || clientX < tabBarRect.left || clientX > tabBarRect.right || clientY < tabBarRect.top || clientY > tabBarRect.bottom) return false;

    const tabTarget = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-tab-id]");
    const targetId = tabTarget?.dataset.tabId;
    // Dropping back on an empty part of A's tab strip keeps the tab in place.
    if (!targetId || targetId === payload.tab.id) return true;

    const draggedTab = queryStore.tabs.find((tab) => tab.id === payload.tab.id);
    const targetTab = queryStore.tabs.find((tab) => tab.id === targetId);
    // A return to the source strip must never turn into a detached window,
    // including when the requested pinned/unpinned reorder is invalid.
    if (!draggedTab || !targetTab || draggedTab.pinned !== targetTab.pinned) return true;

    const targetRect = tabTarget.getBoundingClientRect();
    queryStore.reorderTab(payload.tab.id, targetId, clientX - targetRect.left < targetRect.width / 2 ? "before" : "after");
    return true;
  } catch {
    // If the source window is closing, fall through to the normal transfer path.
    return false;
  }
}

async function handleNativeTabDragPreviewRelease(release: NativeTabDragPreviewRelease) {
  const drag = nativeTabDrag.value;
  if (!drag || drag.payload.transferId !== release.transferId) return;
  nativeTabDrag.value = null;
  nativeTabDragPreviewTransferId = null;
  nativeTabDragPreviewActive.value = false;
  stopTabDragPreviewBroadcast(drag.payload);
  // The native host owns the mouse after the pointer leaves this WebView, so
  // its release event is also responsible for clearing the source drag state.
  tabDrag.cancelDrag();
  const monitor = await monitorFromPoint(release.left, release.top).catch(() => null);
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
    // Once a tab leaves the strip, a same-window insertion marker must not
    // reorder it before the cross-window drop decision is made.
    tabDrag.clearTarget();
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

async function targetTabDropFromTransfer(payload: TabWindowTransferPayload): Promise<{ targetId: string; position: "before" | "after" } | null> {
  if (!payload.dropCursorPhysical) return null;
  try {
    const currentWindow = getCurrentWindow();
    const [innerPosition, scaleFactor] = await Promise.all([currentWindow.innerPosition(), currentWindow.scaleFactor()]);
    const clientX = (payload.dropCursorPhysical.x - innerPosition.x) / scaleFactor;
    const clientY = (payload.dropCursorPhysical.y - innerPosition.y) / scaleFactor;
    const tabBarRect = tabBarRef.value?.getBoundingClientRect();
    if (!tabBarRect || clientX < tabBarRect.left || clientX > tabBarRect.right || clientY < tabBarRect.top || clientY > tabBarRect.bottom) return null;

    const tabTarget = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-tab-id]");
    const targetId = tabTarget?.dataset.tabId;
    const targetTab = targetId ? queryStore.tabs.find((tab) => tab.id === targetId) : null;
    const transferredPinned = payload.liveTab?.pinned ?? payload.tab.pinned;
    if (!targetId || !targetTab || !!targetTab.pinned !== !!transferredPinned) return null;

    const targetRect = tabTarget.getBoundingClientRect();
    return {
      targetId,
      position: clientX - targetRect.left < targetRect.width / 2 ? "before" : "after",
    };
  } catch {
    return null;
  }
}

async function acceptTabWindowTransfer(payload: TabWindowTransferPayload): Promise<boolean> {
  if (payload.sourceWindowLabel === currentWindowLabel.value) return false;
  const dropTarget = await targetTabDropFromTransfer(payload);
  const importedTabId = queryStore.importTransferredTab(payload.tab, payload.liveTab);
  if (!importedTabId) {
    // A retried native event can arrive after the first delivery succeeded.
    // Treat the existing tab as an acknowledged idempotent move.
    if (!queryStore.tabs.some((tab) => tab.id === payload.tab.id)) return false;
    queryStore.switchTab(payload.tab.id);
  }
  if (importedTabId && dropTarget) queryStore.reorderTab(importedTabId, dropTarget.targetId, dropTarget.position);
  // The actual destination tab is now rendered, so any optimistic drag chip
  // in this WebView must disappear even if its final hide event was delayed.
  clearRemoteTabWindowPreview(payload.transferId);
  markTabWindowTransferAccepted(payload.transferId);
  clearTabWindowTransfer(payload.transferId);
  return true;
}

function handleIncomingTabWindowTransfer(payload: TabWindowTransferPayload) {
  void acceptTabWindowTransfer(payload);
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

async function finishTabWindowTransfer(payload: TabWindowTransferPayload, placement?: TabWindowPlacement, knownTargetWindowLabel?: string | null, dropCursorPhysical?: { x: number; y: number }) {
  // Resolve the destination from the OS cursor after pointer capture releases.
  // This keeps the move path independent from WebView2 HTML5 drag delivery.
  const targetWindowLabel = knownTargetWindowLabel === undefined ? await tabWindowAtCursor() : knownTargetWindowLabel;
  if (targetWindowLabel) {
    const cursor = dropCursorPhysical ?? (await cursorPosition().catch(() => null));
    const deliveredPayload = cursor ? { ...payload, dropCursorPhysical: { x: cursor.x, y: cursor.y } } : payload;
    const delivered = await sendTabWindowTransfer(targetWindowLabel, deliveredPayload);
    if (delivered && (await waitForTabWindowTransferAccepted(payload.transferId))) {
      queryStore.detachTabForTransfer(payload.tab.id);
      clearTabWindowTransfer(payload.transferId);
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
  if (created) queryStore.detachTabForTransfer(payload.tab.id);
}

async function openTabInNewWindow(tab: QueryTab) {
  if (!isTauriRuntime()) return;
  const payload = createTabWindowTransfer(tab, currentWindowLabel.value);
  const created = await createDetachedTabWindow(payload);
  if (created) queryStore.detachTabForTransfer(tab.id);
}

function tabWindowTargetLabel(window: TabWindowTarget): string {
  const detachedWindowIndex = otherTabWindows.value.filter((target) => target.label !== "main").findIndex((target) => target.label === window.label) + 1;
  const windowName = window.label === "main" ? t("contextMenu.mainWindow") : t("contextMenu.detachedWindow", { number: detachedWindowIndex });
  return window.title && window.title !== "DBX" ? `${windowName} · ${window.title}` : windowName;
}

async function refreshOtherTabWindows() {
  const windows = await listOtherTabWindows().catch(() => []);
  otherTabWindows.value = await Promise.all(
    windows.map(async (window) => ({
      ...window,
      title: (await requestOtherTabWindowTitle(window.label)) ?? window.title,
    })),
  );
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

async function openTabContextMenu(event: MouseEvent, onContextMenu: (event: MouseEvent, items?: ContextMenuItem[]) => void, tab: QueryTab) {
  event.preventDefault();
  event.stopPropagation();
  await refreshOtherTabWindows();
  onContextMenu(event, getTabMenuItems(tab));
}

async function moveTabToWindow(tab: QueryTab, targetWindowLabel: string) {
  const payload = createTabWindowTransfer(tab, currentWindowLabel.value);
  const delivered = await sendTabWindowTransfer(targetWindowLabel, payload);
  if (delivered && (await waitForTabWindowTransferAccepted(payload.transferId))) {
    queryStore.detachTabForTransfer(tab.id);
  }
  clearTabWindowTransfer(payload.transferId);
}

function handleTabDragTarget(event: MouseEvent, tab: QueryTab) {
  const draggedTab = queryStore.tabs.find((item) => item.id === tabDrag.state.draggedId);
  if (draggedTab && draggedTab.pinned !== tab.pinned) {
    tabDrag.clearTarget(tab.id);
    return;
  }
  tabDrag.updateTarget(event, tab.id);
}

function tabDropStyle(tabId: string) {
  if (!tabDrag.state.active) return {};
  if (tabDrag.state.draggedId === tabId) return { opacity: 0.4 };
  if (tabDrag.state.targetId !== tabId) return {};
  const dropColor = `var(--ring)`;
  if (tabDrag.state.dropPosition === "before") {
    return { boxShadow: `inset 3px 0 0 0 ${dropColor}` };
  }
  return { boxShadow: `inset -3px 0 0 0 ${dropColor}` };
}

const tabsContainerStyle = computed<CSSProperties>(() => ({
  msOverflowStyle: "none",
  scrollbarWidth: "none",
  WebkitOverflowScrolling: "touch",
}));

const tabScrollbarThumbStyle = computed<CSSProperties>(() => ({
  insetInlineStart: `${scrollThumbLeftPercent.value}%`,
  width: `${scrollThumbWidthPercent.value}%`,
}));

const fixedTabScrollbarThumbStyle = computed<CSSProperties>(() => ({
  insetInlineStart: `${fixedScrollThumbLeftPercent.value}%`,
  width: `${fixedScrollThumbWidthPercent.value}%`,
}));

const tabTailDragRegionClass = computed(() => (showRegularTabOverflowControls.value || isWrapLayout.value ? "w-0 flex-none self-stretch" : "min-w-8 flex-1 self-stretch"));
const fixedTabTailDragRegionClass = computed(() => (showFixedTabScrollbar.value || isWrapLayout.value ? "w-0 flex-none self-stretch" : "min-w-8 flex-1 self-stretch"));

const tabOverflowControlClass = computed(() =>
  isClassicLayout.value
    ? "h-full w-8 border-r border-border/80 dark:border-border/45 bg-background/80 text-foreground/75 hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-40"
    : "h-7 w-7 rounded-md border border-border/60 bg-background text-foreground/70 hover:border-border hover:text-foreground",
);

function dispatchBeforeTabSwitch(tabId: string) {
  if (tabId === queryStore.activeTabId) return;
  window.dispatchEvent(new CustomEvent("dbx:before-tab-switch", { detail: { tabId, fromTabId: queryStore.activeTabId } }));
}

function activateTab(tabId: string) {
  dispatchBeforeTabSwitch(tabId);
  tabScrollBehavior.value = "auto";
  queryStore.activeTabId = tabId;
  emit("activate-tab");
}

function activateTabFromOverflow(tabId: string, kind: "regular" | "fixed") {
  activateTab(tabId);
  if (kind === "regular") regularTabOverflowOpen.value = false;
  else fixedTabOverflowOpen.value = false;
}

function closeTabFromOverflow(tabId: string, event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  queryStore.closeTab(tabId);
}

function onOverflowItemKeydown(event: KeyboardEvent, tabId: string, kind: "regular" | "fixed") {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  activateTabFromOverflow(tabId, kind);
}
</script>

<template>
  <Teleport to="body">
    <TabDragPreviewChip
      v-if="visibleTabWindowPreview && !nativeTabDragPreviewActive && !isTauriRuntime()"
      :title="visibleTabWindowPreviewTitle"
      class="pointer-events-none fixed z-[9998] h-[34px] w-[300px]"
      :style="{
        left: `${visibleTabWindowPreview.left}px`,
        top: `${visibleTabWindowPreview.top}px`,
        width: `${visibleTabWindowPreview.width}px`,
        height: `${visibleTabWindowPreview.height}px`,
      }"
    />
  </Teleport>

  <div ref="tabBarRef" v-if="queryStore.tabs.length > 0 || driverStoreOpen || settingsPageOpen" class="app-tab-bar relative flex w-full min-w-0 shrink-0 overflow-hidden" :class="tabBarClass">
    <div class="flex w-full min-w-0 shrink-0 overflow-hidden" :class="regularTabRowClass">
      <div class="app-tab-strip relative h-full min-w-0 flex-1 overflow-hidden">
        <div v-if="showRegularTabScrollbar" class="app-tab-scrollbar" :class="{ 'app-tab-scrollbar--dragging': isScrollbarDragging }" @pointerdown="startScrollbarDrag">
          <div class="app-tab-scrollbar__thumb" :style="tabScrollbarThumbStyle" />
        </div>
        <div
          ref="tabsContainerRef"
          class="app-tab-scroll flex w-full min-w-0 flex-1 items-center overflow-x-auto"
          :class="[isClassicLayout ? 'h-full' : 'h-full gap-1.5 py-1.5', isWrapLayout ? 'wrap-mode' : '', isWrapLayout && isClassicLayout ? 'classic-wrap' : '']"
          :style="tabsContainerStyle"
          @scroll="updateScrollButtons"
          @wheel="onTabsWheel"
        >
          <CustomContextMenu v-for="tab in regularTabs" :key="tab.id" :items="getTabMenuItems(tab)" v-slot="{ onContextMenu }">
            <div :class="isClassicLayout ? 'h-full' : ''" @contextmenu="openTabContextMenu($event, onContextMenu, tab)">
              <Tooltip>
                <TooltipTrigger as-child>
                  <div
                    :data-tab-id="tab.id"
                    class="app-tab-pill group flex cursor-default items-center gap-1 px-2 text-xs transition-colors whitespace-nowrap select-none"
                    :class="
                      isClassicLayout
                        ? [
                            compactTabTitle ? 'min-w-24' : 'min-w-38',
                            'h-full border-r border-border/80 font-medium dark:border-border/45',
                            tab.id === queryStore.activeTabId && !driverStoreActive && !settingsPageActive ? 'bg-background text-foreground' : 'text-foreground/70 hover:text-foreground/90',
                          ]
                        : [compactTabTitle ? 'min-w-24' : 'min-w-38', 'h-7 rounded-md border', tab.id === queryStore.activeTabId && !driverStoreActive && !settingsPageActive ? 'text-foreground font-medium' : 'border-border/60 text-foreground/70 hover:border-border hover:text-foreground/90']
                    "
                    :style="[tabColorStyle(tab), tabDropStyle(tab.id)]"
                    :data-active-tab="tab.id === queryStore.activeTabId && !driverStoreActive && !settingsPageActive"
                    @click="handleTabClick(tab)"
                    @dblclick.stop="startRenameTab(tab)"
                    @mousedown.middle.prevent="queryStore.closeTab(tab.id)"
                    @mousedown="handleTabMouseDown($event, tab.id)"
                    @mouseenter="handleTabDragTarget($event, tab)"
                    @mousemove="handleTabDragTarget($event, tab)"
                    @mouseleave="tabDrag.clearTarget(tab.id)"
                  >
                    <TabExecutionStatus :tab="tab">
                      <span class="shrink-0" :class="tabIconClass(tab)">
                        <AlertTriangle v-if="tab.externalSqlFileMissing" class="h-3.5 w-3.5" />
                        <Table2 v-else-if="tab.mode === 'data' || tab.mode === 'mongo' || tab.mode === 'redis' || tab.mode === 'hbase'" class="h-3.5 w-3.5" />
                        <DatabaseIcon v-else-if="tab.mode === 'mq'" :db-type="tabDatabaseIconType(tab)" class="h-3.5 w-3.5" />
                        <TableProperties v-else-if="tab.mode === 'vector'" class="h-3.5 w-3.5" />
                        <KeyRound v-else-if="tab.mode === 'etcd' || tab.mode === 'zookeeper' || tab.mode === 'consul'" class="h-3.5 w-3.5" />
                        <Gauge v-else-if="tab.mode === 'consul-overview'" class="h-3.5 w-3.5" />
                        <Gauge v-else-if="tab.mode === 'etcd-dashboard'" class="h-3.5 w-3.5" />
                        <ShieldCheck v-else-if="tab.mode === 'etcd-access-control'" class="h-3.5 w-3.5" />
                        <Network v-else-if="tab.mode === 'nacos'" class="h-3.5 w-3.5" />
                        <Database v-else-if="tab.mode === 'databases'" class="h-3.5 w-3.5" />
                        <TableProperties v-else-if="tab.mode === 'objects'" class="h-3.5 w-3.5" />
                        <PencilRuler v-else-if="tab.mode === 'structure'" class="h-3.5 w-3.5" />
                        <CalendarClock v-else-if="tab.mode === 'dameng-jobs'" class="h-3.5 w-3.5" />
                        <Activity v-else-if="tab.mode === 'processlist' || tab.mode === 'sqlserver-trace'" class="h-3.5 w-3.5" />
                        <Gauge v-else-if="tab.mode === 'mysql-dashboard' || tab.mode === 'postgres-dashboard' || tab.mode === 'nacos-dashboard'" class="h-3.5 w-3.5" />
                        <GitBranch v-else-if="tab.mode === 'dolt-version-control'" class="h-3.5 w-3.5" />
                        <Code2 v-else class="h-3.5 w-3.5" />
                      </span>
                    </TabExecutionStatus>
                    <input
                      v-if="editingTabId === tab.id"
                      v-model="editingTitle"
                      :data-tab-title-input="tab.id"
                      :aria-label="t('contextMenu.renameTab')"
                      class="h-5 min-w-0 flex-1 rounded border border-ring bg-background px-1.5 text-xs font-normal text-foreground outline-none"
                      @click.stop
                      @mousedown.stop
                      @keydown.enter.prevent="commitRenameTab(tab)"
                      @keydown.escape.prevent="cancelRenameTab"
                      @blur="commitRenameTab(tab)"
                    />
                    <span v-else class="inline-flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
                      <span v-if="isDirtyTab(tab)" aria-hidden="true" class="dirty-tab-marker">*</span>
                      <span class="min-w-0 flex-1 truncate" :style="tabTitleStyle(tab)">{{ tabTitleText(tab) }}</span>
                    </span>
                    <Tooltip v-if="isConnectionReadonly(tab.connectionId)">
                      <TooltipTrigger as-child>
                        <Lock class="h-3 w-3 text-muted-foreground shrink-0" />
                      </TooltipTrigger>
                      <TooltipContent>{{ t("connection.readOnlyBadge") }}</TooltipContent>
                    </Tooltip>
                    <button class="rounded hover:bg-muted-foreground/20 p-0.5 shrink-0" @click.stop="queryStore.closeTab(tab.id)">
                      <X class="h-3 w-3" />
                    </button>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" class="text-xs grid grid-cols-[auto_1fr] gap-x-2">
                  <template v-for="line in tabTooltipLines(tab, t)" :key="line.label">
                    <span class="text-muted-foreground">{{ line.label }}</span>
                    <span>{{ line.value }}</span>
                  </template>
                </TooltipContent>
              </Tooltip>
            </div>
          </CustomContextMenu>

          <!-- Settings Page Tab -->
          <CustomContextMenu v-if="settingsPageOpen" :items="getSpecialRegularTabMenuItems('settings')" v-slot="{ onContextMenu }">
            <div :class="isClassicLayout ? 'h-full' : ''" @contextmenu="onContextMenu">
              <div
                data-settings-page-tab
                class="app-tab-pill group flex min-w-36 cursor-default items-center gap-1 px-2 text-xs transition-colors whitespace-nowrap"
                :class="
                  isClassicLayout
                    ? ['h-full border-r border-border/80 dark:border-border/45 font-medium', settingsPageActive ? 'bg-background text-foreground' : 'text-foreground/70 hover:text-foreground/90']
                    : ['h-7 rounded-md border font-medium', settingsPageActive ? 'border-ring text-foreground' : 'border-border/60 text-foreground/70 hover:border-border hover:text-foreground/90']
                "
                :style="specialTabActiveStyle(settingsPageActive)"
                :data-active-tab="settingsPageActive"
                @click="emit('activate-settings-page')"
                @mousedown.middle.prevent="emit('close-settings-page')"
              >
                <span class="shrink-0 text-sky-600 dark:text-sky-400">
                  <Settings class="h-3.5 w-3.5" />
                </span>
                <span class="min-w-0 truncate flex-1">{{ t("settings.title") }}</span>
                <button class="rounded hover:bg-muted-foreground/20 p-0.5 shrink-0" @click.stop="emit('close-settings-page')">
                  <X class="h-3 w-3" />
                </button>
              </div>
            </div>
          </CustomContextMenu>

          <!-- Driver Store Tab -->
          <CustomContextMenu v-if="driverStoreOpen" :items="getSpecialRegularTabMenuItems('driverStore')" v-slot="{ onContextMenu }">
            <div :class="isClassicLayout ? 'h-full' : ''" @contextmenu="onContextMenu">
              <div
                data-driver-store-tab
                class="app-tab-pill group flex min-w-38 cursor-default items-center gap-1 px-2 text-xs transition-colors whitespace-nowrap"
                :class="
                  isClassicLayout
                    ? ['h-full border-r border-border/80 dark:border-border/45 font-medium', driverStoreActive ? 'bg-background text-foreground' : 'text-foreground/70 hover:text-foreground/90']
                    : ['h-7 rounded-md border font-medium', driverStoreActive ? 'border-ring text-foreground' : 'border-border/60 text-foreground/70 hover:border-border hover:text-foreground/90']
                "
                :style="specialTabActiveStyle(driverStoreActive)"
                :data-active-tab="driverStoreActive"
                @click="emit('activate-driver-store')"
                @mousedown.middle.prevent="emit('close-driver-store')"
              >
                <span class="shrink-0 text-amber-600 dark:text-amber-400">
                  <Package class="h-3.5 w-3.5" />
                </span>
                <span class="min-w-0 truncate flex-1">{{ t("toolbar.driverManager") }}</span>
                <span v-if="(agentDriverUpdateCount ?? 0) > 0" class="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-medium leading-none text-white" :aria-label="t('toolbar.updatableDriverCount')">
                  {{ (agentDriverUpdateCount ?? 0) > 99 ? "99+" : agentDriverUpdateCount }}
                </span>
                <button class="rounded hover:bg-muted-foreground/20 p-0.5 shrink-0" @click.stop="emit('close-driver-store')">
                  <X class="h-3 w-3" />
                </button>
              </div>
            </div>
          </CustomContextMenu>
          <div :class="tabTailDragRegionClass" data-tauri-drag-region />
        </div>
      </div>
      <div v-if="showRegularTabOverflowControls" class="relative z-30 flex shrink-0 items-center">
        <Popover v-model:open="regularTabOverflowOpen">
          <PopoverTrigger as-child>
            <button type="button" :class="['inline-flex shrink-0 items-center justify-center', tabOverflowControlClass].join(' ')" :aria-label="t('tabs.openTabs')" :title="t('tabs.openTabs')">
              <ChevronDown class="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" class="w-auto min-w-56 max-w-80 gap-0 rounded-[6px] p-1" @click.stop @keydown.stop>
            <div class="relative border-b px-1 pb-1">
              <Search class="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input data-tab-search-input="regular" v-model="tabSearchQuery" type="search" :placeholder="t('tabs.searchOpenTabs')" class="h-8 pl-7 text-sm" />
            </div>
            <div class="max-h-[min(70vh,28rem)] overflow-y-auto pt-1">
              <CustomContextMenu v-for="tab in filteredOpenTabs" :key="tab.id" :items="getTabMenuItems(tab)" v-slot="{ onContextMenu }">
                <div
                  class="group flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                  :class="tab.id === queryStore.activeTabId && !driverStoreActive && !settingsPageActive ? 'bg-accent/70 text-accent-foreground' : ''"
                  :title="tabTitleLabel(tab)"
                  role="menuitem"
                  tabindex="0"
                  @click="activateTabFromOverflow(tab.id, 'regular')"
                  @contextmenu="openTabContextMenu($event, onContextMenu, tab)"
                  @keydown="onOverflowItemKeydown($event, tab.id, 'regular')"
                >
                  <TabExecutionStatus :tab="tab">
                    <DatabaseIcon v-if="tab.mode === 'mq'" :db-type="tabDatabaseIconType(tab)" class="h-3.5 w-3.5 shrink-0" />
                    <component :is="tabMenuIcon(tab)" v-else :class="['h-3.5 w-3.5 shrink-0', tabIconClass(tab)]" />
                  </TabExecutionStatus>
                  <span class="inline-flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
                    <span v-if="isDirtyTab(tab)" aria-hidden="true" class="dirty-tab-marker">*</span>
                    <span class="min-w-0 flex-1 truncate" :style="tabTitleStyle(tab)">{{ tabTitleText(tab) }}</span>
                  </span>
                  <Lock v-if="isConnectionReadonly(tab.connectionId)" class="h-3 w-3 shrink-0 text-muted-foreground" />
                  <Pin v-if="tab.pinned" class="h-3 w-3 shrink-0 fill-current text-primary" />
                  <span class="w-5 shrink-0">
                    <button
                      type="button"
                      class="inline-flex rounded p-1 text-muted-foreground opacity-70 hover:bg-muted-foreground/20 hover:text-foreground group-hover:opacity-100"
                      :aria-label="t('contextMenu.closeTab')"
                      :title="t('contextMenu.closeTab')"
                      @click="closeTabFromOverflow(tab.id, $event)"
                      @mousedown.stop
                    >
                      <X class="h-3 w-3" />
                    </button>
                  </span>
                </div>
              </CustomContextMenu>
              <p v-if="filteredOpenTabs.length === 0" class="px-2 py-4 text-center text-sm text-muted-foreground">{{ t("tabs.noMatchingTabs") }}</p>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>

    <div v-if="hasFixedTabs" class="flex w-full min-w-0 shrink-0 overflow-hidden border-t" :class="isClassicLayout ? 'h-8 items-stretch border-border/80 bg-background/45 dark:border-border/45 dark:bg-background/20' : 'h-9 items-center border-border/70 bg-muted/45 px-2 dark:bg-muted/25'">
      <div class="app-tab-strip relative h-full min-w-0 flex-1 overflow-hidden">
        <div v-if="showFixedTabScrollbar" class="app-tab-scrollbar app-tab-scrollbar--bottom" :class="{ 'app-tab-scrollbar--dragging': isFixedScrollbarDragging }" @pointerdown="startFixedScrollbarDrag">
          <div class="app-tab-scrollbar__thumb" :style="fixedTabScrollbarThumbStyle" />
        </div>
        <div
          ref="fixedTabsContainerRef"
          class="app-tab-scroll flex w-full min-w-0 flex-1 items-center overflow-x-auto"
          :class="[isClassicLayout ? 'h-full' : 'h-full gap-1.5 py-1', isWrapLayout ? 'wrap-mode' : '', isWrapLayout && isClassicLayout ? 'classic-wrap' : '']"
          :style="tabsContainerStyle"
          @scroll="updateFixedScrollButtons"
          @wheel="onFixedTabsWheel"
        >
          <CustomContextMenu v-for="tab in fixedTabs" :key="tab.id" :items="getTabMenuItems(tab)" v-slot="{ onContextMenu }">
            <div :class="isClassicLayout ? 'h-full' : ''" @contextmenu="openTabContextMenu($event, onContextMenu, tab)">
              <Tooltip>
                <TooltipTrigger as-child>
                  <div
                    :data-tab-id="tab.id"
                    class="app-tab-pill group flex cursor-default items-center gap-1 px-2 text-xs transition-colors whitespace-nowrap select-none"
                    :class="
                      isClassicLayout
                        ? [
                            compactTabTitle ? 'min-w-24' : 'min-w-38',
                            'h-full border-r border-border/80 font-medium dark:border-border/45',
                            tab.id === queryStore.activeTabId && !driverStoreActive && !settingsPageActive ? 'bg-background text-foreground' : 'text-foreground/70 hover:text-foreground/90',
                          ]
                        : [compactTabTitle ? 'min-w-24' : 'min-w-38', 'h-7 rounded-md border', tab.id === queryStore.activeTabId && !driverStoreActive && !settingsPageActive ? 'text-foreground font-medium' : 'border-border/60 text-foreground/70 hover:border-border hover:text-foreground/90']
                    "
                    :style="[tabColorStyle(tab), tabDropStyle(tab.id)]"
                    :data-active-tab="tab.id === queryStore.activeTabId && !driverStoreActive && !settingsPageActive"
                    @click="handleTabClick(tab)"
                    @dblclick.stop="startRenameTab(tab)"
                    @mousedown.middle.prevent="queryStore.closeTab(tab.id)"
                    @mousedown="handleTabMouseDown($event, tab.id)"
                    @mouseenter="handleTabDragTarget($event, tab)"
                    @mousemove="handleTabDragTarget($event, tab)"
                    @mouseleave="tabDrag.clearTarget(tab.id)"
                  >
                    <TabExecutionStatus :tab="tab">
                      <span class="shrink-0" :class="tabIconClass(tab)">
                        <AlertTriangle v-if="tab.externalSqlFileMissing" class="h-3.5 w-3.5" />
                        <Table2 v-else-if="tab.mode === 'data' || tab.mode === 'mongo' || tab.mode === 'redis' || tab.mode === 'hbase'" class="h-3.5 w-3.5" />
                        <DatabaseIcon v-else-if="tab.mode === 'mq'" :db-type="tabDatabaseIconType(tab)" class="h-3.5 w-3.5" />
                        <TableProperties v-else-if="tab.mode === 'vector'" class="h-3.5 w-3.5" />
                        <KeyRound v-else-if="tab.mode === 'etcd' || tab.mode === 'zookeeper' || tab.mode === 'consul'" class="h-3.5 w-3.5" />
                        <Gauge v-else-if="tab.mode === 'consul-overview'" class="h-3.5 w-3.5" />
                        <Gauge v-else-if="tab.mode === 'etcd-dashboard'" class="h-3.5 w-3.5" />
                        <ShieldCheck v-else-if="tab.mode === 'etcd-access-control'" class="h-3.5 w-3.5" />
                        <Network v-else-if="tab.mode === 'nacos'" class="h-3.5 w-3.5" />
                        <Database v-else-if="tab.mode === 'databases'" class="h-3.5 w-3.5" />
                        <TableProperties v-else-if="tab.mode === 'objects'" class="h-3.5 w-3.5" />
                        <PencilRuler v-else-if="tab.mode === 'structure'" class="h-3.5 w-3.5" />
                        <CalendarClock v-else-if="tab.mode === 'dameng-jobs'" class="h-3.5 w-3.5" />
                        <Activity v-else-if="tab.mode === 'processlist' || tab.mode === 'sqlserver-trace'" class="h-3.5 w-3.5" />
                        <Gauge v-else-if="tab.mode === 'mysql-dashboard' || tab.mode === 'postgres-dashboard' || tab.mode === 'nacos-dashboard'" class="h-3.5 w-3.5" />
                        <GitBranch v-else-if="tab.mode === 'dolt-version-control'" class="h-3.5 w-3.5" />
                        <Code2 v-else class="h-3.5 w-3.5" />
                      </span>
                    </TabExecutionStatus>
                    <input
                      v-if="editingTabId === tab.id"
                      v-model="editingTitle"
                      :data-tab-title-input="tab.id"
                      :aria-label="t('contextMenu.renameTab')"
                      class="h-5 min-w-0 flex-1 rounded border border-ring bg-background px-1.5 text-xs font-normal text-foreground outline-none"
                      @click.stop
                      @mousedown.stop
                      @keydown.enter.prevent="commitRenameTab(tab)"
                      @keydown.escape.prevent="cancelRenameTab"
                      @blur="commitRenameTab(tab)"
                    />
                    <span v-else class="inline-flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-foreground">
                      <span v-if="isDirtyTab(tab)" aria-hidden="true" class="dirty-tab-marker">*</span>
                      <span class="min-w-0 flex-1 truncate" :style="tabTitleStyle(tab)">{{ tabTitleText(tab) }}</span>
                    </span>
                    <Tooltip v-if="isConnectionReadonly(tab.connectionId)">
                      <TooltipTrigger as-child>
                        <Lock class="h-3 w-3 text-muted-foreground shrink-0" />
                      </TooltipTrigger>
                      <TooltipContent>{{ t("connection.readOnlyBadge") }}</TooltipContent>
                    </Tooltip>
                    <button class="rounded p-0.5 text-primary hover:bg-muted-foreground/20 shrink-0" :aria-label="t('contextMenu.unfixTab')" :title="t('contextMenu.unfixTab')" @click.stop="queryStore.togglePinnedTab(tab.id)">
                      <Pin class="h-3 w-3 fill-current" aria-hidden="true" />
                    </button>
                    <button class="rounded hover:bg-muted-foreground/20 p-0.5 shrink-0" @click.stop="queryStore.closeTab(tab.id)">
                      <X class="h-3 w-3" />
                    </button>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" class="text-xs grid grid-cols-[auto_1fr] gap-x-2">
                  <template v-for="line in tabTooltipLines(tab, t)" :key="line.label">
                    <span class="text-muted-foreground">{{ line.label }}</span>
                    <span>{{ line.value }}</span>
                  </template>
                </TooltipContent>
              </Tooltip>
            </div>
          </CustomContextMenu>
          <div :class="fixedTabTailDragRegionClass" data-tauri-drag-region />
        </div>
      </div>
      <div v-if="showFixedTabScrollbar" class="relative z-30 flex shrink-0 items-center">
        <Popover v-model:open="fixedTabOverflowOpen">
          <PopoverTrigger as-child>
            <button type="button" :class="['inline-flex shrink-0 items-center justify-center', tabOverflowControlClass].join(' ')" :aria-label="t('tabs.openTabs')" :title="t('tabs.openTabs')">
              <ChevronDown class="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" class="w-auto min-w-56 max-w-80 gap-0 rounded-[6px] p-1" @click.stop @keydown.stop>
            <div class="relative border-b px-1 pb-1">
              <Search class="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input data-tab-search-input="fixed" v-model="tabSearchQuery" type="search" :placeholder="t('tabs.searchOpenTabs')" class="h-8 pl-7 text-sm" />
            </div>
            <div class="max-h-[min(70vh,28rem)] overflow-y-auto pt-1">
              <CustomContextMenu v-for="tab in filteredOpenTabs" :key="tab.id" :items="getTabMenuItems(tab)" v-slot="{ onContextMenu }">
                <div
                  class="group flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                  :class="tab.id === queryStore.activeTabId && !driverStoreActive && !settingsPageActive ? 'bg-accent/70 text-accent-foreground' : ''"
                  :title="tabTitleLabel(tab)"
                  role="menuitem"
                  tabindex="0"
                  @click="activateTabFromOverflow(tab.id, 'fixed')"
                  @contextmenu="openTabContextMenu($event, onContextMenu, tab)"
                  @keydown="onOverflowItemKeydown($event, tab.id, 'fixed')"
                >
                  <TabExecutionStatus :tab="tab">
                    <DatabaseIcon v-if="tab.mode === 'mq'" :db-type="tabDatabaseIconType(tab)" class="h-3.5 w-3.5 shrink-0" />
                    <component :is="tabMenuIcon(tab)" v-else :class="['h-3.5 w-3.5 shrink-0', tabIconClass(tab)]" />
                  </TabExecutionStatus>
                  <span class="inline-flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
                    <span v-if="isDirtyTab(tab)" aria-hidden="true" class="dirty-tab-marker">*</span>
                    <span class="min-w-0 flex-1 truncate" :style="tabTitleStyle(tab)">{{ tabTitleText(tab) }}</span>
                  </span>
                  <Lock v-if="isConnectionReadonly(tab.connectionId)" class="h-3 w-3 shrink-0 text-muted-foreground" />
                  <Pin v-if="tab.pinned" class="h-3 w-3 shrink-0 fill-current text-primary" />
                  <span class="w-5 shrink-0">
                    <button
                      type="button"
                      class="inline-flex rounded p-1 text-muted-foreground opacity-70 hover:bg-muted-foreground/20 hover:text-foreground group-hover:opacity-100"
                      :aria-label="t('contextMenu.closeTab')"
                      :title="t('contextMenu.closeTab')"
                      @click="closeTabFromOverflow(tab.id, $event)"
                      @mousedown.stop
                    >
                      <X class="h-3 w-3" />
                    </button>
                  </span>
                </div>
              </CustomContextMenu>
              <p v-if="filteredOpenTabs.length === 0" class="px-2 py-4 text-center text-sm text-muted-foreground">{{ t("tabs.noMatchingTabs") }}</p>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  </div>

  <Dialog
    :open="queryStore.showCloseConfirm"
    @update:open="
      (open) => {
        if (!open) queryStore.cancelClosePendingTab();
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
      <!-- Grid items use min-content sizing by default; shrink and wrap long file paths before they can displace the footer actions. -->
      <!-- 限制最大高度并允许滚动，确保内容超长时底部操作按钮始终可见可点-->
      <div class="max-h-120 min-h-0 min-w-0 overflow-y-auto space-y-2">
        <p class="wrap-anywhere text-sm text-muted-foreground">{{ closeConfirmMessage }}</p>
        <Popover v-if="showCloseConfirmBulkActions" :open="closeConfirmListOpen" @update:open="closeConfirmListOpen = $event">
          <PopoverTrigger as-child>
            <button
              type="button"
              class="inline-flex items-center text-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              @mouseenter="openCloseConfirmList"
              @mouseleave="scheduleCloseConfirmListClose"
            >
              {{ t("editor.unsavedChangesViewList", { count: closeConfirmDirtyCount }) }}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" side="bottom" class="w-72 max-w-[calc(100vw-2rem)] gap-1 p-2" @mouseenter="openCloseConfirmList" @mouseleave="scheduleCloseConfirmListClose" @pointerdown.stop @click.stop @keydown.stop>
            <div class="px-2 pb-1 text-xs font-medium text-muted-foreground">
              {{ t("editor.unsavedChangesListTitle", { count: closeConfirmDirtyCount }) }}
            </div>
            <div class="max-h-48 overflow-y-auto">
              <div v-for="tab in closeConfirmDirtyTabs" :key="tab.id" class="flex min-w-0 items-center gap-2 rounded-[6px] px-2 py-1.5 text-sm" :class="tab.id === queryStore.pendingCloseTabId ? 'bg-muted text-foreground' : 'text-muted-foreground'">
                <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="tab.id === queryStore.pendingCloseTabId ? 'bg-foreground' : 'bg-muted-foreground/50'" />
                <span class="min-w-0 truncate">{{ tabDisplayTitle(tab, t) }}</span>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <DialogFooter class="min-w-0 sm:flex-wrap">
        <Button variant="outline" @click="handleCancelClose">{{ t("common.cancel") }}</Button>
        <Button v-if="showCloseConfirmBulkActions" variant="secondary" class="border-border" @click="handleDiscardAllAndClose">{{ t("editor.discardAllChanges") }}</Button>
        <Button v-if="showCloseConfirmBulkActions" @click="handleSaveAllAndClose">{{ t("editor.saveAllChanges") }}</Button>
        <Button variant="secondary" class="border-border" @click="handleDiscardAndClose">{{ t("editor.discardChanges") }}</Button>
        <Button @click="handleSaveAndClose">{{ t("savedSql.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
/* 多行平铺模式：覆盖滚动相关样式，让标签换行展示 */
.app-tab-scroll.wrap-mode {
  height: auto !important;
  overflow: visible !important;
  overflow-x: visible !important;
  overflow-y: visible !important;
  flex-wrap: wrap;
}

/* 父级 strip 容器在包含 wrap-mode 时也需要解除高度约束和裁剪 */
.app-tab-strip:has(.wrap-mode) {
  height: auto !important;
  overflow: visible !important;
}

/* 标签栏行容器（直接子 div）在包含 wrap-mode 时解除固定高度和裁剪 */
.app-tab-bar > div:has(.wrap-mode) {
  height: auto !important;
  overflow: visible !important;
}

/* 标签栏本身也解除裁剪，让换行内容自然撑高 */
.app-tab-bar:has(.wrap-mode) {
  overflow: visible !important;
}

/* 经典布局 + 多行模式：优化多行标签显示 */
.app-tab-scroll.classic-wrap {
  row-gap: 0.25rem;
  padding-top: 0.25rem;
  padding-bottom: 0.25rem;
  align-items: flex-start;
}

/* 经典布局下 h-full 在 height:auto 容器中失效，改为固定高度 */
.app-tab-scroll.classic-wrap > div {
  height: 2rem;
}

.app-tab-pill {
  background-color: var(--app-tab-background);
}

.app-tab-pill[data-active-tab="false"]:hover {
  background-color: var(--app-tab-hover-background, color-mix(in oklch, var(--foreground) 8%, transparent));
}

.dirty-tab-marker {
  display: inline-flex;
  width: 0.5rem;
  height: 0.75rem;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  color: currentColor;
  font-size: 13px;
  font-weight: 700;
  line-height: 12px;
  opacity: 0.9;
  transform: translateY(2px);
}

.app-tab-scroll::-webkit-scrollbar {
  display: none;
}

.app-tab-scrollbar {
  position: absolute;
  inset-inline: 0;
  top: 0;
  z-index: 20;
  height: 6px;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  touch-action: none;
  transition: opacity 140ms ease;
}

.app-tab-strip:hover .app-tab-scrollbar,
.app-tab-strip:focus-within .app-tab-scrollbar,
.app-tab-scrollbar--dragging {
  opacity: 1;
  pointer-events: auto;
}

.app-tab-scrollbar::before {
  content: "";
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: 2px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--foreground) 8%, transparent);
}

.app-tab-scrollbar--bottom {
  top: auto;
  bottom: 0;
}

.app-tab-scrollbar--bottom::before {
  top: auto;
  bottom: 0;
}

.app-tab-scrollbar__thumb {
  position: absolute;
  top: 0;
  height: 2px;
  min-width: 20px;
  border-radius: 999px;
  background: color-mix(in oklch, var(--foreground) 30%, transparent);
  transition:
    height 120ms ease,
    background-color 120ms ease;
}

.app-tab-scrollbar--bottom .app-tab-scrollbar__thumb {
  top: auto;
  bottom: 0;
}

.app-tab-scrollbar:hover .app-tab-scrollbar__thumb,
.app-tab-scrollbar--dragging .app-tab-scrollbar__thumb {
  height: 5px;
  background: color-mix(in oklch, var(--foreground) 52%, transparent);
}
</style>

<script setup lang="ts">
import { computed, ref, watch, nextTick, onUnmounted } from "vue";
import type { CSSProperties } from "vue";
import { useI18n } from "vue-i18n";
import { X, Pin, ChevronDown, Table2, Code2, TableProperties, PencilRuler, KeyRound, Pencil, Package, Lock, Copy, AlertTriangle, Network, Minimize2, Maximize2, Settings, CalendarClock } from "@lucide/vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTabScroll } from "@/composables/useTabScroll";
import { useTabDrag } from "@/composables/useTabDrag";
import { connectionColor, isConnectionReadonly, tabDisplayTitle, tabTooltipLines } from "@/lib/tabs/tabPresentation";
import { hexToRgba } from "@/lib/common/color";
import { copyToClipboard } from "@/lib/common/clipboard";
import { useToast } from "@/composables/useToast";
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
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const { toast } = useToast();
const tabDrag = useTabDrag((draggedId, targetId, position) => {
  queryStore.reorderTab(draggedId, targetId, position);
});
const editingTabId = ref<string | null>(null);
const editingTitle = ref("");
const isClassicLayout = computed(() => settingsStore.editorSettings.appLayout === "classic");
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
  if (closeConfirmListCloseTimer) {
    clearTimeout(closeConfirmListCloseTimer);
    closeConfirmListCloseTimer = null;
  }
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
    input?.focus();
    input?.select();
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

function closeAllRegularSurfaces() {
  queryStore.closeRegularTabs();
  closeSpecialRegularSurfaces();
}

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
      for (const container of [tabsContainerRef.value, fixedTabsContainerRef.value]) {
        if (!container) continue;
        const activeEl = container.querySelector('[data-active-tab="true"]');
        if (activeEl) {
          activeEl.scrollIntoView({ behavior: tabScrollBehavior.value, block: "nearest", inline: activeTabScrollInline(container, queryStore.activeTabId) });
          break;
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
      backgroundColor: hexToRgba(color, isActive ? 0.16 : 0.07),
      boxShadow: isActive ? `inset 0 -2px 0 ${color}` : undefined,
    };
  }

  return {
    backgroundColor: hexToRgba(color, isActive ? 0.16 : 0.09),
    borderColor: isActive ? hexToRgba(color, 0.72) : hexToRgba(color, 0.18),
  };
}

function tabIconClass(tab: QueryTab) {
  if (tab.mode === "data" || tab.mode === "mongo" || tab.mode === "vector" || tab.mode === "redis" || tab.mode === "objects" || tab.mode === "structure") return "text-emerald-600 dark:text-emerald-400";
  return "text-blue-600 dark:text-blue-400";
}

const showRegularTabScrollbar = computed(() => hasTabOverflow.value);
const showFixedTabScrollbar = computed(() => hasFixedTabOverflow.value);
const showRegularTabOverflowControls = computed(() => regularTabs.value.length > 0 && hasTabOverflow.value);
const regularTabOverflowOpen = ref(false);
const fixedTabOverflowOpen = ref(false);
const tabBarClass = computed(() => [isClassicLayout.value ? "bg-muted" : "border-b bg-background", hasFixedTabs.value ? "flex-col" : "", isClassicLayout.value && hasFixedTabs.value ? "border-b" : ""]);
const regularTabRowClass = computed(() => [isClassicLayout.value ? "h-9 items-stretch" : "h-10 items-center px-2", isClassicLayout.value && !hasFixedTabs.value ? "border-b" : ""]);

function tabMenuIcon(tab: QueryTab) {
  if (tab.mode === "data" || tab.mode === "mongo" || tab.mode === "redis") return Table2;
  if (tab.mode === "vector") return TableProperties;
  if (tab.mode === "etcd" || tab.mode === "zookeeper") return KeyRound;
  if (tab.mode === "nacos") return Network;
  if (tab.mode === "objects") return TableProperties;
  if (tab.mode === "structure") return PencilRuler;
  if (tab.mode === "dameng-jobs") return CalendarClock;
  return Code2;
}

function handleTabClick(tab: QueryTab) {
  if (tabDrag.state.wasDragged) return;
  activateTab(tab.id);
}

function handleTabMouseDown(event: MouseEvent, tabId: string) {
  if (event.button === 0) {
    dispatchBeforeTabSwitch(tabId);
    event.preventDefault();
  }
  tabDrag.startDrag(event, tabId);
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

const tabTailDragRegionClass = computed(() => (showRegularTabOverflowControls.value ? "w-0 flex-none self-stretch" : "min-w-8 flex-1 self-stretch"));
const fixedTabTailDragRegionClass = computed(() => (showFixedTabScrollbar.value ? "w-0 flex-none self-stretch" : "min-w-8 flex-1 self-stretch"));

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
  <div v-if="queryStore.tabs.length > 0 || driverStoreOpen || settingsPageOpen" class="app-tab-bar relative flex w-full min-w-0 shrink-0 overflow-hidden" :class="tabBarClass">
    <div class="flex w-full min-w-0 shrink-0 overflow-hidden" :class="regularTabRowClass">
      <div class="app-tab-strip relative h-full min-w-0 flex-1 overflow-hidden">
        <div v-if="showRegularTabScrollbar" class="app-tab-scrollbar" :class="{ 'app-tab-scrollbar--dragging': isScrollbarDragging }" @pointerdown="startScrollbarDrag">
          <div class="app-tab-scrollbar__thumb" :style="tabScrollbarThumbStyle" />
        </div>
        <div ref="tabsContainerRef" class="app-tab-scroll flex w-full min-w-0 flex-1 items-center overflow-x-auto" :class="isClassicLayout ? 'h-full' : 'h-full gap-1.5 py-1.5'" :style="tabsContainerStyle" @scroll="updateScrollButtons" @wheel="onTabsWheel">
          <CustomContextMenu v-for="tab in regularTabs" :key="tab.id" :items="getTabMenuItems(tab)" v-slot="{ onContextMenu }">
            <div :class="isClassicLayout ? 'h-full' : ''" @contextmenu="onContextMenu">
              <Tooltip>
                <TooltipTrigger as-child>
                  <div
                    class="group flex items-center gap-1 px-2 text-xs cursor-pointer transition-colors whitespace-nowrap select-none"
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
                    <span class="shrink-0" :class="tabIconClass(tab)">
                      <Table2 v-if="tab.mode === 'data' || tab.mode === 'mongo' || tab.mode === 'redis'" class="h-3.5 w-3.5" />
                      <TableProperties v-else-if="tab.mode === 'vector'" class="h-3.5 w-3.5" />
                      <KeyRound v-else-if="tab.mode === 'etcd' || tab.mode === 'zookeeper'" class="h-3.5 w-3.5" />
                      <Network v-else-if="tab.mode === 'nacos'" class="h-3.5 w-3.5" />
                      <TableProperties v-else-if="tab.mode === 'objects'" class="h-3.5 w-3.5" />
                      <PencilRuler v-else-if="tab.mode === 'structure'" class="h-3.5 w-3.5" />
                      <CalendarClock v-else-if="tab.mode === 'dameng-jobs'" class="h-3.5 w-3.5" />
                      <Code2 v-else class="h-3.5 w-3.5" />
                    </span>
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
                class="group flex min-w-36 items-center gap-1 px-2 text-xs cursor-pointer transition-colors whitespace-nowrap"
                :class="
                  isClassicLayout
                    ? ['h-full border-r border-border/80 dark:border-border/45 font-medium', settingsPageActive ? 'bg-background text-foreground' : 'text-foreground/70 hover:text-foreground/90']
                    : ['h-7 rounded-md border font-medium', settingsPageActive ? 'border-ring text-foreground' : 'border-border/60 text-foreground/70 hover:border-border hover:text-foreground/90']
                "
                :style="isClassicLayout && settingsPageActive ? { boxShadow: '0 1px 0 0 var(--color-background)' } : {}"
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
                class="group flex min-w-38 items-center gap-1 px-2 text-xs cursor-pointer transition-colors whitespace-nowrap"
                :class="
                  isClassicLayout
                    ? ['h-full border-r border-border/80 dark:border-border/45 font-medium', driverStoreActive ? 'bg-background text-foreground' : 'text-foreground/70 hover:text-foreground/90']
                    : ['h-7 rounded-md border font-medium', driverStoreActive ? 'border-ring text-foreground' : 'border-border/60 text-foreground/70 hover:border-border hover:text-foreground/90']
                "
                :style="isClassicLayout && driverStoreActive ? { boxShadow: '0 1px 0 0 var(--color-background)' } : {}"
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
          <PopoverContent align="end" class="w-auto min-w-56 max-w-80 max-h-[min(70vh,28rem)] gap-0 overflow-y-auto rounded-[6px] p-1" @click.stop @keydown.stop>
            <CustomContextMenu v-for="tab in queryStore.tabs" :key="tab.id" :items="getTabMenuItems(tab)" v-slot="{ onContextMenu }">
              <div
                class="group flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                :class="tab.id === queryStore.activeTabId && !driverStoreActive && !settingsPageActive ? 'bg-accent/70 text-accent-foreground' : ''"
                :title="tabTitleLabel(tab)"
                role="menuitem"
                tabindex="0"
                @click="activateTabFromOverflow(tab.id, 'regular')"
                @contextmenu="onContextMenu"
                @keydown="onOverflowItemKeydown($event, tab.id, 'regular')"
              >
                <component :is="tabMenuIcon(tab)" :class="['h-3.5 w-3.5 shrink-0', tabIconClass(tab)]" />
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
          </PopoverContent>
        </Popover>
      </div>
    </div>

    <div v-if="hasFixedTabs" class="flex w-full min-w-0 shrink-0 overflow-hidden border-t" :class="isClassicLayout ? 'h-8 items-stretch border-border/80 bg-background/45 dark:border-border/45 dark:bg-background/20' : 'h-9 items-center border-border/70 bg-muted/45 px-2 dark:bg-muted/25'">
      <div class="app-tab-strip relative h-full min-w-0 flex-1 overflow-hidden">
        <div v-if="showFixedTabScrollbar" class="app-tab-scrollbar app-tab-scrollbar--bottom" :class="{ 'app-tab-scrollbar--dragging': isFixedScrollbarDragging }" @pointerdown="startFixedScrollbarDrag">
          <div class="app-tab-scrollbar__thumb" :style="fixedTabScrollbarThumbStyle" />
        </div>
        <div ref="fixedTabsContainerRef" class="app-tab-scroll flex w-full min-w-0 flex-1 items-center overflow-x-auto" :class="isClassicLayout ? 'h-full' : 'h-full gap-1.5 py-1'" :style="tabsContainerStyle" @scroll="updateFixedScrollButtons" @wheel="onFixedTabsWheel">
          <CustomContextMenu v-for="tab in fixedTabs" :key="tab.id" :items="getTabMenuItems(tab)" v-slot="{ onContextMenu }">
            <div :class="isClassicLayout ? 'h-full' : ''" @contextmenu="onContextMenu">
              <Tooltip>
                <TooltipTrigger as-child>
                  <div
                    class="group flex items-center gap-1 px-2 text-xs cursor-pointer transition-colors whitespace-nowrap select-none"
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
                    <span class="shrink-0" :class="tabIconClass(tab)">
                      <Table2 v-if="tab.mode === 'data' || tab.mode === 'mongo' || tab.mode === 'redis'" class="h-3.5 w-3.5" />
                      <TableProperties v-else-if="tab.mode === 'vector'" class="h-3.5 w-3.5" />
                      <KeyRound v-else-if="tab.mode === 'etcd' || tab.mode === 'zookeeper'" class="h-3.5 w-3.5" />
                      <Network v-else-if="tab.mode === 'nacos'" class="h-3.5 w-3.5" />
                      <TableProperties v-else-if="tab.mode === 'objects'" class="h-3.5 w-3.5" />
                      <PencilRuler v-else-if="tab.mode === 'structure'" class="h-3.5 w-3.5" />
                      <CalendarClock v-else-if="tab.mode === 'dameng-jobs'" class="h-3.5 w-3.5" />
                      <Code2 v-else class="h-3.5 w-3.5" />
                    </span>
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
            <button type="button" :class="['inline-flex shrink-0 items-center justify-center', tabOverflowControlClass].join(' ')" :aria-label="t('tabs.fixedTabs')" :title="t('tabs.fixedTabs')">
              <ChevronDown class="h-4 w-4" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" class="w-auto min-w-56 max-w-80 max-h-[min(70vh,28rem)] gap-0 overflow-y-auto rounded-[6px] p-1" @click.stop @keydown.stop>
            <CustomContextMenu v-for="tab in fixedTabs" :key="tab.id" :items="getTabMenuItems(tab)" v-slot="{ onContextMenu }">
              <div
                class="group flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm outline-hidden hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
                :class="tab.id === queryStore.activeTabId && !driverStoreActive && !settingsPageActive ? 'bg-accent/70 text-accent-foreground' : ''"
                :title="tabTitleLabel(tab)"
                role="menuitem"
                tabindex="0"
                @click="activateTabFromOverflow(tab.id, 'fixed')"
                @contextmenu="onContextMenu"
                @keydown="onOverflowItemKeydown($event, tab.id, 'fixed')"
              >
                <component :is="tabMenuIcon(tab)" :class="['h-3.5 w-3.5 shrink-0', tabIconClass(tab)]" />
                <span class="inline-flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
                  <span v-if="isDirtyTab(tab)" aria-hidden="true" class="dirty-tab-marker">*</span>
                  <span class="min-w-0 flex-1 truncate" :style="tabTitleStyle(tab)">{{ tabTitleText(tab) }}</span>
                </span>
                <Lock v-if="isConnectionReadonly(tab.connectionId)" class="h-3 w-3 shrink-0 text-muted-foreground" />
                <Pin class="h-3 w-3 shrink-0 fill-current text-primary" />
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
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <AlertTriangle class="h-5 w-5 text-amber-500" />
          {{ t("editor.unsavedChangesTitle") }}
        </DialogTitle>
      </DialogHeader>
      <div class="space-y-2">
        <p class="text-sm text-muted-foreground">{{ closeConfirmMessage }}</p>
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
      <DialogFooter>
        <Button variant="outline" @click="handleCancelClose">{{ t("common.cancel") }}</Button>
        <Button v-if="showCloseConfirmBulkActions" variant="secondary" @click="handleDiscardAllAndClose">{{ t("editor.discardAllChanges") }}</Button>
        <Button v-if="showCloseConfirmBulkActions" @click="handleSaveAllAndClose">{{ t("editor.saveAllChanges") }}</Button>
        <Button variant="secondary" @click="handleDiscardAndClose">{{ t("editor.discardChanges") }}</Button>
        <Button @click="handleSaveAndClose">{{ t("savedSql.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
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

<script setup lang="ts">
import { computed, ref, watch, nextTick } from "vue";
import type { CSSProperties } from "vue";
import { useI18n } from "vue-i18n";
import { X, Pin, ChevronDown, Table2, Code2, TableProperties, PencilRuler, KeyRound, Pencil, Package, Check, Lock, Copy, AlertTriangle, Network } from "@lucide/vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import LightDropdown from "@/components/ui/LightDropdown.vue";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTabScroll } from "@/composables/useTabScroll";
import { useTabDrag } from "@/composables/useTabDrag";
import { connectionColor, isConnectionReadonly, tabDisplayTitle, tabTooltipLines } from "@/lib/tabPresentation";
import { hexToRgba } from "@/lib/color";
import { copyToClipboard } from "@/lib/clipboard";
import { useToast } from "@/composables/useToast";
import type { QueryTab } from "@/types/database";

const props = defineProps<{
  driverStoreOpen?: boolean;
  driverStoreActive?: boolean;
  agentDriverUpdateCount?: number;
}>();

const emit = defineEmits<{
  "activate-tab": [];
  "activate-driver-store": [];
  "close-driver-store": [];
  "save-tab": [tabId: string];
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
const compactTabTitle = computed({
  get: () => settingsStore.editorSettings.compactTabTitle,
  set: (checked: boolean | "indeterminate") => {
    settingsStore.updateEditorSettings({ compactTabTitle: checked === true });
  },
});

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

function getTabMenuItems(tab: QueryTab): ContextMenuItem[] {
  return [
    {
      label: t("contextMenu.compactTabTitle"),
      action: toggleCompactTabTitle,
      icon: Check,
      iconClass: compactTabTitle.value ? "opacity-100" : "opacity-0",
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
      label: tab.pinned ? t("contextMenu.unpin") : t("contextMenu.pin"),
      action: () => queryStore.togglePinnedTab(tab.id),
      icon: Pin,
      iconClass: tab.pinned ? "fill-current" : "",
    },
    { label: "", separator: true },
    { label: t("contextMenu.closeTab"), action: () => queryStore.closeTab(tab.id), icon: X },
    {
      label: t("contextMenu.closeOtherTabs"),
      action: () => queryStore.closeOtherTabs(tab.id),
      disabled: queryStore.tabs.length <= 1,
      icon: X,
    },
    {
      label: t("contextMenu.closeAllTabs"),
      action: () => queryStore.closeAllTabs(),
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
}

function handleCancelClose() {
  queryStore.cancelClosePendingTab();
}

const tabsContainerRef = ref<HTMLElement | null>(null);
const { hasTabOverflow, scrollThumbLeftPercent, scrollThumbWidthPercent, isScrollbarDragging, updateScrollButtons, onTabsWheel, startScrollbarDrag } = useTabScroll(tabsContainerRef);
const tabScrollBehavior = ref<ScrollBehavior>("smooth");

watch(
  () => queryStore.tabs.length,
  () => {
    nextTick(updateScrollButtons);
  },
);

watch(
  () => queryStore.activeTabId,
  () => {
    nextTick(() => {
      const container = tabsContainerRef.value;
      if (!container) return;
      const activeEl = container.querySelector('[data-active-tab="true"]');
      if (activeEl) {
        activeEl.scrollIntoView({ behavior: tabScrollBehavior.value, block: "nearest", inline: "center" });
      }
      updateScrollButtons();
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
      updateScrollButtons();
    });
  },
);

function tabColorStyle(tab: QueryTab) {
  const color = connectionColor(tab.connectionId);
  const isActive = tab.id === queryStore.activeTabId && !props.driverStoreActive;
  const isClassic = settingsStore.editorSettings.appLayout === "classic";
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

const showTabOverflowControls = computed(() => queryStore.tabs.length > 0 && hasTabOverflow.value);

const openTabMenuItems = computed(() =>
  queryStore.tabs.map((tab) => ({
    value: tab.id,
    label: tabDisplayTitle(tab, t),
    title: tabDisplayTitle(tab, t),
    icon: tabMenuIcon(tab),
    iconClass: tabIconClass(tab),
  })),
);

function tabMenuIcon(tab: QueryTab) {
  if (tab.mode === "data" || tab.mode === "mongo" || tab.mode === "redis") return Table2;
  if (tab.mode === "vector") return TableProperties;
  if (tab.mode === "etcd" || tab.mode === "zookeeper") return KeyRound;
  if (tab.mode === "nacos") return Network;
  if (tab.mode === "objects") return TableProperties;
  if (tab.mode === "structure") return PencilRuler;
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

const tabTailDragRegionClass = computed(() => (showTabOverflowControls.value ? "w-0 flex-none self-stretch" : "min-w-8 flex-1 self-stretch"));

const tabOverflowControlClass = computed(() =>
  settingsStore.editorSettings.appLayout === "classic"
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
</script>

<template>
  <div v-if="queryStore.tabs.length > 0 || driverStoreOpen" class="relative flex border-b shrink-0" :class="settingsStore.editorSettings.appLayout === 'classic' ? 'h-9 items-stretch bg-muted' : 'h-10 items-center bg-background px-2'">
    <div class="app-tab-strip relative h-full min-w-0 flex-1">
      <div v-if="showTabOverflowControls" class="app-tab-scrollbar" :class="{ 'app-tab-scrollbar--dragging': isScrollbarDragging }" @pointerdown="startScrollbarDrag">
        <div class="app-tab-scrollbar__thumb" :style="tabScrollbarThumbStyle" />
      </div>
      <div ref="tabsContainerRef" class="app-tab-scroll flex min-w-0 flex-1 items-center overflow-x-auto" :class="settingsStore.editorSettings.appLayout === 'classic' ? 'h-full' : 'h-10 gap-1.5 py-1.5'" :style="tabsContainerStyle" @scroll="updateScrollButtons" @wheel="onTabsWheel">
        <CustomContextMenu v-for="tab in queryStore.tabs" :key="tab.id" :items="getTabMenuItems(tab)" v-slot="{ onContextMenu }">
          <div :class="settingsStore.editorSettings.appLayout === 'classic' ? 'h-full' : ''" @contextmenu="onContextMenu">
            <Tooltip>
              <TooltipTrigger as-child>
                <div
                  class="group flex items-center gap-1 px-2 text-xs cursor-pointer transition-colors whitespace-nowrap select-none"
                  :class="
                    settingsStore.editorSettings.appLayout === 'classic'
                      ? [compactTabTitle ? 'min-w-24' : 'min-w-38', 'h-full border-r border-border/80 font-medium dark:border-border/45', tab.id === queryStore.activeTabId && !driverStoreActive ? 'bg-background text-foreground' : 'text-foreground/70 hover:text-foreground/90']
                      : [compactTabTitle ? 'min-w-24' : 'min-w-38', 'h-7 rounded-md border', tab.id === queryStore.activeTabId && !driverStoreActive ? 'text-foreground font-medium' : 'border-border/60 text-foreground/70 hover:border-border hover:text-foreground/90']
                  "
                  :style="[tabColorStyle(tab), tabDropStyle(tab.id)]"
                  :data-active-tab="tab.id === queryStore.activeTabId && !driverStoreActive"
                  @click="handleTabClick(tab)"
                  @dblclick.stop="startRenameTab(tab)"
                  @mousedown.middle.prevent="queryStore.closeTab(tab.id)"
                  @mousedown="handleTabMouseDown($event, tab.id)"
                  @mouseenter="tabDrag.updateTarget($event, tab.id)"
                  @mousemove="tabDrag.updateTarget($event, tab.id)"
                  @mouseleave="tabDrag.clearTarget(tab.id)"
                >
                  <span class="shrink-0" :class="tabIconClass(tab)">
                    <Table2 v-if="tab.mode === 'data' || tab.mode === 'mongo' || tab.mode === 'redis'" class="h-3.5 w-3.5" />
                    <TableProperties v-else-if="tab.mode === 'vector'" class="h-3.5 w-3.5" />
                    <KeyRound v-else-if="tab.mode === 'etcd' || tab.mode === 'zookeeper'" class="h-3.5 w-3.5" />
                    <Network v-else-if="tab.mode === 'nacos'" class="h-3.5 w-3.5" />
                    <TableProperties v-else-if="tab.mode === 'objects'" class="h-3.5 w-3.5" />
                    <PencilRuler v-else-if="tab.mode === 'structure'" class="h-3.5 w-3.5" />
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
                  <span v-else class="min-w-0 truncate flex-1">{{ tabDisplayTitle(tab, t) }}</span>
                  <Tooltip v-if="isConnectionReadonly(tab.connectionId)">
                    <TooltipTrigger as-child>
                      <Lock class="h-3 w-3 text-muted-foreground shrink-0" />
                    </TooltipTrigger>
                    <TooltipContent>{{ t("connection.readOnlyBadge") }}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <button class="inline-flex rounded p-0.5 text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground focus:opacity-100" :class="tab.pinned ? 'visible text-primary' : 'invisible group-hover:visible'" @click.stop="queryStore.togglePinnedTab(tab.id)">
                        <Pin class="h-3 w-3" :class="{ 'fill-current': tab.pinned }" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{{ tab.pinned ? t("contextMenu.unpin") : t("contextMenu.pin") }}</TooltipContent>
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

        <!-- Driver Store Tab -->
        <div
          v-if="driverStoreOpen"
          data-driver-store-tab
          class="group flex min-w-38 items-center gap-1 px-2 text-xs cursor-pointer transition-colors whitespace-nowrap"
          :class="
            settingsStore.editorSettings.appLayout === 'classic'
              ? ['h-full border-r border-border/80 dark:border-border/45 font-medium', driverStoreActive ? 'bg-background text-foreground' : 'text-foreground/70 hover:text-foreground/90']
              : ['h-7 rounded-md border font-medium', driverStoreActive ? 'border-ring text-foreground' : 'border-border/60 text-foreground/70 hover:border-border hover:text-foreground/90']
          "
          :style="settingsStore.editorSettings.appLayout === 'classic' && driverStoreActive ? { boxShadow: '0 1px 0 0 var(--color-background)' } : {}"
          @click="emit('activate-driver-store')"
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
        <div :class="tabTailDragRegionClass" data-tauri-drag-region />
      </div>
    </div>
    <div v-if="showTabOverflowControls" class="relative z-30 flex shrink-0 items-center">
      <LightDropdown
        :model-value="queryStore.activeTabId || ''"
        :items="openTabMenuItems"
        :aria-label="t('tabs.openTabs')"
        :trigger-title="t('tabs.openTabs')"
        :trigger-icon="ChevronDown"
        :trigger-class="['inline-flex shrink-0 items-center justify-center', tabOverflowControlClass].join(' ')"
        trigger-icon-class="h-4 w-4"
        item-icon-class="w-3.5 h-3.5 mr-2"
        item-class="max-w-full"
        content-class="w-auto min-w-48 max-w-72"
        :show-trigger-label="false"
        :show-chevron="false"
        :highlight-selected="false"
        :match-trigger-width="false"
        check-position="none"
        align="end"
        @update:model-value="activateTab"
      />
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
      <p class="text-sm text-muted-foreground">{{ t("editor.unsavedChangesMessage") }}</p>
      <DialogFooter>
        <Button variant="outline" @click="handleCancelClose">{{ t("common.cancel") }}</Button>
        <Button variant="secondary" @click="handleDiscardAndClose">{{ t("editor.discardChanges") }}</Button>
        <Button @click="handleSaveAndClose">{{ t("savedSql.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
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

.app-tab-scrollbar:hover .app-tab-scrollbar__thumb,
.app-tab-scrollbar--dragging .app-tab-scrollbar__thumb {
  height: 5px;
  background: color-mix(in oklch, var(--foreground) 52%, transparent);
}
</style>

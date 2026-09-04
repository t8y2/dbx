<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { X, Minimize2, Maximize2, Settings, Package, AlertTriangle } from "@lucide/vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { tabDisplayTitle } from "@/lib/tabs/tabPresentation";
import "./appTabBar.css";

const props = defineProps<{
  driverStoreOpen?: boolean;
  driverStoreActive?: boolean;
  settingsPageOpen?: boolean;
  settingsPageActive?: boolean;
  agentDriverUpdateCount?: number;
  detachedDropTarget?: boolean;
  canDetachTabs?: boolean;
}>();

const emit = defineEmits<{
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
const closeConfirmDirtyCount = computed(() => queryStore.closeConfirmDirtyTabIds.length);
const showCloseConfirmBulkActions = computed(() => closeConfirmDirtyCount.value > 1);
const closeConfirmDirtyTabs = computed(() => queryStore.closeConfirmDirtyTabIds.map((id) => queryStore.tabs.find((tab) => tab.id === id)).filter((tab): tab is NonNullable<ReturnType<typeof queryStore.tabs.find>> => !!tab));
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
    if (queryStore.closeConfirmContext === "app") {
      return t("editor.unsavedChangesAppCloseMultipleMessage", params);
    }
    return t("editor.unsavedChangesBatchCloseMultipleMessage", params);
  }
  if (queryStore.closeConfirmContext === "app") {
    return t("editor.unsavedChangesAppCloseMessage", params);
  }
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
  if (closeConfirmListCloseTimer) {
    clearTimeout(closeConfirmListCloseTimer);
  }
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
    if (!open) {
      closeConfirmListOpen.value = false;
    }
  },
);

function toggleCompactTabTitle() {
  compactTabTitle.value = !compactTabTitle.value;
}

type SpecialRegularSurface = "driverStore" | "settings";

function closeSpecialRegularSurfaces(keep?: SpecialRegularSurface) {
  if (keep !== "driverStore" && props.driverStoreOpen) {
    emit("close-driver-store");
  }
  if (keep !== "settings" && props.settingsPageOpen) {
    emit("close-settings-page");
  }
}

// Regular tabs live in editor groups now, so "close other tabs" at App level
// scopes to the focused group (matching the group tabbar's context menu).
function closeOtherActiveTabs() {
  if (props.settingsPageActive) {
    closeSpecialRegularSurfaces("settings");
    return;
  }
  if (props.driverStoreActive) {
    closeSpecialRegularSurfaces("driverStore");
    return;
  }

  const activeTabId = queryStore.activeTabId;
  if (!activeTabId) {
    return;
  }
  const ownerGroup = queryStore.groups.find((group) => group.tabIds.includes(activeTabId));
  if (ownerGroup) {
    queryStore.closeOtherTabsInGroup(ownerGroup.id, activeTabId);
    return;
  }
  queryStore.closeTab(activeTabId);
}

defineExpose({ closeOtherActiveTabs });

function getSpecialRegularTabMenuItems(surface: SpecialRegularSurface): ContextMenuItem[] {
  const keep = surface;
  const closeCurrent = surface === "driverStore" ? () => emit("close-driver-store") : () => emit("close-settings-page");
  const specialSurfaceCount = (props.driverStoreOpen ? 1 : 0) + (props.settingsPageOpen ? 1 : 0);
  const closeOtherDisabled = specialSurfaceCount <= 1;

  return [
    {
      label: compactTabTitle.value ? t("contextMenu.fullTabTitle") : t("contextMenu.compactTabTitle"),
      action: toggleCompactTabTitle,
      icon: compactTabTitle.value ? Maximize2 : Minimize2,
    },
    { label: "", separator: true },
    { label: t("contextMenu.closeTab"), action: closeCurrent, icon: X },
    {
      label: t("contextMenu.closeOtherTabs"),
      action: () => {
        closeSpecialRegularSurfaces(keep);
      },
      disabled: closeOtherDisabled,
      icon: X,
    },
    { label: t("contextMenu.closeAllTabs"), action: closeCurrent, variant: "destructive" as const, icon: X },
  ];
}

function handleSaveAndClose() {
  const id = queryStore.saveAndClosePendingTab();
  if (id) {
    emit("save-tab", id);
  }
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
</script>

<template>
  <div v-if="driverStoreOpen || settingsPageOpen" class="app-tab-bar relative flex w-full min-w-0 shrink-0 overflow-hidden border-b bg-background" data-main-tab-bar :class="{ 'ring-2 ring-primary ring-inset': detachedDropTarget }">
    <div class="flex h-10 w-full min-w-0 shrink-0 items-center overflow-hidden px-2">
      <div class="app-tab-strip relative h-full min-w-0 flex-1 overflow-hidden">
        <div class="app-tab-scroll flex h-full w-full min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-1.5">
          <!-- Settings Page Tab -->
          <CustomContextMenu v-if="settingsPageOpen" :items="getSpecialRegularTabMenuItems('settings')" v-slot="{ onContextMenu }">
            <div @contextmenu="onContextMenu">
              <div
                data-settings-page-tab
                class="app-tab-pill group flex h-7 min-w-36 cursor-default items-center gap-1 rounded-md border px-2 text-xs transition-colors whitespace-nowrap"
                :class="settingsPageActive ? 'border-ring font-medium text-foreground' : 'border-border/60 text-foreground/70 hover:border-border hover:text-foreground/90'"
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
            <div @contextmenu="onContextMenu">
              <div
                data-driver-store-tab
                class="app-tab-pill group flex h-7 min-w-38 cursor-default items-center gap-1 rounded-md border px-2 text-xs transition-colors whitespace-nowrap"
                :class="driverStoreActive ? 'border-ring font-medium text-foreground' : 'border-border/60 text-foreground/70 hover:border-border hover:text-foreground/90'"
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
          <div class="min-w-8 flex-1 self-stretch" data-tauri-drag-region />
        </div>
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
                <span class="min-w-0 truncate">
                  {{ tabDisplayTitle(tab, t) }}
                </span>
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

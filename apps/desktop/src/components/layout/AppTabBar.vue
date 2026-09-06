<script setup lang="ts">
import { computed, inject, onUnmounted, ref, watch, type CSSProperties } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle } from "@lucide/vue";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { GROUP_TAB_BAR_PORTAL } from "./groupTabBarPortal";
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
  tabBarWidth?: number;
  tabBarCollapsed?: boolean;
}>();

const emit = defineEmits<{
  "activate-driver-store": [];
  "close-driver-store": [];
  "activate-settings-page": [];
  "close-settings-page": [];
  "activate-tab": [tabId: string];
  "save-tab": [tabId: string];
  "discard-tab-close": [];
  "save-all-tab-close": [];
  "discard-all-tab-close": [];
  "cancel-tab-close": [];
}>();

const { t } = useI18n();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const tabBarPortal = inject(GROUP_TAB_BAR_PORTAL, null);
const isVerticalLayout = computed(() => ["left", "right"].includes(settingsStore.editorSettings.tabPlacement));
const layoutClass = computed(() => {
  switch (settingsStore.editorSettings.tabPlacement) {
    case "bottom":
      return "flex-col-reverse";
    case "left":
      return "flex-row";
    case "right":
      return "flex-row-reverse";
    default:
      return "flex-col";
  }
});
const navigationStyle = computed<CSSProperties>(() => {
  if (!isVerticalLayout.value) return { maxHeight: "50%" };
  const width = props.tabBarCollapsed ? "3.5rem" : `${props.tabBarWidth ?? 240}px`;
  return { width, flex: `0 0 ${width}` };
});
function setTabBarTarget(groupId: string, element: unknown) {
  if (element instanceof HTMLElement) tabBarPortal?.targets.set(groupId, element);
  else tabBarPortal?.targets.delete(groupId);
}
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
  <!-- Targets remain mounted while inactive so the original group bars can
       move here without losing their local presentation state. -->
  <div v-show="driverStoreActive || settingsPageActive" data-special-page-workspace class="flex min-h-0 min-w-0 flex-1 overflow-hidden" :class="layoutClass">
    <div data-special-page-navigation class="flex min-h-0 min-w-0 shrink-0 flex-col overflow-auto" :style="navigationStyle">
      <div v-for="group in queryStore.groups" :key="group.id" :ref="(element) => setTabBarTarget(group.id, element)" :data-special-page-tab-target="group.id" class="flex min-h-0 min-w-0" :class="isVerticalLayout ? 'flex-1' : 'shrink-0'" />
    </div>
    <div data-special-page-content class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <slot />
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

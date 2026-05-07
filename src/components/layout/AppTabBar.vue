<script setup lang="ts">
import { ref, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { X, Pin, ChevronRight } from "lucide-vue-next";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useQueryStore } from "@/stores/queryStore";
import { useTabScroll } from "@/composables/useTabScroll";
import { connectionColor, tabDisplayTitle, tabTooltipLines, tabModeLabel } from "@/lib/tabPresentation";

const { t } = useI18n();
const queryStore = useQueryStore();

const tabsContainerRef = ref<HTMLElement | null>(null);
const { canScrollLeft, canScrollRight, updateScrollButtons, scrollTabs } = useTabScroll(tabsContainerRef);

function hasTabsToLeft(tabId: string) {
  return queryStore.tabs.findIndex((tab) => tab.id === tabId) > 0;
}

function hasTabsToRight(tabId: string) {
  const index = queryStore.tabs.findIndex((tab) => tab.id === tabId);
  return index >= 0 && index < queryStore.tabs.length - 1;
}

function tabTitle(tab: (typeof queryStore.tabs)[number]) {
  return tabTooltipLines(tab)
    .map((line) => `${line.label} ${line.value}`)
    .join("\n");
}

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
        activeEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      }
      updateScrollButtons();
    });
  },
);
</script>

<template>
  <div v-if="queryStore.tabs.length > 0" class="relative h-9 flex items-stretch border-b bg-muted shrink-0">
    <button
      v-if="canScrollLeft"
      class="absolute left-0 z-10 h-full px-1 bg-linear-to-r from-background via-background/80 to-transparent text-muted-foreground hover:text-foreground"
      :aria-label="t('tabs.scrollLeft')"
      @click="scrollTabs('left')"
    >
      <ChevronRight class="h-4 w-4 rotate-180" />
    </button>
    <div
      ref="tabsContainerRef"
      class="flex-1 flex items-center overflow-x-auto min-w-0"
      style="-ms-overflow-style: none; scrollbar-width: none; -webkit-overflow-scrolling: touch"
      @scroll="updateScrollButtons"
    >
      <ContextMenu v-for="tab in queryStore.tabs" :key="tab.id">
        <ContextMenuTrigger as-child>
          <div
            class="group flex min-w-38 items-center gap-1 px-2 h-full text-xs cursor-pointer transition-colors whitespace-nowrap border-r border-border/50 select-none"
            :class="
              tab.id === queryStore.activeTabId
                ? 'bg-background text-foreground font-medium'
                : 'text-foreground/70 hover:text-foreground/90'
            "
            :style="tab.id === queryStore.activeTabId ? { boxShadow: '0 1px 0 0 var(--color-background)' } : undefined"
            :data-active-tab="tab.id === queryStore.activeTabId"
            :title="tabTitle(tab)"
            @click="queryStore.activeTabId = tab.id"
            @mousedown.right="queryStore.activeTabId = tab.id"
          >
            <span
              class="h-1.5 w-1.5 rounded-full shrink-0"
              :style="{ backgroundColor: connectionColor(tab.connectionId) || '#9ca3af' }"
            />
            <span class="min-w-0 truncate flex-1">{{ tabDisplayTitle(tab) }}</span>
            <Tooltip>
              <TooltipTrigger as-child>
                <button
                  class="inline-flex rounded p-0.5 text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground focus:opacity-100"
                  :class="tab.pinned ? 'visible text-primary' : 'invisible group-hover:visible'"
                  @click.stop="queryStore.togglePinnedTab(tab.id)"
                >
                  <Pin class="h-3 w-3" :class="{ 'fill-current': tab.pinned }" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{{ tab.pinned ? t("contextMenu.unpin") : t("contextMenu.pin") }}</TooltipContent>
            </Tooltip>
            <span
              class="shrink-0 rounded border px-1 text-[10px] leading-4"
              :class="
                tab.mode === 'data'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
                  : 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300'
              "
            >
              {{ tabModeLabel(tab) }}
            </span>
            <button
              class="rounded hover:bg-muted-foreground/20 p-0.5 shrink-0"
              @click.stop="queryStore.closeTab(tab.id)"
            >
              <X class="h-3 w-3" />
            </button>
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent class="w-44">
          <ContextMenuItem @click="queryStore.togglePinnedTab(tab.id)">
            <Pin class="w-3.5 h-3.5 mr-2" :class="{ 'fill-current': tab.pinned }" />
            {{ tab.pinned ? t("contextMenu.unpin") : t("contextMenu.pin") }}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem @click="queryStore.closeTab(tab.id)">
            <X class="w-3.5 h-3.5 mr-2" />
            {{ t("contextMenu.closeTab") }}
          </ContextMenuItem>
          <ContextMenuItem :disabled="!hasTabsToLeft(tab.id)" @click="queryStore.closeLeftTabs(tab.id)">
            <X class="w-3.5 h-3.5 mr-2" />
            {{ t("contextMenu.closeLeftTabs") }}
          </ContextMenuItem>
          <ContextMenuItem :disabled="!hasTabsToRight(tab.id)" @click="queryStore.closeRightTabs(tab.id)">
            <X class="w-3.5 h-3.5 mr-2" />
            {{ t("contextMenu.closeRightTabs") }}
          </ContextMenuItem>
          <ContextMenuItem :disabled="queryStore.tabs.length <= 1" @click="queryStore.closeOtherTabs(tab.id)">
            <X class="w-3.5 h-3.5 mr-2" />
            {{ t("contextMenu.closeOtherTabs") }}
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" @click="queryStore.closeAllTabs">
            <X class="w-3.5 h-3.5 mr-2" />
            {{ t("contextMenu.closeAllTabs") }}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
    <button
      v-if="canScrollRight"
      class="absolute right-0 z-10 h-full px-1 bg-linear-to-l from-background via-background/80 to-transparent text-muted-foreground hover:text-foreground"
      :aria-label="t('tabs.scrollRight')"
      @click="scrollTabs('right')"
    >
      <ChevronRight class="h-4 w-4" />
    </button>
  </div>
</template>

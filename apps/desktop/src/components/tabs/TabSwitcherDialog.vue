<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionIconType } from "@/lib/connection/connectionPresentation";
import { hexToRgba } from "@/lib/common/color";
import { connectionColor, connectionDisplayName, tabDisplayTitle, tabModeLabel } from "@/lib/tabs/tabPresentation";
import type { QueryTab } from "@/types/database";

const props = defineProps<{
  open: boolean;
  tabs: QueryTab[];
  selectedIndex: number;
  shortcutHint: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  "update:selectedIndex": [index: number];
  select: [tabId: string];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const listRef = ref<HTMLElement>();

function tabColor(tab: QueryTab): string {
  return connectionColor(tab.connectionId);
}

function tabRowStyle(tab: QueryTab, index: number) {
  const color = tabColor(tab);
  if (!color) return undefined;
  return {
    backgroundColor: hexToRgba(color, index === props.selectedIndex ? 0.28 : 0.07),
    boxShadow: `inset 3px 0 0 ${color}`,
  };
}

watch(
  () => [props.open, props.selectedIndex],
  async ([open]) => {
    if (!open) return;
    await nextTick();
    listRef.value?.querySelectorAll("[data-tab-switcher-row]")[props.selectedIndex]?.scrollIntoView({ block: "nearest" });
  },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-[100] flex items-start justify-center pt-[18vh]" @mousedown.self="emit('update:open', false)">
      <div class="w-[420px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border bg-popover shadow-2xl" role="listbox" :aria-label="t('tabs.switcherTitle')">
        <div class="border-b px-3 py-2 text-xs font-medium text-muted-foreground">{{ t("tabs.switcherTitle") }}</div>
        <div ref="listRef" class="max-h-[60vh] overflow-y-auto p-1">
          <div
            v-for="(tab, index) in tabs"
            :key="tab.id"
            :data-tab-switcher-row="tab.id"
            role="option"
            :aria-selected="index === selectedIndex"
            :style="tabRowStyle(tab, index)"
            :class="['flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5', index === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60']"
            @mouseenter="emit('update:selectedIndex', index)"
            @click="emit('select', tab.id)"
          >
            <DatabaseIcon :db-type="connectionIconType(connectionStore.getConfig(tab.connectionId))" class="h-4 w-4 shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium">{{ tabDisplayTitle(tab, t) }}</div>
              <div class="truncate text-xs text-muted-foreground">
                {{ connectionDisplayName(tab.connectionId) }}<template v-if="tab.database"> · {{ tab.database }}</template>
              </div>
            </div>
            <span class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ tabModeLabel(tab, t) }}</span>
          </div>
        </div>
        <div class="flex items-center justify-between border-t px-3 py-1.5 text-xs text-muted-foreground">
          <span>
            <kbd class="rounded bg-muted px-1.5 py-0.5">{{ shortcutHint }}</kbd>
            {{ t("tabs.switcherHint") }}
          </span>
          <span><kbd class="rounded bg-muted px-1.5 py-0.5">Esc</kbd> {{ t("quickOpen.close") }}</span>
        </div>
      </div>
    </div>
  </Teleport>
</template>

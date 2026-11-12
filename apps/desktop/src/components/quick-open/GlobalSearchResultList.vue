<script setup lang="ts">
import { FileCode, FileText } from "@lucide/vue";
import PluginIcon from "@/components/plugins/PluginIcon.vue";
import { useI18n } from "vue-i18n";
import type { QuickOpenItem } from "@/composables/useQuickOpen";

type HighlightPart = string | { text: string; highlight: boolean };
type LinePart = { text: string; highlight: boolean };
type ContentGroup = { header: string; filePath: string; matches: QuickOpenItem[] };
type ResultCategory = "objects" | "files" | "commands";

const props = defineProps<{
  contentMode: boolean;
  contentSearching: boolean;
  contentSearchError: string | null;
  contentGroups: ContentGroup[];
  selectedIndex: number;
  searchQuery: string;
  items: QuickOpenItem[];
  selectedId?: string;
  getHighlightedLineParts: (item: QuickOpenItem) => LinePart[];
  getHighlightedLabel: (item: QuickOpenItem) => HighlightPart[];
  getItemIcon: (type: string) => unknown;
  getResultCategory: (item: QuickOpenItem) => ResultCategory;
  getResultCategoryLabel: (category: ResultCategory) => string;
  getResultCategoryCount: (category: ResultCategory) => number;
  getSourceLabel: (item: QuickOpenItem) => string;
  getTypeBadge: (item: QuickOpenItem) => string;
  getResultContext: (item: QuickOpenItem) => string;
}>();

const emit = defineEmits<{
  open: [item: QuickOpenItem];
  hover: [item: QuickOpenItem];
  contentHover: [index: number];
  retryContentSearch: [];
}>();

const { t } = useI18n();

const contentRows = () => {
  const rows: Array<{ isHeader: boolean; header?: string; filePath?: string; count?: number; item?: QuickOpenItem; flatIndex: number }> = [];
  let flatIndex = 0;
  for (const group of props.contentGroups) {
    rows.push({ isHeader: true, header: group.header, filePath: group.filePath, count: group.matches.length, flatIndex: -1 });
    for (const match of group.matches) rows.push({ isHeader: false, filePath: group.filePath, item: match, flatIndex: flatIndex++ });
  }
  return rows;
};
</script>

<template>
  <div class="min-h-0 overflow-y-auto" :class="props.contentMode ? 'max-h-[min(50vh,480px)]' : 'max-h-[min(58vh,560px)]'">
    <template v-if="props.contentMode">
      <div v-if="props.contentSearching" class="px-4 py-8 text-center text-muted-foreground">{{ t("quickOpen.searchingContent") }}</div>
      <template v-else>
        <div v-if="props.contentSearchError" role="alert" class="flex flex-col items-center gap-3 border-b px-4 py-4 text-center text-destructive">
          <p class="whitespace-pre-wrap break-words text-sm">{{ t("quickOpen.contentSearchFailed") }}</p>
          <p class="max-w-full whitespace-pre-wrap break-words text-xs text-muted-foreground">{{ props.contentSearchError }}</p>
          <button type="button" class="rounded-md border px-3 py-1.5 text-xs text-foreground hover:bg-muted" @click="emit('retryContentSearch')">{{ t("common.retry") }}</button>
        </div>
        <div v-if="contentRows().length === 0 && !props.contentSearchError" class="px-4 py-8 text-center text-muted-foreground">
          <p v-if="!props.searchQuery.trim()">{{ t("quickOpen.emptyPlaceholder") }}</p>
          <p v-else>{{ t("quickOpen.noResults") }}</p>
        </div>
        <div v-else class="divide-y">
          <template v-for="row in contentRows()" :key="row.isHeader ? `h-${row.filePath}` : row.item!.id">
            <div v-if="row.isHeader" class="flex items-center justify-between gap-3 bg-muted/50 px-4 py-1.5">
              <div class="flex min-w-0 items-center gap-2">
                <FileCode class="h-4 w-4 shrink-0 text-muted-foreground" /><span class="truncate text-xs font-semibold text-foreground">{{ row.header }}</span>
              </div>
              <span class="whitespace-nowrap text-xs text-muted-foreground">{{ row.count }}</span>
            </div>
            <div v-else class="cursor-pointer px-4 py-1.5" :data-selected="row.flatIndex === props.selectedIndex" :class="row.flatIndex === props.selectedIndex ? 'bg-accent' : 'hover:bg-muted'" @click="emit('open', row.item!)" @mouseenter="emit('contentHover', row.flatIndex)">
              <div v-if="row.item!.line === 0" class="flex min-w-0 items-center gap-2">
                <FileText class="h-4 w-4 shrink-0 text-muted-foreground" />
                <span class="truncate font-mono text-xs"
                  ><template v-for="(part, i) in props.getHighlightedLineParts(row.item!)" :key="i"
                    ><span v-if="part.highlight" class="rounded-[0.1875rem] bg-yellow-200 px-0.5 font-semibold text-foreground dark:bg-yellow-800">{{ part.text }}</span
                    ><span v-else>{{ part.text }}</span></template
                  ></span
                >
              </div>
              <div v-else class="flex min-w-0 items-center gap-2">
                <span class="shrink-0 font-mono text-xs text-muted-foreground">{{ row.item!.line }}</span>
                <span class="truncate font-mono text-xs"
                  ><template v-for="(part, i) in props.getHighlightedLineParts(row.item!)" :key="i"
                    ><span v-if="part.highlight" class="rounded-[0.1875rem] bg-yellow-200 px-0.5 font-semibold text-foreground dark:bg-yellow-800">{{ part.text }}</span
                    ><span v-else>{{ part.text }}</span></template
                  ></span
                >
              </div>
            </div>
          </template>
        </div>
      </template>
    </template>

    <div v-else-if="props.items.length === 0" class="px-4 py-8 text-center text-muted-foreground">
      <p v-if="!props.searchQuery.trim()">{{ t("quickOpen.emptyPlaceholder") }}</p>
      <p v-else>{{ t("quickOpen.noResults") }}</p>
    </div>
    <div v-else class="divide-y">
      <template v-for="(item, index) in props.items" :key="item.id">
        <div v-if="index === 0 || props.getResultCategory(props.items[index - 1]!) !== props.getResultCategory(item)" class="flex items-center justify-between border-b bg-muted/40 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>{{ props.getResultCategoryLabel(props.getResultCategory(item)) }}</span
          ><span>{{ props.getResultCategoryCount(props.getResultCategory(item)) }}</span>
        </div>
        <div :data-selected="item.id === props.selectedId" :class="['cursor-pointer px-4 py-2', item.id === props.selectedId ? 'bg-accent' : 'hover:bg-muted']" @click="emit('open', item)" @mouseenter="emit('hover', item)">
          <div class="flex items-center justify-between gap-3">
            <div class="flex min-w-0 flex-1 items-center gap-2">
              <PluginIcon v-if="item.type === 'plugin_workbench' && item.pluginId" :plugin-id="item.pluginId" :icon="item.pluginIcon" :contribution-id="item.contributionId" class="h-4 w-4 shrink-0" />
              <component v-if="props.getItemIcon(item.type)" :is="props.getItemIcon(item.type)" class="h-4 w-4 shrink-0 text-muted-foreground" />
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium">
                  <template v-for="(part, i) in props.getHighlightedLabel(item)" :key="i"
                    ><span v-if="typeof part === 'object'" :class="{ 'bg-yellow-200 font-semibold dark:bg-yellow-800': part.highlight }">{{ part.text }}</span
                    ><span v-else>{{ part }}</span></template
                  >
                </div>
                <div v-if="item.description || props.getResultContext(item)" class="truncate text-xs text-muted-foreground">{{ item.description || props.getResultContext(item) }}</div>
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-1">
              <div class="whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ props.getSourceLabel(item) }}</div>
              <div class="whitespace-nowrap rounded bg-muted px-2 py-1 text-xs text-muted-foreground">{{ props.getTypeBadge(item) }}</div>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

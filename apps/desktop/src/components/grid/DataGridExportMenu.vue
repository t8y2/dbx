<script setup lang="ts">
import { computed, ref } from "vue";
import { AlertTriangle, ChevronDown, Download, Upload } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import type { LightDropdownItem } from "@/components/ui/LightDropdown.vue";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const props = defineProps<{
  items: LightDropdownItem[];
  label: string;
  onSelect: (value: string) => void;
  warning?: string;
  compact?: boolean;
}>();
const { t } = useI18n();
const open = ref(false);
const formats = ["csv", "xlsx", "xlsx-with-sql", "json", "markdown", "html", "sql", "txt"];
const rows = computed(() =>
  formats.flatMap((format) => {
    const page = props.items.find((item) => item.value === `page-${format}`);
    const selected = props.items.find((item) => item.value === `selected-${format}`);
    const result = props.items.find((item) => item.value === format);
    return result ? [{ format, label: format === "xlsx-with-sql" ? t("grid.exportFormatXlsxWithSql") : format === "sql" ? "SQL INSERT" : format === "markdown" ? "Markdown" : format.toUpperCase(), selected, page, result }] : [];
  }),
);
const hasPageScope = computed(() => rows.value.some((row) => row.page));
const hasSelectedScope = computed(() => rows.value.some((row) => row.selected));
const gridColumns = computed(() => `minmax(0,1fr) ${hasSelectedScope.value ? "80px " : ""}${hasPageScope.value ? "80px " : ""}88px`);
const extraItems = computed(() => props.items.filter((item) => !formats.includes(item.value) && !formats.some((format) => item.value === `page-${format}` || item.value === `selected-${format}`)));
function select(item: LightDropdownItem) {
  if (item.disabled) return;
  open.value = false;
  props.onSelect(item.value);
}
function onKeydown(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.key === "Escape") {
    event.preventDefault();
    open.value = false;
  }
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button type="button" :aria-label="label" :title="label" class="inline-flex h-6 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md text-xs leading-none text-foreground/80 hover:bg-accent hover:text-accent-foreground" :class="compact ? 'w-6' : 'px-2'">
        <Upload class="h-3.5 w-3.5" /><span v-if="!compact">{{ label }}</span
        ><ChevronDown v-if="!compact" class="h-3 w-3 opacity-50" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" :collision-padding="8" class="max-w-[calc(100vw-1rem)] max-h-[var(--reka-popover-content-available-height)] overflow-y-auto p-1 text-sm" :class="hasSelectedScope ? 'w-[440px]' : 'w-[360px]'" @click.stop @keydown="onKeydown">
      <div class="grid items-center gap-x-1 px-2 py-1.5 text-muted-foreground" :style="{ gridTemplateColumns: gridColumns }">
        <span class="text-xs">{{ t("grid.exportFormat") }}</span>
        <span v-if="hasSelectedScope" class="text-center text-xs">{{ t("grid.exportSelectedRowsScope") }}</span>
        <span v-if="hasPageScope" class="flex items-center justify-center gap-1 text-xs">{{ t("grid.exportPageScope") }}<AlertTriangle v-if="warning" class="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" :aria-label="warning" :title="warning" /></span>
        <span class="text-center text-xs">{{ t(hasPageScope ? "grid.exportResultScope" : "grid.exportLoadedScope") }}</span>
        <template v-for="row in rows" :key="row.format">
          <span class="py-2 text-foreground">{{ row.label }}</span>
          <template v-if="hasSelectedScope">
            <button
              v-if="row.selected"
              type="button"
              class="flex h-8 items-center justify-center gap-1 rounded-sm text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
              :disabled="row.selected.disabled"
              :title="row.selected.label"
              :aria-label="row.selected.label"
              @click="select(row.selected)"
            >
              <Download class="h-3.5 w-3.5" />
            </button>
            <span v-else />
          </template>
          <button
            v-if="row.page"
            type="button"
            class="flex h-8 items-center justify-center gap-1 rounded-sm text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
            :disabled="row.page.disabled"
            :title="row.page.label"
            :aria-label="row.page.label"
            @click="select(row.page)"
          >
            <Download class="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            class="flex h-8 items-center justify-center gap-1 rounded-sm text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
            :disabled="row.result.disabled"
            :title="row.result.label"
            :aria-label="row.result.label"
            @click="select(row.result)"
          >
            <Download class="h-3.5 w-3.5" />
          </button>
        </template>
      </div>
      <p v-if="warning" role="note" class="mx-2 mb-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">{{ warning }}</p>
      <div v-if="extraItems.length" class="my-1 h-px bg-border" />
      <template v-for="(item, index) in extraItems" :key="item.value">
        <div v-if="index > 0 && item.separatorBefore" class="my-1 h-px bg-border" />
        <button type="button" class="block w-full rounded-sm px-2 py-1.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50" :disabled="item.disabled" @click="select(item)">{{ item.label }}</button>
      </template>
    </PopoverContent>
  </Popover>
</template>

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

// Every exportable scope is its own column. Rows, selection and selected columns all
// produce `<scope>-<format>` items, so they belong in the same grid row as the format;
// treating only `selected-*` as a column left the other two as a stray list (#14469).
const scopes = [
  { key: "selected", labelKey: "grid.exportSelectedRowsScope" },
  { key: "selected-cells", labelKey: "grid.exportSelectedCellsScope" },
  { key: "selected-columns", labelKey: "grid.exportSelectedColumnsScope" },
  { key: "page", labelKey: "grid.exportPageScope" },
] as const;

function scopeValue(scopeKey: string, format: string): string {
  return `${scopeKey}-${format}`;
}

const rows = computed(() =>
  formats.flatMap((format) => {
    const result = props.items.find((item) => item.value === format);
    if (!result) return [];
    const scoped = Object.fromEntries(scopes.map((scope) => [scope.key, props.items.find((item) => item.value === scopeValue(scope.key, format))]));
    return [{ format, label: format === "xlsx-with-sql" ? t("grid.exportFormatXlsxWithSql") : format === "sql" ? "SQL INSERT" : format === "markdown" ? "Markdown" : format.toUpperCase(), scoped, result }];
  }),
);

const scopeColumns = computed(() => scopes.filter((scope) => rows.value.some((row) => row.scoped[scope.key])));
const gridColumns = computed(() => `minmax(0,1fr) ${scopeColumns.value.map(() => "80px ").join("")}88px`);
const popoverWidth = computed(() => 360 + scopeColumns.value.length * 80);
const extraItems = computed(() => props.items.filter((item) => !formats.includes(item.value) && !scopes.some((scope) => formats.some((format) => item.value === scopeValue(scope.key, format)))));
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
    <PopoverContent align="end" :collision-padding="8" class="max-w-[calc(100vw-1rem)] max-h-[var(--reka-popover-content-available-height)] overflow-y-auto p-1 text-sm" :style="{ width: `${popoverWidth}px` }" @click.stop @keydown="onKeydown">
      <div class="grid items-center gap-x-1 px-2 py-1.5 text-muted-foreground" :style="{ gridTemplateColumns: gridColumns }">
        <span class="text-xs">{{ t("grid.exportFormat") }}</span>
        <span v-for="scope in scopeColumns" :key="scope.key" class="flex items-center justify-center gap-1 text-center text-xs">
          {{ t(scope.labelKey) }}<AlertTriangle v-if="scope.key === 'page' && warning" class="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" :aria-label="warning" :title="warning" />
        </span>
        <span class="text-center text-xs">{{ t(scopeColumns.some((scope) => scope.key === "page") ? "grid.exportResultScope" : "grid.exportLoadedScope") }}</span>
        <template v-for="row in rows" :key="row.format">
          <span class="py-2 text-foreground">{{ row.label }}</span>
          <template v-for="scope in scopeColumns" :key="scope.key">
            <button
              v-if="row.scoped[scope.key]"
              type="button"
              class="flex h-8 items-center justify-center gap-1 rounded-sm text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
              :disabled="row.scoped[scope.key]!.disabled"
              :title="row.scoped[scope.key]!.label"
              :aria-label="row.scoped[scope.key]!.label"
              @click="select(row.scoped[scope.key]!)"
            >
              <Download class="h-3.5 w-3.5" />
            </button>
            <span v-else />
          </template>
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

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AlertTriangle, KeyRound } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ColumnInfo } from "@/types/database";

const props = defineProps<{
  columns: ColumnInfo[];
  selectedColumns: string[];
  compact?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  apply: [columns: string[]];
  clear: [];
}>();

const { t } = useI18n();
const open = ref(false);
const draftColumns = ref<string[]>([]);
const hasConfiguredKey = computed(() => props.selectedColumns.length > 0);
const canApply = computed(() => !props.disabled && draftColumns.value.length > 0);

watch(open, (nextOpen) => {
  if (nextOpen) draftColumns.value = [...props.selectedColumns];
});

function toggleColumn(column: string, checked: boolean) {
  const selected = new Set(draftColumns.value);
  if (checked) selected.add(column);
  else selected.delete(column);
  draftColumns.value = props.columns.filter((candidate) => selected.has(candidate.name)).map((candidate) => candidate.name);
}

function apply() {
  if (!canApply.value) return;
  emit("apply", [...draftColumns.value]);
  open.value = false;
}

function clear() {
  if (props.disabled) return;
  emit("clear");
  open.value = false;
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button
        data-toolbar-action="virtual-row-identifier"
        variant="ghost"
        size="sm"
        :class="['data-grid-topbar-action-button h-5 shrink-0 px-1.5 text-xs', compact ? 'data-grid-topbar-action-button--compact' : '', hasConfiguredKey ? 'bg-primary/10 text-primary hover:bg-primary/15' : 'text-amber-700 hover:bg-amber-500/10 dark:text-amber-300']"
        :disabled="disabled"
        :aria-label="t('grid.virtualRowIdentifier')"
        :aria-pressed="hasConfiguredKey"
        :title="t('grid.virtualRowIdentifier')"
      >
        <KeyRound class="data-grid-topbar-action-icon h-3 w-3" />
        <span class="data-grid-topbar-action-label" :class="{ 'data-grid-topbar-action-label--compact': compact }">{{ t("grid.virtualRowIdentifier") }}</span>
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" class="w-80 p-0">
      <div class="border-b px-3 py-2.5">
        <div class="text-sm font-semibold">{{ t("grid.virtualRowIdentifierTitle") }}</div>
        <div class="mt-1 text-xs text-muted-foreground">{{ t("grid.virtualRowIdentifierDescription") }}</div>
      </div>
      <div class="flex gap-2 border-b bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
        <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{{ t("grid.virtualRowIdentifierWarning") }}</span>
      </div>
      <div class="max-h-64 overflow-auto p-1.5">
        <label v-for="column in columns" :key="column.name" class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/70">
          <input type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="draftColumns.includes(column.name)" :disabled="disabled" @change="toggleColumn(column.name, ($event.target as HTMLInputElement).checked)" />
          <span class="min-w-0 flex-1 truncate font-mono">{{ column.name }}</span>
          <span v-if="column.is_nullable" class="shrink-0 text-[10px] text-muted-foreground">NULL</span>
        </label>
      </div>
      <div class="flex items-center justify-between gap-2 border-t px-3 py-2">
        <Button v-if="hasConfiguredKey" type="button" variant="ghost" size="sm" :disabled="disabled" @click="clear">{{ t("grid.virtualRowIdentifierClear") }}</Button>
        <span v-else />
        <Button type="button" size="sm" :disabled="!canApply" @click="apply">{{ t("grid.virtualRowIdentifierApply") }}</Button>
      </div>
    </PopoverContent>
  </Popover>
</template>

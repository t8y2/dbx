<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Layers } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";

/**
 * Toolbar control for MongoDB grids: pick subdocument fields to expand into
 * dot-path columns (address.city), or flatten every nested field at once.
 */
const props = withDefaults(
  defineProps<{
    /** Dot-path columns that hold subdocuments (plus any already expanded). */
    columns: string[];
    expanded: string[];
    flattenAll: boolean;
    active: boolean;
    /** Extra note under the title, e.g. that the grid turns read-only. */
    hint?: string;
  }>(),
  { hint: "" },
);

const emit = defineEmits<{
  toggle: [column: string];
  "update:flattenAll": [value: boolean];
  expandAll: [];
  collapseAll: [];
}>();

const { t } = useI18n();
const open = ref(false);

function isExpanded(column: string): boolean {
  return props.flattenAll || props.expanded.includes(column);
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button variant="ghost" size="icon" class="h-6 w-7 shrink-0 text-foreground hover:bg-accent" :class="{ 'bg-accent': active }" :title="t('mongo.nestedFields')" :aria-label="t('mongo.nestedFields')" data-mongo-nested-fields>
        <Layers class="h-4 w-4" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" :collision-padding="8" class="w-72 max-h-[var(--reka-popover-content-available-height)] gap-0 overflow-hidden p-0" @click.stop @keydown.stop>
      <div class="border-b bg-muted/40 px-3 py-2">
        <div class="text-xs font-semibold">{{ t("mongo.nestedFields") }}</div>
        <div class="mt-0.5 text-[11px] text-muted-foreground">{{ hint || t("mongo.nestedFieldsHint") }}</div>
      </div>
      <label class="flex items-center justify-between gap-3 border-b px-3 py-2 text-xs font-medium">
        <span>{{ t("mongo.flattenAllNested") }}</span>
        <Switch :model-value="flattenAll" @update:model-value="(value: boolean) => emit('update:flattenAll', value)" />
      </label>
      <div class="max-h-72 overflow-y-auto py-1">
        <label v-for="column in columns" :key="column" class="flex cursor-pointer items-center gap-2 px-3 py-1 text-xs hover:bg-accent" :class="{ 'opacity-60': flattenAll }">
          <input type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="isExpanded(column)" :disabled="flattenAll" @change="emit('toggle', column)" />
          <span class="truncate font-mono" :title="column">{{ column }}</span>
        </label>
        <div v-if="!columns.length" class="px-3 py-3 text-center text-xs text-muted-foreground">{{ t("mongo.noNestedFields") }}</div>
      </div>
      <div class="flex items-center justify-end gap-1 border-t px-2 py-1.5">
        <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" :disabled="flattenAll || !columns.length" @click="emit('expandAll')">{{ t("mongo.treeExpandAll") }}</Button>
        <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" :disabled="!active" @click="emit('collapseAll')">{{ t("mongo.treeCollapseAll") }}</Button>
      </div>
    </PopoverContent>
  </Popover>
</template>

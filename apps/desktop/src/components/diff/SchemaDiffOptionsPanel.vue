<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HelpTooltip } from "@/components/ui/tooltip";
import type { BooleanSchemaDiffCompareOptionKey, SchemaDiffCompareOptions, SchemaDiffOptionItem } from "@/types/schemaDiff";
import { normalizeSchemaDiffCompareOptions } from "@/types/schemaDiff";

const props = defineProps<{
  options: SchemaDiffCompareOptions;
  optionTree: SchemaDiffOptionItem[];
}>();

const emit = defineEmits<{
  (e: "update:options", options: SchemaDiffCompareOptions): void;
  (e: "close"): void;
}>();

const { t } = useI18n();

// Local copy of options
const localOptions = ref<SchemaDiffCompareOptions>(normalizeSchemaDiffCompareOptions(props.options));

// Watch for external changes
watch(
  () => props.options,
  (newOptions) => {
    localOptions.value = normalizeSchemaDiffCompareOptions(newOptions);
  },
  { deep: true },
);

function isChecked(id: BooleanSchemaDiffCompareOptionKey): boolean {
  return !!localOptions.value[id];
}

function setOption(id: BooleanSchemaDiffCompareOptionKey, checked: boolean) {
  localOptions.value = { ...localOptions.value, [id]: checked };
}

function getChildState(item: SchemaDiffOptionItem): "checked" | "unchecked" | "indeterminate" {
  if (!item.children || item.children.length === 0) {
    return isChecked(item.id) ? "checked" : "unchecked";
  }
  const childStates = item.children.map((child) => getChildState(child));
  if (childStates.every((s) => s === "checked")) return "checked";
  if (childStates.every((s) => s === "unchecked")) return "unchecked";
  return "indeterminate";
}

function toggleItem(item: SchemaDiffOptionItem) {
  const state = getChildState(item);
  const nextChecked = state !== "checked";
  setSubtree(item, nextChecked);
}

function setSubtree(item: SchemaDiffOptionItem, checked: boolean) {
  setOption(item.id, checked);
  if (item.children) {
    for (const child of item.children) {
      setSubtree(child, checked);
    }
  }
}

function handleDone() {
  emit("update:options", { ...localOptions.value });
  emit("close");
}

function handleCancel() {
  emit("close");
}

function getItemClasses(state: "checked" | "unchecked" | "indeterminate"): string {
  const base = "h-4 w-4 rounded border flex items-center justify-center transition-colors cursor-pointer";
  if (state === "checked") {
    return `${base} bg-primary border-primary text-primary-foreground`;
  }
  if (state === "indeterminate") {
    return `${base} bg-primary border-primary text-primary-foreground`;
  }
  return `${base} bg-background border-input hover:border-muted-foreground`;
}
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="grid flex-1 grid-cols-[minmax(0,1fr)_minmax(300px,0.95fr)] gap-4 overflow-auto pr-1">
      <div class="min-w-0 space-y-1">
        <div class="px-2 pb-1 text-xs font-medium text-muted-foreground">{{ t("schemaDiff.optionsTitle") }}</div>
        <div class="space-y-1">
          <template v-for="item in optionTree" :key="item.id">
            <div class="space-y-1">
              <div class="flex items-center gap-2 py-1 px-2 rounded hover:bg-muted/50 cursor-pointer" @click="toggleItem(item)">
                <div :class="getItemClasses(getChildState(item))">
                  <svg v-if="getChildState(item) === 'checked'" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <svg v-else-if="getChildState(item) === 'indeterminate'" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4">
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </div>
                <span class="text-sm select-none">{{ t(item.labelKey) }}</span>
              </div>
              <div v-if="item.children" class="ml-6 space-y-1">
                <div v-for="child in item.children" :key="child.id" class="flex items-center gap-2 py-1 px-2 rounded hover:bg-muted/50 cursor-pointer" @click="toggleItem(child)">
                  <div :class="getItemClasses(getChildState(child))">
                    <svg v-if="getChildState(child) === 'checked'" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                  <span class="text-sm select-none">{{ t(child.labelKey) }}</span>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>

      <div class="grid min-w-0 grid-cols-[112px_minmax(0,1fr)] content-start gap-x-3 gap-y-2 border-l pl-4">
        <div class="pt-1 text-xs font-medium text-muted-foreground">{{ t("schemaDiff.tableFilter") }}</div>
        <div class="flex min-w-0 items-center justify-between gap-2">
          <span class="truncate text-xs text-muted-foreground">{{ t("schemaDiff.tableFilterHintShort") }}</span>
          <HelpTooltip :label="t('schemaDiff.tableFilterHelp')" side="left">
            <div class="space-y-1">
              <div>{{ t("schemaDiff.tableFilterHelpRule") }}</div>
              <div>{{ t("schemaDiff.tableFilterHelpBlank") }}</div>
              <div>{{ t("schemaDiff.tableFilterHelpExample") }}</div>
            </div>
          </HelpTooltip>
        </div>
        <label class="pt-2 text-xs font-medium text-muted-foreground" for="schema-diff-table-include">{{ t("schemaDiff.tableIncludePattern") }}</label>
        <input id="schema-diff-table-include" v-model="localOptions.tableIncludePattern" class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring" :placeholder="t('schemaDiff.tableIncludePatternPlaceholder')" />
        <label class="pt-2 text-xs font-medium text-muted-foreground" for="schema-diff-table-exclude">{{ t("schemaDiff.tableExcludePattern") }}</label>
        <input id="schema-diff-table-exclude" v-model="localOptions.tableExcludePattern" class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring" :placeholder="t('schemaDiff.tableExcludePatternPlaceholder')" />
        <label class="pt-2 text-xs font-medium text-muted-foreground" for="schema-diff-table-priority">{{ t("schemaDiff.tableFilterPriority") }}</label>
        <div>
          <Select v-model="localOptions.tableFilterPriority">
            <SelectTrigger id="schema-diff-table-priority" class="h-8 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="exclude">{{ t("schemaDiff.tableFilterPriorityExclude") }}</SelectItem>
              <SelectItem value="include">{{ t("schemaDiff.tableFilterPriorityInclude") }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>

    <div class="flex items-center justify-end gap-2 pt-4 border-t mt-2">
      <Button variant="outline" size="sm" @click="handleCancel">
        {{ t("common.cancel") }}
      </Button>
      <Button size="sm" @click="handleDone">
        {{ t("common.done") }}
      </Button>
    </div>
  </div>
</template>

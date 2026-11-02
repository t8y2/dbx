<script setup lang="ts">
import { computed, ref } from "vue";
import { ListChecks, ListFilter, Settings2, TableProperties } from "@lucide/vue";
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

// The panel is a transactional editor: it is recreated each time it opens and
// only commits its local snapshot when the user clicks Done.
const localOptions = ref<SchemaDiffCompareOptions>(normalizeSchemaDiffCompareOptions(props.options));
const objectOptionIds = new Set<BooleanSchemaDiffCompareOptionKey>(["views", "functions", "indexes", "sequences", "triggers", "rules", "owners"]);
const tableDetailOptionIds = new Set<BooleanSchemaDiffCompareOptionKey>(["compareColumnOrder", "compareCharset"]);

const tableOption = computed(() => props.optionTree.find((item) => item.id === "tables"));
const objectOptions = computed(() => props.optionTree.filter((item) => objectOptionIds.has(item.id)));
const tableStructureOptions = computed(() => [...(tableOption.value?.children ?? []), ...props.optionTree.filter((item) => tableDetailOptionIds.has(item.id))]);
const behaviorOptions = computed(() => props.optionTree.filter((item) => item.id !== "tables" && !objectOptionIds.has(item.id) && !tableDetailOptionIds.has(item.id)));

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
  const base = "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors";
  if (state === "checked") {
    return `${base} bg-primary border-primary text-primary-foreground`;
  }
  if (state === "indeterminate") {
    return `${base} bg-primary border-primary text-primary-foreground`;
  }
  return `${base} bg-background border-input hover:border-muted-foreground`;
}

function getItemRowClasses(item: SchemaDiffOptionItem): string {
  const state = getChildState(item);
  const base = "group flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  return state === "unchecked" ? `${base} text-foreground hover:bg-muted/60` : `${base} bg-primary/5 text-foreground hover:bg-primary/10`;
}

function getAriaChecked(item: SchemaDiffOptionItem): boolean | "mixed" {
  const state = getChildState(item);
  return state === "indeterminate" ? "mixed" : state === "checked";
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)] overflow-hidden">
      <div class="min-h-0 space-y-4 overflow-y-auto pr-4">
        <section data-section="object-scope">
          <div class="mb-2 flex items-center gap-2 text-xs font-semibold">
            <ListChecks class="h-4 w-4 shrink-0 text-muted-foreground" />
            <h4>{{ t("schemaDiff.options.objectScopeSection") }}</h4>
          </div>
          <div class="grid grid-cols-2 gap-1">
            <button v-if="tableOption" type="button" role="checkbox" :aria-checked="getAriaChecked(tableOption)" :class="getItemRowClasses(tableOption)" @click="toggleItem(tableOption)">
              <span :class="getItemClasses(getChildState(tableOption))">
                <svg v-if="getChildState(tableOption) === 'checked'" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><polyline points="20 6 9 17 4 12" /></svg>
                <svg v-else-if="getChildState(tableOption) === 'indeterminate'" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><line x1="5" y1="12" x2="19" y2="12" /></svg>
              </span>
              <span class="select-none">{{ t(tableOption.labelKey) }}</span>
            </button>
            <button v-for="item in objectOptions" :key="item.id" type="button" role="checkbox" :aria-checked="getAriaChecked(item)" :class="getItemRowClasses(item)" @click="toggleItem(item)">
              <span :class="getItemClasses(getChildState(item))">
                <svg v-if="getChildState(item) === 'checked'" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><polyline points="20 6 9 17 4 12" /></svg>
              </span>
              <span class="select-none">{{ t(item.labelKey) }}</span>
            </button>
          </div>
        </section>

        <section data-section="table-structure" class="border-t pt-4">
          <div class="mb-2 flex items-center gap-2 text-xs font-semibold">
            <TableProperties class="h-4 w-4 shrink-0 text-muted-foreground" />
            <h4>{{ t("schemaDiff.options.tableStructureSection") }}</h4>
          </div>
          <div class="grid grid-cols-2 gap-1">
            <button v-for="item in tableStructureOptions" :key="item.id" type="button" role="checkbox" :aria-checked="getAriaChecked(item)" :class="getItemRowClasses(item)" @click="toggleItem(item)">
              <span :class="getItemClasses(getChildState(item))">
                <svg v-if="getChildState(item) === 'checked'" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><polyline points="20 6 9 17 4 12" /></svg>
              </span>
              <span class="select-none">{{ t(item.labelKey) }}</span>
            </button>
          </div>
        </section>

        <section v-if="behaviorOptions.length" data-section="compare-behavior" class="border-t pt-4">
          <div class="mb-2 flex items-center gap-2 text-xs font-semibold">
            <Settings2 class="h-4 w-4 shrink-0 text-muted-foreground" />
            <h4>{{ t("schemaDiff.options.behaviorSection") }}</h4>
          </div>
          <div class="grid grid-cols-2 gap-1">
            <button v-for="item in behaviorOptions" :key="item.id" type="button" role="checkbox" :aria-checked="getAriaChecked(item)" :class="getItemRowClasses(item)" @click="toggleItem(item)">
              <span :class="getItemClasses(getChildState(item))">
                <svg v-if="getChildState(item) === 'checked'" class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4"><polyline points="20 6 9 17 4 12" /></svg>
              </span>
              <span class="select-none">{{ t(item.labelKey) }}</span>
            </button>
          </div>
        </section>
      </div>

      <div class="min-h-0 space-y-4 overflow-y-auto border-l pl-4 pr-1">
        <section>
          <div class="mb-3 flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 text-xs font-semibold">
              <ListFilter class="h-4 w-4 shrink-0 text-muted-foreground" />
              <h4>{{ t("schemaDiff.tableFilter") }}</h4>
            </div>
            <HelpTooltip :label="t('schemaDiff.tableFilterHelp')" side="left">
              <div class="space-y-1">
                <div>{{ t("schemaDiff.tableFilterHelpRule") }}</div>
                <div>{{ t("schemaDiff.tableFilterHelpBlank") }}</div>
                <div>{{ t("schemaDiff.tableFilterHelpExample") }}</div>
              </div>
            </HelpTooltip>
          </div>
          <div class="space-y-2.5">
            <div class="space-y-1">
              <label class="text-[11px] font-medium text-muted-foreground" for="schema-diff-table-include">{{ t("schemaDiff.tableIncludePattern") }}</label>
              <input id="schema-diff-table-include" v-model="localOptions.tableIncludePattern" class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none transition-shadow focus:ring-1 focus:ring-ring" :placeholder="t('schemaDiff.tableIncludePatternPlaceholder')" />
            </div>
            <div class="space-y-1">
              <label class="text-[11px] font-medium text-muted-foreground" for="schema-diff-table-exclude">{{ t("schemaDiff.tableExcludePattern") }}</label>
              <input id="schema-diff-table-exclude" v-model="localOptions.tableExcludePattern" class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none transition-shadow focus:ring-1 focus:ring-ring" :placeholder="t('schemaDiff.tableExcludePatternPlaceholder')" />
            </div>
            <div class="space-y-1">
              <label class="text-[11px] font-medium text-muted-foreground" for="schema-diff-table-priority">{{ t("schemaDiff.tableFilterPriority") }}</label>
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
        </section>

        <section class="border-t pt-4">
          <div class="mb-3 flex items-center gap-2 text-xs font-semibold">
            <Settings2 class="h-4 w-4 shrink-0 text-muted-foreground" />
            <h4>{{ t("schemaDiff.options.advancedSection") }}</h4>
          </div>
          <div class="space-y-3">
            <div class="space-y-1.5">
              <div class="flex items-center justify-between gap-2">
                <label class="text-[11px] font-medium text-muted-foreground" for="schema-diff-rename-threshold">{{ t("schemaDiff.options.renameThreshold") }}</label>
                <span class="font-mono text-[11px]" :class="localOptions.detectRenames || localOptions.detectTableRenames ? 'text-foreground' : 'text-muted-foreground'">{{ localOptions.renameThreshold.toFixed(2) }}</span>
              </div>
              <input
                id="schema-diff-rename-threshold"
                v-model.number="localOptions.renameThreshold"
                type="range"
                min="0"
                max="1"
                step="0.05"
                :disabled="!localOptions.detectRenames && !localOptions.detectTableRenames"
                class="h-1.5 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40"
              />
            </div>
            <div class="space-y-1.5">
              <div class="flex items-center justify-between gap-2">
                <label class="text-[11px] font-medium text-muted-foreground" for="schema-diff-compat-threshold">{{ t("schemaDiff.options.compatibilityThreshold") }}</label>
                <span class="font-mono text-[11px] text-foreground">{{ localOptions.compatibilityThreshold.toFixed(2) }}</span>
              </div>
              <input id="schema-diff-compat-threshold" v-model.number="localOptions.compatibilityThreshold" type="range" min="0" max="1" step="0.05" class="h-1.5 w-full cursor-pointer accent-primary" />
            </div>
            <div class="grid grid-cols-2 gap-2">
              <div class="min-w-0 space-y-1">
                <label class="text-[11px] font-medium text-muted-foreground" for="schema-diff-source-dialect">{{ t("schemaDiff.options.sourceDialect") }}</label>
                <input id="schema-diff-source-dialect" v-model="localOptions.sourceDialect" class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none transition-shadow focus:ring-1 focus:ring-ring" :placeholder="t('schemaDiff.options.dialectAuto')" />
              </div>
              <div class="min-w-0 space-y-1">
                <label class="text-[11px] font-medium text-muted-foreground" for="schema-diff-target-dialect">{{ t("schemaDiff.options.targetDialect") }}</label>
                <input id="schema-diff-target-dialect" v-model="localOptions.targetDialect" class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none transition-shadow focus:ring-1 focus:ring-ring" :placeholder="t('schemaDiff.options.dialectAuto')" />
              </div>
            </div>
          </div>
        </section>

        <section class="border-t pt-4">
          <h4 class="mb-2.5 text-xs font-semibold">{{ t("schemaDiff.options.batchSection") }}</h4>
          <input id="schema-diff-batch-patterns" v-model="localOptions.batchPatterns" class="h-8 w-full rounded-md border border-input bg-background px-2 text-xs outline-none transition-shadow focus:ring-1 focus:ring-ring" :placeholder="t('schemaDiff.options.batchPatterns')" />
        </section>
      </div>
    </div>

    <div class="mt-3 flex shrink-0 items-center justify-end gap-2 border-t pt-3">
      <Button variant="outline" size="sm" @click="handleCancel">
        {{ t("common.cancel") }}
      </Button>
      <Button size="sm" @click="handleDone">
        {{ t("common.done") }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { schemaDiffObjectSelectionState, type SchemaDiffObject } from "@/lib/schema/schemaDiff";
import { schemaDiffRoutineKey, summarizeSchemaDiffRoutineTextDiff, type SchemaDiffRoutineTextDiffStats } from "@/lib/schema/schemaDiffRoutine";

const props = defineProps<{
  objects: SchemaDiffObject[];
  viewingObjectId?: string | null;
  emptyText?: string;
  /** When false, hide deploy checkboxes (compare/copy-only dialects). */
  selectable?: boolean;
}>();

const emit = defineEmits<{
  (e: "toggle-selection", object: SchemaDiffObject, selected: boolean): void;
  (e: "view-diff", object: SchemaDiffObject): void;
}>();

const { t } = useI18n();

const showSelection = computed(() => props.selectable !== false);
const emptyLabel = computed(() => props.emptyText || t("diff.noDifferences"));
const gridClass = computed(() => (showSelection.value ? "grid-cols-[28px_minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(120px,0.9fr)]" : "grid-cols-[minmax(0,1.2fr)_minmax(0,1.2fr)_minmax(120px,0.9fr)]"));

const rows = computed(() =>
  props.objects.map((object) => {
    const stats = summarizeSchemaDiffRoutineTextDiff(object.sourceDdl, object.targetDdl);
    return {
      object,
      sourceLabel: object.operationType === "delete" ? "" : displayName(object, "source"),
      targetLabel: object.operationType === "create" ? "" : displayName(object, "target"),
      stats,
      selection: schemaDiffObjectSelectionState(object),
    };
  }),
);

function displayName(object: SchemaDiffObject, side: "source" | "target"): string {
  const name = side === "source" ? (object.sourceName ?? object.name) : (object.targetName ?? object.name);
  return schemaDiffRoutineKey(name, object.arguments ?? "");
}

function hasStats(stats: SchemaDiffRoutineTextDiffStats): boolean {
  return stats.added !== 0 || stats.removed !== 0 || stats.modified !== 0;
}

function onCheckboxChange(object: SchemaDiffObject, event: Event) {
  emit("toggle-selection", object, (event.target as HTMLInputElement).checked);
}

function onRowActivate(object: SchemaDiffObject) {
  emit("view-diff", object);
}
</script>

<template>
  <div class="min-w-0">
    <div class="grid gap-2 border-b px-2 py-1.5 text-xs font-medium text-muted-foreground" :class="gridClass">
      <div v-if="showSelection" />
      <div>{{ t("diff.sourceObject") }}</div>
      <div>{{ t("diff.targetObject") }}</div>
      <div>{{ t("diff.routineDiffPoints") }}</div>
    </div>

    <div v-if="rows.length === 0" class="px-3 py-8 text-center text-xs text-muted-foreground">
      {{ emptyLabel }}
    </div>

    <div v-else class="divide-y divide-border/40">
      <div
        v-for="row in rows"
        :key="row.object.id"
        role="button"
        tabindex="0"
        class="grid cursor-pointer items-center gap-2 px-2 py-1.5 text-xs outline-none focus-visible:bg-accent/40"
        :class="[gridClass, viewingObjectId === row.object.id ? 'bg-primary/10' : 'hover:bg-accent/30']"
        @click="onRowActivate(row.object)"
        @keydown.enter.prevent="onRowActivate(row.object)"
        @keydown.space.prevent="onRowActivate(row.object)"
      >
        <input v-if="showSelection" type="checkbox" class="accent-primary justify-self-center" :checked="row.selection.checked" :indeterminate="row.selection.indeterminate" @click.stop @change="onCheckboxChange(row.object, $event)" />
        <div class="min-w-0 truncate font-mono" :title="row.sourceLabel || undefined">
          <span v-if="row.sourceLabel" :class="row.object.operationType === 'create' ? 'text-green-600 dark:text-green-400' : ''">{{ row.sourceLabel }}</span>
          <span v-else class="text-muted-foreground">—</span>
        </div>
        <div class="min-w-0 truncate font-mono" :title="row.targetLabel || undefined">
          <span v-if="row.targetLabel" :class="row.object.operationType === 'delete' ? 'text-red-500 line-through' : ''">{{ row.targetLabel }}</span>
          <span v-else class="text-muted-foreground">—</span>
        </div>
        <div class="min-w-0 truncate tabular-nums" :title="hasStats(row.stats) ? t('diff.routineDiffStats', { added: row.stats.added, removed: row.stats.removed, modified: row.stats.modified }) : undefined">
          <template v-if="hasStats(row.stats)">
            <span class="text-green-600 dark:text-green-400">+{{ row.stats.added }}</span>
            <span class="text-muted-foreground"> </span>
            <span class="text-red-500 dark:text-red-400">−{{ row.stats.removed }}</span>
            <span class="text-muted-foreground"> </span>
            <span class="text-amber-600 dark:text-amber-400">~{{ row.stats.modified }}</span>
          </template>
          <span v-else class="text-muted-foreground">—</span>
        </div>
      </div>
    </div>
  </div>
</template>

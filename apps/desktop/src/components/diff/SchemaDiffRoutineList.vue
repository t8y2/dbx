<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { schemaDiffObjectSelectionState, type SchemaDiffObject } from "@/lib/schema/schemaDiff";
import { schemaDiffRoutineKey, summarizeSchemaDiffRoutineTextDiff, type SchemaDiffRoutineTextDiffStats } from "@/lib/schema/schemaDiffRoutine";

const props = defineProps<{
  objects: SchemaDiffObject[];
  viewingObjectId?: string | null;
  emptyText?: string;
  sourceSchema?: string;
  targetSchema?: string;
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
      typeMetadata: [
        { side: "source", info: object.sourceTypeInfo, paired: object.sourcePairedObjectPresent, schema: object.sourceSchema ?? props.sourceSchema },
        { side: "target", info: object.targetTypeInfo ?? object.typeInfo, paired: object.targetPairedObjectPresent, schema: object.targetSchema ?? props.targetSchema },
      ].filter((item) => item.info),
    };
  }),
);

function displayName(object: SchemaDiffObject, side: "source" | "target"): string {
  const name = side === "source" ? (object.sourceName ?? object.name) : (object.targetName ?? object.name);
  const schema = side === "source" ? (object.sourceSchema ?? props.sourceSchema) : (object.targetSchema ?? props.targetSchema);
  const qualifiedName = schema ? `${schema}.${name}` : name;
  const trigger = side === "source" ? object.sourceTrigger : object.targetTrigger;
  const relation = trigger ? ` · ${trigger.tableOwner}.${trigger.tableName}` : "";
  return `${object.routineType ?? "FUNCTION"} ${schemaDiffRoutineKey(qualifiedName, object.arguments ?? "")}${relation}`;
}

function hasStats(stats: SchemaDiffRoutineTextDiffStats): boolean {
  return stats.added !== 0 || stats.removed !== 0 || stats.modified !== 0;
}

function onCheckboxChange(object: SchemaDiffObject, event: Event) {
  if (object.blockedReason) return;
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
        <input
          v-if="showSelection"
          type="checkbox"
          class="accent-primary justify-self-center"
          :checked="row.selection.checked"
          :indeterminate="row.selection.indeterminate"
          :disabled="!!row.object.blockedReason"
          :aria-label="row.sourceLabel || row.targetLabel"
          @click.stop
          @change="onCheckboxChange(row.object, $event)"
        />
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
        <div
          v-if="row.object.blockedReason || row.object.compatibilityWarnings?.length || row.object.dependencies?.length || row.object.incomingDependencies?.length || row.object.sourceTrigger || row.object.targetTrigger || row.typeMetadata.length"
          class="col-span-full space-y-1 break-words text-xs"
        >
          <p v-if="row.object.blockedReason" class="text-amber-700 dark:text-amber-400">{{ t("diff.routinePlanBlocked", { reason: row.object.blockedReason }) }}</p>
          <p v-for="warning in row.object.compatibilityWarnings ?? []" :key="warning" class="text-amber-700 dark:text-amber-400">{{ warning }}</p>
          <p v-if="row.object.dependencies?.length" class="text-muted-foreground">{{ t("diff.routineDependencies", { dependencies: row.object.dependencies.join(", ") }) }}</p>
          <p v-if="row.object.incomingDependencies?.length" class="text-amber-700 dark:text-amber-400">{{ t("diff.routineIncomingDependencies", { dependencies: row.object.incomingDependencies.map((item) => `${item.objectType} ${item.owner}.${item.name}`).join(", ") }) }}</p>
          <template v-for="metadata in row.typeMetadata" :key="metadata.side">
            <p class="text-muted-foreground">
              {{ t(metadata.side === "source" ? "diff.sourceObject" : "diff.targetObject") }} ·
              {{
                t("diff.typeMetadataState", {
                  pairing: metadata.paired ? `${row.object.routineType === "TYPE" ? "TYPE BODY" : "TYPE"} ${metadata.schema ? `${metadata.schema}.` : ""}${row.object.name}` : t(`diff.typeReadState.${metadata.info!.pairingState}`),
                  outgoing: t(`diff.typeReadState.${metadata.info!.dependencyState}`),
                  incoming: t(`diff.typeReadState.${metadata.info!.incomingState}`),
                })
              }}
            </p>
            <p v-if="metadata.info!.referencedColumns.length" class="text-amber-700 dark:text-amber-400">{{ t("diff.typeReferencedColumns", { columns: metadata.info!.referencedColumns.map((column) => `${column.owner}.${column.tableName}.${column.columnName}`).join(", ") }) }}</p>
            <p v-if="metadata.info!.metadataMessage" class="text-amber-700 dark:text-amber-400">{{ metadata.info!.metadataMessage }}</p>
          </template>
          <p v-if="row.object.sourceTrigger" class="text-muted-foreground">{{ t("diff.sourceObject") }}: {{ row.object.sourceTrigger.timing }} · {{ row.object.sourceTrigger.event }} · {{ row.object.sourceTrigger.status }} · {{ row.object.sourceTrigger.baseObjectType }}</p>
          <p v-if="row.object.targetTrigger" class="text-muted-foreground">{{ t("diff.targetObject") }}: {{ row.object.targetTrigger.timing }} · {{ row.object.targetTrigger.event }} · {{ row.object.targetTrigger.status }} · {{ row.object.targetTrigger.baseObjectType }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

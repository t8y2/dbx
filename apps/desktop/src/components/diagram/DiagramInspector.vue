<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, Trash2, X, KeyRound } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { DiagramTable, DiagramRelationship, CustomDiagramRelationship } from "@/lib/diagram/erDiagram";
import { editableStructureIndexes, hasDroppedColumns, hasPendingColumns, isDraftTable, isDroppedColumn, isPendingColumn } from "@/lib/diagram/erDiagram";
import type { InferredRelationship } from "@/types/diagram";
import type { InspectorTarget } from "@/types/diagram";
import type { ColumnInfo, DatabaseType } from "@/types/database";
import type { EditableStructureIndex } from "@/lib/table/tableStructureEditorSql";
import { createDraftIndex, nextUniqueColumnName } from "@/lib/diagram/draft-table";
import { resolveDiagramDialectAdapter } from "@/lib/diagram/diagram-dialect-adapter";
import { cardinalityChoiceFromPair, cardinalityPairFromChoice, edgeCardinalityPair, type CardinalityChoice } from "@/lib/diagram/cardinality";
import { canAddTableStructureColumn, getTableStructureCapabilities } from "@/lib/table/tableStructureCapabilities";
import { combineDataTypeForDatabase, combineDataTypeForDatabaseWithLengthUnit, dataTypeLengthInputValue, dataTypeLengthUnitValue, getDataTypeLengthUnitOptions, getDataTypeOptions, getDefaultLengthForType, isDataTypeLengthDisabled, splitDataType } from "@/lib/table/tableStructureEditorState";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const { t } = useI18n();

const props = defineProps<{
  target: InspectorTarget;
  tables: DiagramTable[];
  relationships: (DiagramRelationship | InferredRelationship | CustomDiagramRelationship)[];
  databaseType?: DatabaseType;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "update-table", table: DiagramTable): void;
  (e: "delete-draft-table", tableName: string): void;
  (e: "delete-live-table", tableName: string): void;
  (e: "update-relationship", payload: { id: string; patch: Partial<CustomDiagramRelationship> }): void;
  (e: "remove-relationship", id: string): void;
  (e: "save-relationship", payload: Omit<CustomDiagramRelationship, "id"> & { id?: string }): void;
  (e: "confirm-relationship", payload: { id: string; sourceCardinality: "1" | "N"; targetCardinality: "1" | "N" }): void;
  (e: "ignore-relationship", id: string): void;
}>();

type InspectorTab = "fields" | "indexes";

const tableTab = ref<InspectorTab>("fields");
const confirmingDelete = ref(false);
const confirmingDropTable = ref(false);

const relationshipDraft = reactive({
  sourceTable: "",
  sourceColumn: "",
  targetTable: "",
  targetColumn: "",
  cardinality: "many-to-one" as CardinalityChoice,
});

const adapter = computed(() => resolveDiagramDialectAdapter(props.databaseType));
const databaseType = computed(() => props.databaseType);
const structureCapabilities = computed(() => getTableStructureCapabilities(props.databaseType));

const selectedTable = computed(() => {
  const target = props.target;
  if (target?.kind !== "table") return null;
  return props.tables.find((t) => t.name === target.tableName) ?? null;
});

const selectedEdge = computed(() => {
  const target = props.target;
  if (target?.kind !== "edge") return null;
  return props.relationships.find((r) => r.id === target.edgeId) ?? null;
});

const relationshipKind = computed(() => {
  const rel = selectedEdge.value;
  if (!rel) return "unknown";
  if ("kind" in rel) return rel.kind;
  return "inferred";
});

const relationshipEditable = computed(() => relationshipKind.value === "custom" || relationshipKind.value === "inferred");

const tableMap = computed(() => new Map(props.tables.map((table) => [table.name, table])));
const sourceColumns = computed(() => tableMap.value.get(relationshipDraft.sourceTable)?.columns ?? []);
const targetColumns = computed(() => tableMap.value.get(relationshipDraft.targetTable)?.columns ?? []);

/** Full draft table edit (rename, indexes, delete draft). */
const editable = computed(() => selectedTable.value != null && isDraftTable(selectedTable.value));
const isLive = computed(() => selectedTable.value != null && !isDraftTable(selectedTable.value));
const canAddField = computed(() => {
  if (!selectedTable.value) return false;
  return canAddTableStructureColumn(props.databaseType, isDraftTable(selectedTable.value));
});
const showLivePendingHint = computed(() => isLive.value && selectedTable.value != null && canAddField.value);
const canDropLiveColumn = computed(() => isLive.value && structureCapabilities.value.dropColumn);
const canDropLiveTable = computed(() => isLive.value && structureCapabilities.value.createTable);
const supportsCreateIndex = computed(() => structureCapabilities.value.createIndex);
const supportsComment = computed(() => structureCapabilities.value.comment);

function isColumnEditable(columnName: string): boolean {
  const table = selectedTable.value;
  if (!table) return false;
  if (isDroppedColumn(table, columnName)) return false;
  if (isDraftTable(table)) return true;
  return isPendingColumn(table, columnName);
}

function canRemoveColumn(columnName: string): boolean {
  const table = selectedTable.value;
  if (!table) return false;
  if (isDraftTable(table)) return true;
  if (isPendingColumn(table, columnName)) return true;
  return canDropLiveColumn.value;
}

const tableIndexes = computed(() => editableStructureIndexes(selectedTable.value ?? { name: "", columns: [], foreignKeys: [] }).filter((index) => !index.markedForDrop));

function syncRelationshipDraft() {
  const rel = selectedEdge.value;
  if (!rel) return;
  relationshipDraft.sourceTable = rel.sourceTable;
  relationshipDraft.sourceColumn = rel.sourceColumn;
  relationshipDraft.targetTable = rel.targetTable;
  relationshipDraft.targetColumn = rel.targetColumn;
  relationshipDraft.cardinality = cardinalityChoiceFromPair("sourceCardinality" in rel && "targetCardinality" in rel ? { sourceCardinality: rel.sourceCardinality, targetCardinality: rel.targetCardinality } : undefined);
  confirmingDelete.value = false;
}

watch(
  () => props.target,
  () => {
    tableTab.value = "fields";
    confirmingDropTable.value = false;
  },
);

watch(selectedEdge, syncRelationshipDraft, { immediate: true });

watch(
  () => relationshipDraft.sourceTable,
  () => {
    if (!sourceColumns.value.some((c) => c.name === relationshipDraft.sourceColumn)) {
      relationshipDraft.sourceColumn = sourceColumns.value[0]?.name ?? "";
    }
  },
);

watch(
  () => relationshipDraft.targetTable,
  () => {
    if (!targetColumns.value.some((c) => c.name === relationshipDraft.targetColumn)) {
      relationshipDraft.targetColumn = targetColumns.value[0]?.name ?? "";
    }
  },
);

function patchTable(mutator: (table: DiagramTable) => void, options?: { requireDraft?: boolean }) {
  const table = selectedTable.value;
  if (!table) return;
  if (options?.requireDraft && !isDraftTable(table)) return;
  const next: DiagramTable = {
    ...table,
    columns: table.columns.map((c) => ({ ...c })),
    foreignKeys: [...table.foreignKeys],
    indexes: editableStructureIndexes(table).map((index) => ({
      ...index,
      columns: [...index.columns],
      includedColumns: [...index.includedColumns],
    })),
    pendingColumnNames: table.pendingColumnNames ? [...table.pendingColumnNames] : undefined,
    droppedColumnNames: table.droppedColumnNames ? [...table.droppedColumnNames] : undefined,
    pendingDrop: table.pendingDrop,
  };
  mutator(next);
  emit("update-table", next);
}

function renameTable(name: string) {
  patchTable(
    (table) => {
      table.name = name.trim() || table.name;
    },
    { requireDraft: true },
  );
}

function updateColumn(index: number, patch: Partial<ColumnInfo>) {
  const table = selectedTable.value;
  if (!table) return;
  const col = table.columns[index];
  if (!col || !isColumnEditable(col.name)) return;
  patchTable((next) => {
    const target = next.columns[index];
    if (!target) return;
    const oldName = target.name;
    Object.assign(target, patch);
    if (patch.name !== undefined && next.pendingColumnNames) {
      const idx = next.pendingColumnNames.indexOf(oldName);
      if (idx >= 0) next.pendingColumnNames[idx] = String(patch.name);
    }
  });
}

function addColumn() {
  if (!canAddField.value) return;
  patchTable((table) => {
    const name = nextUniqueColumnName(table.columns);
    table.columns.push(adapter.value.createEmptyColumn(name));
    if (!isDraftTable(table)) {
      table.pendingColumnNames = [...(table.pendingColumnNames ?? []), name];
    }
  });
}

function removeColumn(index: number) {
  const table = selectedTable.value;
  if (!table) return;
  const removed = table.columns[index]?.name;
  if (!removed || !canRemoveColumn(removed)) return;

  // Pending add / draft: hard delete (no DB impact yet).
  if (isDraftTable(table) || isPendingColumn(table, removed)) {
    patchTable((next) => {
      next.columns.splice(index, 1);
      if (next.pendingColumnNames) {
        next.pendingColumnNames = next.pendingColumnNames.filter((name) => name !== removed);
        if (next.pendingColumnNames.length === 0) delete next.pendingColumnNames;
      }
      if (!next.indexes) return;
      for (const idx of next.indexes) {
        idx.columns = idx.columns.filter((col) => col !== removed);
      }
    });
    return;
  }

  // Live existing column: soft-mark for DROP COLUMN (toggle).
  patchTable((next) => {
    const dropped = new Set(next.droppedColumnNames ?? []);
    if (dropped.has(removed)) {
      dropped.delete(removed);
    } else {
      dropped.add(removed);
    }
    next.droppedColumnNames = dropped.size ? [...dropped] : undefined;
  });
}

function requestDeleteLiveTable() {
  confirmingDropTable.value = true;
}

function confirmDeleteLiveTable() {
  const table = selectedTable.value;
  if (!table || isDraftTable(table)) return;
  confirmingDropTable.value = false;
  emit("delete-live-table", table.name);
}

function cancelDeleteLiveTable() {
  confirmingDropTable.value = false;
}

function addIndex() {
  if (!supportsCreateIndex.value) return;
  patchTable(
    (table) => {
      const existing = editableStructureIndexes(table);
      const firstCol = table.columns[0]?.name;
      table.indexes = [...existing, createDraftIndex(table.name, firstCol ? [firstCol] : [], existing)];
    },
    { requireDraft: true },
  );
}

function updateIndex(indexId: string, patch: Partial<EditableStructureIndex>) {
  patchTable(
    (table) => {
      const index = editableStructureIndexes(table).find((item) => item.id === indexId);
      if (!index) return;
      Object.assign(index, patch);
      table.indexes = editableStructureIndexes(table).map((item) => (item.id === indexId ? { ...item, ...patch } : item));
    },
    { requireDraft: true },
  );
}

function toggleIndexColumn(indexId: string, columnName: string) {
  patchTable(
    (table) => {
      table.indexes = editableStructureIndexes(table).map((index) => {
        if (index.id !== indexId) return index;
        if (index.columns.includes(columnName)) {
          return { ...index, columns: index.columns.filter((col) => col !== columnName) };
        }
        return { ...index, columns: [...index.columns, columnName] };
      });
    },
    { requireDraft: true },
  );
}

function removeIndex(indexId: string) {
  patchTable(
    (table) => {
      table.indexes = editableStructureIndexes(table).filter((index) => index.id !== indexId);
    },
    { requireDraft: true },
  );
}

const draftCardinality = computed(() => cardinalityPairFromChoice(relationshipDraft.cardinality));

function directedCardinalityLabel(source: "1" | "N", target: "1" | "N"): string {
  return t("diagram.cardinalityDirected", { source, target });
}

const edgeDirectedCardinalityLabel = computed(() => {
  const rel = selectedEdge.value;
  if (!rel) return directedCardinalityLabel("N", "1");
  if (relationshipEditable.value) {
    const pair = draftCardinality.value;
    return directedCardinalityLabel(pair.sourceCardinality, pair.targetCardinality);
  }
  const pair = edgeCardinalityPair(rel);
  return directedCardinalityLabel(pair.sourceCardinality, pair.targetCardinality);
});

function handleSaveRelationship() {
  const rel = selectedEdge.value;
  if (!rel) return;
  const card = cardinalityPairFromChoice(relationshipDraft.cardinality);
  emit("save-relationship", {
    id: "kind" in rel && rel.kind === "custom" ? rel.id : undefined,
    name: "name" in rel ? rel.name : `${relationshipDraft.sourceTable}_${relationshipDraft.sourceColumn}_${relationshipDraft.targetTable}_${relationshipDraft.targetColumn}`,
    sourceTable: relationshipDraft.sourceTable,
    sourceColumn: relationshipDraft.sourceColumn,
    targetTable: relationshipDraft.targetTable,
    targetColumn: relationshipDraft.targetColumn,
    ...card,
  });
}

function handleConfirmRelationship() {
  const rel = selectedEdge.value;
  if (!rel) return;
  emit("confirm-relationship", { id: rel.id, ...cardinalityPairFromChoice(relationshipDraft.cardinality) });
}

function handleIgnoreRelationship() {
  const rel = selectedEdge.value;
  if (!rel) return;
  emit("ignore-relationship", rel.id);
}

function confirmDeleteRelationship() {
  const rel = selectedEdge.value;
  if (!rel) return;
  confirmingDelete.value = false;
  emit("remove-relationship", rel.id);
}

function columnBaseType(dataType: string): string {
  return splitDataType(dataType).baseType;
}

function columnLengthEnabled(dataType: string): boolean {
  return !isDataTypeLengthDisabled(databaseType.value, columnBaseType(dataType));
}

function columnLengthUnitOptions(dataType: string): readonly string[] {
  return getDataTypeLengthUnitOptions(databaseType.value, dataType);
}

function updateColumnBaseType(index: number, baseType: string) {
  const next = combineDataTypeForDatabase(databaseType.value, baseType, getDefaultLengthForType(databaseType.value, baseType));
  updateColumn(index, { data_type: next });
}

function updateColumnLength(index: number, value: string | number) {
  const table = selectedTable.value;
  const col = table?.columns[index];
  if (!col) return;
  const baseType = columnBaseType(col.data_type);
  const next = combineDataTypeForDatabaseWithLengthUnit(databaseType.value, baseType, String(value), dataTypeLengthUnitValue(databaseType.value, col.data_type));
  updateColumn(index, { data_type: next });
}

function updateColumnLengthUnit(index: number, value: unknown) {
  const table = selectedTable.value;
  const col = table?.columns[index];
  if (!col) return;
  const unit = value === "__default" || value == null ? "" : String(value);
  const baseType = columnBaseType(col.data_type);
  const next = combineDataTypeForDatabaseWithLengthUnit(databaseType.value, baseType, dataTypeLengthInputValue(databaseType.value, col.data_type), unit);
  updateColumn(index, { data_type: next });
}

const dataTypeOptionsForColumn = computed(() => {
  const options = getDataTypeOptions(props.databaseType);
  const table = selectedTable.value;
  if (!table) return options;
  const seen = new Set(options.map((type) => type.toLowerCase()));
  const extras: string[] = [];
  for (const col of table.columns) {
    const base = columnBaseType(col.data_type);
    if (!base || seen.has(base.toLowerCase())) continue;
    seen.add(base.toLowerCase());
    extras.push(base);
  }
  return extras.length ? [...options, ...extras] : options;
});
</script>

<template>
  <div class="flex h-full min-w-0 flex-col overflow-hidden">
    <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2 shrink-0">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <h3 class="min-w-0 truncate text-sm font-semibold text-foreground">
          <template v-if="selectedTable">{{ t("diagram.inspectorTable") }} · {{ selectedTable.name }}</template>
          <template v-else-if="selectedEdge">{{ t("diagram.inspectorRelationship") }}</template>
        </h3>
        <Badge v-if="selectedTable && editable" variant="outline" class="h-5 shrink-0 text-[10px]">Draft</Badge>
        <Badge v-else-if="selectedTable && selectedTable.pendingDrop" variant="destructive" class="h-5 shrink-0 text-[10px]">{{ t("diagram.pendingDropTableBadge") }}</Badge>
        <Badge v-else-if="selectedTable && (hasPendingColumns(selectedTable) || hasDroppedColumns(selectedTable))" variant="outline" class="h-5 shrink-0 text-[10px]">{{ t("diagram.pendingColumnsBadge") }}</Badge>
      </div>
      <button type="button" class="p-1.5 rounded-md hover:bg-muted transition-colors" @click="emit('close')">
        <X class="h-4 w-4 text-muted-foreground" />
      </button>
    </div>

    <div class="flex-1 overflow-y-auto p-3 space-y-3">
      <template v-if="selectedTable">
        <div class="space-y-1">
          <label class="text-[10px] text-muted-foreground">{{ t("diagram.tableName") }}</label>
          <Input class="h-8 text-xs" :model-value="selectedTable.name" :disabled="!editable" @update:model-value="(v: string | number) => renameTable(String(v))" />
        </div>

        <div class="flex border-b border-border">
          <button type="button" class="flex-1 px-1 py-1.5 text-[10px] transition-colors" :class="tableTab === 'fields' ? 'border-b-2 border-primary text-primary font-medium' : 'text-muted-foreground hover:text-foreground'" @click="tableTab = 'fields'">
            {{ t("diagram.tabFields") }}
          </button>
          <button type="button" class="flex-1 px-1 py-1.5 text-[10px] transition-colors" :class="tableTab === 'indexes' ? 'border-b-2 border-primary text-primary font-medium' : 'text-muted-foreground hover:text-foreground'" @click="tableTab = 'indexes'">
            {{ t("diagram.tabIndexes") }}
          </button>
        </div>

        <template v-if="tableTab === 'fields'">
          <div class="flex items-center justify-between">
            <span class="text-xs font-medium">{{ t("diagram.fields") }}</span>
            <Button v-if="canAddField" type="button" size="sm" variant="outline" class="h-7 text-[11px]" @click="addColumn">
              <Plus class="mr-1 h-3 w-3" />
              {{ t("diagram.addField") }}
            </Button>
          </div>
          <p v-if="showLivePendingHint" class="text-[11px] text-muted-foreground">{{ t("diagram.liveTableAddColumnsHint") }}</p>

          <div class="space-y-2">
            <div v-for="(col, index) in selectedTable.columns" :key="`field-${index}`" class="rounded border p-2 space-y-1.5" :class="isDroppedColumn(selectedTable, col.name) ? 'border-destructive/50 bg-destructive/5 opacity-70' : 'border-border/80'">
              <div class="flex items-center gap-1">
                <KeyRound v-if="col.is_primary_key" class="h-3 w-3 shrink-0 text-amber-500" />
                <Input class="h-7 flex-1 font-mono text-[11px]" :class="isDroppedColumn(selectedTable, col.name) ? 'line-through' : ''" :model-value="col.name" :disabled="!isColumnEditable(col.name)" @update:model-value="(v: string | number) => updateColumn(index, { name: String(v) })" />
                <Badge v-if="isDroppedColumn(selectedTable, col.name)" variant="outline" class="h-5 shrink-0 text-[10px] text-destructive">{{ t("diagram.pendingDropColumnBadge") }}</Badge>
                <button v-if="canRemoveColumn(col.name)" type="button" class="rounded p-1 hover:bg-muted" :title="isDroppedColumn(selectedTable, col.name) ? t('diagram.undoDropField') : t('diagram.deleteField')" @click="removeColumn(index)">
                  <Trash2 class="h-3 w-3 text-red-500" />
                </button>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <SearchableSelect
                  class="min-w-0 flex-1 basis-[7rem]"
                  :model-value="columnBaseType(col.data_type)"
                  :options="dataTypeOptionsForColumn"
                  :placeholder="t('structureEditor.typePlaceholder')"
                  :search-placeholder="t('structureEditor.typePlaceholder')"
                  :empty-text="t('structureEditor.noMatchingType')"
                  :allow-custom="true"
                  :disabled="!isColumnEditable(col.name)"
                  :trigger-class="['h-7 w-full justify-between px-2 text-[11px] font-mono']"
                  @update:model-value="(v: string) => updateColumnBaseType(index, v)"
                />
                <div v-if="columnLengthEnabled(col.data_type)" class="flex min-w-0 items-center gap-1">
                  <Input
                    class="h-7 w-16 shrink-0 font-mono text-[11px]"
                    :model-value="dataTypeLengthInputValue(databaseType, col.data_type)"
                    :disabled="!isColumnEditable(col.name)"
                    :placeholder="t('structureEditor.length')"
                    @update:model-value="(v: string | number) => updateColumnLength(index, v)"
                  />
                  <Select v-if="columnLengthUnitOptions(col.data_type).length" :model-value="dataTypeLengthUnitValue(databaseType, col.data_type) || '__default'" :disabled="!isColumnEditable(col.name)" @update:model-value="(v: unknown) => updateColumnLengthUnit(index, v)">
                    <SelectTrigger class="h-7 w-14 shrink-0 px-1 text-[10px] font-mono" :aria-label="t('structureEditor.lengthUnit')" :title="t('structureEditor.lengthUnit')">
                      <SelectValue :placeholder="t('structureEditor.unitPlaceholder')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__default">{{ t("structureEditor.defaultAction") }}</SelectItem>
                      <SelectItem v-for="unit in columnLengthUnitOptions(col.data_type)" :key="unit" :value="unit">{{ unit }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <label class="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <input type="checkbox" :checked="col.is_primary_key" :disabled="!isColumnEditable(col.name)" @change="updateColumn(index, { is_primary_key: ($event.target as HTMLInputElement).checked })" />
                  PK
                </label>
                <label class="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <input type="checkbox" :checked="col.is_nullable" :disabled="!isColumnEditable(col.name)" @change="updateColumn(index, { is_nullable: ($event.target as HTMLInputElement).checked })" />
                  NULL
                </label>
              </div>
              <Input v-if="supportsComment" class="h-7 text-[11px]" :model-value="col.comment ?? ''" :disabled="!isColumnEditable(col.name)" :placeholder="t('diagram.fieldComment')" @update:model-value="(v: string | number) => updateColumn(index, { comment: String(v) })" />
            </div>
            <p v-if="selectedTable.columns.length === 0" class="text-[11px] text-muted-foreground">{{ t("diagram.noFieldsYet") }}</p>
            <p v-else-if="!canAddField && isLive" class="text-[11px] text-muted-foreground">{{ t("diagram.addColumnNotSupported") }}</p>
          </div>
        </template>

        <template v-else>
          <div v-if="!supportsCreateIndex" class="text-[11px] text-muted-foreground">
            {{ t("diagram.indexesNotSupported") }}
          </div>
          <template v-else>
            <div class="flex items-center justify-between">
              <span class="text-xs font-medium">{{ t("diagram.tabIndexes") }}</span>
              <Button v-if="editable" type="button" size="sm" variant="outline" class="h-7 text-[11px]" @click="addIndex">
                <Plus class="mr-1 h-3 w-3" />
                {{ t("diagram.addIndex") }}
              </Button>
            </div>

            <div v-if="!editable" class="text-[11px] text-muted-foreground">{{ t("diagram.liveTableIndexesReadOnly") }}</div>

            <div v-else class="space-y-2">
              <div v-for="index in tableIndexes" :key="index.id" class="rounded border border-border/80 p-2 space-y-1.5">
                <div class="flex items-center gap-1">
                  <Input class="h-7 flex-1 font-mono text-[11px]" :model-value="index.name" :placeholder="t('diagram.indexName')" @update:model-value="(v: string | number) => updateIndex(index.id, { name: String(v) })" />
                  <button type="button" class="rounded p-1 hover:bg-muted" :title="t('diagram.deleteField')" @click="removeIndex(index.id)">
                    <Trash2 class="h-3 w-3 text-red-500" />
                  </button>
                </div>
                <label class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <input type="checkbox" :checked="index.isUnique" @change="updateIndex(index.id, { isUnique: ($event.target as HTMLInputElement).checked })" />
                  {{ t("diagram.indexUnique") }}
                </label>
                <div class="space-y-1">
                  <div class="text-[10px] text-muted-foreground">{{ t("diagram.indexColumns") }}</div>
                  <div v-if="selectedTable.columns.length === 0" class="text-[10px] text-muted-foreground">{{ t("diagram.noFieldsYet") }}</div>
                  <div v-else class="max-h-32 space-y-0.5 overflow-y-auto rounded border border-border/60 p-1.5">
                    <label v-for="col in selectedTable.columns" :key="`${index.id}-${col.name}`" class="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] hover:bg-muted/50">
                      <input type="checkbox" :checked="index.columns.includes(col.name)" @change="toggleIndexColumn(index.id, col.name)" />
                      <span class="font-mono truncate">{{ col.name }}</span>
                    </label>
                  </div>
                </div>
              </div>
              <p v-if="tableIndexes.length === 0" class="text-[11px] text-muted-foreground">{{ t("diagram.noIndexesYet") }}</p>
            </div>
          </template>
        </template>

        <Button v-if="editable" type="button" variant="destructive" size="sm" class="w-full h-8 text-xs" @click="emit('delete-draft-table', selectedTable.name)">
          {{ t("diagram.deleteDraftTable") }}
        </Button>

        <template v-else-if="isLive && canDropLiveTable">
          <div v-if="!confirmingDropTable" class="space-y-1">
            <Button type="button" variant="destructive" size="sm" class="w-full h-8 text-xs" @click="requestDeleteLiveTable">
              {{ t("diagram.deleteLiveTable") }}
            </Button>
            <p class="text-[10px] text-muted-foreground">{{ t("diagram.deleteLiveTableHint") }}</p>
          </div>
          <div v-else class="space-y-2 rounded border border-destructive/40 bg-destructive/5 p-2">
            <p class="text-[11px] text-destructive">{{ t("diagram.deleteLiveTableConfirm") }}</p>
            <div class="flex gap-2">
              <Button type="button" variant="destructive" size="sm" class="h-7 flex-1 text-[11px]" @click="confirmDeleteLiveTable">{{ t("common.confirm") }}</Button>
              <Button type="button" variant="outline" size="sm" class="h-7 flex-1 text-[11px]" @click="cancelDeleteLiveTable">{{ t("common.cancel") }}</Button>
            </div>
          </div>
        </template>
        <p v-else-if="isLive && !canDropLiveTable" class="text-[11px] text-muted-foreground">{{ t("diagram.dropTableNotSupported") }}</p>
      </template>

      <template v-else-if="selectedEdge">
        <div class="space-y-3 text-xs">
          <div class="text-[10px] text-muted-foreground">
            <template v-if="relationshipKind === 'foreign-key'">{{ t("diagram.relationshipKindFk") }}</template>
            <template v-else-if="relationshipKind === 'custom'">{{ t("diagram.relationshipKindCustom") }}</template>
            <template v-else-if="relationshipKind === 'inferred'">{{ t("diagram.relationshipKindInferred") }}</template>
            <span> · {{ edgeDirectedCardinalityLabel }}</span>
            <span v-if="'confidence' in selectedEdge"> · {{ selectedEdge.confidence }}</span>
          </div>

          <p v-if="relationshipKind === 'foreign-key'" class="text-[11px] text-muted-foreground">
            {{ t("diagram.relationshipReadOnlyFk") }}
          </p>

          <template v-if="relationshipKind === 'foreign-key'">
            <div>
              <div class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span>{{ t("diagram.source") }}</span>
                <span class="inline-flex min-w-[1.1rem] items-center justify-center rounded border border-border/80 bg-background px-1 py-0.5 font-mono text-[10px] font-semibold leading-none text-foreground">
                  {{ edgeCardinalityPair(selectedEdge).sourceCardinality }}
                </span>
              </div>
              <div class="font-mono">{{ selectedEdge.sourceTable }}.{{ selectedEdge.sourceColumn }}</div>
            </div>
            <div>
              <div class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span>{{ t("diagram.target") }}</span>
                <span class="inline-flex min-w-[1.1rem] items-center justify-center rounded border border-border/80 bg-background px-1 py-0.5 font-mono text-[10px] font-semibold leading-none text-foreground">
                  {{ edgeCardinalityPair(selectedEdge).targetCardinality }}
                </span>
              </div>
              <div class="font-mono">{{ selectedEdge.targetTable }}.{{ selectedEdge.targetColumn }}</div>
            </div>
            <div>
              <div class="text-[10px] text-muted-foreground">{{ t("diagram.cardinality") }}</div>
              <div>{{ edgeDirectedCardinalityLabel }}</div>
            </div>
          </template>

          <template v-else-if="relationshipEditable">
            <div class="space-y-1.5">
              <label class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span>{{ t("diagram.sourceTable") }}</span>
                <span class="inline-flex min-w-[1.1rem] items-center justify-center rounded border border-border/80 bg-background px-1 py-0.5 font-mono text-[10px] font-semibold leading-none text-foreground">
                  {{ draftCardinality.sourceCardinality }}
                </span>
              </label>
              <Select v-model="relationshipDraft.sourceTable">
                <SelectTrigger class="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="table in tables" :key="`s-${table.name}`" :value="table.name" :disabled="table.columns.length === 0">{{ table.name }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <label class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span>{{ t("diagram.sourceColumn") }}</span>
                <span class="inline-flex min-w-[1.1rem] items-center justify-center rounded border border-border/80 bg-background px-1 py-0.5 font-mono text-[10px] font-semibold leading-none text-foreground">
                  {{ draftCardinality.sourceCardinality }}
                </span>
              </label>
              <Select v-model="relationshipDraft.sourceColumn">
                <SelectTrigger class="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="col in sourceColumns" :key="`sc-${col.name}`" :value="col.name">{{ col.name }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <label class="text-[10px] text-muted-foreground">{{ t("diagram.cardinality") }}</label>
              <Select v-model="relationshipDraft.cardinality">
                <SelectTrigger class="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="one-to-one">{{ t("diagram.cardinalityOneToOne") }}</SelectItem>
                  <SelectItem value="one-to-many">{{ t("diagram.cardinalityOneToMany") }}</SelectItem>
                  <SelectItem value="many-to-one">{{ t("diagram.cardinalityManyToOne") }}</SelectItem>
                  <SelectItem value="many-to-many">{{ t("diagram.cardinalityManyToMany") }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <label class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span>{{ t("diagram.targetTable") }}</span>
                <span class="inline-flex min-w-[1.1rem] items-center justify-center rounded border border-border/80 bg-background px-1 py-0.5 font-mono text-[10px] font-semibold leading-none text-foreground">
                  {{ draftCardinality.targetCardinality }}
                </span>
              </label>
              <Select v-model="relationshipDraft.targetTable">
                <SelectTrigger class="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="table in tables" :key="`t-${table.name}`" :value="table.name" :disabled="table.columns.length === 0">{{ table.name }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <label class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <span>{{ t("diagram.targetColumn") }}</span>
                <span class="inline-flex min-w-[1.1rem] items-center justify-center rounded border border-border/80 bg-background px-1 py-0.5 font-mono text-[10px] font-semibold leading-none text-foreground">
                  {{ draftCardinality.targetCardinality }}
                </span>
              </label>
              <Select v-model="relationshipDraft.targetColumn">
                <SelectTrigger class="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="col in targetColumns" :key="`tc-${col.name}`" :value="col.name">{{ col.name }}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div class="flex flex-col gap-1.5 pt-1">
              <Button v-if="relationshipKind === 'custom' || relationshipKind === 'inferred'" type="button" size="sm" class="h-8 w-full text-xs" @click="handleSaveRelationship">
                {{ t("diagram.saveRelationship") }}
              </Button>
              <Button v-if="relationshipKind === 'inferred'" type="button" size="sm" variant="outline" class="h-8 w-full text-xs" @click="handleConfirmRelationship">
                {{ t("diagram.confirmRelationship") }}
              </Button>
              <Button v-if="relationshipKind === 'inferred'" type="button" size="sm" variant="outline" class="h-8 w-full text-xs" @click="handleIgnoreRelationship">
                {{ t("diagram.ignoreRelationship") }}
              </Button>
            </div>

            <template v-if="relationshipKind === 'custom'">
              <div v-if="confirmingDelete" class="space-y-2 rounded border border-destructive/30 bg-destructive/5 p-2">
                <p class="text-[11px] text-muted-foreground">{{ t("diagram.confirmDeleteRelationship") }}</p>
                <div class="flex gap-1.5">
                  <Button type="button" size="sm" variant="destructive" class="h-7 flex-1 text-xs" @click="confirmDeleteRelationship">
                    {{ t("diagram.confirmDeleteRelationshipAction") }}
                  </Button>
                  <Button type="button" size="sm" variant="outline" class="h-7 flex-1 text-xs" @click="confirmingDelete = false">
                    {{ t("common.cancel") }}
                  </Button>
                </div>
              </div>
              <Button v-else type="button" variant="destructive" size="sm" class="h-8 w-full text-xs" @click="confirmingDelete = true">
                {{ t("diagram.removeRelationship") }}
              </Button>
            </template>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

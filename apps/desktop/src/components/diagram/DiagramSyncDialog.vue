<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { DiagramTable } from "@/lib/diagram/erDiagram";
import { isDraftTable, needsDiagramSync } from "@/lib/diagram/erDiagram";
import { draftTableToCreateSqlOptions, hasLiveColumnChanges, liveTableToAlterSqlOptions, validateDraftTable, validateLivePendingColumns } from "@/lib/diagram/draft-table";
import { buildDropTableSql } from "@/lib/database/dbAdminSql";
import { getTableStructureCapabilities } from "@/lib/table/tableStructureCapabilities";
import type { DatabaseType } from "@/types/database";
import * as api from "@/lib/backend/api";
import { copyToClipboard } from "@/lib/common/clipboard";

const { t } = useI18n();

const props = defineProps<{
  open: boolean;
  tables: DiagramTable[];
  connectionId: string;
  database: string;
  schema: string;
  databaseType?: DatabaseType;
}>();

const emit = defineEmits<{
  (e: "update:open", value: boolean): void;
  (e: "synced", tableNames: string[]): void;
}>();

const openModel = computed({
  get: () => props.open,
  set: (v: boolean) => emit("update:open", v),
});

const syncTables = computed(() => props.tables.filter(needsDiagramSync));
const draftTables = computed(() => syncTables.value.filter(isDraftTable));
const liveDropTables = computed(() => syncTables.value.filter((table) => !isDraftTable(table) && !!table.pendingDrop));
const liveAlterTables = computed(() => syncTables.value.filter((table) => !isDraftTable(table) && !table.pendingDrop && hasLiveColumnChanges(table)));
const structureCapabilities = computed(() => getTableStructureCapabilities(props.databaseType));
const validationErrors = ref<string[]>([]);
const sqlText = ref("");
const warnings = ref<string[]>([]);
const building = ref(false);
const executing = ref(false);
const execError = ref("");

function validateStructureCapabilities(): string[] {
  const caps = structureCapabilities.value;
  const errors: string[] = [];
  if (draftTables.value.length && !caps.createTable) {
    errors.push(t("diagram.createTableNotSupported"));
  }
  if (liveAlterTables.value.some((table) => (table.pendingColumnNames?.length ?? 0) > 0) && !caps.addColumn) {
    errors.push(t("diagram.addColumnNotSupported"));
  }
  if (liveAlterTables.value.some((table) => (table.droppedColumnNames?.length ?? 0) > 0) && !caps.dropColumn) {
    errors.push(t("diagram.dropColumnNotSupported"));
  }
  if (liveDropTables.value.length && !caps.createTable) {
    errors.push(t("diagram.dropTableNotSupported"));
  }
  return errors;
}

async function rebuildSql() {
  building.value = true;
  validationErrors.value = [];
  warnings.value = [];
  sqlText.value = "";
  execError.value = "";
  try {
    const capabilityErrors = validateStructureCapabilities();
    const errors = [...capabilityErrors, ...draftTables.value.flatMap(validateDraftTable), ...liveAlterTables.value.flatMap(validateLivePendingColumns)];
    if (errors.length) {
      validationErrors.value = errors;
      return;
    }
    const allStatements: string[] = [];
    const allWarnings: string[] = [];
    // Same SQL APIs as TableStructureEditor — do not generate dialect SQL in the diagram layer.
    for (const table of draftTables.value) {
      const result = await api.buildCreateTableSql(draftTableToCreateSqlOptions(table, props.databaseType, props.schema || undefined));
      allStatements.push(...result.statements);
      allWarnings.push(...result.warnings);
    }
    for (const table of liveAlterTables.value) {
      // Live ER sync only maps ADD/DROP COLUMN. Existing-column type changes stay in TableStructureEditor
      // (including SQLite rebuild via previewSqliteTableStructureChange).
      const result = await api.buildTableStructureChangeSql(liveTableToAlterSqlOptions(table, props.databaseType, props.schema || undefined));
      allStatements.push(...result.statements);
      allWarnings.push(...result.warnings);
    }
    for (const table of liveDropTables.value) {
      const sql = await buildDropTableSql({
        databaseType: props.databaseType,
        schema: props.schema || undefined,
        tableName: table.name,
        cascade: false,
      });
      if (sql.trim()) allStatements.push(sql.trim());
    }
    sqlText.value = allStatements.join("\n\n");
    warnings.value = allWarnings;
  } catch (e: any) {
    validationErrors.value = [e?.message || String(e)];
  } finally {
    building.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void rebuildSql();
  },
);

async function copySql() {
  if (!sqlText.value) return;
  await copyToClipboard(sqlText.value);
}

async function execute() {
  if (!sqlText.value || validationErrors.value.length) return;
  executing.value = true;
  execError.value = "";
  try {
    const statements = sqlText.value
      .split(/;\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.endsWith(";") ? s : `${s};`));
    await api.executeBatch(props.connectionId, props.database, statements, props.schema || undefined);
    emit(
      "synced",
      syncTables.value.map((table) => table.name),
    );
    openModel.value = false;
  } catch (e: any) {
    execError.value = e?.message || String(e);
  } finally {
    executing.value = false;
  }
}

function syncTableLabel(table: DiagramTable): string {
  if (isDraftTable(table)) {
    return `${table.name} (${table.columns.length} cols, CREATE)`;
  }
  if (table.pendingDrop) {
    return `${table.name} (DROP TABLE)`;
  }
  const added = table.pendingColumnNames?.length ?? 0;
  const dropped = table.droppedColumnNames?.length ?? 0;
  const parts: string[] = [];
  if (added) parts.push(`+${added}`);
  if (dropped) parts.push(`-${dropped}`);
  return `${table.name} (${parts.join("/") || "0"} cols, ALTER)`;
}
</script>

<template>
  <Dialog v-model:open="openModel">
    <DialogContent class="max-w-2xl max-h-[80vh] flex flex-col gap-3">
      <DialogHeader>
        <DialogTitle>{{ t("diagram.syncToDatabase") }}</DialogTitle>
      </DialogHeader>

      <div class="text-xs text-muted-foreground">
        {{ t("diagram.syncDraftCount", { count: syncTables.length }) }}
      </div>

      <ul v-if="syncTables.length" class="text-xs list-disc pl-4 space-y-0.5">
        <li v-for="table in syncTables" :key="table.name" class="font-mono">{{ syncTableLabel(table) }}</li>
      </ul>

      <div v-if="validationErrors.length" class="rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive space-y-1">
        <div v-for="(err, i) in validationErrors" :key="i">{{ err }}</div>
      </div>

      <div v-if="warnings.length" class="rounded border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-300 space-y-1">
        <div v-for="(w, i) in warnings" :key="i">{{ w }}</div>
      </div>

      <pre class="flex-1 min-h-[160px] max-h-[40vh] overflow-auto rounded border bg-muted/30 p-3 text-[11px] font-mono whitespace-pre-wrap">{{ building ? t("diagram.buildingSql") : sqlText || t("diagram.noSqlYet") }}</pre>

      <p v-if="execError" class="text-xs text-destructive">{{ execError }}</p>

      <DialogFooter class="gap-2 sm:gap-2">
        <Button type="button" variant="outline" size="sm" :disabled="!sqlText" @click="copySql">{{ t("diagram.copySql") }}</Button>
        <Button type="button" variant="ghost" size="sm" @click="openModel = false">{{ t("common.cancel") }}</Button>
        <Button type="button" size="sm" :disabled="!sqlText || !!validationErrors.length || executing || building" @click="execute">
          {{ executing ? t("diagram.syncing") : t("diagram.executeSync") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

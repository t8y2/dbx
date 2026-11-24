<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import TablePhysicalOptionsEditor from "./TablePhysicalOptionsEditor.vue";
import { emptyTablePhysicalOptions, PAIMON_PHYSICAL_OPTIONS, paimonWriteExpression } from "@/lib/table/tablePhysicalOptions";
import { readPaimonCopySource, paimonCopyDdl } from "@/lib/table/starrocksLayoutCopy";
import StarRocksPhysicalOptionsEditor from "./StarRocksPhysicalOptionsEditor.vue";
import { createColumnDrafts } from "@/lib/table/tableStructureEditorState";
import { buildStarRocksDialectOptions, emptyStarRocksPhysicalOptions } from "@/lib/table/starrocksPhysicalOptions";
import { starRocksAlterOptionsFromDdl, type StarRocksAlterOptions } from "@/lib/table/starrocksAlterOptions";
import { buildStarRocksLayoutCopyDdl, executeStarRocksCopyPlan, starRocksCopyInsertColumns, type StarRocksCopyPlan, type StarRocksCopyStage } from "@/lib/table/starrocksLayoutCopy";
import { formatDdlForDisplay } from "@/lib/sql/ddlDisplay";
import { loadObjectDdl } from "@/lib/metadata/objectDdlCache";
import type { EditableStructureColumn } from "@/lib/table/tableStructureEditorSql";
import * as api from "@/lib/backend/api";

const props = defineProps<{ open: boolean; inline?: boolean; disabled?: boolean; paimon?: boolean; connectionId: string; database: string; schema?: string; catalog?: string; tableName: string; serverVersion?: string; timeoutSecs?: number; authorize: (sql: string) => Promise<boolean> }>();
const emit = defineEmits<{ "update:open": [open: boolean]; created: [tableName: string, completed: boolean] }>();
const { t } = useI18n();
const targetName = ref("");
const transferData = ref(false);
const keepPartition = ref(true);
const paimonPhysical = ref(emptyTablePhysicalOptions());
const savedProperties = ref(new Map<string, string>());
const propertyError = ref("");
const propertiesLoaded = ref(false);
const propertyPlan = computed(() => {
  const current = new Map<string, string>();
  for (const [rawKey, value] of paimonPhysical.value.propertyRows ?? []) {
    const key = rawKey.trim();
    if (!key && !value) continue;
    if (!key || current.has(key) || /^(bucket|bucket-key|primary-key|comment|location|path)$/i.test(key)) {
      return { error: t("structureEditor.invalidPropertyKey", { key }), changes: [] };
    }
    current.set(key, value);
  }
  const table = [props.catalog, props.schema || props.database, props.tableName]
    .filter(Boolean)
    .map((name) => "`" + name!.replaceAll("`", "``") + "`")
    .join(".");
  const literal = (value: string) => "'" + value.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";
  const updates = [...current].filter(([key, value]) => savedProperties.value.get(key) !== value);
  const removals = [...savedProperties.value.keys()].filter((key) => !current.has(key));
  const changes = [];
  if (updates.length)
    changes.push({
      sql: `ALTER TABLE ${table} SET TBLPROPERTIES (${updates.map(([k, v]) => literal(k) + " = " + literal(v)).join(", ")});`,
      apply: () => updates.forEach(([k, v]) => savedProperties.value.set(k, v)),
    });
  if (removals.length)
    changes.push({
      sql: `ALTER TABLE ${table} UNSET TBLPROPERTIES IF EXISTS (${removals.map(literal).join(", ")});`,
      apply: () => removals.forEach((key) => savedProperties.value.delete(key)),
    });
  return { error: "", changes };
});

async function saveProperties() {
  const { changes, error } = propertyPlan.value;
  if (locked.value || error || !changes.length) return;
  const { connectionId, database, schema, timeoutSecs } = props;
  running.value = true;
  propertyError.value = "";
  try {
    if (!(await props.authorize(changes.map((change) => change.sql).join("\n")))) return;
    for (const change of changes) {
      await api.executeBatch(connectionId, database, [change.sql], schema, timeoutSecs, false);
      change.apply();
    }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const immutable = /UnsupportedOperationException:\s*Cannot change ([\w.-]+) from /i.exec(message);
    propertyError.value = immutable ? t("structureEditor.immutableProperty", { key: immutable[1] }) : message;
  } finally {
    running.value = false;
  }
}
const physical = ref(emptyStarRocksPhysicalOptions());
const columns = ref<EditableStructureColumn[]>([]);
const sourceDdl = ref("");
const context = ref<StarRocksAlterOptions>();
const plan = ref<StarRocksCopyPlan>();
const preview = ref("");
const warnings = ref<string[]>([]);
const error = ref("");
const loading = ref(false);
const previewLoading = ref(false);
const running = ref(false);
const attempted = ref(false);
const generatedColumnsRejected = ref(false);
const stage = ref<StarRocksCopyStage>();
let loadRequest = 0;
let previewRequest = 0;
const locked = computed(() => props.disabled || loading.value || running.value || attempted.value);
const canSubmit = computed(() => !!plan.value && !locked.value && !previewLoading.value && !warnings.value.length && !error.value);
function close(open: boolean) {
  if (!running.value) emit("update:open", open);
}
function preventDismiss(event: Event) {
  if (running.value) event.preventDefault();
}

watch(
  [() => props.open, () => props.connectionId, () => props.database, () => props.schema, () => props.tableName, () => props.catalog],
  async ([open]) => {
    if (running.value) return;
    loadRequest++;
    previewRequest++;
    if (!open) return;
    loading.value = true;
    propertyError.value = "";
    propertiesLoaded.value = false;
    paimonPhysical.value = emptyTablePhysicalOptions();
    savedProperties.value = new Map();
    attempted.value = false;
    generatedColumnsRejected.value = false;
    stage.value = undefined;
    plan.value = undefined;
    preview.value = "";
    error.value = "";
    warnings.value = [];
    columns.value = [];
    sourceDdl.value = "";
    context.value = undefined;
    targetName.value = `${props.tableName}_layout`;
    transferData.value = false;
    keepPartition.value = true;
    physical.value = emptyStarRocksPhysicalOptions();
    const id = loadRequest;
    try {
      const [ddl, metadata] = await Promise.all([
        loadObjectDdl({ connectionId: props.connectionId, database: props.database, schema: props.schema ?? props.database, tableName: props.tableName, catalog: props.catalog }, { force: true }),
        api.getColumns(props.connectionId, props.database, props.schema ?? props.database, props.tableName, props.catalog),
      ]);
      if (id !== loadRequest) return;
      if (props.paimon) {
        const source = readPaimonCopySource(ddl.ddl);
        const properties = source.properties;
        const keys = properties
          .get("primary-key")
          ?.split(",")
          .map((name) => name.trim());
        columns.value = createColumnDrafts(metadata, "spark").map((column) => ({ ...column, isPrimaryKey: keys ? keys.includes(column.name) : column.isPrimaryKey }));
        if (!columns.value.length || keys?.some((key) => !columns.value.some((column) => column.name === key))) throw new Error(t("starrocksLayout.copyMetadataUnavailable"));
        const bucketIds = (properties.get("bucket-key") || "")
          .split(",")
          .filter(Boolean)
          .map((name) => {
            const column = columns.value.find((c) => c.name === name.trim());
            if (!column) throw new Error(t("starrocksLayout.copyMetadataUnavailable"));
            return column.id;
          });
        const partitionIds = source.partitionNames.map((name) => {
          const column = columns.value.find((c) => c.name === name);
          if (!column) throw new Error(t("starrocksLayout.copyMetadataUnavailable"));
          return column.id;
        });
        paimonPhysical.value = { ...emptyTablePhysicalOptions(), partitionColumnIds: partitionIds, distributionColumnIds: bucketIds, bucketCount: properties.get("bucket") ?? "", propertyRows: [...properties].filter(([key]) => !["bucket", "bucket-key", "primary-key", "comment"].includes(key)) };
        savedProperties.value = new Map(paimonPhysical.value.propertyRows);
        propertiesLoaded.value = true;
        keepPartition.value = false;
        sourceDdl.value = ddl.ddl;
        return;
      }
      context.value = starRocksAlterOptionsFromDdl(ddl.ddl, props.serverVersion);
      if (!context.value.model || !context.value.distribution) throw new Error(t("starrocksLayout.copyMetadataUnavailable"));
      sourceDdl.value = ddl.ddl;
      columns.value = createColumnDrafts(metadata, "starrocks").map((column) => ({
        ...column,
        // Used only by the layout validator. The copied source DDL keeps its actual key model.
        isPrimaryKey: context.value!.model !== "duplicate" && context.value!.keyColumns.some((name) => name.toLowerCase() === column.name.toLowerCase()),
      }));
      physical.value = {
        ...emptyStarRocksPhysicalOptions(),
        distribution: context.value.distribution.method,
        distributionColumnIds: context.value.distribution.columns.map((name) => columns.value.find((column) => column.name === name)?.id ?? name),
        bucketCount: context.value.distribution.buckets?.toString() ?? "",
      };
    } catch (e) {
      if (id === loadRequest) error.value = e instanceof Error ? e.message : String(e);
      if (id === loadRequest && props.inline && props.paimon) {
        const table = [props.catalog, props.schema || props.database, props.tableName]
          .filter(Boolean)
          .map((name) => "`" + name!.replaceAll("`", "``") + "`")
          .join(".");
        try {
          const result = await api.executeQuery(props.connectionId, props.database, "SHOW TBLPROPERTIES " + table, props.schema);
          if (id !== loadRequest) return;
          const rows: [string, string][] = [];
          for (const [key, value] of result.rows) {
            if (typeof key === "string" && typeof value === "string" && !/^(bucket|bucket-key|primary-key|comment|location|path)$/i.test(key)) rows.push([key, value]);
          }
          paimonPhysical.value.propertyRows = rows;
          savedProperties.value = new Map(rows);
          propertiesLoaded.value = true;
        } catch (cause) {
          if (id === loadRequest) propertyError.value = cause instanceof Error ? cause.message : String(cause);
        }
      }
    } finally {
      if (id === loadRequest) loading.value = false;
    }
  },
  { immediate: true },
);

async function refreshPreview() {
  const id = ++previewRequest;
  if (!props.open || loading.value || running.value || attempted.value || !sourceDdl.value) return;
  plan.value = undefined;
  previewLoading.value = true;
  warnings.value = [];
  error.value = "";
  try {
    const target = targetName.value.trim();
    if (!target || target.toLowerCase() === props.tableName.toLowerCase() || target.includes("\0")) throw new Error(t("starrocksLayout.copyNameRequired"));
    if (props.paimon) {
      const draft = paimonPhysical.value;
      if (draft.propertyRows?.some(([key]) => /^(path|location)$/i.test(key.trim()))) throw new Error("A layout copy requires a new managed table location.");
      const mode = draft.partitionMode ?? "value";
      const derived = mode !== "none" && mode !== "value";
      const quote = (name: string) => "`" + name.replaceAll("`", "``") + "`";
      const namespace = [props.catalog, props.schema || props.database].filter((v): v is string => !!v).map(quote);
      const qualified = (name: string) => [...namespace, quote(name)].join(".");
      const sourceColumn = columns.value.find((column) => column.id === draft.partitionColumnIds[0]);
      const expr = sourceColumn ? paimonWriteExpression(draft, quote(sourceColumn.name)) : "";
      const hasPrimaryKey = columns.value.some((column) => column.isPrimaryKey);
      const source = readPaimonCopySource(sourceDdl.value);
      const partitionName = draft.partitionTarget?.trim() || "p_" + mode;
      const existingPartition = derived && source.partitionNames.includes(partitionName) && sourceColumn?.name !== partitionName ? partitionName : undefined;
      const retainedColumns = columns.value.filter((column) => column.name !== existingPartition);
      if (existingPartition && hasPrimaryKey && !retainedColumns.some((column) => column.isPrimaryKey)) {
        throw new Error("Choose a different partition name to preserve the existing primary key.");
      }
      const copyColumns = retainedColumns.map((column) => ({
        ...column,
        isPrimaryKey: column.isPrimaryKey || (hasPrimaryKey && mode === "value" && draft.partitionColumnIds.includes(column.id)),
      }));
      const result = await api.buildCreateTableSql({ databaseType: "spark", tableName: target, schema: props.schema, columns: copyColumns, indexes: [], foreignKeys: [], triggers: [], tableComment: "", partitioned: false }, props.serverVersion, {
        paimon: { ...draft, bucketColumnIds: draft.distributionColumnIds, propertyRows: draft.propertyRows ?? [] },
      });
      if (id !== previewRequest) return;
      if (result.warnings.length || result.statements.length !== 1) throw new Error(result.warnings.join("\n") || t("starrocksLayout.copyMetadataUnavailable"));
      const createSql = paimonCopyDdl(source, result.statements[0], qualified(target), derived, existingPartition);
      const names = retainedColumns.map((column) => quote(column.name));
      const selections = [...names];
      if (derived && (!draft.generatePartition || mode === "group" || mode === "range")) {
        names.push(quote(draft.partitionTarget?.trim() || "p_" + mode));
        selections.push(expr);
      }
      const insertSql = transferData.value ? `INSERT INTO ${qualified(target)} (${names.join(", ")}) SELECT ${selections.join(", ")} FROM ${qualified(props.tableName)};` : undefined;
      plan.value = { createSql, insertSql, targetName: target };
      preview.value = [createSql, insertSql].filter(Boolean).join("\n\n");
      return;
    }
    const result = await api.buildCreateTableSql({ databaseType: "starrocks", tableName: target, schema: props.schema, columns: columns.value, indexes: [], foreignKeys: [], triggers: [], tableComment: "", partitioned: false }, props.serverVersion, buildStarRocksDialectOptions(physical.value));
    if (id !== previewRequest) return;
    if (result.warnings.length || result.statements.length !== 1) {
      warnings.value = result.warnings;
      return;
    }
    const createSql = buildStarRocksLayoutCopyDdl(sourceDdl.value, result.statements[0]!, props.database, target, keepPartition.value);
    const insertColumns = starRocksCopyInsertColumns(sourceDdl.value, columns.value);
    if (transferData.value && !insertColumns.length) throw new Error(t("starrocksLayout.copyNoInsertColumns"));
    const copySql = transferData.value ? await api.buildCopyTableDataSql({ databaseType: "starrocks", schema: props.database, sourceName: props.tableName, targetName: target, columns: insertColumns }) : undefined;
    if (id !== previewRequest) return;
    // A statement-local setting avoids leaking strict-mode changes into pooled sessions.
    const insertSql = copySql?.replace(/^INSERT\s+/i, "INSERT /*+ SET_VAR(enable_insert_strict=true) */ ");
    const formatted = await formatDdlForDisplay(createSql, { dialect: "mysql", databaseType: "starrocks", includeDatabaseName: true, database: props.database, quoteIdentifiers: true });
    if (id !== previewRequest) return;
    plan.value = { createSql, insertSql, targetName: target };
    preview.value = formatted + (insertSql ? "\n\n" + insertSql : "");
  } catch (e) {
    if (id === previewRequest) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (id === previewRequest) previewLoading.value = false;
  }
}

watch(
  [targetName, transferData, keepPartition, physical, paimonPhysical, sourceDdl, columns],
  () => {
    void refreshPreview();
  },
  { deep: true },
);
watch(loading, (value) => {
  if (!value) void refreshPreview();
});

async function submit() {
  if (!canSubmit.value || !plan.value) return;
  const snapshot = { ...plan.value };
  const connectionId = props.connectionId;
  const database = props.database;
  const schema = props.schema;
  const timeout = props.timeoutSecs === 0 ? 0 : Math.max(props.timeoutSecs ?? 0, 3600);
  let created = false;
  running.value = true;
  try {
    if (!(await props.authorize([snapshot.createSql, snapshot.insertSql].filter(Boolean).join("\n")))) return;
    attempted.value = true;
    await executeStarRocksCopyPlan(
      snapshot,
      (sql) => api.executeBatch(connectionId, database, [sql], schema, timeout, false),
      (value) => {
        stage.value = value;
        if (value === "created") created = true;
      },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (props.paimon && stage.value === "creating" && paimonPhysical.value.generatePartition && /UNSUPPORTED_FEATURE\.TABLE_OPERATION/.test(message) && /does not support generated columns/i.test(message)) {
      generatedColumnsRejected.value = true;
      attempted.value = false;
      stage.value = undefined;
      plan.value = undefined;
      preview.value = "";
      paimonPhysical.value = { ...paimonPhysical.value, generatePartition: false };
      return;
    }
    error.value = t(stage.value === "transferring" || stage.value === "created" ? "starrocksLayout.copyTransferFailed" : "starrocksLayout.copyCreateFailed", { table: snapshot.targetName, message });
  } finally {
    running.value = false;
    if (created) {
      const completed = stage.value === "complete";
      if (completed) close(false);
      emit("created", snapshot.targetName, completed);
    }
  }
}
</script>
<template>
  <component :is="inline ? 'section' : Dialog" :open="open" @update:open="close">
    <component :is="inline ? 'div' : DialogContent" data-starrocks-layout-copy-dialog :class="inline ? 'space-y-2' : 'flex max-h-[90vh] flex-col sm:max-w-[900px]'" :show-close-button="!running" @escape-key-down="preventDismiss" @interact-outside="preventDismiss">
      <DialogHeader v-if="!inline"
        ><DialogTitle>{{ t("starrocksLayout.copyTitle") }}</DialogTitle></DialogHeader
      >
      <div class="min-h-0 space-y-3 overflow-y-auto">
        <TablePhysicalOptionsEditor v-if="inline && paimon" v-model="paimonPhysical" :config="PAIMON_PHYSICAL_OPTIONS" :columns="columns" section="properties" :disabled="locked || !propertiesLoaded" />
        <div v-if="inline && paimon" class="space-y-1">
          <Button size="sm" :disabled="locked || !!propertyPlan.error || !propertyPlan.changes.length" @click="saveProperties">{{ t("structureEditor.saveProperties") }}</Button>
          <p v-if="propertyPlan.error || propertyError" role="alert" class="text-sm text-destructive">{{ propertyPlan.error || propertyError }}</p>
          <pre v-if="propertyPlan.changes.length" class="whitespace-pre-wrap text-xs">{{ propertyPlan.changes.map((change) => change.sql).join("\n") }}</pre>
        </div>
        <TablePhysicalOptionsEditor v-if="paimon && sourceDdl" v-model="paimonPhysical" :config="PAIMON_PHYSICAL_OPTIONS" :columns="columns" :section="inline ? 'layout' : undefined" :generated-columns-unavailable="generatedColumnsRejected" :disabled="locked" />
        <p v-if="generatedColumnsRejected" role="status" class="text-sm">{{ t("structureEditor.partitionGeneratedRejected") }}</p>
        <p class="text-sm text-muted-foreground">{{ t("starrocksLayout.copyHint", { table: tableName }) }}</p>
        <p v-if="loading" class="text-sm">{{ t("starrocksLayout.copyLoading") }}</p>
        <label class="block space-y-1"
          ><span>{{ t("starrocksLayout.copyTargetName") }}</span
          ><Input v-model="targetName" :disabled="locked"
        /></label>
        <label class="flex items-center gap-2 text-sm"><input v-model="transferData" type="checkbox" :disabled="locked" />{{ t("starrocksLayout.copyTransferData") }}</label>
        <p v-if="transferData" class="text-xs text-muted-foreground">{{ t("starrocksLayout.copyTransferHint") }}</p>
        <label v-if="!paimon" class="flex items-center gap-2 text-sm"><input v-model="keepPartition" type="checkbox" :disabled="locked" />{{ t("starrocksLayout.copyKeepPartition") }}</label>
        <pre v-if="keepPartition && context?.partitionClause" class="overflow-auto whitespace-pre-wrap rounded border p-2 text-xs">{{ context.partitionClause }}</pre>

        <StarRocksPhysicalOptionsEditor v-if="!paimon && sourceDdl" v-model="physical" :columns="columns" :server-version="serverVersion" :disabled="locked" :hide-partition="keepPartition" hide-sorting />
        <p v-if="context?.colocated" class="text-xs text-muted-foreground">{{ t("starrocksLayout.copyColocationHint") }}</p>
        <p v-if="!keepPartition" class="text-xs text-muted-foreground">{{ t("starrocksLayout.copyPartitionHint") }}</p>
        <p v-if="stage && !error" class="text-sm" role="status">{{ t(`starrocksLayout.copyStage_${stage}`, { table: plan?.targetName }) }}</p>
        <p v-if="error" class="whitespace-pre-wrap text-sm text-destructive" role="alert">{{ error }}</p>
        <ul v-if="warnings.length" class="space-y-1 text-sm text-amber-600">
          <li v-for="warning in warnings" :key="warning">{{ warning }}</li>
        </ul>
        <details v-if="preview" :open="!inline">
          <summary class="cursor-pointer text-sm">{{ t("structureEditor.sqlPreview") }}</summary>
          <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border bg-muted/20 p-3 text-xs">{{ preview }}</pre>
        </details>
      </div>
      <component :is="inline ? 'div' : DialogFooter">
        <Button v-if="!inline" variant="outline" :disabled="running" @click="close(false)">{{ t("common.close") }}</Button>
        <Button :disabled="!canSubmit" @click="submit">{{ running ? t("starrocksLayout.copyRunning") : t("starrocksLayout.copyExecute") }}</Button>
      </component>
    </component>
  </component>
</template>

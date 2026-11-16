<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import StarRocksPhysicalOptionsEditor from "./StarRocksPhysicalOptionsEditor.vue";
import { createColumnDrafts } from "@/lib/table/tableStructureEditorState";
import { buildStarRocksDialectOptions, emptyStarRocksPhysicalOptions } from "@/lib/table/starrocksPhysicalOptions";
import { starRocksAlterOptionsFromDdl, type StarRocksAlterOptions } from "@/lib/table/starrocksAlterOptions";
import { buildStarRocksLayoutCopyDdl, executeStarRocksCopyPlan, starRocksCopyInsertColumns, type StarRocksCopyPlan, type StarRocksCopyStage } from "@/lib/table/starrocksLayoutCopy";
import { formatDdlForDisplay } from "@/lib/sql/ddlDisplay";
import { loadObjectDdl } from "@/lib/metadata/objectDdlCache";
import type { EditableStructureColumn } from "@/lib/table/tableStructureEditorSql";
import * as api from "@/lib/backend/api";

const props = defineProps<{ open: boolean; connectionId: string; database: string; schema?: string; catalog?: string; tableName: string; serverVersion?: string; timeoutSecs?: number; authorize: (sql: string) => Promise<boolean> }>();
const emit = defineEmits<{ "update:open": [open: boolean]; created: [tableName: string] }>();
const { t } = useI18n();
const targetName = ref("");
const transferData = ref(false);
const keepPartition = ref(true);
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
const stage = ref<StarRocksCopyStage>();
let loadRequest = 0;
let previewRequest = 0;
const locked = computed(() => loading.value || running.value || attempted.value);
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
    attempted.value = false;
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
  [targetName, transferData, keepPartition, physical, sourceDdl, columns],
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
    error.value = t(stage.value === "transferring" || stage.value === "created" ? "starrocksLayout.copyTransferFailed" : "starrocksLayout.copyCreateFailed", { table: snapshot.targetName, message });
  } finally {
    running.value = false;
    if (created) emit("created", snapshot.targetName);
  }
}
</script>
<template>
  <Dialog :open="open" @update:open="close">
    <DialogContent data-starrocks-layout-copy-dialog class="flex max-h-[90vh] flex-col sm:max-w-[900px]" :show-close-button="!running" @escape-key-down="preventDismiss" @interact-outside="preventDismiss">
      <DialogHeader
        ><DialogTitle>{{ t("starrocksLayout.copyTitle") }}</DialogTitle></DialogHeader
      >
      <div class="min-h-0 space-y-3 overflow-y-auto">
        <p class="text-sm text-muted-foreground">{{ t("starrocksLayout.copyHint", { table: tableName }) }}</p>
        <p v-if="loading" class="text-sm">{{ t("starrocksLayout.copyLoading") }}</p>
        <label class="block space-y-1"
          ><span>{{ t("starrocksLayout.copyTargetName") }}</span
          ><Input v-model="targetName" :disabled="locked"
        /></label>
        <label class="flex items-center gap-2 text-sm"><input v-model="transferData" type="checkbox" :disabled="locked" />{{ t("starrocksLayout.copyTransferData") }}</label>
        <p v-if="transferData" class="text-xs text-muted-foreground">{{ t("starrocksLayout.copyTransferHint") }}</p>
        <label class="flex items-center gap-2 text-sm"><input v-model="keepPartition" type="checkbox" :disabled="locked" />{{ t("starrocksLayout.copyKeepPartition") }}</label>
        <pre v-if="keepPartition && context?.partitionClause" class="overflow-auto whitespace-pre-wrap rounded border p-2 text-xs">{{ context.partitionClause }}</pre>
        <StarRocksPhysicalOptionsEditor v-if="sourceDdl" v-model="physical" :columns="columns" :server-version="serverVersion" :disabled="locked" :hide-partition="keepPartition" hide-sorting />
        <p v-if="context?.colocated" class="text-xs text-muted-foreground">{{ t("starrocksLayout.copyColocationHint") }}</p>
        <p v-if="!keepPartition" class="text-xs text-muted-foreground">{{ t("starrocksLayout.copyPartitionHint") }}</p>
        <p v-if="stage && !error" class="text-sm" role="status">{{ t(`starrocksLayout.copyStage_${stage}`, { table: plan?.targetName }) }}</p>
        <p v-if="error" class="whitespace-pre-wrap text-sm text-destructive" role="alert">{{ error }}</p>
        <ul v-if="warnings.length" class="space-y-1 text-sm text-amber-600">
          <li v-for="warning in warnings" :key="warning">{{ warning }}</li>
        </ul>
        <details v-if="preview" open>
          <summary class="cursor-pointer text-sm">{{ t("structureEditor.sqlPreview") }}</summary>
          <pre class="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded border bg-muted/20 p-3 text-xs">{{ preview }}</pre>
        </details>
      </div>
      <DialogFooter>
        <Button variant="outline" :disabled="running" @click="close(false)">{{ t("common.close") }}</Button>
        <Button :disabled="!canSubmit" @click="submit">{{ running ? t("starrocksLayout.copyRunning") : t("starrocksLayout.copyExecute") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

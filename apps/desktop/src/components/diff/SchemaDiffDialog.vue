<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogHeader, DialogTitle, DialogFooter, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { GitCompareArrows, ArrowLeft, Play, Loader2, Maximize2, Minimize2, AlertTriangle, CircleCheck } from "@lucide/vue";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { useSchemaDiffConfig } from "@/composables/useSchemaDiffConfig";
import SchemaDiffConfigStep from "@/components/diff/SchemaDiffConfigStep.vue";
import SchemaDiffObjectTree from "@/components/diff/SchemaDiffObjectTree.vue";
import SchemaDiffDdlPanel from "@/components/diff/SchemaDiffDdlPanel.vue";
import SchemaDiffDeployStep from "@/components/diff/SchemaDiffDeployStep.vue";
import SchemaDiffOptionsPanel from "@/components/diff/SchemaDiffOptionsPanel.vue";

import { getSchemaDiffOptionsForDbType } from "@/lib/schema/schemaDiffOptions";
import { createConcurrencyLimiter, mapWithConcurrency, schemaDiffMetadataConcurrency } from "@/lib/schema/schemaDiffMetadataLoad";
import { normalizeSchemaDiffCompareOptions } from "@/types/schemaDiff";
import type { SchemaDiffCompareOptions, SchemaDiffConfig } from "@/types/schemaDiff";
import type { ObjectSourceKind, TableInfo } from "@/types/database";
import { buildDeploySqlForObjects, convertToSchemaDiffObjects, groupDiffObjects, schemaDiffDeployTargetSchema, type OperationGroup, type SchemaDiffObject, type DiffOperationType, type DiffObjectKi[...] } from "@/lib/schema/schemaDiffUtils";
import { compileSchemaDiffTableFilter, filterSchemaDiffTables } from "@/lib/schema/schemaDiffTableFilter";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";

const { t } = useI18n();
const { toast } = useToast();
const open = defineModel<boolean>("open", { default: false });
const store = useConnectionStore();

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
}>();

// Wizard state
const step = ref<"config" | "compare" | "result" | "deploy-review">("config");

// Deploy confirm dialog
const showConfirmDialog = ref(false);

// Source/Target selections
const sourceConnectionId = ref("");
const sourceDatabase = ref("");
const sourceSchema = ref("");
const targetConnectionId = ref("");
const targetDatabase = ref("");
const targetSchema = ref("");
const ignoreComments = ref(false);

// Options panel
const showOptionsPanel = ref(false);
const optionTree = computed(() => {
  const targetConfig = store.getConfig(targetConnectionId.value);
  const dbType = targetConfig?.db_type || "postgres";
  return getSchemaDiffOptionsForDbType(dbType);
});

// Compare state
const loading = ref(false);
const diffObjects = ref<SchemaDiffObject[]>([]);
const diffGroups = ref<OperationGroup[]>([]);
const selectedObjectId = ref<string | null>(null);
const deploySql = ref("");
const deploySqlAll = ref("");
const executing = ref(false);
const lastDiffResult = ref<SchemaDiffPreparation | null>(null);
const targetDbVersion = ref<string | null>(null);
const showResultDialog = ref(false);
const deployResult = ref<{ success: boolean; message: string; affectedRows?: number } | null>(null);

// Dialog size memory (width + height + splitpanes ratio)
const DIALOG_SIZE_KEY = "dbx-schema-diff-size";
const SPLITPANES_SIZE_KEY = "dbx-schema-diff-splitpanes-v2";
const savedSize = JSON.parse(localStorage.getItem(DIALOG_SIZE_KEY) || "null");

const savedSplitpanes = (() => {
  try {
    const raw = localStorage.getItem(SPLITPANES_SIZE_KEY);
    if (!raw) return null;
    const val = JSON.parse(raw);
    return typeof val === "number" && val >= 10 && val <= 90 ? val : null;
  } catch {
    return null;
  }
})();

// Splitpanes size memory (percentage for first pane)
const splitpanesSize = ref(savedSplitpanes ?? 60);

function handleSplitpanesResized(payload: { panes: { size: number }[] }) {
  if (payload.panes && payload.panes.length > 0) {
    const size = payload.panes[0].size;
    splitpanesSize.value = size;
    localStorage.setItem(SPLITPANES_SIZE_KEY, JSON.stringify(size));
  }
}

const isMaximized = ref(false);

// Config step: always use default size 1100x820
// Result step: use saved size if exists
const dialogStyle = computed(() => {
  if (isMaximized.value) {
    return {
      width: "100%",
      height: "100%",
      maxWidth: "100%",
      maxHeight: "100%",
      borderRadius: "0",
    };
  }
  if (step.value === "result") {
    return {
      width: savedSize?.width || "1100px",
      height: savedSize?.height || "820px",
      maxWidth: "calc(100vw - 2rem)",
      maxHeight: "calc(100vh - 2rem)",
    };
  }
  return {
    width: "1100px",
    height: "820px",
    maxWidth: "calc(100vw - 2rem)",
    maxHeight: "calc(100vh - 2rem)",
  };
});

function toggleMaximize() {
  isMaximized.value = !isMaximized.value;
}

function handleDialogEscape(event: KeyboardEvent) {
  if (!showOptionsPanel.value) return;

  event.preventDefault();
  showOptionsPanel.value = false;
}

let resizeObserver: ResizeObserver | null = null;
let saveTimeout: number | null = null;

function setupResizeObserver() {
  const el = document.querySelector('[data-slot="dialog-content"]') as HTMLElement;
  if (!el) return;

  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = window.setTimeout(() => {
        localStorage.setItem(
          DIALOG_SIZE_KEY,
          JSON.stringify({
            width: `${width}px`,
            height: `${height}px`,
          }),
        );
      }, 500);
    }
  });

  resizeObserver.observe(el);
}

function teardownResizeObserver() {
  if (saveTimeout) clearTimeout(saveTimeout);
  resizeObserver?.disconnect();
  resizeObserver = null;
}

// Only enable resize observer in result step
watch(
  () => step.value,
  (newStep) => {
    if (newStep === "result") {
      setTimeout(setupResizeObserver, 100);
    } else {
      teardownResizeObserver();
    }
  },
);

onBeforeUnmount(() => {
  teardownResizeObserver();
});

// Config management
const { configs, activeConfigId, activeConfig, recentConfigs, ensureDefaultConfig, updateActiveConfigConnection, updateActiveConfigOptions, saveToHistory, deleteFromHistory } = useSchemaDiffConfi[...]
const schemaDiffPanelOptions = computed(() => normalizeSchemaDiffCompareOptions(activeConfig.value?.options, getDbType()));

const selectedObject = computed(() => {
  if (!selectedObjectId.value) return null;
  for (const group of diffGroups.value) {
    for (const typeGroup of group.typeGroups) {
      const obj = typeGroup.objects.find((o) => o.id === selectedObjectId.value);
      if (obj) return obj;
    }
  }
  return null;
});

const canDeploy = computed(() => {
  return diffObjects.value.some((o) => o.selected && o.operationType !== "none");
});

// Watch for prefilled values
watch(
  () => open.value,
  (isOpen) => {
    if (isOpen) {
      ensureDefaultConfig();
      if (props.prefillConnectionId) {
        sourceConnectionId.value = props.prefillConnectionId;
        if (props.prefillDatabase) {
          sourceDatabase.value = props.prefillDatabase;
        }
        if (props.prefillSchema) {
          sourceSchema.value = props.prefillSchema;
        }
      }
    }
  },
  { immediate: true },
);

// Config sync
watch([sourceConnectionId, sourceDatabase, sourceSchema, targetConnectionId, targetDatabase, targetSchema], ([srcConn, srcDb, srcSchema, tgtConn, tgtDb, tgtSchema]) => {
  updateActiveConfigConnection({
    sourceConnectionId: srcConn,
    sourceDatabase: srcDb,
    sourceSchema: srcSchema,
    targetConnectionId: tgtConn,
    targetDatabase: tgtDb,
    targetSchema: tgtSchema,
  });
});

// Auto-fetch target database version when connection/database changes
watch(
  () => [targetConnectionId.value, targetDatabase.value],
  async ([connId, db]) => {
    if (connId && db) {
      await fetchDbVersion(connId, db, targetSchema.value);
    } else {
      targetDbVersion.value = null;
    }
  },
);

function getDbType(): string {
  const targetConfig = store.getConfig(targetConnectionId.value);
  return targetConfig?.db_type || "postgres";
}

function handleSwap() {
  const tempConn = sourceConnectionId.value;
  const tempDb = sourceDatabase.value;
  const tempSchema = sourceSchema.value;
  sourceConnectionId.value = targetConnectionId.value;
  sourceDatabase.value = targetDatabase.value;
  sourceSchema.value = targetSchema.value;
  targetConnectionId.value = tempConn;
  targetDatabase.value = tempDb;
  targetSchema.value = tempSchema;
}

function handleOptionsUpdate(options: SchemaDiffCompareOptions) {
  if (activeConfig.value) {
    updateActiveConfigOptions(normalizeSchemaDiffCompareOptions(options, getDbType()));
  }
}

/** Map a JDBC table_type to an ObjectSourceKind for getTableDdl routing.
 *  Views and materialized views need the object_type parameter so the
 *  backend can call DBMS_METADATA.GET_DDL with the correct type. */
function isViewOrMaterializedView(tableType: string): ObjectSourceKind | undefined {
  switch (tableType.toUpperCase().replace(/\s+/g, "_")) {
    case "VIEW":
      return "VIEW";
    case "MATERIALIZED_VIEW":
      return "MATERIALIZED_VIEW";
    default:
      return undefined;
  }
}

interface SchemaDetailLoadContext {
  connectionId: string;
  database: string;
  schema: string;
  dbType: string;
  options: SchemaDiffCompareOptions;
}

function shouldLoadIndexes(options: SchemaDiffCompareOptions): boolean {
  return options.indexes || options.primaryKeys || options.uniqueKeys;
}

async function loadSchemaDetails(tables: TableInfo[], context: SchemaDetailLoadContext): Promise<TableSchemaDetail[]> {
  const concurrency = schemaDiffMetadataConcurrency(context.dbType, tables.length);
  const runMetadataQuery = createConcurrencyLimiter(concurrency);

  return mapWithConcurrency(tables, concurrency, async (table) => {
    const objectType = isViewOrMaterializedView(table.table_type);
-    const [columns, indexes, foreignKeys, triggers, ddl] = await Promise.all([
-      runMetadataQuery(() => api.getColumns(context.connectionId, context.database, context.schema, table.name)),
-      shouldLoadIndexes(context.options) ? runMetadataQuery(() => api.listIndexes(context.connectionId, context.database, context.schema, table.name)) : Promise.resolve([]),
-      context.options.foreignKeys ? runMetadataQuery(() => api.listForeignKeys(context.connectionId, context.database, context.schema, table.name)) : Promise.resolve([]),
-      context.options.triggers ? runMetadataQuery(() => api.listTriggers(context.connectionId, context.database, context.schema, table.name)) : Promise.resolve([]),
-      runMetadataQuery(() => api.getTableDdl(context.connectionId, context.database, context.schema, table.name, objectType)),
-    ]);
+    // 仅在需要时才请求 DDL：
+    // - 如果是 VIEW / MATERIALIZED_VIEW，受 context.options.views 控制
+    // - 如果是普通表，受 context.options.tables 控制
+    const shouldFetchDdl = objectType ? !!context.options.views : !!context.options.tables;
+
+    const ddlPromise = shouldFetchDdl
+      ? runMetadataQuery(() => api.getTableDdl(context.connectionId, context.database, context.schema, table.name, objectType))
+      : Promise.resolve("");
+
+    const [columns, indexes, foreignKeys, triggers, ddl] = await Promise.all([
+      runMetadataQuery(() => api.getColumns(context.connectionId, context.database, context.schema, table.name)),
+      shouldLoadIndexes(context.options) ? runMetadataQuery(() => api.listIndexes(context.connectionId, context.database, context.schema, table.name)) : Promise.resolve([]),
+      context.options.foreignKeys ? runMetadataQuery(() => api.listForeignKeys(context.connectionId, context.database, context.schema, table.name)) : Promise.resolve([]),
+      context.options.triggers ? runMetadataQuery(() => api.listTriggers(context.connectionId, context.database, context.schema, table.name)) : Promise.resolve([]),
+      ddlPromise,
+    ]);

    return { name: table.name, columns, indexes, foreignKeys, triggers, ddl };
  });
}

async function handleCompare() {
  loading.value = true;
  step.value = "compare";

  try {
    const sourceConfig = store.getConfig(sourceConnectionId.value);
    const targetConfig = store.getConfig(targetConnectionId.value);
    const dbType = targetConfig?.db_type || "mysql";
    const sourceDbType = sourceConfig?.db_type || dbType;
    const opts = normalizeSchemaDiffCompareOptions(activeConfig.value?.options, dbType);
    const tableFilter = compileSchemaDiffTableFilter(opts);

    await store.ensureConnected(sourceConnectionId.value);
    await store.ensureConnected(targetConnectionId.value);

    const [srcTables, tgtTables] = await Promise.all([api.listTables(sourceConnectionId.value, sourceDatabase.value, sourceSchema.value), api.listTables(targetConnectionId.value, targetDatabase.v[...]
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { uuid } from "@/lib/common/utils";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { buildTransferObjectSelections } from "./transferSelections";
import { createTaskLoadTracker } from "./taskLoadTracker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import SearchableSelect from "@/components/ui/searchable-select/SearchableSelect.vue";
import ConnectionTreeSelect from "@/components/connection/ConnectionTreeSelect.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { ensureReadOnlyWriteAccess } from "@/lib/database/readOnlyWriteAccess";
import * as api from "@/lib/backend/api";
import type { TransferContent, TransferMode, TransferObjectKind, TransferTableNameCase } from "@/lib/backend/api";
import { crossFamilyTransferableKinds, isSameTransferFamily, transferObjectKindsForDatabase } from "@/lib/database/transferObjectKinds";
import ObjectSelectionTree from "@/components/transfer/ObjectSelectionTree.vue";
import TransferTaskTree from "@/components/transfer/TransferTaskTree.vue";
import type { DatabaseType } from "@/types/database";
import type { TransferTask, TransferTaskConfig } from "@/types/database";
import { isSchemaAware, supportsTransfer } from "@/lib/database/databaseCapabilities";
import { isDorisFamilyCatalogCapable } from "@/lib/database/databaseFeatureSupport";
import { decodeTransferDatabaseOption, encodeTransferDatabaseOptions, isSameTransferDatabase, isTransferDatabaseSelected, normalizeTransferCatalog } from "@/lib/database/dataTransferSelection";
import { formatDatabaseLabel } from "@/lib/database/defaultDatabase";
import { databaseOptionsForConnection, fetchCatalogNamespaceOptions, fetchNamespaceOptionsForConnection, namespaceOptionsAreSchemas } from "@/composables/useDatabaseOptions";
import { useExportTracker } from "@/composables/useExportTracker";
import { useTransferTaskStore, TransferTaskNameConflictError, nextTransferTaskCopyName } from "@/stores/transferTaskStore";
import { useToast } from "@/composables/useToast";
import type { CatalogInfo } from "@/types/database";
import { ArrowRightLeft, ArrowLeftRight, Loader2 } from "@lucide/vue";

const { t } = useI18n();
const { startDataTransferTask } = useExportTracker();
const { toast } = useToast();
const taskStore = useTransferTaskStore();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillCatalog?: string;
  prefillSchema?: string;
  prefillTables?: string[];
  prefillTargetConnectionId?: string;
  prefillTargetDatabase?: string;
  prefillTargetSchema?: string;
}>();

const transferDialogStyle = {
  width: "min(1120px, calc(100vw - 2rem))",
  height: "min(80vh, calc(var(--dbx-viewport-height) - 2rem))",
  minWidth: "min(780px, calc(100vw - 2rem))",
  minHeight: "min(480px, calc(var(--dbx-viewport-height) - 2rem))",
  maxWidth: "calc(100vw - 2rem)",
  maxHeight: "calc(var(--dbx-viewport-height) - 2rem)",
} as const;

const store = useConnectionStore();

const sqlConnections = computed(() => store.connections.filter((c) => supportsTransfer(c.db_type)));

// Source state
const sourceConnectionId = ref("");
const sourceCatalog = ref("");
const sourceCatalogs = ref<CatalogInfo[]>([]);
const sourceDatabase = ref("");
const sourceDatabases = ref<string[]>([]);
const sourceSchemas = ref<string[]>([]);
const sourceSchema = ref("");
const objectGroups = ref<Partial<Record<TransferObjectKind, string[]>>>({});
const selectedObjects = ref<Partial<Record<TransferObjectKind, Set<string>>>>({});
const objectSearch = ref("");
const loadingObjects = ref(false);
const transferContent = ref<TransferContent>("structureAndData");

const selectedTables = computed(() => new Set(selectedObjects.value.TABLE ?? []));

const OBJECT_KIND_LABEL_KEY: Record<TransferObjectKind, string> = {
  TABLE: "objectTypeTable",
  VIEW: "objectTypeView",
  MATERIALIZED_VIEW: "objectTypeMaterializedView",
  PROCEDURE: "objectTypeProcedure",
  FUNCTION: "objectTypeFunction",
  TRIGGER: "objectTypeTrigger",
  SEQUENCE: "objectTypeSequence",
  EVENT: "objectTypeEvent",
};

const treeSelection = computed<Record<string, string[]>>({
  get: () => Object.fromEntries(Object.entries(selectedObjects.value).map(([k, v]) => [k, [...(v ?? [])]])),
  set: (value) => {
    const next: Partial<Record<TransferObjectKind, Set<string>>> = {};
    for (const [k, names] of Object.entries(value)) {
      if (names.length > 0) next[k as TransferObjectKind] = new Set(names);
    }
    selectedObjects.value = next;
  },
});

const treeGroups = computed(() =>
  (Object.keys(objectGroups.value) as TransferObjectKind[]).map((kind) => ({
    kind,
    label: t(`transfer.${OBJECT_KIND_LABEL_KEY[kind]}`),
    items: objectGroups.value[kind] ?? [],
  })),
);

const treeDisabledGroups = computed<TransferObjectKind[]>(() => {
  const presentKinds = Object.keys(objectGroups.value) as TransferObjectKind[];
  if (transferContent.value === "dataOnly") {
    return presentKinds.filter((k) => k !== "TABLE");
  }
  const sourceConfig = store.getConfig(sourceConnectionId.value);
  const targetConfig = store.getConfig(targetConnectionId.value);
  const allowed = crossFamilyTransferableKinds(sourceConfig?.db_type, targetConfig?.db_type);
  return presentKinds.filter((k) => k !== "TABLE" && !allowed.includes(k));
});

const treeDisabledHints = computed<Record<string, string>>(() => {
  const hints: Record<string, string> = {};
  const dataOnly = transferContent.value === "dataOnly";
  for (const kind of treeDisabledGroups.value) {
    hints[kind] = dataOnly ? t("transfer.objectDataOnlyDisabled") : t("transfer.objectCrossFamilyDisabled");
  }
  return hints;
});

const showCrossFamilyViewHint = computed(() => {
  const sourceConfig = store.getConfig(sourceConnectionId.value);
  const targetConfig = store.getConfig(targetConnectionId.value);
  if (transferContent.value === "dataOnly") return false;
  if (!sourceConfig || !targetConfig) return false;
  const allowed = crossFamilyTransferableKinds(sourceConfig.db_type, targetConfig.db_type);
  if (!allowed.includes("VIEW")) return false;
  return !isSameTransferFamily(sourceConfig.db_type, targetConfig.db_type) && (selectedObjects.value.VIEW?.size ?? 0) > 0;
});
const pendingSourceSchemaPrefill = ref("");
const pendingSelectedTablesPrefill = ref<string[] | null>(null);
// Pending object selection for saved-task loading (covers all object kinds,
// unlike the table-only dialog prefill used by sidebar entry points).
const pendingSelectedObjectsPrefill = ref<Partial<Record<TransferObjectKind, string[]>> | null>(null);

// Target state
const targetConnectionId = ref("");
const targetCatalog = ref("");
const targetCatalogs = ref<CatalogInfo[]>([]);
const targetDatabase = ref("");
const targetDatabases = ref<string[]>([]);
const targetSchemas = ref<string[]>([]);
const targetSchema = ref("");
const pendingTargetSchemaPrefill = ref("");

// Options
const transferMode = ref<TransferMode>("append");
const targetTableNameCase = ref<TransferTableNameCase>("preserve");
const batchSize = ref(1000);
const isSubmitting = ref(false);
const showStartConfirm = ref(false);
const ownershipDialogOpen = ref(false);
const ownershipMissingOwners = ref<string[]>([]);
const ownershipTargetOwner = ref("");
const pendingOwnershipRequest = ref<api.TransferRequest | null>(null);
const pendingOwnershipRefresh = ref<{ shouldRefreshTargetTree: boolean } | null>(null);

// Saved-task state: the form mirrors the active task; a canonical JSON
// snapshot taken at load/save time drives the unsaved-changes check.
const taskTreeRef = ref<InstanceType<typeof TransferTaskTree> | null>(null);
const activeTaskId = ref<string | null>(null);
const savedConfigSnapshot = ref("");
const showUnsavedConfirm = ref(false);
let pendingDiscardAction: (() => void) | null = null;
const taskLoadTracker = createTaskLoadTracker();

function connectionType(id: string): DatabaseType | undefined {
  return store.connections.find((c) => c.id === id)?.db_type;
}

function isMongoConnection(id: string): boolean {
  return connectionType(id) === "mongodb";
}

function isCatalogCapable(id: string): boolean {
  const config = store.getConfig(id);
  return isDorisFamilyCatalogCapable(config?.db_type, config?.driver_profile);
}

function decodedDatabase(connectionId: string, option: string): string {
  return decodeTransferDatabaseOption(connectionType(connectionId), option);
}

function encodedDatabase(connectionId: string, database: string): string {
  return encodeTransferDatabaseOptions(connectionType(connectionId), [database])[0] ?? "";
}

function databaseOptionLabel(connectionId: string, option: string): string {
  return formatDatabaseLabel(store.getConfig(connectionId), decodedDatabase(connectionId, option), {
    defaultDatabase: t("editor.defaultDatabase"),
    noDatabase: t("editor.noDatabase"),
  });
}

const sourceDatabaseName = computed(() => decodedDatabase(sourceConnectionId.value, sourceDatabase.value));
const targetDatabaseName = computed(() => decodedDatabase(targetConnectionId.value, targetDatabase.value));

const canStart = computed(() => {
  const effectiveSourceSchema = sourceSchema.value || sourceDatabaseName.value;
  const effectiveTargetSchema = targetSchema.value || targetDatabaseName.value;
  const sameCatalogAndDatabase = isSameTransferDatabase(
    { connectionId: sourceConnectionId.value, catalog: sourceCatalog.value, catalogs: sourceCatalogs.value, database: sourceDatabaseName.value },
    { connectionId: targetConnectionId.value, catalog: targetCatalog.value, catalogs: targetCatalogs.value, database: targetDatabaseName.value },
  );
  const sameSourceAndTarget = sameCatalogAndDatabase && effectiveSourceSchema === effectiveTargetSchema;
  return (
    !!sourceConnectionId.value &&
    isTransferDatabaseSelected(sourceDatabase.value) &&
    !!targetConnectionId.value &&
    isTransferDatabaseSelected(targetDatabase.value) &&
    (sourceCatalogs.value.length <= 1 || !!sourceCatalog.value) &&
    (targetCatalogs.value.length <= 1 || !!targetCatalog.value) &&
    (selectedTables.value.size > 0 || Object.values(selectedObjects.value).some((names) => names.size > 0)) &&
    !sameSourceAndTarget
  );
});

async function loadCatalogs(connectionId: string, side: "source" | "target", isCancelled: () => boolean = () => false) {
  if (!connectionId || !isCatalogCapable(connectionId)) {
    if (side === "source") {
      sourceCatalogs.value = [];
      sourceCatalog.value = "";
    } else {
      targetCatalogs.value = [];
      targetCatalog.value = "";
    }
    return;
  }
  // 竞态防护：请求发出后若用户切换了连接，旧连接的回调必须丢弃，
  // 不允许过期结果覆盖新选择（一切以最新选择的连接为准）。
  const isStale = () => isCancelled() || (side === "source" ? sourceConnectionId.value !== connectionId : targetConnectionId.value !== connectionId);
  try {
    const catalogs = await api.listDorisCatalogs(connectionId);
    if (isStale()) return;
    if (side === "source") {
      sourceCatalogs.value = catalogs;
      sourceCatalog.value = catalogs.length === 1 ? catalogs[0].name : "";
    } else {
      targetCatalogs.value = catalogs;
      targetCatalog.value = catalogs.length === 1 ? catalogs[0].name : "";
    }
  } catch {
    if (isStale()) return;
    if (side === "source") {
      sourceCatalogs.value = [];
      sourceCatalog.value = "";
    } else {
      targetCatalogs.value = [];
      targetCatalog.value = "";
    }
  }
}

async function loadDatabases(connectionId: string, target: "source" | "target", isCancelled: () => boolean = () => false) {
  if (!connectionId) return;
  // 竞态防护：连接切换后，旧连接的数据库列表回调直接丢弃。
  const isStale = () => isCancelled() || (target === "source" ? sourceConnectionId.value !== connectionId : targetConnectionId.value !== connectionId);
  try {
    await store.ensureConnected(connectionId);
    const config = store.getConfig(connectionId);
    if (!config) return;
    const names = isMongoConnection(connectionId) ? databaseOptionsForConnection(await api.mongoListDatabases(connectionId), config) : await fetchNamespaceOptionsForConnection(connectionId, config);
    const options = encodeTransferDatabaseOptions(config.db_type, names);
    if (isStale()) return;
    if (target === "source") {
      sourceDatabases.value = options;
      sourceDatabase.value = options.length === 1 ? options[0] : "";
    } else {
      targetDatabases.value = options;
      targetDatabase.value = options.length === 1 ? options[0] : "";
    }
  } catch {
    if (isStale()) return;
    if (target === "source") sourceDatabases.value = [];
    else targetDatabases.value = [];
  }
}

async function loadDatabasesForCatalog(connectionId: string, catalog: string, target: "source" | "target", isCancelled: () => boolean = () => false) {
  if (!connectionId || !catalog) return;
  // 竞态防护：连接或 catalog 切换后，旧请求的数据库列表回调直接丢弃。
  const isStale = () => {
    const currentConnection = target === "source" ? sourceConnectionId.value : targetConnectionId.value;
    const currentCatalog = target === "source" ? sourceCatalog.value : targetCatalog.value;
    return isCancelled() || currentConnection !== connectionId || currentCatalog !== catalog;
  };
  try {
    await store.ensureConnected(connectionId);
    const config = store.getConfig(connectionId);
    if (!config) return;
    const names = await fetchCatalogNamespaceOptions(connectionId, catalog, config);
    const options = encodeTransferDatabaseOptions(config.db_type, names);
    if (isStale()) return;
    if (target === "source") {
      sourceDatabases.value = options;
      sourceDatabase.value = options.length === 1 ? options[0] : "";
    } else {
      targetDatabases.value = options;
      targetDatabase.value = options.length === 1 ? options[0] : "";
    }
  } catch {
    if (isStale()) return;
    if (target === "source") sourceDatabases.value = [];
    else targetDatabases.value = [];
  }
}

async function loadSchemas(connectionId: string, database: string, side: "source" | "target", preferredSchema = "", isCancelled: () => boolean = () => false) {
  if (!connectionId) return;
  // 竞态防护：连接或数据库切换后，旧请求的 schema 列表回调直接丢弃。
  const isStale = () => {
    const currentConnection = side === "source" ? sourceConnectionId.value : targetConnectionId.value;
    const currentDatabase = side === "source" ? sourceDatabaseName.value : targetDatabaseName.value;
    return isCancelled() || currentConnection !== connectionId || currentDatabase !== database;
  };
  if (isMongoConnection(connectionId)) {
    if (isStale()) return;
    if (side === "source") {
      sourceSchemas.value = [];
      sourceSchema.value = database;
    } else {
      targetSchemas.value = [];
      targetSchema.value = database;
    }
    return;
  }
  try {
    const schemas = await api.listSchemas(connectionId, database);
    if (isStale()) return;
    const selected = preferredSchema && schemas.includes(preferredSchema) ? preferredSchema : schemas.includes("public") ? "public" : (schemas[0] ?? "");
    if (side === "source") {
      sourceSchemas.value = schemas;
      sourceSchema.value = selected;
    } else {
      targetSchemas.value = schemas;
      targetSchema.value = selected;
    }
  } catch {
    if (isStale()) return;
    if (side === "source") {
      sourceSchemas.value = [];
      sourceSchema.value = "";
    } else {
      targetSchemas.value = [];
      targetSchema.value = "";
    }
  }
}

function applyPendingTableSelection() {
  const pending = pendingSelectedTablesPrefill.value;
  const tables = objectGroups.value.TABLE ?? [];
  if (pending) {
    const chosen = new Set(tables.filter((table) => pending.includes(table)));
    if (chosen.size > 0) {
      selectedObjects.value = { ...selectedObjects.value, TABLE: chosen };
    }
  }
  pendingSelectedTablesPrefill.value = null;
}

/** Applies a saved task's object selection, dropping objects missing from the source. */
function applyPendingObjectSelection() {
  const pending = pendingSelectedObjectsPrefill.value;
  if (!pending) return;
  const next: Partial<Record<TransferObjectKind, Set<string>>> = { ...selectedObjects.value };
  for (const [kind, names] of Object.entries(pending)) {
    const available = objectGroups.value[kind as TransferObjectKind] ?? [];
    const chosen = new Set(available.filter((name) => names.includes(name)));
    if (chosen.size > 0) next[kind as TransferObjectKind] = chosen;
  }
  selectedObjects.value = next;
  pendingSelectedObjectsPrefill.value = null;
}

async function loadObjects(isCancelled: () => boolean = () => false) {
  const connectionId = sourceConnectionId.value;
  const databaseOption = sourceDatabase.value;
  const database = sourceDatabaseName.value;
  if (!connectionId || !isTransferDatabaseSelected(databaseOption)) {
    objectGroups.value = {};
    return;
  }
  // 竞态防护：捕获发起时的上下文快照，加载期间用户切换连接/数据库/Schema 后，
  // 旧请求的对象列表回调直接丢弃，不覆盖新选择对应的状态。
  const catalog = sourceCatalog.value || undefined;
  const schemaValue = sourceSchema.value;
  const isStale = () => isCancelled() || sourceConnectionId.value !== connectionId || sourceDatabase.value !== databaseOption || (sourceCatalog.value || undefined) !== catalog || sourceSchema.value !== schemaValue;
  loadingObjects.value = true;
  try {
    if (isMongoConnection(connectionId)) {
      const collections = await api.mongoListCollections(connectionId, database);
      if (isStale()) return;
      objectGroups.value = { TABLE: collections.map((c) => c.name) };
      applyPendingTableSelection();
      applyPendingObjectSelection();
      return;
    }
    const config = store.getConfig(connectionId);
    const needsSchema = isSchemaAware(config?.db_type);
    const schema = needsSchema && schemaValue ? schemaValue : database;
    const kinds = transferObjectKindsForDatabase(config?.db_type);
    const groups: Partial<Record<TransferObjectKind, string[]>> = {};
    for (const kind of kinds) {
      try {
        if (kind === "TABLE") {
          const tables = await api.listTables(connectionId, database, schema, undefined, undefined, undefined, undefined, catalog);
          groups.TABLE = tables.filter((t) => t.table_type === "TABLE" || t.table_type === "BASE TABLE").map((t) => t.name);
        } else {
          const objects = await api.listObjects(connectionId, database, schema, [kind], undefined, undefined, undefined, catalog);
          groups[kind] = objects.map((o) => o.name);
        }
      } catch {
        groups[kind] = [];
      }
    }
    if (isStale()) return;
    objectGroups.value = groups;
    applyPendingTableSelection();
    applyPendingObjectSelection();
  } catch {
    if (!isStale()) objectGroups.value = {};
  } finally {
    if (!isStale()) loadingObjects.value = false;
  }
}

const skipSourceWatch = ref(false);
const skipTargetWatch = ref(false);
// One-shot watcher suppression used when applying a saved task: every flag is
// consumed by its watcher so task loading can drive the form deterministically
// with explicit awaits instead of racing the async watcher chain.
const skipSourceCatalogWatch = ref(false);
const skipSourceDatabaseWatch = ref(false);
const skipSourceSchemaWatch = ref(false);
const skipTargetCatalogWatch = ref(false);
const skipTargetDatabaseWatch = ref(false);

watch(sourceConnectionId, async (id) => {
  if (skipSourceWatch.value) {
    skipSourceWatch.value = false;
    return;
  }
  sourceCatalog.value = "";
  sourceCatalogs.value = [];
  sourceDatabase.value = "";
  objectGroups.value = {};
  selectedObjects.value = {};
  pendingSourceSchemaPrefill.value = "";
  pendingSelectedTablesPrefill.value = null;
  if (isCatalogCapable(id)) {
    await loadCatalogs(id, "source");
    // await 期间连接可能已被切换，旧链直接放弃，后续加载由新连接的 watcher 负责
    if (sourceConnectionId.value !== id) return;
    if (sourceCatalog.value) {
      await loadDatabasesForCatalog(id, sourceCatalog.value, "source");
    }
  } else {
    await loadDatabases(id, "source");
  }
});

watch(sourceCatalog, async (catalog) => {
  if (skipSourceCatalogWatch.value) {
    skipSourceCatalogWatch.value = false;
    return;
  }
  if (!sourceConnectionId.value) return;
  sourceDatabase.value = "";
  objectGroups.value = {};
  selectedObjects.value = {};
  if (catalog) {
    await loadDatabasesForCatalog(sourceConnectionId.value, catalog, "source");
  }
});

watch(sourceDatabase, async (db) => {
  if (skipSourceDatabaseWatch.value) {
    skipSourceDatabaseWatch.value = false;
    return;
  }
  if (isTransferDatabaseSelected(db)) {
    const config = store.getConfig(sourceConnectionId.value);
    const database = sourceDatabaseName.value;
    if (namespaceOptionsAreSchemas(config)) {
      // Dameng has no selectable catalog, so the top-level namespace option is
      // also the schema used for metadata lookup and qualified transfer SQL.
      sourceSchemas.value = [];
      sourceSchema.value = database;
    } else if (isSchemaAware(config?.db_type)) {
      await loadSchemas(sourceConnectionId.value, database, "source", pendingSourceSchemaPrefill.value);
      pendingSourceSchemaPrefill.value = "";
    } else {
      sourceSchema.value = database;
    }
  }
});

watch(sourceSchema, () => {
  if (skipSourceSchemaWatch.value) {
    skipSourceSchemaWatch.value = false;
    return;
  }
  loadObjects();
});

watch(targetConnectionId, async (id) => {
  if (skipTargetWatch.value) {
    skipTargetWatch.value = false;
    return;
  }
  targetCatalog.value = "";
  targetCatalogs.value = [];
  targetDatabase.value = "";
  targetSchemas.value = [];
  targetSchema.value = "";
  pendingTargetSchemaPrefill.value = "";
  if (isCatalogCapable(id)) {
    await loadCatalogs(id, "target");
    // await 期间连接可能已被切换，旧链直接放弃，后续加载由新连接的 watcher 负责
    if (targetConnectionId.value !== id) return;
    if (targetCatalog.value) {
      await loadDatabasesForCatalog(id, targetCatalog.value, "target");
    }
  } else {
    await loadDatabases(id, "target");
  }
});

watch(targetCatalog, async (catalog) => {
  if (skipTargetCatalogWatch.value) {
    skipTargetCatalogWatch.value = false;
    return;
  }
  if (!targetConnectionId.value) return;
  targetDatabase.value = "";
  targetSchemas.value = [];
  targetSchema.value = "";
  if (catalog) {
    await loadDatabasesForCatalog(targetConnectionId.value, catalog, "target");
  }
});

watch(targetDatabase, async (db) => {
  if (skipTargetDatabaseWatch.value) {
    skipTargetDatabaseWatch.value = false;
    return;
  }
  if (isTransferDatabaseSelected(db)) {
    const config = store.getConfig(targetConnectionId.value);
    const database = targetDatabaseName.value;
    if (namespaceOptionsAreSchemas(config)) {
      targetSchemas.value = [];
      targetSchema.value = database;
    } else if (isSchemaAware(config?.db_type)) {
      await loadSchemas(targetConnectionId.value, database, "target", pendingTargetSchemaPrefill.value);
      pendingTargetSchemaPrefill.value = "";
    } else {
      targetSchema.value = database;
    }
  }
});

watch(
  open,
  async (val) => {
    if (val) {
      void taskStore.initFromStorage();
      resetState();
      pendingSourceSchemaPrefill.value = props.prefillSchema ?? "";
      pendingSelectedTablesPrefill.value = props.prefillTables?.length ? [...props.prefillTables] : null;
      pendingTargetSchemaPrefill.value = props.prefillTargetSchema ?? "";
      if (props.prefillConnectionId) {
        skipSourceWatch.value = true;
        sourceConnectionId.value = props.prefillConnectionId;
        if (isCatalogCapable(props.prefillConnectionId)) {
          await loadCatalogs(props.prefillConnectionId, "source");
          if (props.prefillCatalog) {
            sourceCatalog.value = props.prefillCatalog;
          }
          if (sourceCatalog.value) {
            await loadDatabasesForCatalog(props.prefillConnectionId, sourceCatalog.value, "source");
          }
        } else {
          await loadDatabases(props.prefillConnectionId, "source");
        }
        if (props.prefillDatabase !== undefined) sourceDatabase.value = encodedDatabase(props.prefillConnectionId, props.prefillDatabase);
      }
      if (props.prefillTargetConnectionId) {
        skipTargetWatch.value = true;
        targetConnectionId.value = props.prefillTargetConnectionId;
        if (isCatalogCapable(props.prefillTargetConnectionId)) {
          await loadCatalogs(props.prefillTargetConnectionId, "target");
          if (targetCatalog.value) {
            await loadDatabasesForCatalog(props.prefillTargetConnectionId, targetCatalog.value, "target");
          }
        } else {
          await loadDatabases(props.prefillTargetConnectionId, "target");
        }
        if (props.prefillTargetDatabase !== undefined) targetDatabase.value = encodedDatabase(props.prefillTargetConnectionId, props.prefillTargetDatabase);
      }
    }
  },
  { immediate: true },
);

function resetState(cancelTaskLoad = true) {
  if (cancelTaskLoad) taskLoadTracker.cancel();
  sourceConnectionId.value = "";
  sourceCatalog.value = "";
  sourceCatalogs.value = [];
  sourceDatabase.value = "";
  sourceDatabases.value = [];
  sourceSchemas.value = [];
  sourceSchema.value = "";
  objectGroups.value = {};
  selectedObjects.value = {};
  loadingObjects.value = false;
  pendingSourceSchemaPrefill.value = "";
  pendingSelectedTablesPrefill.value = null;
  objectSearch.value = "";
  targetConnectionId.value = "";
  targetCatalog.value = "";
  targetCatalogs.value = [];
  targetDatabase.value = "";
  targetDatabases.value = [];
  targetSchemas.value = [];
  targetSchema.value = "";
  pendingTargetSchemaPrefill.value = "";
  transferContent.value = "structureAndData";
  transferMode.value = "append";
  targetTableNameCase.value = "preserve";
  batchSize.value = 1000;
  isSubmitting.value = false;
  showStartConfirm.value = false;
  ownershipDialogOpen.value = false;
  ownershipMissingOwners.value = [];
  ownershipTargetOwner.value = "";
  pendingOwnershipRequest.value = null;
  pendingOwnershipRefresh.value = null;
  pendingSelectedObjectsPrefill.value = null;
  activeTaskId.value = null;
  savedConfigSnapshot.value = "";
}

/**
 * 交换源和目标两侧：连接、Catalog、数据库、Schema 的选择随各自一侧整体互换，
 * 一次点击即可反转传输方向。对象树只属于源端，旧选择作废，按新源端重新加载。
 */
function swapSourceAndTarget() {
  const sourceState = {
    connectionId: sourceConnectionId.value,
    catalog: sourceCatalog.value,
    catalogs: sourceCatalogs.value,
    database: sourceDatabase.value,
    databases: sourceDatabases.value,
    schema: sourceSchema.value,
    schemas: sourceSchemas.value,
  };
  const targetState = {
    connectionId: targetConnectionId.value,
    catalog: targetCatalog.value,
    catalogs: targetCatalogs.value,
    database: targetDatabase.value,
    databases: targetDatabases.value,
    schema: targetSchema.value,
    schemas: targetSchemas.value,
  };

  if (sourceState.connectionId === targetState.connectionId && sourceState.catalog === targetState.catalog && sourceState.database === targetState.database && sourceState.schema === targetState.schema) {
    // 两侧选择完全相同（含都未选择）时交换没有意义
    return;
  }

  // 若正在加载已保存任务，先取消，避免任务加载链覆盖交换后的状态
  taskLoadTracker.cancel();
  pendingSourceSchemaPrefill.value = "";
  pendingTargetSchemaPrefill.value = "";
  pendingSelectedTablesPrefill.value = null;
  pendingSelectedObjectsPrefill.value = null;

  // 只在值确实变化时设置一次性跳过标记：标记由对应 watcher 消费，
  // 若值未变则 watcher 不会触发，残留标记会误吞后续一次真实变更。
  if (sourceConnectionId.value !== targetState.connectionId) {
    skipSourceWatch.value = true;
    sourceConnectionId.value = targetState.connectionId;
  }
  if (sourceCatalog.value !== targetState.catalog) {
    skipSourceCatalogWatch.value = true;
    sourceCatalog.value = targetState.catalog;
  }
  sourceCatalogs.value = targetState.catalogs;
  if (sourceDatabase.value !== targetState.database) {
    skipSourceDatabaseWatch.value = true;
    sourceDatabase.value = targetState.database;
  }
  sourceDatabases.value = targetState.databases;
  if (sourceSchema.value !== targetState.schema) {
    skipSourceSchemaWatch.value = true;
    sourceSchema.value = targetState.schema;
  }
  sourceSchemas.value = targetState.schemas;

  if (targetConnectionId.value !== sourceState.connectionId) {
    skipTargetWatch.value = true;
    targetConnectionId.value = sourceState.connectionId;
  }
  if (targetCatalog.value !== sourceState.catalog) {
    skipTargetCatalogWatch.value = true;
    targetCatalog.value = sourceState.catalog;
  }
  targetCatalogs.value = sourceState.catalogs;
  if (targetDatabase.value !== sourceState.database) {
    skipTargetDatabaseWatch.value = true;
    targetDatabase.value = sourceState.database;
  }
  targetDatabases.value = sourceState.databases;
  targetSchema.value = sourceState.schema;
  targetSchemas.value = sourceState.schemas;

  // 对象树始终跟随源端：新源端是旧目标端，旧选择已无意义，清空后重新加载
  objectGroups.value = {};
  selectedObjects.value = {};
  objectSearch.value = "";
  void loadObjects();
}

async function startTransfer() {
  if (!canStart.value || isSubmitting.value) return;
  if (!(await ensureReadOnlyWriteAccess({ connection: store.getConfig(targetConnectionId.value), source: t("readOnlyUnlock.sourceTransfer"), treatAsMutation: true }))) {
    return;
  }
  isSubmitting.value = true;

  const effectiveSourceSchema = sourceSchema.value || sourceDatabaseName.value;
  const effectiveTargetSchema = targetSchema.value || targetDatabaseName.value;
  const sourceDatabase = sourceDatabaseName.value;
  const targetConnection = targetConnectionId.value;
  const targetDatabase = targetDatabaseName.value;
  const shouldRefreshTargetTree = transferContent.value !== "dataOnly";

  const request: api.TransferRequest = {
    transferId: uuid(),
    sourceConnectionId: sourceConnectionId.value,
    sourceDatabase,
    sourceSchema: effectiveSourceSchema,
    sourceCatalog: normalizeTransferCatalog(sourceCatalog.value, sourceCatalogs.value) || undefined,
    targetConnectionId: targetConnection,
    targetDatabase,
    targetSchema: effectiveTargetSchema,
    targetCatalog: normalizeTransferCatalog(targetCatalog.value, targetCatalogs.value) || undefined,
    tables: [...selectedTables.value],
    createTable: transferContent.value !== "dataOnly",
    content: transferContent.value,
    objects: buildTransferObjectSelections(selectedObjects.value, treeDisabledGroups.value),
    mode: transferMode.value,
    targetTableNameCase: targetTableNameCase.value,
    ownershipPolicy: "preserve",
    batchSize: batchSize.value,
  };

  if (transferContent.value !== "dataOnly") {
    try {
      const preview = await api.previewTransferOwnership(request);
      if (preview.missingOwners.length > 0) {
        ownershipMissingOwners.value = preview.missingOwners;
        ownershipTargetOwner.value = preview.targetOwner;
        pendingOwnershipRequest.value = request;
        pendingOwnershipRefresh.value = {
          shouldRefreshTargetTree,
        };
        ownershipDialogOpen.value = true;
        isSubmitting.value = false;
        return;
      }
    } catch {
      isSubmitting.value = false;
      return;
    }
  }

  runTransfer(request, shouldRefreshTargetTree);
}

function runTransfer(request: api.TransferRequest, shouldRefreshTargetTree: boolean) {
  isSubmitting.value = true;
  startDataTransferTask(request, `${request.sourceDatabase} → ${request.targetDatabase}`, {
    formatOverlapError: (tables) => t("transfer.targetTableBusy", { tables: tables.join(", ") }),
    onDone: async () => {
      if (shouldRefreshTargetTree) {
        await store.refreshObjectListTreeNode(request.targetConnectionId, request.targetDatabase, request.targetSchema, request.targetCatalog);
      }
    },
  });
  open.value = false;
  resetState();
}

function resolveOwnershipDecision(policy: api.TransferOwnershipPolicy | null) {
  const request = pendingOwnershipRequest.value;
  const refresh = pendingOwnershipRefresh.value;
  pendingOwnershipRequest.value = null;
  pendingOwnershipRefresh.value = null;
  ownershipDialogOpen.value = false;
  ownershipMissingOwners.value = [];
  ownershipTargetOwner.value = "";
  if (!policy || !request || !refresh) {
    isSubmitting.value = false;
    return;
  }
  runTransfer({ ...request, ownershipPolicy: policy }, refresh.shouldRefreshTargetTree);
}

function getConnectionName(id: string) {
  return store.connections.find((c) => c.id === id)?.name ?? id;
}

// ---------------------------------------------------------------------------
// Saved transfer tasks (left tree panel)
// ---------------------------------------------------------------------------

const activeTaskName = computed(() => (activeTaskId.value ? (taskStore.getTask(activeTaskId.value)?.name ?? "") : ""));

/** Builds a serializable config from the current form state. */
function currentConfig(): TransferTaskConfig {
  const objects: TransferTaskConfig["objects"] = {};
  for (const [kind, names] of Object.entries(selectedObjects.value)) {
    if (names && names.size > 0) objects[kind as TransferObjectKind] = [...names];
  }
  return {
    sourceConnectionId: sourceConnectionId.value,
    sourceCatalog: normalizeTransferCatalog(sourceCatalog.value, sourceCatalogs.value) || undefined,
    sourceDatabase: sourceDatabaseName.value,
    sourceSchema: sourceSchema.value || undefined,
    targetConnectionId: targetConnectionId.value,
    targetCatalog: normalizeTransferCatalog(targetCatalog.value, targetCatalogs.value) || undefined,
    targetDatabase: targetDatabaseName.value,
    targetSchema: targetSchema.value || undefined,
    objects,
    content: transferContent.value,
    mode: transferMode.value,
    targetTableNameCase: targetTableNameCase.value,
    batchSize: batchSize.value,
  };
}

/** Canonical serialization (sorted kinds/names) for stable dirty comparison. */
function configSnapshot(config: TransferTaskConfig) {
  const orderedObjects: Record<string, string[]> = {};
  for (const kind of Object.keys(config.objects).sort()) {
    orderedObjects[kind] = [...(config.objects[kind as TransferObjectKind] ?? [])].sort();
  }
  return JSON.stringify({ ...config, objects: orderedObjects });
}

const formHasContent = computed(() => !!sourceConnectionId.value || !!targetConnectionId.value);
const isConfigDirty = computed(() => !!activeTaskId.value && configSnapshot(currentConfig()) !== savedConfigSnapshot.value);
const needsDiscardConfirm = computed(() => isConfigDirty.value || (!activeTaskId.value && formHasContent.value));
const canSaveConfig = computed(() => !!sourceConnectionId.value && isTransferDatabaseSelected(sourceDatabase.value) && !!targetConnectionId.value && isTransferDatabaseSelected(targetDatabase.value));

/** Applies a saved task to the form, loading catalogs/databases/schemas/objects with explicit awaits. */
async function loadTaskIntoForm(task: TransferTask) {
  const taskLoadToken = taskLoadTracker.begin(task.id);
  const isTaskLoadStale = () => !taskLoadTracker.isCurrent(taskLoadToken, activeTaskId.value);
  const config = task.config;
  resetState(false);
  activeTaskId.value = task.id;
  transferContent.value = config.content;
  transferMode.value = config.mode;
  targetTableNameCase.value = config.targetTableNameCase;
  batchSize.value = config.batchSize;
  pendingSelectedObjectsPrefill.value = Object.keys(config.objects).length > 0 ? JSON.parse(JSON.stringify(config.objects)) : null;

  skipSourceWatch.value = true;
  sourceConnectionId.value = config.sourceConnectionId;
  if (isCatalogCapable(config.sourceConnectionId)) {
    await loadCatalogs(config.sourceConnectionId, "source", isTaskLoadStale);
    if (isTaskLoadStale()) return;
    if (config.sourceCatalog && sourceCatalog.value !== config.sourceCatalog) {
      skipSourceCatalogWatch.value = true;
      sourceCatalog.value = config.sourceCatalog;
    }
    if (sourceCatalog.value) {
      await loadDatabasesForCatalog(config.sourceConnectionId, sourceCatalog.value, "source", isTaskLoadStale);
      if (isTaskLoadStale()) return;
    }
  } else {
    await loadDatabases(config.sourceConnectionId, "source", isTaskLoadStale);
    if (isTaskLoadStale()) return;
  }
  const sourceConfig = store.getConfig(config.sourceConnectionId);
  const sourceDatabaseOption = encodedDatabase(config.sourceConnectionId, config.sourceDatabase);
  if (sourceDatabase.value !== sourceDatabaseOption) {
    skipSourceDatabaseWatch.value = true;
    sourceDatabase.value = sourceDatabaseOption;
  }
  if (namespaceOptionsAreSchemas(sourceConfig)) {
    sourceSchemas.value = [];
    sourceSchema.value = config.sourceDatabase;
  } else if (isSchemaAware(sourceConfig?.db_type)) {
    await loadSchemas(config.sourceConnectionId, config.sourceDatabase, "source", config.sourceSchema ?? "", isTaskLoadStale);
    if (isTaskLoadStale()) return;
  } else {
    sourceSchema.value = config.sourceDatabase;
  }
  // The schema watcher may trigger a concurrent loadObjects; both converge on
  // the same groups and the pending selection is consumed by the first one.
  await loadObjects(isTaskLoadStale);
  if (isTaskLoadStale()) return;

  skipTargetWatch.value = true;
  targetConnectionId.value = config.targetConnectionId;
  if (isCatalogCapable(config.targetConnectionId)) {
    await loadCatalogs(config.targetConnectionId, "target", isTaskLoadStale);
    if (isTaskLoadStale()) return;
    if (config.targetCatalog && targetCatalog.value !== config.targetCatalog) {
      skipTargetCatalogWatch.value = true;
      targetCatalog.value = config.targetCatalog;
    }
    if (targetCatalog.value) {
      await loadDatabasesForCatalog(config.targetConnectionId, targetCatalog.value, "target", isTaskLoadStale);
      if (isTaskLoadStale()) return;
    }
  } else {
    await loadDatabases(config.targetConnectionId, "target", isTaskLoadStale);
    if (isTaskLoadStale()) return;
  }
  const targetConfig = store.getConfig(config.targetConnectionId);
  const targetDatabaseOption = encodedDatabase(config.targetConnectionId, config.targetDatabase);
  if (targetDatabase.value !== targetDatabaseOption) {
    skipTargetDatabaseWatch.value = true;
    targetDatabase.value = targetDatabaseOption;
  }
  if (namespaceOptionsAreSchemas(targetConfig)) {
    targetSchemas.value = [];
    targetSchema.value = config.targetDatabase;
  } else if (isSchemaAware(targetConfig?.db_type)) {
    await loadSchemas(config.targetConnectionId, config.targetDatabase, "target", config.targetSchema ?? "", isTaskLoadStale);
    if (isTaskLoadStale()) return;
  } else {
    targetSchema.value = config.targetDatabase;
  }

  if (isTaskLoadStale()) return;
  savedConfigSnapshot.value = configSnapshot(currentConfig());
}

/** Runs the action immediately, or asks for confirmation when the form has unsaved changes. */
function requestDiscardableAction(action: () => void) {
  if (needsDiscardConfirm.value) {
    pendingDiscardAction = action;
    showUnsavedConfirm.value = true;
    return;
  }
  action();
}

function confirmDiscardChanges() {
  showUnsavedConfirm.value = false;
  const action = pendingDiscardAction;
  pendingDiscardAction = null;
  action?.();
}

function onSelectTask(task: TransferTask) {
  if (task.id === activeTaskId.value && !isConfigDirty.value) return;
  requestDiscardableAction(() => {
    void loadTaskIntoForm(task);
  });
}

function onNewBlank() {
  requestDiscardableAction(() => resetState());
}

/** Tree cleared the selection because the active task was deleted: reset the form so no stale config lingers as "unsaved changes". */
function onSelectedTaskIdUpdate(id: string | null) {
  if (id === null && activeTaskId.value) {
    resetState();
    return;
  }
  activeTaskId.value = id;
}

// ---- start confirmation (guards the only run entry: the footer button) ----

/** Number of objects currently selected across all kinds. */
const selectedObjectCount = computed(() => Object.values(selectedObjects.value).reduce((total, names) => total + (names?.size ?? 0), 0));

const startConfirmSource = computed(() => `${getConnectionName(sourceConnectionId.value)}.${databaseOptionLabel(sourceConnectionId.value, sourceDatabase.value)}`);
const startConfirmTarget = computed(() => `${getConnectionName(targetConnectionId.value)}.${databaseOptionLabel(targetConnectionId.value, targetDatabase.value)}`);

/** Opens the confirmation dialog before starting a transfer. */
function requestStartTransfer() {
  if (!canStart.value || isSubmitting.value) return;
  showStartConfirm.value = true;
}

/** Confirmed: close the prompt and run the normal start flow. */
function confirmStartTransfer() {
  showStartConfirm.value = false;
  void startTransfer();
}

/** Saves the form into the active task, or creates a new one and starts its rename. */
async function saveConfigTask() {
  if (!canSaveConfig.value) return;
  const config = currentConfig();
  try {
    const existing = activeTaskId.value ? taskStore.getTask(activeTaskId.value) : undefined;
    if (existing) {
      await taskStore.saveTask({ id: existing.id, name: existing.name, config });
    } else {
      const rootTasks = taskStore.listTasks(undefined);
      const defaultName = t("transfer.tasks.newTaskDefault");
      const takenNames = new Set(rootTasks.map((task) => task.name));
      const takenKeys = new Set(rootTasks.map((task) => task.name.toLocaleLowerCase()));
      const name = takenKeys.has(defaultName.toLocaleLowerCase()) ? nextTransferTaskCopyName(defaultName, takenNames) : defaultName;
      const task = await taskStore.saveTask({ name, config });
      activeTaskId.value = task.id;
      taskTreeRef.value?.startRenameTask(task);
    }
    savedConfigSnapshot.value = configSnapshot(currentConfig());
    toast(t("transfer.taskSaved"), 2000);
  } catch (error) {
    const message = error instanceof TransferTaskNameConflictError ? t("transfer.tasks.nameConflict", { name: error.entryName }) : ((error as Error)?.message ?? String(error));
    toast(t("transfer.tasks.saveFailed", { message }), 5000);
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="dbx-transfer-dialog sm:max-w-[1120px] max-h-[80vh] flex flex-col overflow-hidden resize" :style="transferDialogStyle" @interact-outside.prevent>
      <DialogHeader class="shrink-0">
        <DialogTitle class="flex items-center gap-2">
          <ArrowRightLeft class="w-4 h-4" />
          {{ t("transfer.title") }}
          <span v-if="activeTaskName" class="text-xs font-normal text-muted-foreground truncate">— {{ activeTaskName }}</span>
        </DialogTitle>
      </DialogHeader>

      <div class="flex min-h-0 flex-1 -ml-4">
        <div class="relative w-60 shrink-0 self-stretch border-r border-border">
          <TransferTaskTree ref="taskTreeRef" :selected-task-id="activeTaskId" class="absolute inset-0" @update:selected-task-id="onSelectedTaskIdUpdate" @select="onSelectTask" @new-blank="onNewBlank" />
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto pl-4 pr-1 scrollbar-thin">
          <div class="flex flex-col gap-5 py-3">
            <!-- Source / Target Side by Side -->
            <div class="grid grid-cols-[1fr_auto_1fr] gap-4 items-start">
              <!-- Source Section -->
              <div class="space-y-3">
                <div class="text-sm font-medium text-blue-500">
                  {{ t("transfer.source") }}
                </div>

                <div class="space-y-1.5">
                  <Label class="text-xs">{{ t("transfer.sourceConnection") }}</Label>
                  <ConnectionTreeSelect
                    v-model="sourceConnectionId"
                    :connections="sqlConnections"
                    :layout="store.sidebarLayout"
                    :placeholder="t('transfer.selectConnection')"
                    :search-placeholder="t('transfer.searchConnection')"
                    :empty-text="t('common.noResults')"
                    trigger-class="h-8 w-full max-w-none justify-between gap-1.5 border border-input rounded-md bg-transparent px-2.5 text-xs shadow-none hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50"
                    list-class="w-[var(--reka-popover-trigger-width)]"
                  />
                </div>

                <!-- Source Catalog (Doris/StarRocks multi-catalog) -->
                <div v-if="sourceCatalogs.length > 1" class="space-y-1.5">
                  <Label class="text-xs">{{ t("transfer.sourceCatalog") }}</Label>
                  <SearchableSelect
                    v-model="sourceCatalog"
                    :options="sourceCatalogs.map((c) => c.name)"
                    :placeholder="t('transfer.selectCatalog')"
                    :search-placeholder="t('transfer.searchCatalog')"
                    :empty-text="t('common.noResults')"
                    trigger-variant="outline"
                    trigger-class="h-8 w-full justify-between text-xs"
                    content-class="w-[var(--reka-popover-trigger-width)]"
                  />
                </div>

                <div class="space-y-1.5">
                  <Label class="text-xs">{{ t("transfer.sourceDatabase") }}</Label>
                  <SearchableSelect
                    v-model="sourceDatabase"
                    :options="sourceDatabases"
                    :display-name="(option) => databaseOptionLabel(sourceConnectionId, option)"
                    :placeholder="t('transfer.selectDatabase')"
                    :search-placeholder="t('transfer.searchDatabase')"
                    :empty-text="t('common.noResults')"
                    :disabled="!sourceDatabases.length"
                    trigger-variant="outline"
                    trigger-class="h-8 w-full justify-between text-xs"
                    content-class="w-[var(--reka-popover-trigger-width)]"
                  />
                </div>

                <div v-if="sourceSchemas.length" class="space-y-1.5">
                  <Label class="text-xs">{{ t("transfer.sourceSchema") }}</Label>
                  <SearchableSelect
                    v-model="sourceSchema"
                    :options="sourceSchemas"
                    :placeholder="t('transfer.selectSchema')"
                    :search-placeholder="t('transfer.searchSchema')"
                    :empty-text="t('common.noResults')"
                    trigger-variant="outline"
                    trigger-class="h-8 w-full justify-between text-xs"
                    content-class="w-[var(--reka-popover-trigger-width)]"
                  />
                </div>
              </div>

              <!-- Swap source / target -->
              <div class="flex items-center pt-8">
                <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('transfer.swap')" :aria-label="t('transfer.swap')" @click="swapSourceAndTarget">
                  <ArrowLeftRight class="w-3.5 h-3.5" />
                </Button>
              </div>

              <!-- Target Section -->
              <div class="space-y-3">
                <div class="text-sm font-medium text-green-500">
                  {{ t("transfer.target") }}
                </div>

                <div class="space-y-1.5">
                  <Label class="text-xs">{{ t("transfer.targetConnection") }}</Label>
                  <ConnectionTreeSelect
                    v-model="targetConnectionId"
                    :connections="sqlConnections"
                    :layout="store.sidebarLayout"
                    :placeholder="t('transfer.selectConnection')"
                    :search-placeholder="t('transfer.searchConnection')"
                    :empty-text="t('common.noResults')"
                    trigger-class="h-8 w-full max-w-none justify-between gap-1.5 border border-input rounded-md bg-transparent px-2.5 text-xs shadow-none hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50"
                    list-class="w-[var(--reka-popover-trigger-width)]"
                  />
                </div>

                <!-- Target Catalog (Doris/StarRocks multi-catalog) -->
                <div v-if="targetCatalogs.length > 1" class="space-y-1.5">
                  <Label class="text-xs">{{ t("transfer.targetCatalog") }}</Label>
                  <SearchableSelect
                    v-model="targetCatalog"
                    :options="targetCatalogs.map((c) => c.name)"
                    :placeholder="t('transfer.selectCatalog')"
                    :search-placeholder="t('transfer.searchCatalog')"
                    :empty-text="t('common.noResults')"
                    trigger-variant="outline"
                    trigger-class="h-8 w-full justify-between text-xs"
                    content-class="w-[var(--reka-popover-trigger-width)]"
                  />
                </div>

                <div class="space-y-1.5">
                  <Label class="text-xs">{{ t("transfer.targetDatabase") }}</Label>
                  <SearchableSelect
                    v-model="targetDatabase"
                    :options="targetDatabases"
                    :display-name="(option) => databaseOptionLabel(targetConnectionId, option)"
                    :placeholder="t('transfer.selectDatabase')"
                    :search-placeholder="t('transfer.searchDatabase')"
                    :empty-text="t('common.noResults')"
                    :disabled="!targetDatabases.length"
                    trigger-variant="outline"
                    trigger-class="h-8 w-full justify-between text-xs"
                    content-class="w-[var(--reka-popover-trigger-width)]"
                  />
                </div>

                <div v-if="targetSchemas.length" class="space-y-1.5">
                  <Label class="text-xs">{{ t("transfer.targetSchema") }}</Label>
                  <SearchableSelect
                    v-model="targetSchema"
                    :options="targetSchemas"
                    :placeholder="t('transfer.selectSchema')"
                    :search-placeholder="t('transfer.searchSchema')"
                    :empty-text="t('common.noResults')"
                    trigger-variant="outline"
                    trigger-class="h-8 w-full justify-between text-xs"
                    content-class="w-[var(--reka-popover-trigger-width)]"
                  />
                </div>
              </div>
            </div>

            <!-- Objects Section -->
            <div class="flex min-h-0 flex-col gap-2">
              <div class="flex items-center justify-between">
                <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {{ t("transfer.objects") }}
                  <span v-if="objectGroups.TABLE?.length" class="text-muted-foreground/60">({{ selectedTables.size }}/{{ objectGroups.TABLE.length }})</span>
                </div>
              </div>

              <div v-if="(!loadingObjects && !sourceConnectionId) || !sourceDatabase" class="text-xs text-muted-foreground py-4 text-center">
                {{ t("transfer.selectSourceFirst") }}
              </div>
              <ObjectSelectionTree v-model="treeSelection" :groups="treeGroups" :disabled-groups="treeDisabledGroups" :disabled-hints="treeDisabledHints" v-model:search="objectSearch" :loading="loadingObjects" class="min-h-0 flex-1" />
              <div v-if="showCrossFamilyViewHint" class="mt-1.5 rounded-md border border-amber-300/40 bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
                {{ t("transfer.crossFamilyViewHint") }}
              </div>
            </div>

            <!-- Options -->
            <div class="space-y-2.5">
              <div class="space-y-1">
                <Label class="text-xs">{{ t("transfer.content") }}</Label>
                <div class="flex flex-col gap-1">
                  <label class="flex cursor-pointer items-center gap-2 text-xs">
                    <input type="radio" value="structureAndData" v-model="transferContent" class="h-3.5 w-3.5" />
                    {{ t("transfer.contentStructureAndData") }}
                  </label>
                  <label class="flex cursor-pointer items-center gap-2 text-xs">
                    <input type="radio" value="structureOnly" v-model="transferContent" class="h-3.5 w-3.5" />
                    {{ t("transfer.contentStructureOnly") }}
                    <span class="text-muted-foreground/70">{{ t("transfer.contentStructureOnlyHint") }}</span>
                  </label>
                  <label class="flex cursor-pointer items-center gap-2 text-xs">
                    <input type="radio" value="dataOnly" v-model="transferContent" class="h-3.5 w-3.5" />
                    {{ t("transfer.contentDataOnly") }}
                    <span class="text-muted-foreground/70">{{ t("transfer.contentDataOnlyHint") }}</span>
                  </label>
                </div>
              </div>
              <div v-if="transferContent !== 'structureOnly'" class="flex items-center gap-3">
                <Label class="text-xs shrink-0">{{ t("transfer.dataWriteMode") }}</Label>
                <Select v-model="transferMode">
                  <SelectTrigger class="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="append">{{ t("transfer.modeAppend") }}</SelectItem>
                    <SelectItem value="overwrite">{{ t("transfer.modeOverwrite") }}</SelectItem>
                    <SelectItem value="upsert">{{ t("transfer.modeUpsert") }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="flex items-center gap-3">
                <Label class="text-xs shrink-0">{{ t("transfer.targetTableNameCase") }}</Label>
                <Select v-model="targetTableNameCase">
                  <SelectTrigger class="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="preserve">{{ t("transfer.tableNameCasePreserve") }}</SelectItem>
                    <SelectItem value="lower">{{ t("transfer.tableNameCaseLower") }}</SelectItem>
                    <SelectItem value="upper">{{ t("transfer.tableNameCaseUpper") }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="flex items-center gap-3">
                <Label class="text-xs shrink-0">{{ t("transfer.batchSize") }}</Label>
                <Input v-model.number="batchSize" type="number" min="100" max="10000" step="100" class="h-7 text-xs w-24" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <DialogFooter class="shrink-0">
        <Button variant="outline" size="sm" @click="open = false">
          {{ t("transfer.cancel") }}
        </Button>
        <Button variant="outline" size="sm" :disabled="!canSaveConfig || isSubmitting" @click="saveConfigTask">
          {{ activeTaskId ? t("transfer.saveConfig") : t("transfer.saveAsNewTask") }}
        </Button>
        <Button size="sm" :disabled="!canStart || isSubmitting" @click="requestStartTransfer">
          <Loader2 v-if="isSubmitting" class="w-3.5 h-3.5 mr-1.5 animate-spin" />
          <ArrowRightLeft v-else class="w-3.5 h-3.5 mr-1.5" />
          {{ t("transfer.start") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showUnsavedConfirm">
    <DialogContent class="sm:max-w-[400px]" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t("transfer.unsavedTitle") }}</DialogTitle>
        <DialogDescription>
          {{ t("transfer.unsavedMessage") }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter class="gap-2">
        <Button variant="outline" size="sm" @click="showUnsavedConfirm = false">
          {{ t("transfer.cancel") }}
        </Button>
        <Button variant="destructive" size="sm" @click="confirmDiscardChanges">
          {{ t("transfer.unsavedDiscard") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showStartConfirm">
    <DialogContent class="sm:max-w-[420px]" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t("transfer.startConfirmTitle") }}</DialogTitle>
        <DialogDescription>
          {{ t("transfer.startConfirmMessage", { source: startConfirmSource, target: startConfirmTarget, count: selectedObjectCount }) }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter class="gap-2">
        <Button variant="outline" size="sm" @click="showStartConfirm = false">
          {{ t("transfer.cancel") }}
        </Button>
        <Button size="sm" @click="confirmStartTransfer">
          {{ t("transfer.start") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="ownershipDialogOpen">
    <DialogContent class="sm:max-w-[520px]" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t("transfer.ownershipTitle") }}</DialogTitle>
      </DialogHeader>
      <div class="space-y-3 text-sm">
        <p class="text-muted-foreground">
          {{ t("transfer.ownershipMessage", { owners: ownershipMissingOwners.join(", ") }) }}
        </p>
        <div class="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {{ t("transfer.ownershipSkipDetails") }}
        </div>
        <div class="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {{ t("transfer.ownershipTargetOwner", { owner: ownershipTargetOwner }) }}
        </div>
      </div>
      <DialogFooter class="gap-2">
        <Button variant="outline" size="sm" @click="resolveOwnershipDecision(null)">
          {{ t("transfer.cancel") }}
        </Button>
        <Button variant="secondary" size="sm" @click="resolveOwnershipDecision('skip')">
          {{ t("transfer.ownershipSkip") }}
        </Button>
        <Button size="sm" @click="resolveOwnershipDecision('reassignMissing')">
          {{ t("transfer.ownershipConfirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style>
html.dbx-legacy-webview [data-slot="dialog-content"].dbx-transfer-dialog[class~="max-w-sm"] {
  /* Override the legacy default cap without pinning width, so native resize remains effective. */
  max-width: calc(100vw - 2rem) !important;
}
</style>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { uuid } from "@/lib/common/utils";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { buildTransferObjectSelections } from "./transferSelections";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import SearchableSelect from "@/components/ui/searchable-select/SearchableSelect.vue";
import ConnectionGroupBadge from "@/components/connection/ConnectionGroupBadge.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { connectionIconType } from "@/lib/connection/connectionPresentation";
import * as api from "@/lib/backend/api";
import type { TransferContent, TransferMode, TransferObjectKind, TransferTableNameCase } from "@/lib/backend/api";
import { crossFamilyTransferableKinds, isSameTransferFamily, transferObjectKindsForDatabase } from "@/lib/database/transferObjectKinds";
import ObjectSelectionTree from "@/components/transfer/ObjectSelectionTree.vue";
import type { DatabaseType } from "@/types/database";
import { isSchemaAware, supportsTransfer } from "@/lib/database/databaseCapabilities";
import { isDorisFamilyCatalogCapable } from "@/lib/database/databaseFeatureSupport";
import { isSameTransferDatabase, normalizeTransferCatalog } from "@/lib/database/dataTransferSelection";
import { databaseOptionsForConnection, fetchCatalogNamespaceOptions, fetchNamespaceOptionsForConnection, namespaceOptionsAreSchemas } from "@/composables/useDatabaseOptions";
import { useExportTracker } from "@/composables/useExportTracker";
import type { CatalogInfo } from "@/types/database";
import { ArrowRightLeft, ArrowLeftRight, Loader2 } from "@lucide/vue";

const { t } = useI18n();
const { startDataTransferTask } = useExportTracker();
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
const ownershipDialogOpen = ref(false);
const ownershipMissingOwners = ref<string[]>([]);
const ownershipTargetOwner = ref("");
const pendingOwnershipRequest = ref<api.TransferRequest | null>(null);
const pendingOwnershipRefresh = ref<{ shouldRefreshTargetTree: boolean } | null>(null);

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

const canStart = computed(() => {
  const effectiveSourceSchema = sourceSchema.value || sourceDatabase.value;
  const effectiveTargetSchema = targetSchema.value || targetDatabase.value;
  const sameCatalogAndDatabase = isSameTransferDatabase(
    { connectionId: sourceConnectionId.value, catalog: sourceCatalog.value, catalogs: sourceCatalogs.value, database: sourceDatabase.value },
    { connectionId: targetConnectionId.value, catalog: targetCatalog.value, catalogs: targetCatalogs.value, database: targetDatabase.value },
  );
  const sameSourceAndTarget = sameCatalogAndDatabase && effectiveSourceSchema === effectiveTargetSchema;
  return (
    !!sourceConnectionId.value &&
    !!sourceDatabase.value &&
    !!targetConnectionId.value &&
    !!targetDatabase.value &&
    (sourceCatalogs.value.length <= 1 || !!sourceCatalog.value) &&
    (targetCatalogs.value.length <= 1 || !!targetCatalog.value) &&
    (selectedTables.value.size > 0 || Object.values(selectedObjects.value).some((names) => names.size > 0)) &&
    !sameSourceAndTarget
  );
});

async function loadCatalogs(connectionId: string, side: "source" | "target") {
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
  try {
    const catalogs = await api.listDorisCatalogs(connectionId);
    if (side === "source") {
      sourceCatalogs.value = catalogs;
      sourceCatalog.value = catalogs.length === 1 ? catalogs[0].name : "";
    } else {
      targetCatalogs.value = catalogs;
      targetCatalog.value = catalogs.length === 1 ? catalogs[0].name : "";
    }
  } catch {
    if (side === "source") {
      sourceCatalogs.value = [];
      sourceCatalog.value = "";
    } else {
      targetCatalogs.value = [];
      targetCatalog.value = "";
    }
  }
}

async function loadDatabases(connectionId: string, target: "source" | "target") {
  if (!connectionId) return;
  try {
    await store.ensureConnected(connectionId);
    const config = store.getConfig(connectionId);
    if (!config) return;
    const names = isMongoConnection(connectionId) ? databaseOptionsForConnection(await api.mongoListDatabases(connectionId), config) : await fetchNamespaceOptionsForConnection(connectionId, config);
    if (target === "source") {
      sourceDatabases.value = names;
      sourceDatabase.value = names.length === 1 ? names[0] : "";
    } else {
      targetDatabases.value = names;
      targetDatabase.value = names.length === 1 ? names[0] : "";
    }
  } catch {
    if (target === "source") sourceDatabases.value = [];
    else targetDatabases.value = [];
  }
}

async function loadDatabasesForCatalog(connectionId: string, catalog: string, target: "source" | "target") {
  if (!connectionId || !catalog) return;
  try {
    await store.ensureConnected(connectionId);
    const config = store.getConfig(connectionId);
    if (!config) return;
    const names = await fetchCatalogNamespaceOptions(connectionId, catalog, config);
    if (target === "source") {
      sourceDatabases.value = names;
      sourceDatabase.value = names.length === 1 ? names[0] : "";
    } else {
      targetDatabases.value = names;
      targetDatabase.value = names.length === 1 ? names[0] : "";
    }
  } catch {
    if (target === "source") sourceDatabases.value = [];
    else targetDatabases.value = [];
  }
}

async function loadSchemas(connectionId: string, database: string, side: "source" | "target", preferredSchema = "") {
  if (!connectionId || !database) return;
  if (isMongoConnection(connectionId)) {
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
    const selected = preferredSchema && schemas.includes(preferredSchema) ? preferredSchema : schemas.includes("public") ? "public" : (schemas[0] ?? "");
    if (side === "source") {
      sourceSchemas.value = schemas;
      sourceSchema.value = selected;
    } else {
      targetSchemas.value = schemas;
      targetSchema.value = selected;
    }
  } catch {
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

async function loadObjects() {
  if (!sourceConnectionId.value || !sourceDatabase.value) {
    objectGroups.value = {};
    return;
  }
  loadingObjects.value = true;
  try {
    if (isMongoConnection(sourceConnectionId.value)) {
      const collections = await api.mongoListCollections(sourceConnectionId.value, sourceDatabase.value);
      objectGroups.value = { TABLE: collections.map((c) => c.name) };
      applyPendingTableSelection();
      return;
    }
    const config = store.getConfig(sourceConnectionId.value);
    const needsSchema = isSchemaAware(config?.db_type);
    const schema = needsSchema && sourceSchema.value ? sourceSchema.value : sourceDatabase.value;
    const catalog = sourceCatalog.value || undefined;
    const kinds = transferObjectKindsForDatabase(config?.db_type);
    const groups: Partial<Record<TransferObjectKind, string[]>> = {};
    for (const kind of kinds) {
      try {
        if (kind === "TABLE") {
          const tables = await api.listTables(sourceConnectionId.value, sourceDatabase.value, schema, undefined, undefined, undefined, undefined, catalog);
          groups.TABLE = tables.filter((t) => t.table_type === "TABLE" || t.table_type === "BASE TABLE").map((t) => t.name);
        } else {
          const objects = await api.listObjects(sourceConnectionId.value, sourceDatabase.value, schema, [kind], undefined, undefined, undefined, catalog);
          groups[kind] = objects.map((o) => o.name);
        }
      } catch {
        groups[kind] = [];
      }
    }
    objectGroups.value = groups;
    applyPendingTableSelection();
  } catch {
    objectGroups.value = {};
  } finally {
    loadingObjects.value = false;
  }
}

const skipSourceWatch = ref(false);
const skipTargetWatch = ref(false);

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
    if (sourceCatalog.value) {
      await loadDatabasesForCatalog(id, sourceCatalog.value, "source");
    }
  } else {
    await loadDatabases(id, "source");
  }
});

watch(sourceCatalog, async (catalog) => {
  if (!sourceConnectionId.value) return;
  sourceDatabase.value = "";
  objectGroups.value = {};
  selectedObjects.value = {};
  if (catalog) {
    await loadDatabasesForCatalog(sourceConnectionId.value, catalog, "source");
  }
});

watch(sourceDatabase, async (db) => {
  if (db) {
    const config = store.getConfig(sourceConnectionId.value);
    if (namespaceOptionsAreSchemas(config)) {
      // Dameng has no selectable catalog, so the top-level namespace option is
      // also the schema used for metadata lookup and qualified transfer SQL.
      sourceSchemas.value = [];
      sourceSchema.value = db;
    } else if (isSchemaAware(config?.db_type)) {
      await loadSchemas(sourceConnectionId.value, db, "source", pendingSourceSchemaPrefill.value);
      pendingSourceSchemaPrefill.value = "";
    } else {
      sourceSchema.value = db;
    }
  }
});

watch(sourceSchema, () => loadObjects());

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
    if (targetCatalog.value) {
      await loadDatabasesForCatalog(id, targetCatalog.value, "target");
    }
  } else {
    await loadDatabases(id, "target");
  }
});

watch(targetCatalog, async (catalog) => {
  if (!targetConnectionId.value) return;
  targetDatabase.value = "";
  targetSchemas.value = [];
  targetSchema.value = "";
  if (catalog) {
    await loadDatabasesForCatalog(targetConnectionId.value, catalog, "target");
  }
});

watch(targetDatabase, async (db) => {
  if (db) {
    const config = store.getConfig(targetConnectionId.value);
    if (namespaceOptionsAreSchemas(config)) {
      targetSchemas.value = [];
      targetSchema.value = db;
    } else if (isSchemaAware(config?.db_type)) {
      await loadSchemas(targetConnectionId.value, db, "target", pendingTargetSchemaPrefill.value);
      pendingTargetSchemaPrefill.value = "";
    } else {
      targetSchema.value = db;
    }
  }
});

watch(
  open,
  async (val) => {
    if (val) {
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
        if (props.prefillDatabase) sourceDatabase.value = props.prefillDatabase;
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
        if (props.prefillTargetDatabase) targetDatabase.value = props.prefillTargetDatabase;
      }
    }
  },
  { immediate: true },
);

function resetState() {
  sourceConnectionId.value = "";
  sourceCatalog.value = "";
  sourceCatalogs.value = [];
  sourceDatabase.value = "";
  sourceDatabases.value = [];
  sourceSchemas.value = [];
  sourceSchema.value = "";
  objectGroups.value = {};
  selectedObjects.value = {};
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
  ownershipDialogOpen.value = false;
  ownershipMissingOwners.value = [];
  ownershipTargetOwner.value = "";
  pendingOwnershipRequest.value = null;
  pendingOwnershipRefresh.value = null;
}

async function startTransfer() {
  if (!canStart.value || isSubmitting.value) return;
  isSubmitting.value = true;

  const effectiveSourceSchema = sourceSchema.value || sourceDatabase.value;
  const effectiveTargetSchema = targetSchema.value || targetDatabase.value;
  const sourceDatabaseName = sourceDatabase.value;
  const targetConnection = targetConnectionId.value;
  const targetDatabaseName = targetDatabase.value;
  const shouldRefreshTargetTree = transferContent.value !== "dataOnly";

  const request: api.TransferRequest = {
    transferId: uuid(),
    sourceConnectionId: sourceConnectionId.value,
    sourceDatabase: sourceDatabaseName,
    sourceSchema: effectiveSourceSchema,
    sourceCatalog: normalizeTransferCatalog(sourceCatalog.value, sourceCatalogs.value) || undefined,
    targetConnectionId: targetConnection,
    targetDatabase: targetDatabaseName,
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
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[780px] max-h-[80vh] flex flex-col overflow-hidden" @interact-outside.prevent>
      <DialogHeader class="shrink-0">
        <DialogTitle class="flex items-center gap-2">
          <ArrowRightLeft class="w-4 h-4" />
          {{ t("transfer.title") }}
        </DialogTitle>
      </DialogHeader>

      <div class="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-thin">
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
                <SearchableSelect
                  v-model="sourceConnectionId"
                  :options="sqlConnections.map((c) => c.id)"
                  :placeholder="t('transfer.selectConnection')"
                  :search-placeholder="t('transfer.searchConnection')"
                  :empty-text="t('common.noResults')"
                  :display-name="getConnectionName"
                  trigger-variant="outline"
                  trigger-class="h-8 w-full justify-between text-xs"
                  content-class="w-[var(--reka-popover-trigger-width)]"
                >
                  <template #option-label="{ option, label }">
                    <div class="flex min-w-0 items-center gap-1.5">
                      <DatabaseIcon :db-type="connectionIconType(sqlConnections.find((c) => c.id === option))" class="h-3.5 w-3.5 shrink-0" />
                      <ConnectionGroupBadge :connection-id="option" />
                      <span class="min-w-0 flex-1 truncate">{{ label }}</span>
                    </div>
                  </template>
                </SearchableSelect>
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

            <!-- Arrow -->
            <div class="flex items-center pt-8">
              <ArrowLeftRight class="w-5 h-5 text-muted-foreground" />
            </div>

            <!-- Target Section -->
            <div class="space-y-3">
              <div class="text-sm font-medium text-green-500">
                {{ t("transfer.target") }}
              </div>

              <div class="space-y-1.5">
                <Label class="text-xs">{{ t("transfer.targetConnection") }}</Label>
                <SearchableSelect
                  v-model="targetConnectionId"
                  :options="sqlConnections.map((c) => c.id)"
                  :placeholder="t('transfer.selectConnection')"
                  :search-placeholder="t('transfer.searchConnection')"
                  :empty-text="t('common.noResults')"
                  :display-name="getConnectionName"
                  trigger-variant="outline"
                  trigger-class="h-8 w-full justify-between text-xs"
                  content-class="w-[var(--reka-popover-trigger-width)]"
                >
                  <template #option-label="{ option, label }">
                    <div class="flex min-w-0 items-center gap-1.5">
                      <DatabaseIcon :db-type="connectionIconType(sqlConnections.find((c) => c.id === option))" class="h-3.5 w-3.5 shrink-0" />
                      <ConnectionGroupBadge :connection-id="option" />
                      <span class="min-w-0 flex-1 truncate">{{ label }}</span>
                    </div>
                  </template>
                </SearchableSelect>
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

      <DialogFooter class="shrink-0">
        <Button variant="outline" size="sm" @click="open = false">
          {{ t("transfer.cancel") }}
        </Button>
        <Button size="sm" :disabled="!canStart || isSubmitting" @click="startTransfer">
          <Loader2 v-if="isSubmitting" class="w-3.5 h-3.5 mr-1.5 animate-spin" />
          <ArrowRightLeft v-else class="w-3.5 h-3.5 mr-1.5" />
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

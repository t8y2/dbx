<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { emptyAnnotations } from "@/docs/annotationEdits";
import type { SchemaSnapshot, SnapshotWarning, TableKind } from "@/docs/types";
import * as api from "@/lib/backend/api";
import { isSchemaAware } from "@/lib/database/databaseFeatureSupport";
import type { SidebarObjectKind } from "@/lib/database/databaseObjectCapabilities";
import {
  applyTemplate,
  dataDictionaryFileName,
  dictionaryCatalogNames,
  exportBlockedBySkippedTables,
  isDictionaryProfile,
  objectKey,
  orderDictionaryTables,
  resolveDictionaryExportPath,
  tableKindFrom,
  warningsForSelection,
  toggleOrderedKey,
  moveOrderedKey,
  type DataDictionaryLabels,
  type DictionaryLayout,
  type DictionaryObjectRef,
  type DictionaryProfile,
  type DictionaryTable,
  type DictionaryTemplateId,
} from "@/lib/docs/dataDictionary";
import { buildDataDictionaryPdf } from "@/lib/docs/dataDictionaryPdf";
import { DictionaryFileExistsError, chooseDataDictionaryPath } from "@/lib/docs/saveDataDictionaryFile";
import { hasActiveDictionaryExport, startDataDictionaryExport } from "@/lib/docs/dataDictionaryExportTask";
import { useToast } from "@/composables/useToast";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useConnectionStore } from "@/stores/connectionStore";

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  prefillTableNames?: string[];
  snapshot?: SchemaSnapshot | null;
}>();

const open = defineModel<boolean>("open", { default: false });
const { t } = useI18n();
const connectionStore = useConnectionStore();
const { toast } = useToast();

const step = ref(0);
const loading = ref(false);
const exporting = ref(false);
const loadError = ref<string | null>(null);
const exportError = ref<string | null>(null);
const databases = ref<Array<{ name: string; checked: boolean }>>([]);
const schemas = ref<Array<{ database: string; name: string; checked: boolean }>>([]);
const objects = ref<DictionaryObjectRef[]>([]);
const order = ref<string[]>([]);
const objectSearch = ref("");
const templateId = ref<DictionaryTemplateId>("standard");
const layout = ref<DictionaryLayout>(blankLayout());
const appendTimestamp = ref(false);
const overwrite = ref(true);
const continueOnError = ref(true);
const outputPath = ref("");
const previewUrl = ref("");
let generation = 0;

const steps = computed(() => [t("dataDictionary.stepDatabases"), t("dataDictionary.stepObjects"), t("dataDictionary.stepTemplate"), t("dataDictionary.stepLayout"), t("dataDictionary.stepFile")]);
const dbType = computed(() => connectionStore.getConfig(props.prefillConnectionId || "")?.db_type);
const schemaAware = computed(() => isSchemaAware(dbType.value));
const checkedDatabases = computed(() => databases.value.filter((item) => item.checked).map((item) => item.name));
const checkedSchemas = computed(() => schemas.value.filter((item) => item.checked && checkedDatabases.value.includes(item.database)));
const filteredObjects = computed(() => {
  const query = objectSearch.value.trim().toLowerCase();
  return objects.value.filter((item) => !query || `${item.database} ${item.schema} ${item.name}`.toLowerCase().includes(query));
});
const orderedObjects = computed(() => order.value.flatMap((key) => objects.value.filter((item) => objectKey(item) === key)));
const canNext = computed(() => {
  if (loading.value) return false;
  if (step.value === 0) return checkedDatabases.value.length > 0 && (!schemaAware.value || checkedSchemas.value.length > 0 || schemas.value.length === 0);
  if (step.value === 1) return order.value.length > 0;
  return true;
});

function blankLayout(): DictionaryLayout {
  return applyTemplate("standard", { title: "", introduction: "", detailedIntroduction: "", leftFooter: "" });
}

function labels(): DataDictionaryLabels {
  return {
    column: t("dataDictionary.column"),
    type: t("dataDictionary.type"),
    length: t("dataDictionary.length"),
    precision: t("dataDictionary.precision"),
    scale: t("dataDictionary.scale"),
    primaryKey: t("dataDictionary.primaryKey"),
    nullable: t("dataDictionary.nullable"),
    unique: t("dataDictionary.unique"),
    defaultValue: t("dataDictionary.defaultValue"),
    extra: t("dataDictionary.extra"),
    comment: t("dataDictionary.comment"),
    indexName: t("dataDictionary.indexName"),
    indexColumns: t("dataDictionary.indexColumns"),
    indexType: t("dataDictionary.indexType"),
    constraintName: t("dataDictionary.constraintName"),
    refSchema: t("dataDictionary.refSchema"),
    refTable: t("dataDictionary.refTable"),
    refColumn: t("dataDictionary.refColumn"),
    onUpdate: t("dataDictionary.onUpdate"),
    onDelete: t("dataDictionary.onDelete"),
    yes: t("dataDictionary.yes"),
    no: t("dataDictionary.no"),
    indexesHeading: t("dataDictionary.indexesHeading"),
    foreignKeysHeading: t("dataDictionary.foreignKeysHeading"),
    contentsHeading: t("dataDictionary.contentsHeading"),
    kindTable: t("dataDictionary.kindTable"),
    kindView: t("dataDictionary.kindView"),
    kindMaterializedView: t("dataDictionary.kindMaterializedView"),
  };
}

function kindLabel(kind: TableKind): string {
  if (kind === "VIEW") return t("dataDictionary.kindView");
  if (kind === "MATERIALIZED_VIEW") return t("dataDictionary.kindMaterializedView");
  return t("dataDictionary.kindTable");
}

function objectLabel(item: DictionaryObjectRef): string {
  const schema = item.schema ? `${item.schema}.` : "";
  return `${item.database}.${schema}${item.name}`;
}

function warningText(warning: SnapshotWarning): string {
  switch (warning.kind) {
    case "tableSkipped":
      return t("dataDictionary.warningTableSkipped", { table: warning.table, reason: warning.reason });
    case "noForeignKeyMetadata":
      return t("dataDictionary.warningNoForeignKeys", { engine: warning.engine });
    case "commentsUnsupported":
      return t("dataDictionary.warningCommentsUnsupported", { engine: warning.engine });
    default:
      return "";
  }
}

function chooseTemplate(id: DictionaryTemplateId): void {
  templateId.value = id;
  const title = checkedDatabases.value.join(", ") || props.prefillDatabase || "Data Dictionary";
  layout.value = applyTemplate(id, {
    title,
    introduction: t("dataDictionary.introductionDefault"),
    detailedIntroduction: `${t("dataDictionary.introductionDefault")}\n${t("dataDictionary.detailedIntroduction")}`,
    leftFooter: title,
  });
}

async function loadDatabases(): Promise<void> {
  const mine = ++generation;
  loading.value = true;
  loadError.value = null;
  databases.value = [];
  schemas.value = [];
  try {
    const connectionId = props.prefillConnectionId;
    if (!connectionId) throw new Error(t("dataDictionary.empty"));
    await connectionStore.ensureConnected(connectionId);
    if (mine !== generation) return;
    const listed = await api.listDatabases(connectionId);
    if (mine !== generation) return;
    const names = dictionaryCatalogNames(
      listed.map((item) => item.name).filter((name) => name !== ""),
      dbType.value,
      props.prefillDatabase,
    );
    const preferred = props.prefillDatabase && names.includes(props.prefillDatabase) ? props.prefillDatabase : names[0];
    databases.value = (names.length ? names : [props.prefillDatabase || ""].filter(Boolean)).map((name) => ({ name, checked: name === preferred }));
    await loadSchemas();
  } catch (error) {
    if (mine === generation) loadError.value = t("dataDictionary.loadFailed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    if (mine === generation) loading.value = false;
  }
}

async function toggleDatabase(item: { name: string; checked: boolean }, checked: boolean): Promise<void> {
  item.checked = checked;
  await loadSchemas();
}

async function loadSchemas(): Promise<void> {
  if (!schemaAware.value) {
    schemas.value = [];
    return;
  }
  const connectionId = props.prefillConnectionId;
  if (!connectionId) return;
  const previous = new Set(schemas.value.filter((item) => item.checked).map((item) => `${item.database}.${item.name}`));
  const firstLoad = schemas.value.length === 0;
  const next: Array<{ database: string; name: string; checked: boolean }> = [];
  for (const database of checkedDatabases.value) {
    const names = dictionaryCatalogNames(await api.listSchemas(connectionId, database), dbType.value, database === props.prefillDatabase ? props.prefillSchema : undefined);
    for (const name of names) {
      const key = `${database}.${name}`;
      const prefilled = !props.prefillSchema || (database === props.prefillDatabase && name === props.prefillSchema);
      next.push({ database, name, checked: firstLoad ? prefilled : previous.has(key) });
    }
  }
  if (firstLoad && props.prefillSchema && next.length > 0 && !next.some((item) => item.checked)) next.forEach((item) => (item.checked = true));
  schemas.value = next;
}

async function loadObjects(): Promise<void> {
  const connectionId = props.prefillConnectionId;
  if (!connectionId) return;
  loading.value = true;
  loadError.value = null;
  try {
    const targets = schemaAware.value ? checkedSchemas.value.map((item) => ({ database: item.database, schema: item.name })) : checkedDatabases.value.map((database) => ({ database, schema: "" }));
    const listed: DictionaryObjectRef[] = [];
    for (const target of targets) {
      const tables = await api.listTables(connectionId, target.database, target.schema, undefined, undefined, undefined, ["TABLE", "VIEW", "MATERIALIZED_VIEW"] satisfies SidebarObjectKind[]);
      for (const table of tables) {
        listed.push({ database: target.database, schema: target.schema || table.parent_schema || "", name: table.name, kind: tableKindFrom(table.table_type) });
      }
    }
    objects.value = listed;
    const wanted = new Set(props.prefillTableNames ?? []);
    const initial = listed.filter((item) => (wanted.size > 0 ? wanted.has(item.name) : item.kind === "TABLE"));
    order.value = (initial.length ? initial : listed).map(objectKey);
  } catch (error) {
    loadError.value = t("dataDictionary.loadFailed", { error: error instanceof Error ? error.message : String(error) });
    objects.value = [];
    order.value = [];
  } finally {
    loading.value = false;
  }
}

async function collectSelection(): Promise<{ tables: DictionaryTable[]; warnings: string[] }> {
  const connectionId = props.prefillConnectionId;
  if (!connectionId) throw new Error(t("dataDictionary.empty"));
  const warnings: string[] = [];
  const tables: DictionaryTable[] = [];
  if (props.snapshot) {
    const database = props.snapshot.project.database || props.prefillDatabase || "";
    const fromSnapshot = orderDictionaryTables(
      props.snapshot.tables.map((table) => ({ ...table, database })),
      order.value,
    );
    if (fromSnapshot.length === order.value.length) {
      const relevant = warningsForSelection(props.snapshot.warnings, orderedObjects.value);
      if (exportBlockedBySkippedTables(relevant, continueOnError.value)) {
        throw new Error(relevant.map(warningText).find(Boolean) || database);
      }
      return { tables: fromSnapshot, warnings: relevant.map(warningText).filter(Boolean) };
    }
  }
  for (const database of checkedDatabases.value) {
    const schemaNames = schemaAware.value ? checkedSchemas.value.filter((item) => item.database === database).map((item) => item.name) : [];
    const tableNames = orderedObjects.value.filter((item) => item.database === database).map((item) => (item.schema ? `${item.schema}.${item.name}` : item.name));
    if (tableNames.length === 0) continue;
    try {
      const raw = await api.collectDocsSnapshot(connectionId, database, schemaNames, tableNames, database);
      const file = (await api.loadDocsAnnotations(connectionId)) ?? emptyAnnotations();
      const merged = await api.applyDocsAnnotations(connectionId, raw, file);
      const relevant = warningsForSelection(merged.warnings, orderedObjects.value);
      if (exportBlockedBySkippedTables(relevant, continueOnError.value)) throw new Error(relevant.map(warningText).find(Boolean) || database);
      warnings.push(...relevant.map(warningText).filter(Boolean));
      tables.push(...merged.tables.map((table) => ({ ...table, database })));
    } catch (error) {
      if (!continueOnError.value) throw error;
      warnings.push(t("dataDictionary.warningTableSkipped", { table: database, reason: error instanceof Error ? error.message : String(error) }));
    }
  }
  return { tables: orderDictionaryTables(tables, order.value), warnings };
}

async function refreshPreview(): Promise<void> {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = "";
  try {
    const document = await collectSelection();
    const bytes = buildDataDictionaryPdf(document.tables, labels(), layout.value, document.warnings);
    previewUrl.value = URL.createObjectURL(new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: "application/pdf" }));
  } catch (error) {
    exportError.value = t("dataDictionary.previewFailed", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function goNext(): Promise<void> {
  exportError.value = null;
  if (step.value === 0) {
    await loadObjects();
    if (loadError.value || order.value.length === 0) return;
    chooseTemplate(templateId.value);
  }
  if (step.value === 1 && order.value.length === 0) return;
  const enteringLayout = step.value === 2;
  if (step.value < 4) step.value += 1;
  if (enteringLayout) await refreshPreview();
}

async function browse(): Promise<void> {
  if (!isTauriRuntime()) return;
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: dataDictionaryFileName(checkedDatabases.value[0] || "DataDictionary", appendTimestamp.value), filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (path) outputPath.value = path;
}

async function exportDictionary(): Promise<void> {
  const connectionId = props.prefillConnectionId;
  if (!connectionId) return;
  if (hasActiveDictionaryExport(connectionId)) {
    exportError.value = t("dataDictionary.alreadyRunning");
    return;
  }
  exporting.value = true;
  exportError.value = null;
  try {
    const fallback = dataDictionaryFileName(checkedDatabases.value[0] || "DataDictionary", false);
    const suggested = resolveDictionaryExportPath(outputPath.value, fallback, appendTimestamp.value);
    const path = await chooseDataDictionaryPath(suggested);
    if (!path) return;
    const started = startDataDictionaryExport({
      connectionId,
      databases: [...checkedDatabases.value],
      schemas: checkedSchemas.value.map((item) => ({ database: item.database, name: item.name })),
      objects: orderedObjects.value.map((item) => ({ ...item })),
      snapshot: props.snapshot,
      layout: { ...layout.value },
      labels: labels(),
      outputPath: path,
      overwrite: overwrite.value,
      continueOnError: continueOnError.value,
      warningText: (warning) => warningText(warning),
      skippedDatabase: (database, reason) => t("dataDictionary.warningTableSkipped", { table: database, reason }),
      missingObject: (object) => t("dataDictionary.warningTableSkipped", { table: objectLabel(object), reason: t("dataDictionary.objectUnavailable") }),
      onSuccess: (saved, warnings) => toast(t("dataDictionary.backgroundDone", { path: saved }) + (warnings ? ` · ${t("dataDictionary.warningCount", { count: warnings })}` : ""), 8000),
      onFailure: (error) => toast(t("dataDictionary.backgroundFailed", { error: error instanceof DictionaryFileExistsError ? t("dataDictionary.fileExists") : error instanceof Error ? error.message : String(error) }), 8000),
    });
    if (!started) throw new Error(t("dataDictionary.alreadyRunning"));
    toast(t("dataDictionary.backgroundStarted"));
    open.value = false;
  } catch (error) {
    exportError.value = error instanceof DictionaryFileExistsError ? t("dataDictionary.fileExists") : t("dataDictionary.exportFailed", { error: error instanceof Error ? error.message : String(error) });
  } finally {
    exporting.value = false;
  }
}

function profilePayload(): DictionaryProfile {
  return {
    version: 1,
    databases: checkedDatabases.value,
    schemas: checkedSchemas.value.map((item) => ({ database: item.database, name: item.name })),
    objects: orderedObjects.value.map((item) => ({ database: item.database, schema: item.schema, name: item.name })),
    layout: layout.value,
    appendTimestamp: appendTimestamp.value,
    overwrite: overwrite.value,
    continueOnError: continueOnError.value,
    fileName: outputPath.value,
  };
}

async function saveProfile(): Promise<void> {
  const content = JSON.stringify(profilePayload(), null, 2);
  if (isTauriRuntime()) {
    const [{ save }, fs] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
    const path = await save({ defaultPath: "data-dictionary.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (path) await fs.writeTextFile(path, content);
    return;
  }
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "data-dictionary.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

async function loadProfile(): Promise<void> {
  try {
    const text = isTauriRuntime() ? await readProfileFromDialog() : await readProfileFromBrowser();
    if (!text) return;
    const parsed: unknown = JSON.parse(text);
    if (!isDictionaryProfile(parsed)) throw new Error(t("dataDictionary.profileInvalid"));
    layout.value = parsed.layout;
    appendTimestamp.value = parsed.appendTimestamp;
    overwrite.value = parsed.overwrite;
    continueOnError.value = parsed.continueOnError;
    outputPath.value = parsed.fileName;
    databases.value = databases.value.map((item) => ({ ...item, checked: parsed.databases.includes(item.name) }));
    await loadSchemas();
    schemas.value = schemas.value.map((item) => ({ ...item, checked: parsed.schemas.some((schema) => schema.database === item.database && schema.name === item.name) }));
    await loadObjects();
    order.value = parsed.objects.map((item) => objectKey(item)).filter((key) => objects.value.some((item) => objectKey(item) === key));
  } catch (error) {
    loadError.value = t("dataDictionary.loadFailed", { error: error instanceof Error ? error.message : String(error) });
  }
}

async function readProfileFromDialog(): Promise<string | null> {
  const [{ open: pick }, fs] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
  const path = await pick({ filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!path || Array.isArray(path)) return null;
  return fs.readTextFile(path);
}

function readProfileFromBrowser(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      void file.text().then(resolve);
    };
    input.click();
  });
}

function setFontSize(size: "small" | "medium" | "large"): void {
  const scale = size === "small" ? 0.85 : size === "large" ? 1.15 : 1;
  layout.value = { ...layout.value, headingSize: Math.round(16 * scale), bodySize: Math.round(9 * scale) };
}

watch(
  open,
  (isOpen) => {
    if (!isOpen) {
      generation += 1;
      if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
      previewUrl.value = "";
      return;
    }
    step.value = 0;
    exportError.value = null;
    outputPath.value = "";
    appendTimestamp.value = false;
    overwrite.value = true;
    continueOnError.value = true;
    templateId.value = "standard";
    void loadDatabases();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  generation += 1;
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
});
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="flex h-[min(760px,88vh)] w-[min(980px,94vw)] max-w-[94vw] flex-col gap-0 p-0 sm:max-w-[94vw]">
      <DialogHeader class="border-b px-4 py-3 pr-12">
        <DialogTitle>{{ t("dataDictionary.title") }}</DialogTitle>
        <DialogDescription>{{ steps[step] }}</DialogDescription>
      </DialogHeader>

      <div class="flex items-center gap-2 border-b px-4 py-2 text-xs">
        <span v-for="(label, index) in steps" :key="label" :class="index === step ? 'font-medium text-foreground' : 'text-muted-foreground'">{{ index + 1 }}. {{ label }}</span>
        <span class="ml-auto flex gap-2">
          <Button type="button" size="sm" variant="outline" @click="loadProfile()">{{ t("dataDictionary.loadProfile") }}</Button>
          <Button type="button" size="sm" variant="outline" @click="saveProfile()">{{ t("dataDictionary.saveProfile") }}</Button>
        </span>
      </div>

      <div class="min-h-0 flex-1 overflow-auto p-4">
        <p v-if="loading" class="text-sm text-muted-foreground">{{ t("dataDictionary.loading") }}</p>
        <p v-if="loadError" class="mb-2 text-sm text-destructive">{{ loadError }}</p>

        <div v-if="step === 0" class="grid gap-4 md:grid-cols-2">
          <section>
            <h3 class="mb-2 text-sm font-medium">{{ t("dataDictionary.databases") }}</h3>
            <label v-for="item in databases" :key="item.name" class="flex items-center gap-2 py-1 text-sm">
              <input type="checkbox" :checked="item.checked" @change="toggleDatabase(item, ($event.target as HTMLInputElement).checked)" />
              <span>{{ item.name }}</span>
            </label>
          </section>
          <section v-if="schemaAware">
            <h3 class="mb-2 text-sm font-medium">{{ t("dataDictionary.schemasHeading") }}</h3>
            <p v-if="schemas.length === 0" class="text-sm text-muted-foreground">{{ t("dataDictionary.noSchemaLevel") }}</p>
            <label v-for="item in schemas" :key="`${item.database}.${item.name}`" class="flex items-center gap-2 py-1 text-sm">
              <input v-model="item.checked" type="checkbox" />
              <span>{{ item.database }}.{{ item.name }}</span>
            </label>
          </section>
        </div>

        <div v-else-if="step === 1" class="grid h-full gap-3 md:grid-cols-2">
          <section class="flex min-h-0 flex-col gap-2">
            <div class="flex gap-2">
              <Input v-model="objectSearch" :placeholder="t('dataDictionary.searchObjects')" />
              <Button type="button" size="sm" variant="outline" @click="order = filteredObjects.map(objectKey)">{{ t("dataDictionary.selectAll") }}</Button>
              <Button type="button" size="sm" variant="outline" @click="order = order.filter((key) => !filteredObjects.some((item) => objectKey(item) === key))">{{ t("dataDictionary.selectNone") }}</Button>
            </div>
            <div class="min-h-0 flex-1 overflow-auto rounded border">
              <label v-for="item in filteredObjects" :key="objectKey(item)" class="flex items-center gap-2 border-b px-2 py-1 text-sm">
                <input type="checkbox" :checked="order.includes(objectKey(item))" @change="order = toggleOrderedKey(order, objectKey(item), ($event.target as HTMLInputElement).checked)" />
                <span class="min-w-0 flex-1 truncate">{{ objectLabel(item) }}</span>
                <span class="text-xs text-muted-foreground">{{ kindLabel(item.kind) }}</span>
              </label>
            </div>
          </section>
          <section>
            <h3 class="mb-2 text-sm font-medium">{{ t("dataDictionary.selectedCount", { count: order.length }) }}</h3>
            <div class="max-h-[420px] overflow-auto rounded border">
              <div v-for="item in orderedObjects" :key="objectKey(item)" class="flex items-center gap-2 border-b px-2 py-1 text-sm">
                <span class="min-w-0 flex-1 truncate">{{ objectLabel(item) }}</span>
                <Button type="button" size="sm" variant="outline" @click="order = moveOrderedKey(order, objectKey(item), -1)">{{ t("dataDictionary.moveUp") }}</Button>
                <Button type="button" size="sm" variant="outline" @click="order = moveOrderedKey(order, objectKey(item), 1)">{{ t("dataDictionary.moveDown") }}</Button>
              </div>
            </div>
          </section>
        </div>

        <div v-else-if="step === 2" class="grid gap-2">
          <button v-for="id in ['standard', 'detailed', 'compact', 'catalog', 'reference']" :key="id" type="button" class="rounded border px-3 py-2 text-left" :class="templateId === id ? 'border-foreground bg-muted' : 'border-border'" @click="chooseTemplate(id as DictionaryTemplateId)">
            <span class="block text-sm font-medium">{{ t(`dataDictionary.template${id[0]!.toUpperCase()}${id.slice(1)}`) }}</span>
            <span class="text-xs text-muted-foreground">{{ t(`dataDictionary.template${id[0]!.toUpperCase()}${id.slice(1)}Hint`) }}</span>
          </button>
        </div>

        <div v-else-if="step === 3" class="grid h-full gap-3 md:grid-cols-[280px_minmax(0,1fr)]">
          <div class="flex flex-col gap-3 overflow-auto pr-1">
            <label class="flex items-center justify-between gap-2 text-sm"
              ><span>{{ t("dataDictionary.includeCover") }}</span
              ><input v-model="layout.includeCover" type="checkbox"
            /></label>
            <Label>{{ t("dataDictionary.header") }}</Label>
            <Input v-model="layout.header" />
            <Label>{{ t("dataDictionary.dictionaryTitle") }}</Label>
            <Input v-model="layout.title" />
            <Label>{{ t("dataDictionary.subtitle") }}</Label>
            <Input v-model="layout.subtitle" />
            <Label>{{ t("dataDictionary.remarks") }}</Label>
            <Input v-model="layout.remarks" />
            <Label>{{ t("dataDictionary.coverFooter") }}</Label>
            <Input v-model="layout.coverFooter" />
            <label class="flex items-center justify-between gap-2 text-sm"
              ><span>{{ t("dataDictionary.includeToc") }}</span
              ><input v-model="layout.includeToc" type="checkbox"
            /></label>
            <label class="flex items-center justify-between gap-2 text-sm"
              ><span>{{ t("dataDictionary.includeBreadcrumbs") }}</span
              ><input v-model="layout.includeBreadcrumbs" type="checkbox"
            /></label>
            <label class="flex items-center justify-between gap-2 text-sm"
              ><span>{{ t("dataDictionary.includeLeftFooter") }}</span
              ><input v-model="layout.includeLeftFooter" type="checkbox"
            /></label>
            <Input v-model="layout.leftFooter" />
            <label class="flex items-center justify-between gap-2 text-sm"
              ><span>{{ t("dataDictionary.includePageNumber") }}</span
              ><input v-model="layout.includePageNumber" type="checkbox"
            /></label>
            <label class="flex items-center justify-between gap-2 text-sm"
              ><span>{{ t("dataDictionary.includeIntroduction") }}</span
              ><input v-model="layout.includeIntroduction" type="checkbox"
            /></label>
            <textarea v-model="layout.introduction" class="min-h-24 rounded border bg-transparent p-2 text-sm" />
            <label class="flex items-center justify-between gap-2 text-sm"
              ><span>{{ t("dataDictionary.includeIndexes") }}</span
              ><input v-model="layout.includeIndexesAndForeignKeys" type="checkbox"
            /></label>
            <Label>{{ t("dataDictionary.paper") }}</Label>
            <select v-model="layout.paper" class="rounded border bg-transparent px-2 py-1 text-sm">
              <option value="A4">A4</option>
              <option value="A3">A3</option>
              <option value="Letter">Letter</option>
              <option value="Legal">Legal</option>
            </select>
            <Label>{{ t("dataDictionary.orientation") }}</Label>
            <select v-model="layout.orientation" class="rounded border bg-transparent px-2 py-1 text-sm">
              <option value="portrait">{{ t("dataDictionary.portrait") }}</option>
              <option value="landscape">{{ t("dataDictionary.landscape") }}</option>
            </select>
            <Label>{{ t("dataDictionary.margin") }}</Label>
            <Input v-model.number="layout.marginCm" type="number" min="0.5" max="4" step="0.1" />
            <Label>{{ t("dataDictionary.fontSize") }}</Label>
            <select class="rounded border bg-transparent px-2 py-1 text-sm" @change="setFontSize(($event.target as HTMLSelectElement).value as 'small' | 'medium' | 'large')">
              <option value="medium">{{ t("dataDictionary.fontMedium") }}</option>
              <option value="small">{{ t("dataDictionary.fontSmall") }}</option>
              <option value="large">{{ t("dataDictionary.fontLarge") }}</option>
            </select>
            <Button type="button" variant="outline" @click="refreshPreview()">{{ t("dataDictionary.preview") }}</Button>
          </div>
          <iframe v-if="previewUrl" :src="previewUrl" class="h-full min-h-80 w-full rounded border" :title="t('dataDictionary.preview')" />
          <p v-else class="text-sm text-muted-foreground">{{ t("dataDictionary.preview") }}</p>
        </div>

        <div v-else class="flex max-w-xl flex-col gap-3">
          <Label>{{ t("dataDictionary.exportToFile") }}</Label>
          <div class="flex gap-2">
            <Input v-model="outputPath" :placeholder="dataDictionaryFileName(checkedDatabases[0] || 'DataDictionary', appendTimestamp)" />
            <Button v-if="isTauriRuntime()" type="button" variant="outline" @click="browse()">{{ t("dataDictionary.browse") }}</Button>
          </div>
          <label class="flex items-center justify-between gap-2 text-sm"
            ><span>{{ t("dataDictionary.appendTimestamp") }}</span
            ><input v-model="appendTimestamp" type="checkbox"
          /></label>
          <label class="flex items-center justify-between gap-2 text-sm"
            ><span>{{ t("dataDictionary.overwriteExisting") }}</span
            ><input v-model="overwrite" type="checkbox"
          /></label>
          <label class="flex items-center justify-between gap-2 text-sm"
            ><span>{{ t("dataDictionary.continueOnError") }}</span
            ><input v-model="continueOnError" type="checkbox"
          /></label>
          <p v-if="exporting" class="text-sm text-muted-foreground">{{ t("dataDictionary.exporting") }}</p>
          <p v-if="exportError" class="text-sm text-destructive">{{ exportError }}</p>
        </div>
      </div>

      <DialogFooter class="border-t px-4 py-3">
        <Button v-if="step > 0" type="button" variant="outline" @click="step -= 1">{{ t("dataDictionary.back") }}</Button>
        <Button v-if="step < 4" type="button" :disabled="!canNext" @click="goNext()">{{ t("dataDictionary.next") }}</Button>
        <Button v-else type="button" :disabled="exporting || order.length === 0" @click="exportDictionary()">{{ exporting ? t("dataDictionary.exporting") : t("dataDictionary.start") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

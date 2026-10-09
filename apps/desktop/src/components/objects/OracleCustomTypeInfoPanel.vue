<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Copy, RefreshCw, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { createSidePanelRequestGuard } from "@/lib/table/sidePanelRequestGuard";
import { metadataLoadBudgetMs } from "@/lib/metadata/metadataLoadBudget";
import { copyToClipboard } from "@/lib/common/clipboard";
import { useToast } from "@/composables/useToast";
import { translateBackendError } from "@/i18n/backend-errors";
import type { ConnectionConfig, CustomTypeDetails, CustomTypeKind, DatabaseType, ObjectSourceKind, TypeMetadataRead } from "@/types/database";
import * as api from "@/lib/backend/api";

const props = defineProps<{
  connection: ConnectionConfig;
  database: string;
  schema: string;
  name: string;
  catalog?: string;
  databaseType?: DatabaseType;
}>();

const emit = defineEmits<{ close: []; "open-source": [objectType: "TYPE" | "TYPE_BODY"] }>();

const { t } = useI18n();
const toast = useToast();
type CustomTypeTabId = "members" | "properties" | "methods" | "ddl" | "source";
type CustomTypeTab = { id: CustomTypeTabId; label: string };
const guard = createSidePanelRequestGuard();
const sourceGuard = createSidePanelRequestGuard();
const details = ref<CustomTypeDetails | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const sourceLoading = ref(false);
const sourceError = ref<string | null>(null);
const sourceText = ref("");
const sourceObjectType = ref<"TYPE" | "TYPE_BODY">("TYPE");
const tab = ref<"members" | "properties" | "methods" | "ddl" | "source">("members");
const userSelectedTab = ref(false);
const dbType = computed(() => props.databaseType ?? props.connection.db_type);
const isOracleFamily = computed(() => ["oracle", "oceanbase-oracle", "dameng"].includes(dbType.value));

const kindLabel = computed(() => (details.value ? t(details.value.oracleMetadata ? `oracleType.kinds.${details.value.kind}` : `customType.kinds.${details.value.kind}`) : ""));
const hasMemberTab = computed(() => details.value?.kind === "composite" || details.value?.kind === "enum" || !!details.value?.oracleMetadata);
const tabs = computed<CustomTypeTab[]>(() => {
  const items: CustomTypeTab[] = [];
  if (hasMemberTab.value) items.push({ id: "members", label: t("customType.tabs.members") });
  if (!details.value && isOracleFamily.value) {
    const sourceTab: CustomTypeTab = { id: "source", label: t("oracleType.source") };
    return [sourceTab];
  }
  items.push({ id: "properties", label: t("customType.tabs.properties") });
  if (details.value?.oracleMetadata) {
    items.push({ id: "methods", label: t("oracleType.methods") });
    items.push({ id: "source", label: t("oracleType.source") });
  } else if (isOracleFamily.value) {
    items.push({ id: "source", label: t("oracleType.source") });
  } else {
    items.push({ id: "ddl", label: t("customType.tabs.ddl") });
  }
  return items;
});

async function load(preserveDetails = false) {
  // start() bumps the epoch so an in-flight request from a previously selected
  // type can never overwrite the current panel state.
  const epoch = guard.start();
  loading.value = true;
  error.value = null;
  if (!preserveDetails) details.value = null;
  try {
    const result = await guard.wait(epoch, api.getCustomTypeDetails(props.connection.id, props.database, props.schema, props.name), metadataLoadBudgetMs(props.connection.query_timeout_secs));
    if (guard.isStale(epoch)) return;
    details.value = result;
    if (!userSelectedTab.value && isOracleFamily.value && result.oracleMetadata) tab.value = result.kind === "collection" ? "properties" : "members";
    if (!userSelectedTab.value && tab.value === "members" && result.kind !== "composite" && result.kind !== "enum" && !result.oracleMetadata) {
      tab.value = "properties";
    }
  } catch (e: any) {
    if (guard.isStale(epoch)) return;
    error.value = e?.message || String(e);
    if (!details.value && isOracleFamily.value) {
      tab.value = "source";
    }
  } finally {
    if (guard.isFresh(epoch)) loading.value = false;
  }
}

watch(
  () => [props.connection.id, props.database, props.schema, props.name, dbType.value] as const,
  () => {
    sourceGuard.bump();
    sourceLoading.value = false;
    sourceError.value = null;
    sourceText.value = "";
    sourceObjectType.value = "TYPE";
    userSelectedTab.value = false;
    tab.value = isOracleFamily.value ? "source" : "members";
    void load();
    if (isOracleFamily.value) void loadSource("TYPE");
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  guard.bump();
  sourceGuard.bump();
});

const ddlText = computed(() => details.value?.ddl?.sql ?? "");

async function copyDdl() {
  if (!ddlText.value) return;
  try {
    await copyToClipboard(ddlText.value);
    toast.toast(t("contextMenu.ddlCopied"));
  } catch (error) {
    toast.toast(t("grid.copyFailed", { message: translateBackendError(t, error) }));
  }
}

const propertyRows = computed<Array<{ label: string; value: string }>>(() => {
  const p = details.value?.properties;
  if (!p) return [];
  const rows: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string | null | undefined) => {
    if (value != null && value !== "") rows.push({ label, value: String(value) });
  };
  push(t("customType.properties.baseType"), p.baseType);
  if (p.notNull) push(t("customType.properties.notNull"), "true");
  push(t("customType.properties.default"), p.default);
  push(t("customType.properties.collation"), p.collation);
  for (const constraint of p.domainConstraints) {
    rows.push({
      label: constraint.name ? `${t("customType.properties.domainConstraint")} · ${constraint.name}` : t("customType.properties.domainConstraint"),
      value: constraint.definition,
    });
  }
  push(t("customType.properties.rangeSubtype"), p.rangeSubtype);
  push(t("customType.properties.rangeMultirange"), p.rangeMultirangeName);
  return rows;
});

function isFieldKind(kind: CustomTypeKind | undefined): boolean {
  return kind === "composite";
}

function isEnumKind(kind: CustomTypeKind | undefined): boolean {
  return kind === "enum";
}

function selectTab(next: CustomTypeTabId) {
  userSelectedTab.value = true;
  tab.value = next;
  if (next === "source" && !sourceText.value && !sourceLoading.value && !sourceError.value) {
    void loadSource(sourceObjectType.value);
  }
}

async function loadSource(objectType: "TYPE" | "TYPE_BODY", preserveSource = false) {
  const epoch = sourceGuard.start();
  const connectionId = props.connection.id;
  const database = props.database;
  const schema = props.schema;
  const name = props.name;
  sourceObjectType.value = objectType;
  sourceLoading.value = true;
  sourceError.value = null;
  if (!preserveSource) sourceText.value = "";
  try {
    const result = await sourceGuard.wait(epoch, api.getObjectSource(connectionId, database, schema, name, objectType as ObjectSourceKind), metadataLoadBudgetMs(props.connection.query_timeout_secs));
    if (sourceGuard.isStale(epoch)) return;
    sourceText.value = result.source;
  } catch (e: any) {
    if (sourceGuard.isStale(epoch)) return;
    sourceError.value = e?.message || String(e);
  } finally {
    if (sourceGuard.isFresh(epoch)) sourceLoading.value = false;
  }
}

function refresh() {
  const objectType = sourceObjectType.value;
  sourceGuard.bump();
  void load(true);
  if (isOracleFamily.value) void loadSource(objectType, true);
}

function viewBodySource() {
  sourceObjectType.value = "TYPE_BODY";
  tab.value = "source";
  void loadSource("TYPE_BODY");
}

async function copySource() {
  if (!sourceText.value) return;
  try {
    await copyToClipboard(sourceText.value);
    toast.toast(t("contextMenu.ddlCopied"));
  } catch (error) {
    toast.toast(t("grid.copyFailed", { message: translateBackendError(t, error) }));
  }
}

function readStateLabel(read: TypeMetadataRead): string {
  return t(`oracleType.read.${read.state}`);
}

function readReason(read: TypeMetadataRead): string {
  return read.reason || "";
}

const oraclePropertyRows = computed<Array<{ label: string; value: string }>>(() => {
  const metadata = details.value?.oracleMetadata;
  if (!metadata) return [];
  const rows: Array<{ label: string; value: string }> = [];
  const add = (key: string, value: unknown) => {
    if (value !== null && value !== undefined && value !== "") rows.push({ label: t(`oracleType.${key}`), value: String(value) });
  };
  add("owner", details.value?.schema);
  add("status", metadata.status ?? t("oracleType.unknown"));
  add("typeCode", metadata.typeCode);
  add("isFinal", metadata.isFinal == null ? null : t(metadata.isFinal ? "oracleType.boolean.yes" : "oracleType.boolean.no"));
  add("instantiable", metadata.instantiable == null ? null : t(metadata.instantiable ? "oracleType.boolean.yes" : "oracleType.boolean.no"));
  add("supertype", metadata.supertypeName ? [metadata.supertypeOwner, metadata.supertypeName].filter(Boolean).join(".") : null);
  add("attributeCount", metadata.attributeCount);
  add("methodCount", metadata.methodCount);
  add("bodyStatus", metadata.bodyStatus);
  if (metadata.bodyRead.state === "available") {
    const visibilityKey = metadata.bodyVisible === true ? "oracleType.bodyVisible" : metadata.bodyVisible === false ? "oracleType.bodyNotVisible" : "oracleType.unknown";
    add("bodyVisibility", t(visibilityKey));
  }
  return rows;
});

defineExpose({ selectTab, refresh });
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex items-center gap-2 border-b px-3 py-1.5 bg-muted/20 h-9 shrink-0">
      <span class="text-xs font-medium flex-1 min-w-0 truncate">{{ name }}</span>
      <span class="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0">{{ kindLabel || details?.oracleMetadata?.typeCode || "" }}</span>
      <Button v-if="isOracleFamily && details" variant="ghost" size="icon" class="h-6 w-6" :title="t('common.retry')" :aria-label="t('common.retry')" @click="refresh">
        <RefreshCw class="w-3 h-3" />
      </Button>
      <Button variant="ghost" size="icon" class="h-6 w-6" @click="emit('close')">
        <X class="w-3 h-3" />
      </Button>
    </div>

    <div v-if="loading && !details" class="flex-1 flex items-center justify-center text-xs text-muted-foreground" role="status" aria-live="polite">
      {{ t("common.loading") }}
    </div>

    <div v-else-if="error && !details && !isOracleFamily" class="flex-1 flex flex-col items-center justify-center gap-2 px-4 text-center" role="alert">
      <div class="text-xs text-destructive break-words max-w-full">{{ error }}</div>
      <Button variant="outline" size="sm" class="h-6 text-xs" @click="load">
        <RefreshCw class="w-3 h-3" />
        {{ t("common.retry") }}
      </Button>
    </div>

    <template v-if="details || (isOracleFamily && (loading || error))">
      <div class="flex items-center gap-1 border-b px-2 py-1 shrink-0">
        <button
          v-for="item in tabs"
          :key="item.id"
          type="button"
          class="rounded px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          :class="tab === item.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'"
          @click="selectTab(item.id)"
        >
          {{ item.label }}
        </button>
        <span class="flex-1" />
        <Button v-if="tab === 'ddl' && ddlText" variant="ghost" size="sm" class="h-6 px-2 text-xs" :title="t('grid.copyDdl')" :aria-label="t('grid.copyDdl')" @click="copyDdl">
          <Copy class="w-3 h-3" />
          <span class="table-info-action-label">{{ t("grid.copyDdl") }}</span>
        </Button>
      </div>

      <div class="flex-1 min-h-0 overflow-auto" :aria-busy="loading || sourceLoading">
        <div v-if="error" class="flex items-center gap-2 border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
          <span class="flex-1">{{ error }}</span>
          <Button v-if="!details" variant="outline" size="sm" class="h-6 text-xs" @click="load">{{ t("common.retry") }}</Button>
        </div>
        <div v-if="loading" class="border-b px-3 py-1 text-xs text-muted-foreground" role="status" aria-live="polite">{{ t("common.loading") }}</div>
        <!-- Members: empty state for composite/enum -->
        <template v-if="details">
          <div v-if="tab === 'members' && details.oracleMetadata && details.oracleMetadata.attributesRead.state !== 'available'" class="border-b px-3 py-2 text-xs text-muted-foreground">
            <strong>{{ readStateLabel(details.oracleMetadata.attributesRead) }}</strong
            ><span v-if="readReason(details.oracleMetadata.attributesRead)"> · {{ readReason(details.oracleMetadata.attributesRead) }}</span>
          </div>
          <div
            v-if="tab === 'members' && details.oracleMetadata && details.kind !== 'collection' && details.oracleMetadata.attributesRead.state === 'available' && details.oracleMetadata.attributes.length === 0"
            class="flex flex-col items-center justify-center gap-1 px-4 py-8 text-center text-xs text-muted-foreground"
          >
            {{ t("oracleType.emptyAttributes") }}
          </div>
          <div v-else-if="tab === 'members' && !details.oracleMetadata && details.members.length === 0" class="flex flex-col items-center justify-center gap-1 px-4 py-8 text-center">
            <span class="text-xs text-muted-foreground">{{ t("customType.members.empty") }}</span>
          </div>

          <table v-if="tab === 'members' && details.oracleMetadata && details.oracleMetadata.attributes.length > 0" class="w-full text-[11px]">
            <thead class="sticky top-0 bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th class="px-3 py-1.5 font-medium">#</th>
                <th class="px-3 py-1.5 font-medium">{{ t("customType.members.name") }}</th>
                <th class="px-3 py-1.5 font-medium">{{ t("customType.members.type") }}</th>
                <th class="px-3 py-1.5 font-medium">{{ t("oracleType.length") }}</th>
                <th class="px-3 py-1.5 font-medium">{{ t("oracleType.precision") }}</th>
                <th class="px-3 py-1.5 font-medium">{{ t("oracleType.scale") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(attribute, index) in details.oracleMetadata.attributes" :key="`${attribute.ordinal ?? index}:${attribute.name}`" class="border-t border-border/60">
                <td class="px-3 py-1.5 text-muted-foreground">{{ attribute.ordinal ?? "—" }}</td>
                <td class="px-3 py-1.5 font-mono">{{ attribute.name }}</td>
                <td class="px-3 py-1.5 font-mono">{{ [attribute.typeOwner, attribute.typeName, attribute.typeModifier].filter(Boolean).join(".") || "—" }}</td>
                <td class="px-3 py-1.5">{{ attribute.length ?? "—" }}</td>
                <td class="px-3 py-1.5">{{ attribute.precision ?? "—" }}</td>
                <td class="px-3 py-1.5">{{ attribute.scale ?? "—" }}</td>
              </tr>
            </tbody>
          </table>
          <!-- Members: composite fields -->
          <table v-else-if="tab === 'members' && isFieldKind(details.kind)" class="w-full text-[11px]">
            <thead class="sticky top-0 bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th class="px-3 py-1.5 font-medium">#</th>
                <th class="px-3 py-1.5 font-medium">{{ t("customType.members.name") }}</th>
                <th class="px-3 py-1.5 font-medium">{{ t("customType.members.type") }}</th>
                <th class="px-3 py-1.5 font-medium">{{ t("customType.members.nullable") }}</th>
                <th class="px-3 py-1.5 font-medium">{{ t("customType.members.default") }}</th>
                <th class="px-3 py-1.5 font-medium">{{ t("customType.members.comment") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="member in details.members" :key="member.ordinal" class="border-t border-border/60">
                <td class="px-3 py-1.5 text-muted-foreground">{{ member.ordinal }}</td>
                <td class="px-3 py-1.5 font-mono">{{ member.name }}</td>
                <td class="px-3 py-1.5 font-mono">{{ member.dataType }}</td>
                <td class="px-3 py-1.5">{{ member.nullable == null ? "—" : member.nullable ? "✓" : "✗" }}</td>
                <td class="px-3 py-1.5 font-mono">{{ member.default ?? "—" }}</td>
                <td class="px-3 py-1.5">{{ member.comment ?? "—" }}</td>
              </tr>
            </tbody>
          </table>

          <!-- Members: enum values -->
          <ul v-else-if="tab === 'members' && isEnumKind(details.kind) && details.members.length > 0" class="divide-y divide-border/60">
            <li v-for="member in details.members" :key="member.ordinal" class="flex items-center gap-3 px-3 py-1.5 text-[11px]">
              <span class="w-6 text-muted-foreground text-right">{{ member.ordinal }}</span>
              <span class="font-mono">{{ member.enumValue }}</span>
            </li>
          </ul>

          <!-- Properties -->
          <table v-else-if="tab === 'properties'" class="w-full text-[11px]">
            <tbody>
              <template v-if="details.oracleMetadata">
                <tr v-for="row in oraclePropertyRows" :key="row.label" class="border-b border-border/60">
                  <td class="px-3 py-1.5 text-muted-foreground w-44 align-top">{{ row.label }}</td>
                  <td class="px-3 py-1.5 font-mono whitespace-pre-wrap break-all">{{ row.value }}</td>
                </tr>
                <tr
                  v-for="section in [
                    { key: 'propertiesRead', read: details.oracleMetadata.propertiesRead },
                    { key: 'bodyRead', read: details.oracleMetadata.bodyRead },
                  ]"
                  :key="section.key"
                  class="border-b border-border/60"
                >
                  <td class="px-3 py-1.5 text-muted-foreground w-44 align-top">{{ t(`oracleType.${section.key}`) }}</td>
                  <td class="px-3 py-1.5">
                    <span>{{ readStateLabel(section.read) }}</span
                    ><span v-if="readReason(section.read)"> · {{ readReason(section.read) }}</span>
                  </td>
                </tr>
                <tr v-if="details.oracleMetadata.bodyVisible === true" class="border-b border-border/60">
                  <td class="px-3 py-1.5 text-muted-foreground w-44">{{ t("oracleType.body") }}</td>
                  <td class="px-3 py-1.5">
                    <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" @click="viewBodySource">{{ t("oracleType.viewBody") }}</Button>
                  </td>
                </tr>
                <tr v-if="details.oracleMetadata.collection">
                  <td class="px-3 py-1.5 text-muted-foreground w-44 align-top">{{ t("oracleType.collection") }}</td>
                  <td class="px-3 py-1.5 font-mono">
                    {{ [details.oracleMetadata.collection.kind, details.oracleMetadata.collection.elementOwner, details.oracleMetadata.collection.elementName, details.oracleMetadata.collection.elementModifier].filter(Boolean).join(" · ")
                    }}<span v-if="details.oracleMetadata.collection.upperBound != null"> · {{ t("oracleType.upperBound") }}: {{ details.oracleMetadata.collection.upperBound }}</span
                    ><span v-if="details.oracleMetadata.collection.length != null"> · {{ t("oracleType.length") }}: {{ details.oracleMetadata.collection.length }}</span
                    ><span v-if="details.oracleMetadata.collection.precision != null"> · {{ t("oracleType.precision") }}: {{ details.oracleMetadata.collection.precision }}</span
                    ><span v-if="details.oracleMetadata.collection.scale != null"> · {{ t("oracleType.scale") }}: {{ details.oracleMetadata.collection.scale }}</span>
                  </td>
                </tr>
                <tr v-if="details.kind === 'collection' && details.oracleMetadata.collectionRead.state !== 'available'" class="border-b border-border/60">
                  <td class="px-3 py-1.5 text-muted-foreground w-44">{{ t("oracleType.collection") }}</td>
                  <td class="px-3 py-1.5 text-muted-foreground">
                    <span>{{ readStateLabel(details.oracleMetadata.collectionRead) }}</span
                    ><span v-if="readReason(details.oracleMetadata.collectionRead)"> · {{ readReason(details.oracleMetadata.collectionRead) }}</span>
                  </td>
                </tr>
              </template>
              <tr v-if="details.comment" class="border-b border-border/60">
                <td class="px-3 py-1.5 text-muted-foreground w-44">{{ t("customType.members.comment") }}</td>
                <td class="px-3 py-1.5">{{ details.comment }}</td>
              </tr>
              <tr v-for="row in propertyRows" :key="row.label" class="border-b border-border/60">
                <td class="px-3 py-1.5 text-muted-foreground w-44 align-top">{{ row.label }}</td>
                <td class="px-3 py-1.5 font-mono whitespace-pre-wrap break-all">{{ row.value }}</td>
              </tr>
              <tr v-if="propertyRows.length === 0 && oraclePropertyRows.length === 0 && !details.oracleMetadata?.collection && !details.comment" class="border-b border-border/60">
                <td class="px-3 py-2 text-xs text-muted-foreground" colspan="2">{{ t("customType.properties.empty") }}</td>
              </tr>
            </tbody>
          </table>

          <section v-else-if="tab === 'methods' && details.oracleMetadata" class="p-3 text-xs">
            <div class="mb-3 flex items-center justify-between border-b pb-2">
              <strong>{{ t("oracleType.methodMetadata") }}</strong
              ><span
                >{{ readStateLabel(details.oracleMetadata.methodsRead) }}<span v-if="readReason(details.oracleMetadata.methodsRead)"> · {{ readReason(details.oracleMetadata.methodsRead) }}</span></span
              >
            </div>
            <p v-if="details.oracleMetadata.methodsRead.state === 'available' && details.oracleMetadata.methods.length === 0" class="py-4 text-center text-muted-foreground">{{ t("oracleType.emptyMethods") }}</p>
            <article v-for="(method, index) in details.oracleMetadata.methods" :key="`${method.number ?? index}:${method.name}`" class="mb-3 rounded border p-2">
              <div class="flex flex-wrap items-baseline gap-x-2">
                <strong class="font-mono">{{ method.name }}</strong
                ><span v-if="method.kind" class="text-muted-foreground">{{ method.kind }}</span
                ><span v-if="method.number != null" class="text-muted-foreground">#{{ method.number }}</span>
              </div>
              <div class="mt-2 grid gap-1" v-if="method.parameters.length || method.results.length || method.parametersRead.state !== 'available' || method.resultsRead.state !== 'available'">
                <div v-for="parameter in method.parameters" :key="`p:${parameter.ordinal ?? ''}:${parameter.name ?? ''}`" class="font-mono text-muted-foreground">
                  {{ parameter.mode || t("oracleType.parameter") }} {{ parameter.name || "—" }}: {{ [parameter.typeOwner, parameter.typeName, parameter.typeModifier].filter(Boolean).join(".") || "—" }}
                </div>
                <div v-if="method.parametersRead.state !== 'available'" class="text-muted-foreground">
                  {{ t("oracleType.parameters") }}: {{ readStateLabel(method.parametersRead) }}<span v-if="readReason(method.parametersRead)"> · {{ readReason(method.parametersRead) }}</span>
                </div>
                <div v-for="result in method.results" :key="`r:${result.ordinal ?? ''}:${result.name ?? ''}`" class="font-mono text-muted-foreground">
                  {{ t("oracleType.result") }} {{ result.name || "—" }}: {{ [result.typeOwner, result.typeName, result.typeModifier].filter(Boolean).join(".") || "—" }}
                </div>
                <div v-if="method.resultsRead.state !== 'available'" class="text-muted-foreground">
                  {{ t("oracleType.results") }}: {{ readStateLabel(method.resultsRead) }}<span v-if="readReason(method.resultsRead)"> · {{ readReason(method.resultsRead) }}</span>
                </div>
              </div>
            </article>
          </section>
        </template>
        <section v-if="tab === 'source'" class="flex h-full min-h-0 flex-col">
          <div class="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
            <span class="flex-1 font-medium">{{ sourceObjectType === "TYPE_BODY" ? t("oracleType.bodySource") : t("oracleType.source") }}</span
            ><Button v-if="sourceError" variant="outline" size="sm" class="h-6 text-xs" @click="loadSource(sourceObjectType)">{{ t("common.retry") }}</Button
            ><Button v-if="sourceText" variant="ghost" size="sm" class="h-6 px-2 text-xs" @click="copySource"><Copy class="mr-1 h-3 w-3" />{{ t("grid.copyDdl") }}</Button>
          </div>
          <div v-if="sourceLoading && !sourceText" class="flex flex-1 items-center justify-center text-xs text-muted-foreground" role="status" aria-live="polite">{{ t("common.loading") }}</div>
          <div v-if="sourceError" class="flex items-center justify-center px-4 py-2 text-center text-xs text-destructive" role="alert">{{ sourceError }}</div>
          <pre v-if="sourceText" class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed">{{ sourceText }}</pre>
        </section>
        <!-- DDL -->
        <div v-if="details && tab === 'ddl'" class="flex h-full flex-col">
          <div v-if="details.ddl && !details.ddl.complete" class="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5">
            <div v-for="warning in details.ddl.warnings" :key="warning" class="text-[11px] text-amber-600 dark:text-amber-400">{{ warning }}</div>
          </div>
          <pre class="flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed">{{ ddlText || t("customType.ddl.empty") }}</pre>
        </div>
      </div>
    </template>
  </div>
</template>

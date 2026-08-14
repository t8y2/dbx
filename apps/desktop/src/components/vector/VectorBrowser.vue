<script setup lang="ts">
import { computed, ref, watch, defineAsyncComponent, onBeforeUnmount } from "vue";
import { Play, RefreshCcw, RotateCcw, Save, Search, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import ErrorBanner from "@/components/ui/ErrorBanner.vue";
import QueryLoadingState from "@/components/common/QueryLoadingState.vue";
import * as api from "@/lib/backend/api";
import { uuid } from "@/lib/common/utils";
import type { DatabaseType, MilvusCollectionSchema, MilvusFieldInfo, QueryResult } from "@/types/database";

const DataGrid = defineAsyncComponent(() => import("@/components/grid/DataGrid.vue"));
const { t } = useI18n();

type VectorOperationMode = "browse" | "upsert" | "delete" | "search";

const props = defineProps<{
  connectionId: string;
  database: string;
  collection: string;
  collectionLabel?: string;
  databaseType?: DatabaseType;
  dimension?: number;
  tenant?: string;
}>();

const loading = ref(false);
const cancelling = ref(false);
const executionId = ref("");
const elapsedSeconds = ref("0.0");
const error = ref("");
const statusMessage = ref("");
const result = ref<QueryResult>(emptyResult());
const operationMode = ref<VectorOperationMode>("browse");
const requestText = ref("");
const requestIsDefault = ref(true);
const searchVector = ref("");
const searchTopK = ref(10);
let loadingTimer: ReturnType<typeof setInterval> | undefined;
const milvusSchema = ref<MilvusCollectionSchema>();
const milvusDetailError = ref("");
let milvusDetailGeneration = 0;
let milvusDetailLoad: Promise<void> | undefined;

const milvusFields = computed(() => milvusSchema.value?.fields ?? []);
const milvusSearchField = computed(() => milvusFields.value.find((field) => isMilvusVectorField(field) && !field.isFunctionOutput) ?? milvusFields.value.find(isMilvusVectorField));
const collectionDimension = computed(() => milvusSearchField.value?.dimension ?? props.dimension);
const dim = computed(() => collectionDimension.value ?? 4);
function sampleVector(dimension = dim.value): number[] {
  return Array.from({ length: Math.max(1, dimension) }, (_, i) => parseFloat(((i + 1) / 10).toFixed(1)));
}
const productLabel = computed(() => {
  switch (props.databaseType) {
    case "milvus":
      return "Milvus";
    case "weaviate":
      return "Weaviate";
    case "chromadb":
      return "ChromaDB";
    default:
      return "Qdrant";
  }
});
const collectionLabel = computed(() => props.collectionLabel || props.collection || t("vector.collectionFallback"));
const executeLabel = computed(() => {
  switch (operationMode.value) {
    case "browse":
      return t("vector.run");
    case "search":
      return t("vector.search");
    default:
      return t("vector.apply");
  }
});
const operationIcon = computed(() => {
  switch (operationMode.value) {
    case "delete":
      return Trash2;
    case "upsert":
      return Save;
    case "search":
      return Search;
    default:
      return Play;
  }
});
const needsExplicitSearchVector = computed(() => operationMode.value === "search" && props.databaseType === "weaviate" && props.dimension == null && parseVector(searchVector.value) == null);
const executeDisabled = computed(() => loading.value || !requestText.value.trim() || needsExplicitSearchVector.value);

watch(
  () => [props.connectionId, props.databaseType, props.database, props.collection] as const,
  () => {
    invalidateRequest();
    resetRequest();
    result.value = emptyResult();
    error.value = "";
    statusMessage.value = "";
    resetMilvusCollectionDetail();
    if (props.databaseType === "milvus") void loadMilvusCollectionDetail();
  },
  { immediate: true },
);

watch(
  () => [operationMode.value, searchVector.value, searchTopK.value, collectionDimension.value] as const,
  () => {
    if (operationMode.value === "search" && requestIsDefault.value) {
      resetRequest();
    }
  },
);

function emptyResult(): QueryResult {
  return {
    columns: [],
    column_types: [],
    column_sortables: [],
    rows: [],
    affected_rows: 0,
    execution_time_ms: 0,
  };
}

function pathSegment(value: string): string {
  return encodeURIComponent(value || "collection");
}

function milvusDataType(field: Pick<MilvusFieldInfo, "dataType">): string {
  return field.dataType.toLowerCase();
}

function isMilvusVectorField(field: MilvusFieldInfo): boolean {
  return milvusDataType(field).endsWith("vector");
}

function defaultMilvusValue(field: MilvusFieldInfo): unknown {
  const type = milvusDataType(field);
  if (isMilvusVectorField(field)) {
    const dimension = field.dimension ?? dim.value;
    if (type === "sparsefloatvector") return { "0": 0.1 };
    if (type === "binaryvector") return Array.from({ length: Math.max(8, dimension) }, (_, index) => Number(index === 0));
    if (type === "int8vector") return Array.from({ length: Math.max(1, dimension) }, () => 1);
    return sampleVector(dimension);
  }
  switch (type) {
    case "bool":
      return false;
    case "int8":
    case "int16":
    case "int32":
    case "int64":
      return 1;
    case "float":
    case "double":
      return 0.1;
    case "json":
      return {};
    case "array":
      return [];
    case "geometry":
      return "POINT (0 0)";
    default:
      return "x";
  }
}

function defaultMilvusUpsertEntity(): Record<string, unknown> {
  return Object.fromEntries(milvusFields.value.filter((field) => !field.isFunctionOutput && (!field.autoId || field.primaryKey) && (isMilvusVectorField(field) || (!field.nullable && !field.hasDefaultValue))).map((field) => [field.name, defaultMilvusValue(field)]));
}

function defaultMilvusPrimaryKeyFilter(): string {
  const primaryKey = milvusFields.value.find((field) => field.primaryKey);
  if (!primaryKey) return "id in [1]";
  return `${primaryKey.name} in [${JSON.stringify(defaultMilvusValue(primaryKey))}]`;
}

function parseJsonValue(input: string): unknown | undefined {
  try {
    return JSON.parse(input);
  } catch {
    return undefined;
  }
}

function tryParseMilvusSearchVector(input: string): unknown {
  const field = milvusSearchField.value;
  const parsed = parseJsonValue(input);
  if (field?.isFunctionOutput) return typeof parsed === "string" ? parsed : input.trim() || "x";
  if (Array.isArray(parsed) || (parsed && typeof parsed === "object")) return parsed;
  return field ? defaultMilvusValue(field) : [];
}

function milvusRequestText(database: string, collection: string, mode: VectorOperationMode, strongConsistency = false): string {
  const base = { dbName: database || "default", collectionName: collection };
  let endpoint: string;
  let body: Record<string, unknown>;
  switch (mode) {
    case "delete":
      endpoint = "delete";
      body = { ...base, filter: defaultMilvusPrimaryKeyFilter() };
      break;
    case "upsert":
      endpoint = "upsert";
      body = { ...base, data: [defaultMilvusUpsertEntity()] };
      break;
    case "search":
      endpoint = "search";
      body = {
        ...base,
        data: [tryParseMilvusSearchVector(searchVector.value)],
        limit: searchTopK.value,
        outputFields: ["*"],
        ...(milvusSearchField.value ? { annsField: milvusSearchField.value.name } : {}),
      };
      break;
    default:
      endpoint = "query";
      body = { ...base, filter: "", limit: 100, outputFields: ["*"], ...(strongConsistency && { consistencyLevel: "Strong" }) };
  }
  return `POST /v2/vectordb/entities/${endpoint}\n${JSON.stringify(body, null, 2)}`;
}

function defaultRequestText(databaseType: DatabaseType | undefined, database: string, collection: string, mode: VectorOperationMode, strongConsistency = false): string {
  if (databaseType === "milvus") return milvusRequestText(database, collection, mode, strongConsistency);
  if (databaseType === "weaviate") {
    const collectionName = collection || "Collection";
    if (mode === "delete") {
      return "DELETE /v1/objects/{id}";
    }
    if (mode === "upsert") {
      return `POST /v1/objects\n${JSON.stringify(
        {
          class: collectionName,
          properties: {
            title: "updated vector",
            kind: "demo",
          },
        },
        null,
        2,
      )}`;
    }
    if (mode === "search") {
      const vec = tryParseVector(searchVector.value);
      const gql = `{ Get { ${collectionName}(limit: ${searchTopK.value}, nearVector: {vector: [${vec.join(",")}]}) { _additional { distance id } } } }`;
      return `POST /v1/graphql\n${JSON.stringify({ query: gql }, null, 2)}`;
    }
    return `GET /v1/objects?class=${encodeURIComponent(collectionName)}&limit=100`;
  }
  if (databaseType === "chromadb") {
    const collectionId = collection || "collection-id";
    const tenant = encodeURIComponent(props.tenant?.trim() || "default_tenant");
    const chromaDatabase = encodeURIComponent(database.trim() || "default_database");
    const collectionPath = `/api/v2/tenants/${tenant}/databases/${chromaDatabase}/collections/${encodeURIComponent(collectionId)}`;
    if (mode === "delete") {
      return `POST ${collectionPath}/delete\n${JSON.stringify({ ids: ["id1"] }, null, 2)}`;
    }
    if (mode === "upsert") {
      return `POST ${collectionPath}/upsert\n${JSON.stringify({ ids: ["id1"], embeddings: [sampleVector()], documents: ["sample document"], metadatas: [{}] }, null, 2)}`;
    }
    if (mode === "search") {
      return `POST ${collectionPath}/query\n${JSON.stringify({ query_embeddings: [tryParseVector(searchVector.value)], n_results: searchTopK.value, include: ["documents", "metadatas", "distances"] }, null, 2)}`;
    }
    return `POST ${collectionPath}/get\n${JSON.stringify({ limit: 100, include: ["documents", "metadatas"] }, null, 2)}`;
  }
  const collectionPath = pathSegment(collection);
  if (mode === "delete") {
    return `POST /collections/${collectionPath}/points/delete?wait=true\n${JSON.stringify({ points: [1] }, null, 2)}`;
  }
  if (mode === "upsert") {
    return `PUT /collections/${collectionPath}/points?wait=true\n${JSON.stringify(
      {
        points: [
          {
            id: 1,
            vector: sampleVector(),
            payload: {
              title: "updated vector",
              kind: "demo",
            },
          },
        ],
      },
      null,
      2,
    )}`;
  }
  if (mode === "search") {
    return `POST /collections/${collectionPath}/points/search\n${JSON.stringify({ vector: tryParseVector(searchVector.value), limit: searchTopK.value, with_payload: true, with_vector: false }, null, 2)}`;
  }
  return `POST /collections/${collectionPath}/points/scroll\n${JSON.stringify({ limit: 100, with_payload: true, with_vector: false }, null, 2)}`;
}

function resetMilvusCollectionDetail() {
  milvusDetailGeneration += 1;
  milvusDetailLoad = undefined;
  milvusSchema.value = undefined;
  milvusDetailError.value = "";
}

function loadMilvusCollectionDetail(): Promise<void> {
  if (props.databaseType !== "milvus" || !props.connectionId || !props.collection) return Promise.resolve();
  if (milvusDetailLoad) return milvusDetailLoad;

  const generation = ++milvusDetailGeneration;
  const promise = api
    .vectorGetCollectionDetail(props.connectionId, props.database || "default", props.collection)
    .then((info) => {
      if (generation !== milvusDetailGeneration) return;
      milvusSchema.value = info.milvusSchema;
      if (!milvusSearchField.value) milvusDetailError.value = "Milvus collection schema did not return a supported vector field.";
      if (requestIsDefault.value) resetRequest();
    })
    .catch((reason: unknown) => {
      if (generation !== milvusDetailGeneration) return;
      milvusDetailError.value = reason instanceof Error ? reason.message : String(reason);
      milvusDetailLoad = undefined;
    });
  return (milvusDetailLoad = promise);
}

async function ensureMilvusDefaultSchema() {
  if (props.databaseType !== "milvus" || operationMode.value === "browse" || !requestIsDefault.value) return;
  if (!milvusSchema.value) await loadMilvusCollectionDetail();
  if (!milvusSchema.value) {
    throw new Error(milvusDetailError.value || "Unable to load the Milvus collection schema for the default request.");
  }
  if (operationMode.value === "search" && !milvusSearchField.value) {
    throw new Error(milvusDetailError.value || "Unable to determine the Milvus vector field for the default request.");
  }
}

function parseVector(input: string): number[] | undefined {
  const parsed = parseJsonValue(input);
  return Array.isArray(parsed) && parsed.length > 0 ? (parsed as number[]) : undefined;
}

function tryParseVector(input: string): number[] {
  const parsed = parseVector(input);
  if (parsed) return parsed;
  if (props.databaseType === "weaviate" && props.dimension == null) return [];
  return sampleVector();
}

function startTimer() {
  stopTimer();
  const startedAt = Date.now();
  elapsedSeconds.value = "0.0";
  loadingTimer = setInterval(() => {
    elapsedSeconds.value = ((Date.now() - startedAt) / 1000).toFixed(1);
  }, 100);
}

function stopTimer() {
  if (loadingTimer) clearInterval(loadingTimer);
  loadingTimer = undefined;
}

function firstResult(results: QueryResult[]): QueryResult {
  return results.find((item) => item.columns.length > 0) ?? results[0] ?? emptyResult();
}

async function executeRequestText(text: string): Promise<QueryResult> {
  const results = await api.executeMulti(props.connectionId, props.database || "default", text, undefined, executionId.value);
  return firstResult(results);
}

async function withLoading(run: (id: string) => Promise<void>) {
  if (loading.value) return;
  const id = uuid();
  executionId.value = id;
  loading.value = true;
  cancelling.value = false;
  error.value = "";
  statusMessage.value = "";
  startTimer();
  try {
    await run(id);
  } catch (e: unknown) {
    if (executionId.value === id) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (executionId.value === id) {
      loading.value = false;
      executionId.value = "";
      stopTimer();
    }
  }
}

function refreshResult() {
  return withLoading(async (id) => {
    const browseText = defaultRequestText(props.databaseType, props.database, props.collection, "browse");
    const nextResult = await executeRequestText(browseText);
    if (executionId.value === id) result.value = nextResult;
  });
}

function runRequest() {
  return withLoading(async (id) => {
    await ensureMilvusDefaultSchema();
    if (executionId.value !== id) return;
    const nextResult = await executeRequestText(requestText.value);
    if (executionId.value !== id) return;
    if (operationMode.value === "browse" || operationMode.value === "search") {
      result.value = nextResult;
    } else {
      const browseText = defaultRequestText(props.databaseType, props.database, props.collection, "browse", true);
      const browseResult = await executeRequestText(browseText);
      if (executionId.value !== id) return;
      result.value = browseResult;
      statusMessage.value = t("vector.operationSuccess");
    }
  });
}

async function cancelRequest() {
  const id = executionId.value;
  if (!id || cancelling.value) return;
  cancelling.value = true;
  executionId.value = "";
  try {
    await api.cancelQuery(id).catch(() => false);
  } finally {
    loading.value = false;
    cancelling.value = false;
    stopTimer();
  }
}

function invalidateRequest() {
  const id = executionId.value;
  executionId.value = "";
  loading.value = false;
  cancelling.value = false;
  stopTimer();
  if (id) void api.cancelQuery(id).catch(() => false);
}

function resetRequest() {
  requestText.value = defaultRequestText(props.databaseType, props.database, props.collection, operationMode.value);
  requestIsDefault.value = true;
}

function markRequestAsCustom() {
  requestIsDefault.value = false;
}

function setOperationMode(mode: VectorOperationMode) {
  if (operationMode.value === mode) return;
  operationMode.value = mode;
  resetRequest();
  error.value = "";
  statusMessage.value = "";
}

onBeforeUnmount(() => {
  invalidateRequest();
  resetMilvusCollectionDetail();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2">
      <div class="min-w-0">
        <div class="truncate text-sm font-semibold">{{ collectionLabel }}</div>
        <div class="truncate text-xs text-muted-foreground">
          {{ t("vector.productCollection", { product: productLabel }) }}
          <span v-if="collectionDimension != null" class="ml-1.5 inline-flex items-center rounded border bg-muted/50 px-1.5 py-px text-[11px] font-medium text-foreground/80">{{ collectionDimension }}d</span>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <div class="mr-1 flex h-7 overflow-hidden rounded-md border bg-muted/30 p-0.5">
          <button type="button" class="h-6 px-2 text-xs transition-colors" :class="operationMode === 'browse' ? 'rounded bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'" :disabled="loading" @click="setOperationMode('browse')">{{ t("vector.browse") }}</button>
          <button type="button" class="h-6 px-2 text-xs transition-colors" :class="operationMode === 'search' ? 'rounded bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'" :disabled="loading" @click="setOperationMode('search')">{{ t("vector.search") }}</button>
          <button type="button" class="h-6 px-2 text-xs transition-colors" :class="operationMode === 'upsert' ? 'rounded bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'" :disabled="loading" @click="setOperationMode('upsert')">{{ t("vector.upsert") }}</button>
          <button type="button" class="h-6 px-2 text-xs transition-colors" :class="operationMode === 'delete' ? 'rounded bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'" :disabled="loading" @click="setOperationMode('delete')">{{ t("vector.delete") }}</button>
        </div>
        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2" :disabled="loading" @click="resetRequest">
          <RotateCcw class="h-3.5 w-3.5" />
          {{ t("vector.reset") }}
        </Button>
        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2" :disabled="loading" @click="refreshResult">
          <RefreshCcw class="h-3.5 w-3.5" />
          {{ t("vector.refresh") }}
        </Button>
        <Button size="sm" class="h-7 gap-1.5 px-2" :disabled="executeDisabled" @click="runRequest">
          <component :is="operationIcon" class="h-3.5 w-3.5" />
          {{ executeLabel }}
        </Button>
      </div>
    </div>

    <div v-if="operationMode === 'search'" class="flex shrink-0 flex-wrap items-center gap-3 border-b px-3 py-2">
      <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>{{ t("vector.vectorLabel") }}</span>
        <input v-model="searchVector" :disabled="loading" class="h-7 w-80 rounded border bg-muted/30 px-2 font-mono text-xs outline-none focus:border-primary" placeholder="[0.1, 0.2, ...]" spellcheck="false" />
      </div>
      <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>topK</span>
        <input v-model.number="searchTopK" :disabled="loading" type="number" min="1" max="1000" class="h-7 w-16 rounded border bg-muted/30 px-2 text-xs outline-none focus:border-primary" />
      </div>
      <span v-if="needsExplicitSearchVector" class="text-xs text-amber-600 dark:text-amber-400">{{ t("vector.vectorDimensionRequired") }}</span>
    </div>
    <div class="grid min-h-0 flex-1 grid-rows-[minmax(9rem,15rem)_1fr]">
      <div class="min-h-0 border-b">
        <textarea
          v-model="requestText"
          :readonly="loading"
          class="dbx-editor-font-family h-full w-full resize-none bg-background px-3 py-2 text-xs leading-5 outline-none"
          :aria-label="t('vector.requestEditor')"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          @input="markRequestAsCustom"
        />
      </div>
      <div class="min-h-0">
        <ErrorBanner v-if="error" :message="error" copy-mode="label" dismissible @dismiss="error = ''" />
        <div v-else-if="statusMessage" class="border-b bg-emerald-50 px-3 py-1.5 text-xs text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">{{ statusMessage }}</div>
        <QueryLoadingState v-if="loading && result.columns.length === 0" class="h-full" label-key="editor.fetching" :elapsed-seconds="elapsedSeconds" show-cancel :cancel-disabled="!executionId || cancelling" :cancelling="cancelling" @cancel="cancelRequest" />
        <DataGrid v-else class="h-full" :result="result" context="results" :sql="requestText" :loading="loading" @reload="refreshResult" />
      </div>
    </div>
  </div>
</template>

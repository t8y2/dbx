<script setup lang="ts">
import { computed, ref, watch, defineAsyncComponent } from "vue";
import { Play, RefreshCcw, RotateCcw, Save, Search, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import ErrorBanner from "@/components/ui/ErrorBanner.vue";
import QueryLoadingState from "@/components/common/QueryLoadingState.vue";
import * as api from "@/lib/api";
import { uuid } from "@/lib/utils";
import type { DatabaseType, QueryResult } from "@/types/database";

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
}>();

const loading = ref(false);
const cancelling = ref(false);
const executionId = ref("");
const elapsedSeconds = ref("0.0");
const error = ref("");
const statusMessage = ref("");
const result = ref<QueryResult>(emptyResult());
const operationMode = ref<VectorOperationMode>("browse");
const requestText = ref(defaultRequestText(props.databaseType, props.database, props.collection, operationMode.value));
const searchVector = ref("");
const searchTopK = ref(10);
let loadingTimer: ReturnType<typeof setInterval> | undefined;

const dim = computed(() => props.dimension || 4);
function sampleVector(): number[] {
  return Array.from({ length: dim.value }, (_, i) => parseFloat(((i + 1) / 10).toFixed(1)));
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

watch(
  () => [props.databaseType, props.database, props.collection] as const,
  ([databaseType, database, collection]) => {
    requestText.value = defaultRequestText(databaseType, database, collection, operationMode.value);
    result.value = emptyResult();
    error.value = "";
    statusMessage.value = "";
  },
);

watch(
  () => [operationMode.value, searchVector.value, searchTopK.value] as const,
  () => {
    if (operationMode.value === "search") {
      requestText.value = defaultRequestText(props.databaseType, props.database, props.collection, operationMode.value);
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

function defaultRequestText(databaseType: DatabaseType | undefined, database: string, collection: string, mode: VectorOperationMode): string {
  if (databaseType === "milvus") {
    const body =
      mode === "delete"
        ? {
            dbName: database || "default",
            collectionName: collection,
            filter: "id in [1]",
          }
        : mode === "upsert"
          ? {
              dbName: database || "default",
              collectionName: collection,
              data: [
                {
                  id: 1,
                  vector: sampleVector(),
                  title: "updated vector",
                  kind: "demo",
                },
              ],
            }
          : mode === "search"
            ? {
                dbName: database || "default",
                collectionName: collection,
                data: [tryParseVector(searchVector.value)],
                limit: searchTopK.value,
                outputFields: ["*"],
              }
            : {
                dbName: database || "default",
                collectionName: collection,
                filter: "",
                limit: 100,
                outputFields: ["*"],
              };
    const endpoint = mode === "delete" ? "delete" : mode === "upsert" ? "upsert" : mode === "search" ? "search" : "query";
    return `POST /v2/vectordb/entities/${endpoint}\n${JSON.stringify(body, null, 2)}`;
  }
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
    if (mode === "delete") {
      return `POST /api/v2/tenants/default_tenant/databases/default_database/collections/${encodeURIComponent(collectionId)}/delete\n${JSON.stringify({ ids: ["id1"] }, null, 2)}`;
    }
    if (mode === "upsert") {
      return `POST /api/v2/tenants/default_tenant/databases/default_database/collections/${encodeURIComponent(collectionId)}/upsert\n${JSON.stringify({ ids: ["id1"], embeddings: [sampleVector()], documents: ["sample document"], metadatas: [{}] }, null, 2)}`;
    }
    if (mode === "search") {
      return `POST /api/v2/tenants/default_tenant/databases/default_database/collections/${encodeURIComponent(collectionId)}/query\n${JSON.stringify({ query_embeddings: [tryParseVector(searchVector.value)], n_results: searchTopK.value, include: ["documents", "metadatas", "distances"] }, null, 2)}`;
    }
    return `POST /api/v2/tenants/default_tenant/databases/default_database/collections/${encodeURIComponent(collectionId)}/get\n${JSON.stringify({ limit: 100, include: ["documents", "metadatas"] }, null, 2)}`;
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

function tryParseVector(input: string): number[] {
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
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

async function refreshResult() {
  if (loading.value) return;
  const id = uuid();
  executionId.value = id;
  loading.value = true;
  cancelling.value = false;
  error.value = "";
  statusMessage.value = "";
  startTimer();
  try {
    const browseText = defaultRequestText(props.databaseType, props.database, props.collection, "browse");
    const nextResult = await executeRequestText(browseText);
    if (executionId.value === id) result.value = nextResult;
  } catch (e: unknown) {
    if (executionId.value === id) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (executionId.value === id) {
      loading.value = false;
      stopTimer();
    }
  }
}

async function runRequest() {
  if (loading.value) return;
  const id = uuid();
  executionId.value = id;
  loading.value = true;
  cancelling.value = false;
  error.value = "";
  statusMessage.value = "";
  startTimer();
  try {
    const nextResult = await executeRequestText(requestText.value);
    if (executionId.value !== id) return;
    if (operationMode.value === "browse" || operationMode.value === "search") {
      result.value = nextResult;
    } else {
      const browseText = defaultRequestText(props.databaseType, props.database, props.collection, "browse");
      result.value = await executeRequestText(browseText);
      statusMessage.value = t("vector.operationSuccess");
    }
  } catch (e: unknown) {
    if (executionId.value === id) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (executionId.value === id) {
      loading.value = false;
      stopTimer();
    }
  }
}

async function cancelRequest() {
  if (!executionId.value) return;
  cancelling.value = true;
  await api.cancelQuery(executionId.value).catch(() => false);
}

function resetRequest() {
  requestText.value = defaultRequestText(props.databaseType, props.database, props.collection, operationMode.value);
}

function setOperationMode(mode: VectorOperationMode) {
  if (operationMode.value === mode) return;
  operationMode.value = mode;
  resetRequest();
  error.value = "";
  statusMessage.value = "";
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2">
      <div class="min-w-0">
        <div class="truncate text-sm font-semibold">{{ collectionLabel }}</div>
        <div class="truncate text-xs text-muted-foreground">
          {{ t("vector.productCollection", { product: productLabel }) }}
          <span v-if="dimension != null" class="ml-1.5 inline-flex items-center rounded border bg-muted/50 px-1.5 py-px text-[11px] font-medium text-foreground/80">{{ dimension }}d</span>
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
        <Button size="sm" class="h-7 gap-1.5 px-2" :disabled="loading || !requestText.trim()" @click="runRequest">
          <component :is="operationIcon" class="h-3.5 w-3.5" />
          {{ executeLabel }}
        </Button>
      </div>
    </div>

    <div v-if="operationMode === 'search'" class="flex shrink-0 flex-wrap items-center gap-3 border-b px-3 py-2">
      <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>{{ t("vector.vectorLabel") }}</span>
        <input v-model="searchVector" class="h-7 w-80 rounded border bg-muted/30 px-2 font-mono text-xs outline-none focus:border-primary" placeholder="[0.1, 0.2, ...]" spellcheck="false" />
      </div>
      <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span>topK</span>
        <input v-model.number="searchTopK" type="number" min="1" max="1000" class="h-7 w-16 rounded border bg-muted/30 px-2 text-xs outline-none focus:border-primary" />
      </div>
    </div>
    <div class="grid min-h-0 flex-1 grid-rows-[minmax(9rem,15rem)_1fr]">
      <div class="min-h-0 border-b">
        <textarea v-model="requestText" class="dbx-editor-font-family h-full w-full resize-none bg-background px-3 py-2 text-xs leading-5 outline-none" :aria-label="t('vector.requestEditor')" spellcheck="false" autocomplete="off" autocapitalize="off" autocorrect="off" />
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

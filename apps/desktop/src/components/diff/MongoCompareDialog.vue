<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowLeftRight, Download, Loader2, Play, Square } from "@lucide/vue";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import MongoCompareEndpointSelect from "./MongoCompareEndpointSelect.vue";
import MongoCompareConfigBar from "./MongoCompareConfigBar.vue";
import MongoComparePairs from "./MongoComparePairs.vue";
import { mongoCompareConfigSnapshot, type MongoCompareConfigSnapshot } from "@/composables/useMongoCompareConfigs";
import { compareMongoBatch, mongoCompareFields, mongoPairKey, requireMongoCompareCollections, validMongoMatchFields, type MongoBatchSummary, type MongoCollectionPair } from "@/lib/mongo/mongoCompareBatch";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { saveTextFile } from "@/lib/export/saveTextFile";
import { uuid } from "@/lib/common/utils";
import * as api from "@/lib/backend/api";
import { compareMongoDocuments, mongoCompareCsv, planMongoSync, type MongoCompareResult, type MongoCompareSide, type MongoCompareStatus, type MongoSyncChange } from "@/lib/mongo/mongoCompare";
import { executeMongoSync, MongoCompareError, mongoSyncCommand, readMongoCompareSnapshot, validateMongoCompareFilter, type MongoCompareEndpoint } from "@/lib/mongo/mongoCompareRuntime";

const props = defineProps<{ prefillConnectionId?: string; prefillDatabase?: string; prefillCollection?: string }>();
const open = defineModel<boolean>("open", { default: false });
const { t } = useI18n();
const store = useConnectionStore();
const endpoint = (): MongoCompareEndpoint => ({ connectionId: "", database: "", collection: "", filter: "{}" });
const source = ref<MongoCompareEndpoint>({
  ...endpoint(),
  connectionId: props.prefillConnectionId ?? "",
  database: props.prefillDatabase ?? "",
  collection: props.prefillCollection ?? "",
});
const target = ref<MongoCompareEndpoint>(endpoint());
const matchFields = ref("_id");
const ignoredFields = ref("");
const limit = ref<number | string>(10000);
const numericTypesEqual = ref(false);
const batchMode = ref(false);
const pairs = ref<MongoCollectionPair[]>([]);
const sourceCollections = ref<string[]>([]);
const targetCollections = ref<string[]>([]);
const summaries = shallowRef<MongoBatchSummary[]>([]);
const detailSource = ref<MongoCompareEndpoint>(endpoint());
const detailTarget = ref<MongoCompareEndpoint>(endpoint());
const detailKeys = ref<string[]>([]);
const batchRunning = ref(false);
const configSnapshot = computed(() =>
  mongoCompareConfigSnapshot({
    source: source.value,
    target: target.value,
    matchFields: matchFields.value,
    ignoredFields: ignoredFields.value,
    limit: Number(limit.value),
    numericTypesEqual: numericTypesEqual.value,
    batchMode: batchMode.value,
    pairs: pairs.value,
  }),
);
const loading = ref(false);
const syncing = ref(false);
const sourceLoading = ref(false);
const targetLoading = ref(false);
const result = shallowRef<MongoCompareResult | null>(null);
const truncated = ref(false);
const counts = ref({ source: 0, target: 0 });
const duration = ref(0);
const comparedAt = ref("");
const error = ref("");
const notice = ref("");
const selectedRows = ref(new Set<string>());
const focusedKey = ref<string | null>(null);
const filter = ref<"differences" | "all" | MongoCompareStatus>("differences");
const page = ref(0);
const review = shallowRef<{ destination: MongoCompareSide; changes: MongoSyncChange[]; text: string } | null>(null);
const completedWrites = ref(0);
const stale = ref(false);
const statuses: MongoCompareStatus[] = ["same", "different", "sourceOnly", "targetOnly", "multiple"];
const rows = computed(() => (result.value?.rows ?? []).filter((row) => filter.value === "all" || (filter.value === "differences" ? row.status !== "same" : row.status === filter.value)));
const pageRows = computed(() => rows.value.slice(page.value * 100, (page.value + 1) * 100));
const focused = computed(() => result.value?.rows.find((row) => row.key === focusedKey.value));
const locked = computed(() => loading.value || syncing.value || !!review.value);
const endpointsReady = computed(() => [source.value, target.value].every((side) => side.connectionId && side.database && store.getConfig(side.connectionId)?.db_type === "mongodb") && !locked.value && !sourceLoading.value && !targetLoading.value);
const ready = computed(() => endpointsReady.value && (batchMode.value ? pairs.value.some((pair) => pair.enabled) : source.value.collection && target.value.collection));
const syncReady = computed(() => !!result.value && !truncated.value && !stale.value && !loading.value && !syncing.value && !review.value);
let controller: AbortController | undefined;
let executionIds: string[] = [];
let generation = 0;

function fields(value: string): string[] {
  return mongoCompareFields(value);
}
function describeError(cause: unknown): string {
  return cause instanceof MongoCompareError ? `${t(`mongoCompare.errors.${cause.code}`)}${cause.message !== cause.code ? `: ${cause.message}` : ""}` : cause instanceof Error ? cause.message : String(cause);
}
function clearResult() {
  result.value = null;
  focusedKey.value = null;
  selectedRows.value = new Set();
  review.value = null;
  stale.value = false;
  page.value = 0;
}
watch(
  [source, target, matchFields, ignoredFields, limit, numericTypesEqual, batchMode, pairs],
  () => {
    clearResult();
    summaries.value = [];
    notice.value = "";
    error.value = "";
  },
  { deep: true },
);
watch(filter, () => {
  page.value = 0;
});

function cancel() {
  controller?.abort();
  for (const id of executionIds) void api.cancelQuery(id).catch(() => {});
  generation += 1;
  loading.value = false;
  batchRunning.value = false;
  summaries.value = summaries.value.map((item) => (item.state === "pending" || item.state === "running" ? { ...item, state: "cancelled" } : item));
}
onBeforeUnmount(cancel);
watch(open, (visible) => {
  if (!visible) cancel();
});

function applyConfig(snapshot: MongoCompareConfigSnapshot) {
  if (locked.value) return;
  source.value = { ...snapshot.source };
  target.value = { ...snapshot.target };
  matchFields.value = snapshot.matchFields;
  ignoredFields.value = snapshot.ignoredFields;
  limit.value = snapshot.limit;
  numericTypesEqual.value = snapshot.numericTypesEqual;
  batchMode.value = snapshot.batchMode;
  pairs.value = snapshot.pairs.map((pair) => ({ ...pair }));
}

async function runBatch() {
  if (!ready.value) return;
  clearResult();
  error.value = "";
  notice.value = "";
  const selected = pairs.value.filter((pair) => pair.enabled).map((pair) => ({ ...pair }));
  if (selected.some((pair) => !pair.source || !pair.target) || new Set(selected.map(mongoPairKey)).size !== selected.length) {
    error.value = t("mongoCompare.invalidPairs");
    return;
  }
  const request = ++generation;
  controller = new AbortController();
  executionIds = [uuid(), uuid()];
  const signal = controller.signal;
  const sourceSnapshot = { ...source.value };
  const targetSnapshot = { ...target.value };
  const batchOptions = {
    matchFields: fields(matchFields.value),
    ignoredFields: fields(ignoredFields.value),
    numericTypesEqual: numericTypesEqual.value,
    limit: Number(limit.value),
    signal,
    executionIds: [...executionIds] as [string, string],
  };
  try {
    validateMongoCompareFilter(sourceSnapshot.filter);
    validateMongoCompareFilter(targetSnapshot.filter);
    if (!validMongoMatchFields(fields(matchFields.value))) throw new MongoCompareError("invalidMatchFields");
    if (!Number.isInteger(Number(limit.value)) || Number(limit.value) < 1 || Number(limit.value) > 100_000) throw new MongoCompareError("invalidLimit");
    summaries.value = selected.map((pair) => ({ pair, state: "pending" }));
    loading.value = true;
    batchRunning.value = true;
    await Promise.all([store.ensureConnected(sourceSnapshot.connectionId), store.ensureConnected(targetSnapshot.connectionId)]);
    if (request !== generation) return;
    await compareMongoBatch(api, sourceSnapshot, targetSnapshot, selected, batchOptions, (index, summary) => {
      if (request === generation) summaries.value = summaries.value.map((item, i) => (i === index ? summary : item));
    });
  } catch (cause) {
    if (request === generation) {
      error.value = describeError(cause);
      summaries.value = summaries.value.map((item) => ({ ...item, state: "failed", error: cause }));
    }
  } finally {
    if (request === generation) {
      loading.value = false;
      batchRunning.value = false;
      executionIds = [];
    }
  }
}

async function runCompare(pair?: MongoCollectionPair) {
  if (!endpointsReady.value || (!pair && !ready.value)) return;
  if (!pair && batchMode.value) return runBatch();
  clearResult();
  error.value = "";
  notice.value = "";
  const request = ++generation;
  try {
    const keys = fields(pair?.matchFields.trim() || matchFields.value);
    if (!validMongoMatchFields(keys)) throw new Error(t("mongoCompare.matchRequired"));
    validateMongoCompareFilter(source.value.filter);
    validateMongoCompareFilter(target.value.filter);
    const sourceSnapshot = { ...source.value, collection: pair?.source ?? source.value.collection };
    const targetSnapshot = { ...target.value, collection: pair?.target ?? target.value.collection };
    if (sourceSnapshot.connectionId === targetSnapshot.connectionId && sourceSnapshot.database === targetSnapshot.database && sourceSnapshot.collection === targetSnapshot.collection) throw new Error(t("mongoCompare.sameEndpoint"));
    const options = { matchFields: keys, ignoredFields: fields(ignoredFields.value), numericTypesEqual: numericTypesEqual.value };
    loading.value = true;
    counts.value = { source: 0, target: 0 };
    controller = new AbortController();
    executionIds = [uuid(), uuid()];
    const readIds = [...executionIds];
    const readLimit = Number(limit.value);
    const signal = controller.signal;
    const start = performance.now();
    await Promise.all([store.ensureConnected(sourceSnapshot.connectionId), store.ensureConnected(targetSnapshot.connectionId)]);
    if (request !== generation) return;
    await requireMongoCompareCollections(api, sourceSnapshot, targetSnapshot);
    if (request !== generation) return;
    const [left, right] = await Promise.all(
      [sourceSnapshot, targetSnapshot].map((side, index) =>
        readMongoCompareSnapshot(api, side, {
          limit: readLimit,
          executionId: readIds[index],
          signal,
          onProgress: (count) => {
            if (request === generation) counts.value[index === 0 ? "source" : "target"] = count;
          },
        }),
      ),
    );
    if (request !== generation) return;
    truncated.value = left.truncated || right.truncated;
    result.value = compareMongoDocuments(left.documents, right.documents, options);
    detailSource.value = sourceSnapshot;
    detailTarget.value = targetSnapshot;
    detailKeys.value = keys;
    focusedKey.value = result.value.rows.find((row) => row.status !== "same")?.key ?? result.value.rows[0]?.key ?? null;
    duration.value = Math.round(performance.now() - start);
    comparedAt.value = new Date().toISOString();
    if (pair) summaries.value = summaries.value.map((item) => (mongoPairKey(item.pair) === mongoPairKey(pair) ? { pair, state: "complete", counts: result.value!.counts, truncated: truncated.value, durationMs: duration.value } : item));
  } catch (cause) {
    if (request === generation) {
      error.value = describeError(cause);
      if (pair) summaries.value = summaries.value.map((item) => (mongoPairKey(item.pair) === mongoPairKey(pair) ? { pair, state: "failed", error: cause } : item));
      cancel();
    }
  } finally {
    if (request === generation) {
      loading.value = false;
      executionIds = [];
    }
  }
}

function canWrite(destination: MongoCompareSide) {
  const config = store.getConfig((destination === "source" ? detailSource : detailTarget).value.connectionId);
  return syncReady.value && config?.db_type === "mongodb" && !connectionIsEffectivelyReadOnly(config);
}
function prepareSync(destination: MongoCompareSide, field?: string[]) {
  if (!canWrite(destination) || !result.value) return;
  error.value = "";
  const selected = field ? result.value.rows.filter((row) => row.key === focusedKey.value) : result.value.rows.filter((row) => selectedRows.value.has(row.key));
  const changes = selected.map((row) => planMongoSync(row, destination, field ? [field] : undefined)).filter((change): change is MongoSyncChange => change !== null);
  if (!changes.length) {
    notice.value = t("mongoCompare.noSelected");
    return;
  }
  const endpoint = destination === "target" ? detailTarget.value : detailSource.value;
  review.value = {
    destination,
    changes,
    text: changes.map((change) => `db.getSiblingDB(${JSON.stringify(endpoint.database)}).runCommand(${JSON.stringify(mongoSyncCommand(endpoint.collection, change), null, 2)})`).join("\n\n"),
  };
}
async function confirmSync() {
  const plan = review.value;
  if (!plan || syncing.value) return;
  const destination = { ...(plan.destination === "target" ? detailTarget.value : detailSource.value) };
  const origin = { ...(plan.destination === "target" ? detailSource.value : detailTarget.value) };
  syncing.value = true;
  completedWrites.value = 0;
  error.value = "";
  let attempted = false;
  controller = new AbortController();
  const signal = controller.signal;
  const keys = [...detailKeys.value];
  try {
    const executed = await executeWithProductionContextGuard({
      connection: store.getConfig(destination.connectionId),
      database: destination.database,
      reviewText: plan.text,
      source: t("mongoCompare.title"),
      execute: async () => {
        if (signal.aborted || !open.value) return false;
        attempted = true;
        await requireMongoCompareCollections(api, origin, destination);
        await executeMongoSync(
          api,
          origin,
          destination,
          keys,
          plan.changes,
          (count) => {
            completedWrites.value = count;
          },
          signal,
        );
        return true;
      },
    });
    if (executed) notice.value = t("mongoCompare.syncComplete", { count: completedWrites.value });
  } catch (cause) {
    error.value = `${t("mongoCompare.syncStopped", { count: completedWrites.value })} ${describeError(cause)}`;
  } finally {
    syncing.value = false;
    review.value = null;
    if (attempted) {
      stale.value = true;
      selectedRows.value = new Set();
      // Pairs can share a namespace, so every retained summary may now be stale.
      summaries.value = summaries.value.map((item) => (item.state === "complete" ? { ...item, state: "stale" } : item));
    }
  }
}
function toggleRow(key: string) {
  const selected = new Set(selectedRows.value);
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  selectedRows.value = selected;
}
function selectPage() {
  const eligible = pageRows.value.filter((row) => row.status !== "same" && row.status !== "multiple");
  const selected = new Set(selectedRows.value);
  const all = eligible.every((row) => selected.has(row.key));
  for (const row of eligible) {
    if (all) selected.delete(row.key);
    else selected.add(row.key);
  }
  selectedRows.value = selected;
}
async function exportResult(format: "csv" | "json") {
  if (!result.value) return;
  try {
    const text =
      format === "csv"
        ? mongoCompareCsv(result.value)
        : JSON.stringify(
            {
              source: detailSource.value,
              target: detailTarget.value,
              comparedAt: comparedAt.value,
              durationMs: duration.value,
              truncated: truncated.value,
              stale: stale.value,
              options: { matchFields: detailKeys.value, ignoredFields: fields(ignoredFields.value), numericTypesEqual: numericTypesEqual.value },
              ...result.value,
            },
            null,
            2,
          );
    await saveTextFile(text, `mongo-compare.${format}`, format.toUpperCase(), format);
  } catch (cause) {
    error.value = describeError(cause);
  }
}
function display(value: unknown, exists = true) {
  return !exists ? t("mongoCompare.missing") : JSON.stringify(value, null, 2);
}

async function exportBatch() {
  try {
    await saveTextFile(
      JSON.stringify(
        {
          configuration: configSnapshot.value,
          exportedAt: new Date().toISOString(),
          summaries: summaries.value.map((item) => ({ ...item, error: item.error ? describeError(item.error) : undefined })),
        },
        null,
        2,
      ),
      "mongo-compare-batch.json",
      "JSON",
      "json",
    );
  } catch (cause) {
    error.value = describeError(cause);
  }
}
</script>

<template>
  <Dialog
    :open="open"
    @update:open="
      (value) => {
        if (!syncing) open = value;
      }
    "
  >
    <DialogContent
      class="flex h-[min(900px,calc(100dvh-2rem))] max-w-[min(1380px,calc(100vw-2rem))] flex-col gap-0 p-0"
      :show-close-button="!syncing"
      @interact-outside.prevent
      @escape-key-down="
        (event) => {
          if (syncing) event.preventDefault();
        }
      "
    >
      <DialogHeader class="shrink-0 border-b border-border px-5 py-4">
        <DialogTitle class="flex items-center gap-2"><ArrowLeftRight class="size-4" />{{ t("mongoCompare.title") }}</DialogTitle>
        <p class="text-xs text-muted-foreground">{{ t("mongoCompare.subtitle") }}</p>
      </DialogHeader>
      <div class="min-h-0 flex-1 space-y-3 overflow-auto p-4">
        <MongoCompareConfigBar :snapshot="configSnapshot" :disabled="locked" @apply="applyConfig" />
        <label class="flex items-center gap-2 text-xs"><input v-model="batchMode" type="checkbox" :disabled="locked" />{{ t("mongoCompare.batchMode") }}</label>
        <div class="grid gap-3 md:grid-cols-2">
          <MongoCompareEndpointSelect v-model="source" :label="t('mongoCompare.source')" :disabled="locked" :database-only="batchMode" @loading="(value) => (sourceLoading = value)" @collections="(value) => (sourceCollections = value)" />
          <MongoCompareEndpointSelect v-model="target" :label="t('mongoCompare.target')" :disabled="locked" :database-only="batchMode" @loading="(value) => (targetLoading = value)" @collections="(value) => (targetCollections = value)" />
        </div>
        <MongoComparePairs v-if="batchMode" v-model="pairs" :source-collections="sourceCollections" :target-collections="targetCollections" :disabled="locked || sourceLoading || targetLoading" :default-match-fields="matchFields" />
        <div class="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_140px_auto]">
          <label class="space-y-1 text-xs"
            ><span>{{ t("mongoCompare.matchFields") }}</span
            ><Input v-model="matchFields" :disabled="locked" class="h-8 font-mono text-xs" placeholder="_id"
          /></label>
          <label class="space-y-1 text-xs"
            ><span>{{ t("mongoCompare.ignoreFields") }}</span
            ><Input v-model="ignoredFields" :disabled="locked" class="h-8 font-mono text-xs" placeholder="updatedAt,metadata.debug"
          /></label>
          <label class="space-y-1 text-xs"
            ><span>{{ t("mongoCompare.limit") }}</span
            ><Input v-model="limit" :disabled="locked" type="number" min="1" max="100000" class="h-8 text-xs"
          /></label>
          <Button v-if="loading" variant="outline" @click="cancel"><Square class="size-4" />{{ t("mongoCompare.cancel") }}</Button>
          <Button v-else :disabled="!ready" @click="runCompare()"><Play class="size-4" />{{ t("mongoCompare.run") }}</Button>
        </div>
        <label class="flex items-center gap-2 text-xs"><input v-model="numericTypesEqual" type="checkbox" :disabled="locked" />{{ t("mongoCompare.numericTypesEqual") }}</label>
        <p v-if="loading" role="status" class="flex items-center gap-2 text-xs">
          <Loader2 class="size-4 animate-spin motion-reduce:animate-none" />{{ batchRunning ? t("mongoCompare.batchProgress", { done: summaries.filter((item) => item.state === "complete" || item.state === "failed").length, total: summaries.length }) : t("mongoCompare.progress", counts) }}
        </p>
        <p v-if="error" role="alert" class="whitespace-pre-wrap break-all rounded-md border border-destructive/50 p-3 text-xs text-destructive">{{ error }}</p>
        <p v-if="notice" role="status" class="text-xs">{{ notice }}</p>
        <p v-if="truncated && result" role="alert" class="rounded-md bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
          {{ t("mongoCompare.truncated", { limit }) }}
        </p>
        <p v-if="stale" role="status" class="rounded-md bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">{{ t("mongoCompare.stale") }}</p>
        <section v-if="batchMode && summaries.length" class="space-y-2" :aria-label="t('mongoCompare.batchResults')">
          <div class="flex items-center justify-between">
            <h3 class="text-xs font-semibold">{{ t("mongoCompare.batchResults") }}</h3>
            <Button size="sm" variant="ghost" :disabled="locked" @click="exportBatch">{{ t("mongoCompare.exportSummary") }}</Button>
          </div>
          <div class="max-h-64 overflow-auto rounded-md border border-border">
            <table class="w-full text-xs">
              <thead class="sticky top-0 bg-muted">
                <tr>
                  <th class="p-2 text-left">{{ t("mongoCompare.pairs") }}</th>
                  <th class="p-2 text-left">{{ t("mongoCompare.status") }}</th>
                  <th v-for="status in statuses" :key="status" class="p-2 text-right">{{ t(`mongoCompare.${status}`) }}</th>
                  <th class="p-2">
                    <span class="sr-only">{{ t("mongoCompare.openPair") }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in summaries" :key="mongoPairKey(item.pair)" class="border-t border-border">
                  <td class="max-w-64 break-all p-2 font-mono">{{ item.pair.source }} → {{ item.pair.target }}</td>
                  <td class="max-w-72 break-all p-2">
                    <span>{{ t(`mongoCompare.batchStates.${item.state}`) }}</span
                    ><span v-if="item.truncated" class="ml-1 text-amber-800 dark:text-amber-200">{{ t("mongoCompare.partial") }}</span>
                    <p v-if="item.error" class="text-destructive">{{ describeError(item.error) }}</p>
                  </td>
                  <td v-for="status in statuses" :key="status" class="p-2 text-right">{{ item.counts?.[status] ?? "—" }}</td>
                  <td class="p-2">
                    <Button size="sm" variant="outline" :disabled="!endpointsReady" @click="runCompare(item.pair)">{{ t("mongoCompare.openPair") }}</Button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <template v-if="result">
          <p class="break-all text-xs font-semibold">{{ detailSource.database }}.{{ detailSource.collection }} → {{ detailTarget.database }}.{{ detailTarget.collection }}</p>
          <div class="flex flex-wrap items-center gap-2 border-y border-border py-2 text-xs">
            <span v-for="status in statuses" :key="status" class="rounded bg-muted px-2 py-1"
              >{{ t(`mongoCompare.${status}`) }} <strong>{{ result.counts[status] }}</strong></span
            >
            <span class="ml-auto text-muted-foreground">{{ t("mongoCompare.duration", { ms: duration }) }}</span>
            <Button variant="ghost" size="sm" :disabled="syncing" @click="exportResult('csv')"><Download class="size-3" />CSV</Button>
            <Button variant="ghost" size="sm" :disabled="syncing" @click="exportResult('json')">JSON</Button>
          </div>
          <div class="flex flex-wrap items-center gap-2 text-xs">
            <label
              >{{ t("mongoCompare.show") }}
              <select v-model="filter" class="rounded border border-input bg-background px-2 py-1" :disabled="locked">
                <option value="differences">{{ t("mongoCompare.differences") }}</option>
                <option value="all">{{ t("mongoCompare.all") }}</option>
                <option v-for="status in statuses" :key="status" :value="status">{{ t(`mongoCompare.${status}`) }}</option>
              </select></label
            >
            <Button variant="ghost" size="sm" :disabled="!syncReady" @click="selectPage">{{ t("mongoCompare.selectPage") }}</Button>
            <span>{{ t("mongoCompare.selected", { count: selectedRows.size }) }}</span>
            <div class="ml-auto flex items-center gap-1">
              <Button variant="ghost" size="sm" :disabled="page === 0 || locked" @click="page--">‹</Button><span>{{ page + 1 }} / {{ Math.max(1, Math.ceil(rows.length / 100)) }}</span
              ><Button variant="ghost" size="sm" :disabled="(page + 1) * 100 >= rows.length || locked" @click="page++">›</Button>
            </div>
          </div>
          <div class="max-h-52 overflow-auto rounded-md border border-border">
            <table class="w-full text-xs">
              <thead class="sticky top-0 bg-muted">
                <tr>
                  <th class="w-8 p-2">
                    <span class="sr-only">{{ t("mongoCompare.select") }}</span>
                  </th>
                  <th class="p-2 text-left">{{ t("mongoCompare.key") }}</th>
                  <th class="p-2 text-left">{{ t("mongoCompare.status") }}</th>
                  <th class="p-2 text-right">{{ t("mongoCompare.matches") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in pageRows" :key="row.key" :class="['border-t border-border', focusedKey === row.key && 'bg-accent']">
                  <td class="p-2">
                    <input type="checkbox" :aria-label="`${t('mongoCompare.select')}: ${row.key}`" :checked="selectedRows.has(row.key)" :disabled="!syncReady || row.status === 'same' || row.status === 'multiple'" @change="toggleRow(row.key)" />
                  </td>
                  <td class="max-w-96 p-2">
                    <button class="w-full break-all text-left font-mono hover:underline focus-visible:outline-ring" @click="focusedKey = row.key">{{ row.key }}</button>
                  </td>
                  <td
                    class="p-2 whitespace-nowrap"
                    :class="{
                      'text-amber-800 dark:text-amber-200': row.status === 'different',
                      'text-emerald-800 dark:text-emerald-200': row.status === 'sourceOnly',
                      'text-red-800 dark:text-red-200': row.status === 'targetOnly',
                    }"
                  >
                    {{ t(`mongoCompare.${row.status}`) }}
                  </td>
                  <td class="p-2 text-right">{{ row.sourceMatches }} / {{ row.targetMatches }}</td>
                </tr>
                <tr v-if="!rows.length">
                  <td colspan="4" class="p-6 text-center text-muted-foreground">{{ t("mongoCompare.noRows") }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <section v-if="focused" class="space-y-2">
            <p v-if="focused.status === 'multiple'" class="text-xs text-amber-800 dark:text-amber-200">{{ t("mongoCompare.multipleHint") }}</p>
            <div v-if="focused.fields.length" class="max-h-56 overflow-auto rounded-md border border-border">
              <table class="w-full table-fixed text-xs">
                <thead class="sticky top-0 bg-muted">
                  <tr>
                    <th class="w-1/5 p-2 text-left">{{ t("mongoCompare.field") }}</th>
                    <th class="p-2 text-left">{{ t("mongoCompare.source") }}</th>
                    <th class="p-2 text-left">{{ t("mongoCompare.target") }}</th>
                    <th class="w-24 p-2">{{ t("mongoCompare.syncField") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="field in focused.fields" :key="JSON.stringify(field.segments)" class="border-t border-border">
                    <td class="break-all p-2 font-mono">{{ field.path }}</td>
                    <td class="bg-emerald-500/5 p-2">
                      <pre class="whitespace-pre-wrap break-all">{{ display(field.source, field.sourceExists) }}</pre>
                    </td>
                    <td class="bg-red-500/5 p-2">
                      <pre class="whitespace-pre-wrap break-all">{{ display(field.target, field.targetExists) }}</pre>
                    </td>
                    <td class="p-1 text-center">
                      <Button variant="ghost" size="sm" :title="t('mongoCompare.syncToSource')" :aria-label="t('mongoCompare.syncToSource')" :disabled="!canWrite('source') || field.segments[0] === '_id'" @click="prepareSync('source', field.segments)">←</Button
                      ><Button variant="ghost" size="sm" :title="t('mongoCompare.syncToTarget')" :aria-label="t('mongoCompare.syncToTarget')" :disabled="!canWrite('target') || field.segments[0] === '_id'" @click="prepareSync('target', field.segments)">→</Button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <details :open="!focused.fields.length">
              <summary class="cursor-pointer text-xs">{{ t("mongoCompare.documents") }}</summary>
              <div class="mt-2 grid gap-2 md:grid-cols-2">
                <div v-for="side in ['source', 'target'] as const" :key="side" class="min-w-0 rounded-md border border-border p-2">
                  <h4 class="mb-1 text-xs font-semibold">{{ t(`mongoCompare.${side}`) }}</h4>
                  <pre class="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">{{ display(focused[side], !!focused[side]) }}</pre>
                </div>
              </div>
            </details>
          </section>
        </template>
        <p v-else-if="!loading" class="py-6 text-center text-sm text-muted-foreground">{{ t("mongoCompare.empty") }}</p>
        <section v-if="review" class="space-y-3 rounded-md border border-border bg-muted/20 p-3" aria-live="polite">
          <h3 class="text-sm font-semibold">{{ t("mongoCompare.reviewTitle", { count: review.changes.length, side: t(`mongoCompare.${review.destination}`) }) }}</h3>
          <p class="text-xs">{{ t("mongoCompare.reviewHint") }}</p>
          <div class="flex gap-4 text-xs">
            <span v-for="kind in ['insert', 'replace', 'delete'] as const" :key="kind">{{ t(`mongoCompare.${kind}`) }}: {{ review.changes.filter((change) => change.kind === kind).length }}</span>
          </div>
          <pre class="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-background p-2 text-xs">{{ review.text }}</pre>
          <div class="flex items-center gap-2">
            <Button :disabled="syncing" @click="confirmSync"><Loader2 v-if="syncing" class="size-4 animate-spin motion-reduce:animate-none" />{{ t("mongoCompare.confirmSync") }}</Button
            ><Button variant="outline" :disabled="syncing" @click="review = null">{{ t("mongoCompare.cancel") }}</Button
            ><span v-if="syncing" role="status" class="text-xs">{{ completedWrites }} / {{ review.changes.length }}</span>
          </div>
        </section>
      </div>
      <DialogFooter class="shrink-0 flex-wrap items-center border-t border-border px-4 py-3">
        <p class="mr-auto text-xs text-muted-foreground">{{ t("mongoCompare.idHint") }}</p>
        <Button variant="outline" :disabled="!canWrite('source') || !selectedRows.size" @click="prepareSync('source')">← {{ t("mongoCompare.syncToSource") }}</Button>
        <Button :disabled="!canWrite('target') || !selectedRows.size" @click="prepareSync('target')">{{ t("mongoCompare.syncToTarget") }} →</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

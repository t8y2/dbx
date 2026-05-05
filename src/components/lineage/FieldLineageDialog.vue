<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowUpRight, Check, Columns3, Copy, Eye, Filter, History, Link, Loader2, RefreshCw, Search, SearchX, X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogFooter, DialogHeader, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/api";
import {
  analyzeFieldLineage,
  summarizeLineageCounts,
  type FieldLineageConfidence,
  type FieldLineageItem,
  type FieldLineageResult,
  type FieldLineageTable,
  type FieldLineageView,
} from "@/lib/fieldLineage";

const props = defineProps<{
  open: boolean;
  prefillConnectionId: string;
  prefillDatabase: string;
  prefillSchema?: string;
  prefillTable: string;
  prefillColumn: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  "open-target": [value: {
    connectionId: string;
    database: string;
    schema?: string;
    tableName: string;
    columnName?: string;
  }];
}>();

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const dialogOpen = computed({
  get: () => props.open,
  set: (value) => emit("update:open", value),
});

const MAX_TABLES = 180;
const MAX_VIEW_DDLS = 60;
const BATCH_SIZE = 6;

const loading = ref(false);
const cancelled = ref(false);
const error = ref("");
const progressDone = ref(0);
const progressTotal = ref(0);
const result = ref<FieldLineageResult | null>(null);
const confidenceFilter = ref<"all" | FieldLineageConfidence>("all");
const searchText = ref("");
const copiedId = ref("");
let runId = 0;

const targetLabel = computed(() => {
  const scope = props.prefillSchema ? `${props.prefillSchema}.${props.prefillTable}` : props.prefillTable;
  return `${scope}.${props.prefillColumn}`;
});

const counts = computed(() => summarizeLineageCounts(result.value?.items ?? []));

const confidenceOptions = computed<Array<{ value: "all" | FieldLineageConfidence; label: string; count: number }>>(() => [
  { value: "all", label: t("lineage.all"), count: result.value?.items.length ?? 0 },
  { value: "certain", label: t("lineage.certain"), count: counts.value.certain },
  { value: "likely", label: t("lineage.likely"), count: counts.value.likely },
  { value: "possible", label: t("lineage.possible"), count: counts.value.possible },
]);

const filteredItems = computed(() => {
  const query = searchText.value.trim().toLowerCase();
  return (result.value?.items ?? [])
    .filter((item) => confidenceFilter.value === "all" || item.confidence === confidenceFilter.value)
    .filter((item) => {
      if (!query) return true;
      return [
        item.title,
        item.schema,
        item.table,
        item.column,
        item.sqlSnippet,
        itemKindLabel(item),
        itemDescription(item),
      ].some((value) => String(value ?? "").toLowerCase().includes(query));
    })
    .sort((a, b) => itemRank(a) - itemRank(b));
});

const filteredCounts = computed(() => summarizeLineageCounts(filteredItems.value));

watch(dialogOpen, (open) => {
  if (open) {
    confidenceFilter.value = "all";
    searchText.value = "";
    void loadLineage();
  } else {
    cancelLoad();
  }
});

function cancelLoad() {
  cancelled.value = true;
  runId++;
  loading.value = false;
}

async function loadLineage() {
  if (!props.prefillConnectionId || !props.prefillDatabase || !props.prefillTable || !props.prefillColumn) return;
  const currentRun = ++runId;
  loading.value = true;
  cancelled.value = false;
  error.value = "";
  result.value = null;
  progressDone.value = 0;
  progressTotal.value = 0;

  try {
    await connectionStore.ensureConnected(props.prefillConnectionId);
    if (isStale(currentRun)) return;

    const schema = props.prefillSchema || props.prefillDatabase;
    const tableInfos = prioritizeTargetTable(
      await api.listTables(props.prefillConnectionId, props.prefillDatabase, schema),
      props.prefillTable,
    ).slice(0, MAX_TABLES);
    const viewInfos = tableInfos.filter((table) => table.table_type.toUpperCase().includes("VIEW")).slice(0, MAX_VIEW_DDLS);
    progressTotal.value = tableInfos.length + viewInfos.length + 1;

    const tables: FieldLineageTable[] = [];
    for (let i = 0; i < tableInfos.length; i += BATCH_SIZE) {
      if (isStale(currentRun)) return;
      const batch = tableInfos.slice(i, i + BATCH_SIZE);
      const loaded = await Promise.all(batch.map(async (table) => {
        try {
          const columns = await api.getColumns(props.prefillConnectionId, props.prefillDatabase, schema, table.name);
          const foreignKeys = await api.listForeignKeys(props.prefillConnectionId, props.prefillDatabase, schema, table.name);
          return {
            schema,
            name: table.name,
            columns: columns.map((column) => column.name),
            foreignKeys,
          };
        } catch {
          return { schema, name: table.name, columns: [], foreignKeys: [] };
        }
      }));
      tables.push(...loaded);
      progressDone.value += batch.length;
    }

    const views: FieldLineageView[] = [];
    for (const view of viewInfos) {
      if (isStale(currentRun)) return;
      try {
        const ddl = await api.getTableDdl(props.prefillConnectionId, props.prefillDatabase, schema, view.name);
        views.push({ schema, name: view.name, ddl });
      } catch {
        // Some drivers may not expose view DDL consistently; keep the rest of the lineage usable.
      } finally {
        progressDone.value++;
      }
    }

    const histories = (await api.loadHistory(200, 0))
      .filter((entry) => !entry.database || entry.database === props.prefillDatabase)
      .map((entry) => ({ id: entry.id, sql: entry.sql, executed_at: entry.executed_at }));
    progressDone.value++;
    if (isStale(currentRun)) return;

    result.value = analyzeFieldLineage({
      target: {
        schema,
        table: props.prefillTable,
        column: props.prefillColumn,
      },
      tables,
      views,
      histories,
    });
  } catch (e: any) {
    if (!isStale(currentRun)) error.value = e?.message || String(e);
  } finally {
    if (!isStale(currentRun)) loading.value = false;
  }
}

function isStale(id: number) {
  return cancelled.value || id !== runId;
}

function prioritizeTargetTable<T extends { name: string }>(tables: T[], targetTable: string): T[] {
  return [...tables].sort((a, b) => Number(a.name !== targetTable) - Number(b.name !== targetTable));
}

function itemIcon(item: FieldLineageItem) {
  if (item.kind === "foreignKey") return Link;
  if (item.kind === "viewReference") return Eye;
  if (item.kind === "historyReference") return History;
  return Columns3;
}

function confidenceVariant(confidence: FieldLineageItem["confidence"]) {
  return confidence === "certain" ? "default" : "secondary";
}

function confidenceTone(confidence: FieldLineageItem["confidence"]) {
  if (confidence === "certain") return "text-emerald-600 bg-emerald-50 border-emerald-200";
  if (confidence === "likely") return "text-blue-600 bg-blue-50 border-blue-200";
  return "text-zinc-600 bg-zinc-50 border-zinc-200";
}

function itemRank(item: FieldLineageItem) {
  const confidenceRank = item.confidence === "certain" ? 0 : item.confidence === "likely" ? 10 : 20;
  const kindRank = item.kind === "foreignKey" ? 0 : item.kind === "viewReference" ? 1 : item.kind === "historyReference" ? 2 : 3;
  return confidenceRank + kindRank;
}

function itemKindLabel(item: FieldLineageItem) {
  return t(`lineage.kind.${item.kind}`);
}

function itemPrimaryLabel(item: FieldLineageItem) {
  if (item.kind === "historyReference") return t("lineage.queryHistory");
  if (item.table && item.column) return `${item.table}.${item.column}`;
  if (item.table) return `${item.table}.${props.prefillColumn}`;
  return item.title;
}

function itemDescription(item: FieldLineageItem) {
  if (item.kind === "foreignKey") {
    if (item.direction === "incoming") {
      return t("lineage.description.foreignKeyIncoming", { target: `${item.table}.${item.column}` });
    }
    return t("lineage.description.foreignKeyOutgoing", { target: `${item.table}.${item.column}` });
  }
  if (item.kind === "viewReference") {
    return item.confidence === "likely"
      ? t("lineage.description.viewLikely")
      : t("lineage.description.viewPossible");
  }
  if (item.kind === "historyReference") {
    return item.confidence === "likely"
      ? t("lineage.description.historyLikely")
      : t("lineage.description.historyPossible");
  }
  return t("lineage.description.sameName");
}

function copyItem(item: FieldLineageItem) {
  const text = itemPrimaryLabel(item);
  navigator.clipboard.writeText(text);
  copiedId.value = item.id;
  toast(t("lineage.copied"));
  setTimeout(() => {
    if (copiedId.value === item.id) copiedId.value = "";
  }, 1400);
}

function openItemTarget(item: FieldLineageItem) {
  if (!item.table) return;
  emit("open-target", {
    connectionId: props.prefillConnectionId,
    database: props.prefillDatabase,
    schema: item.schema || props.prefillSchema,
    tableName: item.table,
    columnName: item.column || props.prefillColumn,
  });
}
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogScrollContent class="h-[78vh] min-h-[560px] max-h-[780px] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden gap-0 p-0 sm:max-w-[980px]">
      <DialogHeader class="border-b px-6 py-4 pr-12">
        <DialogTitle class="flex items-center gap-2 text-lg">
          <Link class="h-5 w-5" />
          {{ t('lineage.title') }}
        </DialogTitle>
      </DialogHeader>

      <div class="flex min-h-0 flex-col overflow-hidden">
        <div class="border-b bg-muted/10 px-6 py-3">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="text-xs text-muted-foreground">{{ t('lineage.targetField') }}</div>
              <div class="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-sm">
                <span class="max-w-[520px] truncate font-semibold">{{ targetLabel }}</span>
                <Badge variant="outline">{{ props.prefillDatabase }}</Badge>
                <Badge v-if="props.prefillSchema" variant="outline">{{ props.prefillSchema }}</Badge>
              </div>
            </div>
            <div v-if="result" class="flex flex-wrap gap-2 text-xs">
              <Badge>{{ t('lineage.certain') }} {{ counts.certain }}</Badge>
              <Badge variant="secondary">{{ t('lineage.likely') }} {{ counts.likely }}</Badge>
              <Badge variant="outline">{{ t('lineage.possible') }} {{ counts.possible }}</Badge>
            </div>
          </div>

          <div v-if="result" class="mt-3 flex flex-col gap-2 lg:flex-row lg:items-center">
            <div class="relative min-w-0 flex-1">
              <Search class="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input v-model="searchText" class="h-8 pl-8 text-sm" :placeholder="t('lineage.searchPlaceholder')" />
            </div>
            <div class="flex items-center gap-2 overflow-x-auto">
              <Filter class="h-4 w-4 shrink-0 text-muted-foreground" />
              <Button
                v-for="option in confidenceOptions"
                :key="option.value"
                size="sm"
                :variant="confidenceFilter === option.value ? 'default' : 'outline'"
                class="h-8 shrink-0 px-3"
                @click="confidenceFilter = option.value"
              >
                {{ option.label }} {{ option.count }}
              </Button>
            </div>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div v-if="loading" class="rounded-md border bg-muted/20 p-4">
          <div class="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 class="h-4 w-4 animate-spin" />
            {{ t('lineage.loading', { done: progressDone, total: progressTotal || '-' }) }}
          </div>
        </div>

        <div v-else-if="error" class="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {{ error }}
        </div>

        <div v-else-if="result && result.items.length === 0" class="flex flex-col items-center justify-center gap-2 rounded-md border py-12 text-sm text-muted-foreground">
          <SearchX class="h-8 w-8" />
          {{ t('lineage.empty') }}
        </div>

        <template v-else-if="result">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{{ t('lineage.showing', { shown: filteredItems.length, total: result.items.length }) }}</span>
            <span v-if="filteredItems.length">
              {{ t('lineage.certain') }} {{ filteredCounts.certain }} ·
              {{ t('lineage.likely') }} {{ filteredCounts.likely }} ·
              {{ t('lineage.possible') }} {{ filteredCounts.possible }}
            </span>
          </div>

          <div v-if="filteredItems.length === 0" class="flex flex-col items-center justify-center gap-2 rounded-md border py-12 text-sm text-muted-foreground">
            <SearchX class="h-8 w-8" />
            {{ t('lineage.noFiltered') }}
          </div>

          <div v-else class="space-y-2">
            <div v-for="item in filteredItems" :key="item.id" class="rounded-md border bg-background transition-colors hover:bg-muted/25">
              <div class="flex items-start gap-3 p-3">
                <div :class="['mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border', confidenceTone(item.confidence)]">
                  <component :is="itemIcon(item)" class="h-4 w-4" />
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 flex-wrap items-center gap-2">
                    <button
                      v-if="item.table"
                      type="button"
                      class="group inline-flex min-w-0 max-w-[560px] items-center gap-1 truncate rounded-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      :title="t('lineage.openTable')"
                      @click="openItemTarget(item)"
                    >
                      <span class="truncate">{{ itemPrimaryLabel(item) }}</span>
                      <ArrowUpRight class="h-3.5 w-3.5 shrink-0 opacity-70 transition-opacity group-hover:opacity-100" />
                    </button>
                    <span v-else class="max-w-[560px] truncate font-medium">{{ itemPrimaryLabel(item) }}</span>
                    <Badge v-if="item.schema" variant="outline" class="text-[10px]">{{ item.schema }}</Badge>
                    <Badge variant="outline" class="text-[10px]">{{ itemKindLabel(item) }}</Badge>
                    <Badge :variant="confidenceVariant(item.confidence)" class="text-[10px]">{{ t(`lineage.${item.confidence}`) }}</Badge>
                  </div>
                  <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ itemDescription(item) }}</p>
                  <pre v-if="item.sqlSnippet" class="mt-2 max-h-20 overflow-auto rounded-md bg-muted/40 p-2 text-xs whitespace-pre-wrap">{{ item.sqlSnippet }}</pre>
                </div>
                <Button variant="ghost" size="sm" class="h-8 w-8 shrink-0 p-0" :title="t('lineage.copy')" @click="copyItem(item)">
                  <Check v-if="copiedId === item.id" class="h-4 w-4 text-emerald-600" />
                  <Copy v-else class="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </template>
        </div>
      </div>

      <DialogFooter class="border-t px-6 py-4">
        <Button v-if="loading" variant="outline" @click="cancelLoad">
          <X class="h-4 w-4" />
          {{ t('lineage.cancel') }}
        </Button>
        <Button v-else variant="outline" @click="loadLineage">
          <RefreshCw class="h-4 w-4" />
          {{ t('lineage.refresh') }}
        </Button>
        <Button @click="dialogOpen = false">{{ t('common.close') }}</Button>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>
</template>

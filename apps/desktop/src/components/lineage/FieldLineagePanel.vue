<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import { ArrowUpRight, Check, Columns3, Copy, Eye, Filter, History, Link, Loader2, RefreshCw, Search, SearchX, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import { cancelFieldLineageSession, getFieldLineageSession, startFieldLineageSession, type FieldLineageSessionConfig } from "@/composables/useFieldLineageSession";
import { summarizeLineageCounts, type FieldLineageConfidence, type FieldLineageItem } from "@/lib/diagram/fieldLineage";
import { copyToClipboard } from "@/lib/common/clipboard";
import type { DatabaseType, FieldLineageTabState } from "@/types/database";

const props = withDefaults(
  defineProps<{
    prefillConnectionId?: string;
    prefillDatabase?: string;
    prefillSchema?: string;
    prefillTable?: string;
    prefillColumn?: string;
    prefillDatabaseType?: DatabaseType;
    /** Dialog form factor: footer actions. Tab form factor: top toolbar + convert action. */
    inDialog?: boolean;
    /** Serialized snapshot a converted tab (or dialog) resumes from. */
    initialState?: FieldLineageTabState;
  }>(),
  { prefillConnectionId: undefined, prefillDatabase: undefined, prefillSchema: undefined, prefillTable: undefined, prefillColumn: undefined, prefillDatabaseType: undefined, inDialog: true, initialState: undefined },
);

const emit = defineEmits<{
  "update:state": [state: FieldLineageTabState];
  "update:initial-state": [state: FieldLineageTabState | undefined];
  "open-target": [
    value: {
      connectionId: string;
      database: string;
      schema?: string;
      tableName: string;
      tableType?: string;
      columnName?: string;
    },
  ];
}>();

const { t } = useI18n();
const { toast } = useToast();
const { highlight } = useSqlHighlighter();
const connectionStore = useConnectionStore();

const open = defineModel<boolean>("open", { default: false });

/** The panel works on one config: from the converted snapshot, or from the dialog prefill props. */
const config = computed<FieldLineageSessionConfig | null>(() => {
  if (props.initialState) return { databaseType: props.prefillDatabaseType, ...props.initialState.config };
  if (!props.prefillConnectionId || !props.prefillDatabase || !props.prefillTable || !props.prefillColumn) return null;
  return {
    connectionId: props.prefillConnectionId,
    database: props.prefillDatabase,
    schema: props.prefillSchema,
    table: props.prefillTable,
    column: props.prefillColumn,
    databaseType: props.prefillDatabaseType,
  };
});

const activeSessionId = ref<string | null>(props.initialState?.sessionId ?? null);
const session = computed(() => getFieldLineageSession(activeSessionId.value));
const loading = computed(() => session.value?.status === "running");
const errorText = computed(() => (session.value?.status === "failed" ? (session.value.error ?? "") : ""));
const result = computed(() => session.value?.result ?? null);
const progressDone = computed(() => session.value?.progress?.done ?? 0);
const progressTotal = computed(() => session.value?.progress?.total ?? 0);
const isXugu = computed(() => config.value?.databaseType === "xugu");
const coverage = computed(() => session.value?.coverage ?? null);
const hasIncompleteCoverage = computed(() => !!coverage.value && Object.values(coverage.value).some((count) => count > 0));

const confidenceFilter = ref<"all" | FieldLineageConfidence>("all");
const searchText = ref("");
const copiedId = ref("");

const targetLabel = computed(() => {
  const cfg = config.value;
  if (!cfg) return "";
  const scope = cfg.schema ? `${cfg.schema}.${cfg.table}` : cfg.table;
  return `${scope}.${cfg.column}`;
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
      return [item.title, item.schema, item.table, item.column, item.sqlSnippet, itemKindLabel(item), itemDescription(item)].some((value) =>
        String(value ?? "")
          .toLowerCase()
          .includes(query),
      );
    })
    .sort((a, b) => itemRank(a) - itemRank(b));
});

const filteredCounts = computed(() => summarizeLineageCounts(filteredItems.value));

/** Starts a run for the current config, reusing an existing session for the same field. */
function runAnalysis() {
  const cfg = config.value;
  if (!cfg) return;
  const started = startFieldLineageSession(cfg, { ensureConnected: (connectionId) => connectionStore.ensureConnected(connectionId) });
  activeSessionId.value = started.id;
}

function cancelAnalysis() {
  if (activeSessionId.value) cancelFieldLineageSession(activeSessionId.value);
}

/** Serializable snapshot for dialog/tab conversion; the session id reattaches the running analysis. */
function getCurrentState(): FieldLineageTabState {
  return {
    config: config.value ?? { connectionId: "", database: "", table: "", column: "" },
    sessionId: activeSessionId.value,
  };
}

function restoreDialogSnapshot(): boolean {
  const state = props.initialState;
  if (!state) return false;
  confidenceFilter.value = "all";
  searchText.value = "";
  activeSessionId.value = state.sessionId ?? null;
  // No live session (e.g. it was cancelled or the dialog was reopened later): rerun for the snapshot's field.
  if (!getFieldLineageSession(activeSessionId.value)) runAnalysis();
  emit("update:initial-state", undefined);
  return true;
}

// Dialog form factor keeps the original open-driven run/cancel lifecycle.
watch(
  open,
  (isOpen) => {
    if (!props.inDialog) return;
    if (isOpen) {
      confidenceFilter.value = "all";
      searchText.value = "";
      if (restoreDialogSnapshot()) return;
      runAnalysis();
    } else {
      cancelAnalysis();
    }
  },
  { immediate: true },
);

// A snapshot can also arrive while the dialog is already open (tab -> dialog conversion).
watch(
  () => props.initialState,
  (state) => {
    if (!props.inDialog || !state || !open.value) return;
    restoreDialogSnapshot();
  },
);

onMounted(() => {
  if (props.inDialog) return;
  if (props.initialState?.sessionId && getFieldLineageSession(props.initialState.sessionId)) {
    activeSessionId.value = props.initialState.sessionId;
    return;
  }
  runAnalysis();
});

// Tab form factor mirrors the snapshot (config + session id) to the tab payload, debounced.
let stateEmitTimer: ReturnType<typeof setTimeout> | undefined;
let componentUnmounted = false;
watch(
  () => [targetLabel.value, activeSessionId.value] as const,
  () => {
    if (props.inDialog) return;
    if (stateEmitTimer) clearTimeout(stateEmitTimer);
    stateEmitTimer = setTimeout(() => {
      stateEmitTimer = undefined;
      if (!componentUnmounted) emit("update:state", getCurrentState());
    }, 400);
  },
);

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
  if (item.table) return `${item.table}.${config.value?.column ?? ""}`;
  return item.title;
}

function itemDescription(item: FieldLineageItem) {
  if (item.kind === "foreignKey") {
    if (item.direction === "incoming") {
      return t("lineage.description.foreignKeyIncoming", {
        target: `${item.table}.${item.column}`,
      });
    }
    return t("lineage.description.foreignKeyOutgoing", { target: `${item.table}.${item.column}` });
  }
  if (item.kind === "viewReference") {
    return item.confidence === "likely" ? t("lineage.description.viewLikely") : t("lineage.description.viewPossible");
  }
  if (item.kind === "historyReference") {
    return item.confidence === "likely" ? t("lineage.description.historyLikely") : t("lineage.description.historyPossible");
  }
  return t("lineage.description.sameName");
}

async function copyItem(item: FieldLineageItem) {
  const text = itemPrimaryLabel(item);
  try {
    await copyToClipboard(text);
    copiedId.value = item.id;
    toast(t("lineage.copied"));
    setTimeout(() => {
      if (copiedId.value === item.id) copiedId.value = "";
    }, 1400);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function openItemTarget(item: FieldLineageItem) {
  const cfg = config.value;
  if (!item.table || !cfg) return;
  emit("open-target", {
    connectionId: cfg.connectionId,
    database: cfg.database,
    schema: item.schema || cfg.schema,
    tableName: item.table,
    tableType: item.kind === "viewReference" ? "VIEW" : "TABLE",
    columnName: item.column || cfg.column,
  });
}

defineExpose({ getCurrentState });
</script>

<template>
  <div :class="['flex min-h-0 min-w-0 flex-col', props.inDialog ? 'flex-1 overflow-hidden' : 'h-full bg-background']">
    <!-- Tab form factor: action bar on top (footer actions become toolbar actions). -->
    <div v-if="!props.inDialog" class="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/10 px-5 py-2">
      <Link class="h-4 w-4 text-muted-foreground" />
      <span class="font-medium text-sm">{{ t("lineage.title") }}</span>
      <span class="text-xs text-muted-foreground truncate">{{ targetLabel }}</span>
      <span class="flex-1" />
      <Button v-if="loading" variant="outline" size="sm" @click="cancelAnalysis">
        <X class="h-3.5 w-3.5 mr-1" />
        {{ t("lineage.cancel") }}
      </Button>
      <Button v-else variant="outline" size="sm" @click="runAnalysis">
        <RefreshCw class="h-3.5 w-3.5 mr-1" />
        {{ t("lineage.refresh") }}
      </Button>
    </div>

    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div class="border-b bg-muted/10 px-6 py-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="text-xs text-muted-foreground">{{ t("lineage.targetField") }}</div>
            <div class="mt-1 flex min-w-0 flex-wrap items-center gap-2 text-sm">
              <span class="max-w-[520px] truncate font-semibold">{{ targetLabel }}</span>
              <Badge variant="outline">{{ config?.database }}</Badge>
              <Badge v-if="config?.schema" variant="outline">{{ config.schema }}</Badge>
            </div>
          </div>
          <div v-if="result" class="flex flex-wrap gap-2 text-xs">
            <Badge>{{ t("lineage.certain") }} {{ counts.certain }}</Badge>
            <Badge variant="secondary">{{ t("lineage.likely") }} {{ counts.likely }}</Badge>
            <Badge variant="outline">{{ t("lineage.possible") }} {{ counts.possible }}</Badge>
          </div>
        </div>

        <div v-if="result" class="mt-3 flex flex-col gap-2 lg:flex-row lg:items-center">
          <div class="relative min-w-0 flex-1">
            <Search class="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="searchText" class="h-8 pl-8 text-sm" :placeholder="t('lineage.searchPlaceholder')" />
          </div>
          <div class="flex items-center gap-2 overflow-x-auto">
            <Filter class="h-4 w-4 shrink-0 text-muted-foreground" />
            <Button v-for="option in confidenceOptions" :key="option.value" size="sm" :variant="confidenceFilter === option.value ? 'default' : 'outline'" class="h-8 shrink-0 px-3" @click="confidenceFilter = option.value"> {{ option.label }} {{ option.count }} </Button>
          </div>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div v-if="isXugu" class="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-5 text-muted-foreground">
          {{ t("lineage.xuguScopeNotice", { schema: config?.schema || config?.database || "" }) }}
        </div>
        <div v-if="isXugu && hasIncompleteCoverage" class="mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-5 text-amber-800 dark:text-amber-200">
          {{
            t("lineage.xuguPartialCoverage", {
              skippedTables: coverage?.skippedTables ?? 0,
              skippedViews: coverage?.skippedViews ?? 0,
              omittedTables: coverage?.omittedTables ?? 0,
              omittedViews: coverage?.omittedViews ?? 0,
            })
          }}
        </div>
        <div v-if="loading" class="rounded-md border bg-muted/20 p-4">
          <div class="flex items-center gap-2 text-sm text-muted-foreground tabular-nums">
            <Loader2 class="h-4 w-4 animate-spin" />
            {{ t("lineage.loading", { done: progressDone, total: progressTotal || "-" }) }}
          </div>
        </div>

        <div v-else-if="errorText" class="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {{ errorText }}
        </div>

        <div v-else-if="result && result.items.length === 0" class="flex flex-col items-center justify-center gap-2 rounded-md border py-12 text-sm text-muted-foreground">
          <SearchX class="h-8 w-8" />
          {{ t("lineage.empty") }}
        </div>

        <template v-else-if="result">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{{ t("lineage.showing", { shown: filteredItems.length, total: result.items.length }) }}</span>
            <span v-if="filteredItems.length">
              {{ t("lineage.certain") }} {{ filteredCounts.certain }} · {{ t("lineage.likely") }} {{ filteredCounts.likely }} · {{ t("lineage.possible") }}
              {{ filteredCounts.possible }}
            </span>
          </div>

          <div v-if="filteredItems.length === 0" class="flex flex-col items-center justify-center gap-2 rounded-md border py-12 text-sm text-muted-foreground">
            <SearchX class="h-8 w-8" />
            {{ t("lineage.noFiltered") }}
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
                  <p class="mt-1 text-xs leading-5 text-muted-foreground">
                    {{ itemDescription(item) }}
                  </p>
                  <pre v-if="item.sqlSnippet" class="mt-2 max-h-20 overflow-auto rounded-md bg-muted/40 p-2 text-xs whitespace-pre-wrap" v-html="highlight(item.sqlSnippet)" />
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

    <!-- Dialog form factor: footer actions. -->
    <DialogFooter v-if="props.inDialog" class="border-t px-6 py-4">
      <Button v-if="loading" variant="outline" @click="cancelAnalysis">
        <X class="h-4 w-4" />
        {{ t("lineage.cancel") }}
      </Button>
      <Button v-else variant="outline" @click="runAnalysis">
        <RefreshCw class="h-4 w-4" />
        {{ t("lineage.refresh") }}
      </Button>
      <Button @click="open = false">{{ t("common.close") }}</Button>
    </DialogFooter>
  </div>
</template>

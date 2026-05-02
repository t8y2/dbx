<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Columns3, Eye, History, Link, Loader2, RefreshCw, SearchX, X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogFooter, DialogHeader, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/tauri";
import {
  analyzeFieldLineage,
  summarizeLineageCounts,
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
}>();

const { t } = useI18n();
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
let runId = 0;

const targetLabel = computed(() => {
  const scope = props.prefillSchema ? `${props.prefillSchema}.${props.prefillTable}` : props.prefillTable;
  return `${scope}.${props.prefillColumn}`;
});

const counts = computed(() => summarizeLineageCounts(result.value?.items ?? []));

const groupedItems = computed(() => ({
  certain: (result.value?.items ?? []).filter((item) => item.confidence === "certain"),
  likely: (result.value?.items ?? []).filter((item) => item.confidence === "likely"),
  possible: (result.value?.items ?? []).filter((item) => item.confidence === "possible"),
}));

watch(dialogOpen, (open) => {
  if (open) void loadLineage();
  else cancelLoad();
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
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogScrollContent class="sm:max-w-[900px] max-h-[86vh]">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Link class="h-4 w-4" />
          {{ t('lineage.title') }}
        </DialogTitle>
      </DialogHeader>

      <div class="space-y-4">
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="font-medium">{{ targetLabel }}</span>
          <Badge variant="outline">{{ props.prefillDatabase }}</Badge>
          <Badge v-if="props.prefillSchema" variant="outline">{{ props.prefillSchema }}</Badge>
        </div>

        <div v-if="loading" class="rounded border bg-muted/20 p-4">
          <div class="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 class="h-4 w-4 animate-spin" />
            {{ t('lineage.loading', { done: progressDone, total: progressTotal || '-' }) }}
          </div>
        </div>

        <div v-else-if="error" class="rounded border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {{ error }}
        </div>

        <div v-else-if="result && result.items.length === 0" class="flex flex-col items-center justify-center gap-2 rounded border py-12 text-sm text-muted-foreground">
          <SearchX class="h-8 w-8" />
          {{ t('lineage.empty') }}
        </div>

        <template v-else-if="result">
          <div class="flex flex-wrap gap-2 text-xs">
            <Badge>{{ t('lineage.certain') }} {{ counts.certain }}</Badge>
            <Badge variant="secondary">{{ t('lineage.likely') }} {{ counts.likely }}</Badge>
            <Badge variant="outline">{{ t('lineage.possible') }} {{ counts.possible }}</Badge>
          </div>

          <section
            v-for="group in [
              { key: 'certain', label: t('lineage.certain'), items: groupedItems.certain },
              { key: 'likely', label: t('lineage.likely'), items: groupedItems.likely },
              { key: 'possible', label: t('lineage.possible'), items: groupedItems.possible },
            ]"
            :key="group.key"
            class="space-y-2"
          >
            <h3 v-if="group.items.length" class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ group.label }}</h3>
            <div v-for="item in group.items" :key="item.id" class="rounded border p-3">
              <div class="flex items-start gap-2">
                <component :is="itemIcon(item)" class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                <div class="min-w-0 flex-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-medium">{{ item.title }}</span>
                    <Badge :variant="confidenceVariant(item.confidence)" class="text-[10px]">{{ t(`lineage.${item.confidence}`) }}</Badge>
                  </div>
                  <p class="mt-1 text-sm text-muted-foreground">{{ item.description }}</p>
                  <pre v-if="item.sqlSnippet" class="mt-2 max-h-24 overflow-auto rounded bg-muted/40 p-2 text-xs whitespace-pre-wrap">{{ item.sqlSnippet }}</pre>
                </div>
              </div>
            </div>
          </section>
        </template>
      </div>

      <DialogFooter>
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

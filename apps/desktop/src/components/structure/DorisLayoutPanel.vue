<script setup lang="ts">
import { computed, ref } from "vue";
import { Copy, Loader2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { dorisPartitionRangeText, dorisPartitionSearchText } from "@/lib/table/dorisLayout";
import type { DorisPartitionInfo, DorisTableLayout } from "@/types/database";

interface Props {
  layout: DorisTableLayout | null;
  loading: boolean;
  error: string;
  searchQuery?: string;
}

const props = defineProps<Props>();
const { t } = useI18n();
const copied = ref(false);

const modelLabel = computed(() => {
  switch (props.layout?.model) {
    case "duplicate":
      return t("dorisLayout.modelDuplicate");
    case "unique":
      return t("dorisLayout.modelUnique");
    case "aggregate":
      return t("dorisLayout.modelAggregate");
    default:
      return t("dorisLayout.unknown");
  }
});

const partitionLabel = computed(() => {
  const partition = props.layout?.partition;
  if (!partition?.enabled) return t("dorisLayout.notPartitioned");
  const kind = partition.mode === "list" ? t("dorisLayout.partitionList") : partition.mode === "range" ? t("dorisLayout.partitionRange") : t("dorisLayout.unknown");
  return partition.auto ? `${t("dorisLayout.partitionAuto")} · ${kind}` : kind;
});

const partitionColumnsText = computed(() => {
  const partition = props.layout?.partition;
  if (!partition?.enabled) return "";
  if (partition.expression) return partition.expression;
  return partition.columns.join(", ");
});

const distributionLabel = computed(() => {
  const distribution = props.layout?.distribution;
  if (distribution?.method === "hash") return t("dorisLayout.distributionHash");
  if (distribution?.method === "random") return t("dorisLayout.distributionRandom");
  return t("dorisLayout.unknown");
});

const bucketLabel = computed(() => {
  const distribution = props.layout?.distribution;
  if (!distribution) return "-";
  if (distribution.autoBuckets) return t("dorisLayout.bucketsAuto");
  return distribution.buckets !== null ? String(distribution.buckets) : "-";
});

const propertyRows = computed(() => Object.entries(props.layout?.properties ?? {}).sort(([a], [b]) => a.localeCompare(b)));
const currentReplicas = computed(() => {
  const property = Object.entries(props.layout?.properties ?? {}).find(([key]) => key.toLowerCase() === "replication_num");
  if (property) return property[1];
  const first = props.layout?.partitions.find((partition) => partition.replicationNum !== null && partition.replicationNum !== undefined);
  const value = first?.replicationNum;
  return value !== null && value !== undefined ? String(value) : "-";
});

const rows = computed(() => {
  const query = props.searchQuery?.trim().toLowerCase();
  const partitions = props.layout?.partitions ?? [];
  return query ? partitions.filter((partition) => dorisPartitionSearchText(partition).includes(query)) : partitions;
});

function rowBuckets(partition: DorisPartitionInfo): string {
  if (partition.buckets !== null && partition.buckets !== undefined) return String(partition.buckets);
  return partition.bucketsRaw?.trim() || "-";
}

function rowRange(partition: DorisPartitionInfo): string {
  return dorisPartitionRangeText(partition.range) || "-";
}

function emptyMessage(): string {
  const layout = props.layout;
  if (!layout) return t("dorisLayout.unavailable");
  if (layout.kind === "nonOlap" || layout.unavailableReason === "notOlap") return t("dorisLayout.notOlap");
  if (layout.unavailableReason === "externalCatalog") return t("dorisLayout.externalCatalog");
  if (layout.unavailableReason === "permissionDenied") return t("dorisLayout.permissionDenied");
  if (!layout.partition.enabled) return t("dorisLayout.notPartitioned");
  return props.searchQuery ? t("dorisLayout.noSearchResults") : t("dorisLayout.empty");
}

async function copyRows() {
  const header = [t("dorisLayout.partitionName"), t("dorisLayout.partitionRangeColumn"), t("dorisLayout.partitionBuckets"), t("dorisLayout.partitionReplicas"), t("dorisLayout.partitionState"), t("dorisLayout.partitionSize"), t("dorisLayout.partitionVersion")].join("\t");
  const body = rows.value.map((partition) => [partition.name, rowRange(partition), rowBuckets(partition), partition.replicationNum ?? "", partition.state ?? "", partition.dataSize ?? "", partition.visibleVersion ?? ""].join("\t"));
  try {
    await navigator.clipboard.writeText([header, ...body].join("\n"));
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <div data-doris-layout class="flex-1 min-h-0 overflow-auto">
    <div v-if="props.loading" class="h-full flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" />
      {{ t("common.loading") }}
    </div>
    <div v-else-if="props.error" class="p-3 text-xs text-destructive">
      {{ props.error }}
    </div>
    <template v-else-if="props.layout">
      <div class="border-b px-3 py-2 text-xs">
        <div class="flex flex-wrap items-center gap-1.5">
          <span data-doris-model class="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ modelLabel }}</span>
          <span class="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ t("dorisLayout.keyColumns") }}: {{ props.layout.keyColumns.length ? props.layout.keyColumns.join(", ") : "-" }}</span>
          <span data-doris-partition class="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ t("dorisLayout.partition") }}: {{ partitionLabel }}</span>
          <span v-if="partitionColumnsText" class="rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{{ partitionColumnsText }}</span>
          <span data-doris-distribution class="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ t("dorisLayout.distribution") }}: {{ distributionLabel }}</span>
          <span v-if="props.layout.distribution.columns.length" class="rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{{ props.layout.distribution.columns.join(", ") }}</span>
          <span data-doris-buckets class="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ t("dorisLayout.buckets") }}: {{ bucketLabel }}</span>
          <span class="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ t("dorisLayout.replication") }}: {{ currentReplicas }}</span>
          <span v-if="props.layout.dynamicPartition" class="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ t("dorisLayout.dynamicPartition") }}</span>
          <span v-if="props.layout.colocateWith" class="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ t("dorisLayout.colocateWith") }}: {{ props.layout.colocateWith }}</span>
        </div>
        <div v-if="props.layout.unavailableReason" data-doris-unavailable class="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-300">
          {{ emptyMessage() }}
        </div>
        <div v-if="props.layout.warnings.length" data-doris-warning class="mt-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
          <div v-for="warning in props.layout.warnings" :key="warning">{{ warning }}</div>
        </div>
      </div>

      <details v-if="propertyRows.length" class="border-b px-3 py-2 text-xs">
        <summary class="cursor-pointer text-muted-foreground">{{ t("dorisLayout.properties") }} ({{ propertyRows.length }})</summary>
        <dl class="mt-2 grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-[11px]">
          <template v-for="[key, value] in propertyRows" :key="key">
            <dt class="truncate text-muted-foreground">{{ key }}</dt>
            <dd class="break-all">{{ value }}</dd>
          </template>
        </dl>
      </details>

      <div v-if="rows.length" class="min-w-0">
        <div class="flex items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground">
          <span>{{ t("dorisLayout.partitionCount", { count: rows.length }) }}</span>
          <button type="button" data-doris-copy class="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 hover:text-foreground" @click="copyRows">
            <Copy class="h-3.5 w-3.5" />
            {{ copied ? t("dorisLayout.copied") : t("dorisLayout.copy") }}
          </button>
        </div>
        <table class="w-full text-xs">
          <thead class="sticky top-0 bg-muted text-muted-foreground">
            <tr class="border-b">
              <th class="px-3 py-2 text-left font-medium">{{ t("dorisLayout.partitionName") }}</th>
              <th class="px-3 py-2 text-left font-medium">{{ t("dorisLayout.partitionRangeColumn") }}</th>
              <th class="px-3 py-2 text-right font-medium">{{ t("dorisLayout.partitionBuckets") }}</th>
              <th class="px-3 py-2 text-right font-medium">{{ t("dorisLayout.partitionReplicas") }}</th>
              <th class="px-3 py-2 text-left font-medium">{{ t("dorisLayout.partitionState") }}</th>
              <th class="px-3 py-2 text-right font-medium">{{ t("dorisLayout.partitionSize") }}</th>
              <th class="px-3 py-2 text-right font-medium">{{ t("dorisLayout.partitionVersion") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="partition in rows" :key="partition.partitionId ?? partition.name" class="border-b" :data-doris-partition-row="partition.name">
              <td class="px-3 py-2 font-mono font-medium">{{ partition.name }}</td>
              <td class="px-3 py-2 font-mono text-[11px] text-muted-foreground break-all">{{ rowRange(partition) }}</td>
              <td class="px-3 py-2 text-right font-mono">{{ rowBuckets(partition) }}</td>
              <td class="px-3 py-2 text-right font-mono">{{ partition.replicationNum ?? "-" }}</td>
              <td class="px-3 py-2">{{ partition.state ?? "-" }}</td>
              <td class="px-3 py-2 text-right font-mono">{{ partition.dataSize ?? "-" }}</td>
              <td class="px-3 py-2 text-right font-mono">{{ partition.visibleVersion ?? "-" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="p-6 text-center text-xs text-muted-foreground">
        {{ emptyMessage() }}
      </div>
    </template>
    <div v-else class="p-6 text-center text-xs text-muted-foreground">
      {{ t("dorisLayout.unavailable") }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Activity, Database, FileText, KeyRound, RefreshCcw, Tags } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import ErrorBanner from "@/components/ui/ErrorBanner.vue";
import QueryLoadingState from "@/components/common/QueryLoadingState.vue";
import * as api from "@/lib/backend/api";
import { formatBytes } from "@/lib/database/serverMetrics";
import type { MeilisearchSystemOverview, OverviewSection } from "@/types/meilisearchManagement";

const props = defineProps<{ connectionId: string }>();
const { t } = useI18n();
const loading = ref(false);
const error = ref("");
const overview = ref<MeilisearchSystemOverview | null>(null);

const stats = computed(() => overview.value?.stats.data ?? null);
const cards = computed(() => [
  { label: t("meilisearch.health"), value: overview.value?.health.data?.status ?? sectionLabel(overview.value?.health), icon: Activity },
  { label: t("meilisearch.version"), value: overview.value?.version.data?.pkgVersion ?? sectionLabel(overview.value?.version), icon: Tags },
  { label: t("meilisearch.indexCount"), value: stats.value?.indexCount ?? sectionLabel(overview.value?.stats), icon: Database },
  { label: t("meilisearch.totalDocuments"), value: stats.value?.documentCount ?? sectionLabel(overview.value?.stats), icon: FileText },
  { label: t("meilisearch.indexingCount"), value: stats.value?.indexingCount ?? sectionLabel(overview.value?.stats), icon: RefreshCcw },
  { label: t("meilisearch.keyCount"), value: overview.value?.keyCount.data ?? sectionLabel(overview.value?.keyCount), icon: KeyRound },
]);

function sectionLabel(section?: OverviewSection<unknown>): string {
  if (!section) return "-";
  return section.message || t(`meilisearch.sectionStatus.${section.status}`);
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    overview.value = await api.meilisearchGetSystemOverview(props.connectionId);
  } catch (cause: any) {
    error.value = cause?.message || String(cause);
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="h-full overflow-y-auto p-4">
    <div class="mb-4 flex items-center justify-between">
      <div>
        <h2 class="text-base font-semibold">{{ t("meilisearch.overview") }}</h2>
        <p class="text-xs text-muted-foreground">{{ t("meilisearch.overviewDescription") }}</p>
      </div>
      <Button size="sm" variant="outline" :disabled="loading" @click="load"><RefreshCcw class="mr-1 h-3.5 w-3.5" />{{ t("meilisearch.refresh") }}</Button>
    </div>
    <QueryLoadingState v-if="loading && !overview" class="py-12" />
    <ErrorBanner v-else-if="error && !overview" :message="error" />
    <template v-else-if="overview">
      <ErrorBanner v-if="error" class="mb-3" :message="error" />
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <div v-for="card in cards" :key="card.label" class="rounded-lg border bg-card p-4">
          <div class="flex items-center gap-2 text-xs text-muted-foreground"><component :is="card.icon" class="h-4 w-4" />{{ card.label }}</div>
          <div class="mt-2 break-words text-xl font-semibold tabular-nums">{{ card.value }}</div>
        </div>
      </div>

      <div class="mt-4 grid gap-3 xl:grid-cols-2">
        <section class="rounded-lg border bg-card p-4">
          <h3 class="mb-3 text-sm font-semibold">{{ t("meilisearch.storage") }}</h3>
          <div v-if="stats" class="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div class="text-muted-foreground">{{ t("meilisearch.databaseSize") }}</div>
              <div class="mt-1 text-sm font-medium">{{ stats.databaseSize == null ? "-" : formatBytes(stats.databaseSize) }}</div>
            </div>
            <div>
              <div class="text-muted-foreground">{{ t("meilisearch.usedDatabaseSize") }}</div>
              <div class="mt-1 text-sm font-medium">{{ stats.usedDatabaseSize == null ? "-" : formatBytes(stats.usedDatabaseSize) }}</div>
            </div>
            <div class="col-span-2">
              <div class="text-muted-foreground">{{ t("meilisearch.lastUpdate") }}</div>
              <div class="mt-1 text-sm font-medium">{{ stats.lastUpdate || "-" }}</div>
            </div>
          </div>
          <p v-else class="text-xs text-muted-foreground">{{ sectionLabel(overview.stats) }}</p>
        </section>

        <section class="rounded-lg border bg-card p-4">
          <h3 class="mb-3 text-sm font-semibold">{{ t("meilisearch.taskStatusDistribution") }}</h3>
          <div v-if="overview.taskCounts.data" class="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
            <div v-for="(count, status) in overview.taskCounts.data" :key="status" class="rounded border px-2 py-2">
              <div class="text-muted-foreground">{{ status }}</div>
              <div class="mt-1 text-base font-semibold tabular-nums">{{ count }}</div>
            </div>
          </div>
          <p v-else class="text-xs text-muted-foreground">{{ sectionLabel(overview.taskCounts) }}</p>
        </section>
      </div>

      <section class="mt-4 rounded-lg border bg-card">
        <div class="border-b px-4 py-3 text-sm font-semibold">{{ t("meilisearch.topIndexes") }}</div>
        <div v-if="overview.topIndexes.data?.length" class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="bg-muted/40 text-muted-foreground">
              <tr>
                <th class="px-4 py-2">{{ t("meilisearch.uid") }}</th>
                <th class="px-4 py-2">{{ t("meilisearch.documentCountLabel") }}</th>
                <th class="px-4 py-2">{{ t("meilisearch.status") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in overview.topIndexes.data" :key="item.uid" class="border-t">
                <td class="px-4 py-2 font-mono">{{ item.uid }}</td>
                <td class="px-4 py-2 tabular-nums">{{ item.numberOfDocuments }}</td>
                <td class="px-4 py-2">{{ item.isIndexing ? t("meilisearch.isIndexing") : t("meilisearch.idle") }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="p-4 text-xs text-muted-foreground">{{ sectionLabel(overview.topIndexes) }}</p>
      </section>
    </template>
  </div>
</template>

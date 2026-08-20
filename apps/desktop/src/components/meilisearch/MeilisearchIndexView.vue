<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/zh-cn";
import "dayjs/locale/zh-tw";
import "dayjs/locale/es";
import "dayjs/locale/it";
import "dayjs/locale/ja";
import "dayjs/locale/ko";
import "dayjs/locale/pt-br";
import { Copy, FileText, Settings } from "@lucide/vue";
import * as api from "@/lib/backend/api";
import type { MeilisearchIndexOverview } from "@/lib/backend/tauri";
import { formatBytes } from "@/lib/database/serverMetrics";
import { useToast } from "@/composables/useToast";
import MeilisearchDocumentsPage from "./MeilisearchDocumentsPage.vue";
import MeilisearchSettingsPage from "./MeilisearchSettingsPage.vue";

dayjs.extend(relativeTime);

const DAYJS_LOCALES: Record<string, string> = {
  "zh-CN": "zh-cn",
  "zh-TW": "zh-tw",
  "pt-BR": "pt-br",
  es: "es",
  it: "it",
  ja: "ja",
  ko: "ko",
};

const props = defineProps<{
  connectionId: string;
  index: string;
}>();

type ActiveSection = "documents" | "settings";

const { t, locale } = useI18n();
const { toast } = useToast();

const activeSection = ref<ActiveSection>("documents");
const overview = ref<MeilisearchIndexOverview | null>(null);

const navSections = computed<Array<{ value: ActiveSection; label: string; icon: typeof FileText }>>(() => [
  { value: "documents", label: t("meilisearch.documents"), icon: FileText },
  { value: "settings", label: t("meilisearch.settings"), icon: Settings },
]);

const updatedAtLabel = computed(() => {
  const value = overview.value?.updatedAt;
  if (!value) return "-";
  return dayjs(value)
    .locale(DAYJS_LOCALES[locale.value] ?? "en")
    .fromNow();
});

async function refreshStats() {
  try {
    overview.value = await api.meilisearchGetIndexOverview(props.connectionId, props.index);
  } catch {
    // Overview is best-effort; the tab still works without it.
  }
}

async function copyText(value: string | null | undefined) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast(t("meilisearch.copied"));
  } catch {
    // Clipboard may be unavailable (e.g. permission denied); stay silent.
  }
}

onMounted(() => {
  void refreshStats();
});
</script>

<template>
  <div class="h-full flex overflow-hidden">
    <!-- Left column: index meta + navigation -->
    <nav class="w-44 shrink-0 border-r flex flex-col gap-1 overflow-y-auto p-2">
      <div class="px-1 pb-2">
        <div class="truncate text-sm font-semibold text-foreground" :title="index">{{ index }}</div>
        <div v-if="overview?.isIndexing" class="mt-0.5 text-xs text-primary">{{ t("meilisearch.isIndexing") }}</div>
      </div>

      <div class="space-y-2.5 px-1 pb-2 text-xs">
        <div>
          <div class="text-muted-foreground">{{ t("meilisearch.uid") }}</div>
          <div class="mt-0.5 flex items-center gap-1">
            <span class="min-w-0 truncate font-mono text-foreground/80" :title="overview?.uid ?? index">{{ overview?.uid ?? index }}</span>
            <button type="button" class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" :title="t('common.copy')" @click="copyText(overview?.uid ?? index)">
              <Copy class="h-3 w-3" />
            </button>
          </div>
        </div>
        <div>
          <div class="text-muted-foreground">{{ t("meilisearch.updatedAt") }}</div>
          <div class="mt-0.5 text-foreground/80" :title="overview?.updatedAt ?? undefined">{{ updatedAtLabel }}</div>
        </div>
        <div>
          <div class="text-muted-foreground">{{ t("meilisearch.primaryKey") }}</div>
          <div class="mt-0.5 flex items-center gap-1">
            <span class="min-w-0 truncate font-mono text-foreground/80" :title="overview?.primaryKey ?? undefined">{{ overview?.primaryKey ?? "-" }}</span>
            <button v-if="overview?.primaryKey" type="button" class="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground" :title="t('common.copy')" @click="copyText(overview.primaryKey)">
              <Copy class="h-3 w-3" />
            </button>
          </div>
        </div>
        <div>
          <div class="text-muted-foreground">{{ t("meilisearch.documentCountLabel") }}</div>
          <div class="mt-0.5 tabular-nums text-foreground/80">{{ overview ? overview.numberOfDocuments : "-" }}</div>
        </div>
        <div v-if="overview?.databaseSize != null">
          <div class="text-muted-foreground">{{ t("meilisearch.databaseSize") }}</div>
          <div class="mt-0.5 tabular-nums text-foreground/80">{{ formatBytes(overview.databaseSize) }}</div>
        </div>
      </div>

      <div class="mx-1 border-t border-border/60" />

      <button
        v-for="section in navSections"
        :key="section.value"
        type="button"
        class="mt-1 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors"
        :class="activeSection === section.value ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'"
        @click="activeSection = section.value"
      >
        <component :is="section.icon" class="h-3.5 w-3.5 shrink-0" />
        <span>{{ section.label }}</span>
      </button>
    </nav>

    <!-- Content -->
    <div class="flex-1 min-h-0 min-w-0 overflow-hidden">
      <MeilisearchDocumentsPage v-if="activeSection === 'documents'" :connection-id="connectionId" :index="index" @refresh-stats="refreshStats" />
      <MeilisearchSettingsPage v-else :connection-id="connectionId" :index="index" @refresh-stats="refreshStats" />
    </div>
  </div>
</template>

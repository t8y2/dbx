<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Copy, Search } from "@lucide/vue";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import RedisJsonEditor from "@/components/redis/RedisJsonEditor.vue";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import { elasticsearchDocumentJson, type ElasticsearchDocumentHit } from "@/lib/elasticsearch/elasticsearchDocumentHits";

/**
 * Kibana-style result surface for Elasticsearch queries: the left column lists
 * the search hits, the right column shows the selected document as JSON.
 *
 * The pane is read-only and purely presentational — the caller owns the
 * documents, the page window and the pagination request.
 */
const props = withDefaults(
  defineProps<{
    documents: ElasticsearchDocumentHit[];
    loading?: boolean;
    /** Pagination is offered only when the caller can re-run the query for it. */
    canPaginate?: boolean;
    pageOffset?: number;
    pageLimit?: number;
  }>(),
  { loading: false, canPaginate: false, pageOffset: 0, pageLimit: 0 },
);

const emit = defineEmits<{
  paginate: [offset: number, limit: number];
}>();

const { t } = useI18n();
const { toast } = useToast();

const filterQuery = ref("");
const selectedIndex = ref(0);
const listRef = ref<HTMLElement>();
const filterInputRef = ref<InstanceType<typeof Input> | null>(null);

const filteredDocuments = computed(() => {
  const needle = filterQuery.value.trim().toLowerCase();
  if (!needle) return props.documents.map((document, index) => ({ document, index }));
  return props.documents.flatMap((document, index) => {
    const matchesLabel = document.label.toLowerCase().includes(needle);
    const matchesIndex = (document.index ?? "").toLowerCase().includes(needle);
    return matchesLabel || matchesIndex ? [{ document, index }] : [];
  });
});

const selectedDocument = computed(() => {
  const hit = props.documents[selectedIndex.value];
  return hit && props.documents.includes(hit) ? hit : undefined;
});
const selectedDocumentText = computed(() => elasticsearchDocumentJson(selectedDocument.value));

const pageStart = computed(() => (props.documents.length === 0 ? 0 : props.pageOffset + 1));
const pageEnd = computed(() => props.pageOffset + props.documents.length);
const canGoPrevious = computed(() => props.canPaginate && props.pageOffset > 0 && !props.loading);
const canGoNext = computed(() => props.canPaginate && props.pageLimit > 0 && props.documents.length >= props.pageLimit && !props.loading);
const pageRangeLabel = computed(() => t("esResult.range", { start: pageStart.value, end: pageEnd.value }));

// A new page or a new result set must not keep pointing at a stale index.
watch(
  () => props.documents,
  () => {
    selectedIndex.value = 0;
  },
);
watch(
  () => props.pageOffset,
  () => {
    selectedIndex.value = 0;
  },
);

function selectDocument(index: number) {
  selectedIndex.value = index;
  void nextTick(() => listRef.value?.querySelector<HTMLElement>('[data-document-active="true"]')?.scrollIntoView({ block: "nearest" }));
}

function goToPreviousPage() {
  const limit = props.pageLimit > 0 ? props.pageLimit : props.documents.length;
  if (!canGoPrevious.value || limit <= 0) return;
  emit("paginate", Math.max(0, props.pageOffset - limit), limit);
}

function goToNextPage() {
  const limit = props.pageLimit > 0 ? props.pageLimit : props.documents.length;
  if (!canGoNext.value || limit <= 0) return;
  emit("paginate", props.pageOffset + limit, limit);
}

async function copySelectedDocument() {
  if (!selectedDocumentText.value) return;
  try {
    await copyToClipboard(selectedDocumentText.value);
    toast(t("grid.copied"), 2000);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    toast(t("grid.copyFailed", { message }), 5000);
  }
}

function focusSearch(): boolean {
  const target = filterInputRef.value;
  if (!target) return false;
  void nextTick(() => target.$el?.focus?.());
  return true;
}

defineExpose({ focusSearch });
</script>

<template>
  <section data-elasticsearch-documents-root class="flex h-full min-h-0 flex-col bg-background">
    <Splitpanes vertical class="elasticsearch-documents-splitpanes flex-1 min-h-0 overflow-hidden">
      <Pane :size="30" :min-size="18" class="min-h-0">
        <div class="flex h-full min-h-0 flex-col border-r">
          <div class="flex min-h-9 shrink-0 items-center gap-2 border-b bg-muted/25 px-2 py-1">
            <span class="truncate text-xs font-medium">{{ t("esResult.listTitle") }}</span>
            <span class="ml-auto shrink-0 rounded-full border px-1.5 text-[10px] tabular-nums text-muted-foreground">{{ props.documents.length }}</span>
          </div>
          <div class="relative shrink-0 px-2 py-1.5">
            <Search class="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input ref="filterInputRef" v-model="filterQuery" class="h-7 pl-7 text-xs" :placeholder="t('esResult.filterPlaceholder')" :aria-label="t('esResult.filterPlaceholder')" />
          </div>
          <div ref="listRef" class="min-h-0 flex-1 overflow-y-auto px-1 py-1" role="listbox" :aria-label="t('esResult.listTitle')">
            <p v-if="props.documents.length === 0" class="px-2 py-6 text-center text-xs text-muted-foreground">{{ t("esResult.empty") }}</p>
            <p v-else-if="filteredDocuments.length === 0" class="px-2 py-6 text-center text-xs text-muted-foreground">{{ t("esResult.emptyFilter") }}</p>
            <button
              v-for="entry in filteredDocuments"
              :key="`${entry.document.label}:${entry.index}`"
              type="button"
              role="option"
              :data-document-active="selectedIndex === entry.index ? 'true' : undefined"
              :aria-selected="selectedIndex === entry.index"
              class="flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left transition-colors"
              :class="selectedIndex === entry.index ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'"
              @click="selectDocument(entry.index)"
            >
              <span class="w-full truncate font-mono text-xs">{{ entry.document.label }}</span>
              <span v-if="entry.document.index" class="w-full truncate text-[10px] text-muted-foreground">{{ entry.document.index }}</span>
            </button>
          </div>
          <div v-if="props.canPaginate" class="flex shrink-0 items-center gap-1 border-t px-2 py-1.5 text-[11px] text-muted-foreground">
            <Button variant="ghost" size="sm" class="h-6 px-1.5 text-xs" :disabled="!canGoPrevious" @click="goToPreviousPage">{{ t("esResult.previous") }}</Button>
            <span class="min-w-0 flex-1 truncate text-center tabular-nums">{{ pageRangeLabel }}</span>
            <Button variant="ghost" size="sm" class="h-6 px-1.5 text-xs" :disabled="!canGoNext" @click="goToNextPage">{{ t("esResult.next") }}</Button>
          </div>
        </div>
      </Pane>
      <Pane :size="70" class="min-h-0 min-w-0">
        <div class="flex h-full min-h-0 flex-col">
          <div class="flex min-h-9 shrink-0 items-center gap-2 border-b bg-muted/25 px-2 py-1">
            <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ selectedDocument?.label ?? t("esResult.detailEmpty") }}</span>
            <Button variant="ghost" size="icon" class="h-6 w-7 shrink-0" :title="t('grid.copyJson')" :aria-label="t('grid.copyJson')" :disabled="!selectedDocumentText" @click="copySelectedDocument">
              <Copy class="h-3.5 w-3.5" />
            </Button>
          </div>
          <RedisJsonEditor v-if="selectedDocumentText" :key="`${selectedDocument?.label}:${selectedIndex}`" :model-value="selectedDocumentText" read-only class="min-h-0 min-w-0 flex-1" />
          <div v-else class="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
            {{ props.loading ? t("esResult.loading") : t("esResult.detailEmpty") }}
          </div>
        </div>
      </Pane>
    </Splitpanes>
  </section>
</template>

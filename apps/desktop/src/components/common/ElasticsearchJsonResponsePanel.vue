<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Code2, Copy } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import TextContentSearchBar from "@/components/common/TextContentSearchBar.vue";
import RedisJsonEditor from "@/components/redis/RedisJsonEditor.vue";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatJsonSource } from "@/lib/common/safeJsonFormat";
import { TEXT_CONTENT_SEARCH_MATCH_LIMIT, canFullHighlightTextContent, findTextContentMatches, nextTextContentSearchMatchIndex, renderTextContentMatchesHtml, textContentSearchStatus, type TextContentMatch } from "@/lib/common/textContentSearch";

const props = defineProps<{
  status: number;
  body: string;
  /** When true, render a "Table" button to switch back to the grid view. */
  canShowTable?: boolean;
}>();

const emit = defineEmits<{
  showTable: [];
}>();

const { t } = useI18n();
const { toast } = useToast();
const responseView = ref<"raw" | "json">("json");
const responsePanelRef = ref<HTMLElement>();
const rawPreRef = ref<HTMLPreElement>();
const jsonEditorRef = ref<{ openSearch: () => boolean }>();
const responseSearchBarRef = ref<{ focusInput: (select?: boolean) => void }>();
const responseSearchOpen = ref(false);
const responseSearchQuery = ref("");
const responseSearchMatchIndex = ref(0);
const responseSearchHasNavigated = ref(false);

const formattedBody = computed(() => {
  try {
    // Match Redis JSON rendering: a lossless, read-only CodeMirror JSON view.
    return { valid: true, text: formatJsonSource(props.body, 2) };
  } catch {
    return { valid: false, text: "" };
  }
});

const statusClass = computed(() => {
  if (props.status >= 500) return "border-destructive/40 bg-destructive/10 text-destructive";
  if (props.status >= 400) return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (props.status >= 300) return "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
});

const statusLabel = computed(() => `HTTP ${props.status}`);
const rawSearchMatches = computed(() => findTextContentMatches(props.body, responseSearchQuery.value));
const responseSearchActiveIndex = computed(() => {
  const count = rawSearchMatches.value.length;
  if (count === 0) return 0;
  return Math.min(responseSearchMatchIndex.value, count - 1);
});
const responseSearchLimited = computed(() => rawSearchMatches.value.length >= TEXT_CONTENT_SEARCH_MATCH_LIMIT);
const responseSearchStatus = computed(() => textContentSearchStatus(responseSearchActiveIndex.value, rawSearchMatches.value.length, responseSearchLimited.value));
const canHighlightRawSearch = computed(() => responseSearchOpen.value && Boolean(responseSearchQuery.value) && canFullHighlightTextContent(props.body.length));
const highlightedRawResponse = computed(() => renderTextContentMatchesHtml(props.body, rawSearchMatches.value, { activeMatchIndex: responseSearchActiveIndex.value }));

watch(
  () => props.body,
  () => {
    resetResponseSearch();
    responseView.value = formattedBody.value.valid ? "json" : "raw";
  },
  { immediate: true },
);

watch(responseSearchQuery, () => {
  responseSearchMatchIndex.value = 0;
  responseSearchHasNavigated.value = false;
  if (responseSearchOpen.value) void scrollResponseSearchMatchIntoView();
});

async function copyResponse() {
  try {
    await copyToClipboard(props.body);
    toast(t("grid.copied"), 2000);
  } catch (error: any) {
    toast(t("grid.copyFailed", { message: error?.message || String(error) }), 5000);
  }
}

function handleResponsePanelPointerDown() {
  // The read-only editor manages its own focus. The plain raw response needs a
  // focus target so the global Cmd/Ctrl+F shortcut can be routed here.
  if (responseView.value === "raw") responsePanelRef.value?.focus({ preventScroll: true });
}

function focusSearch(): boolean {
  if (!responsePanelRef.value?.contains(document.activeElement)) return false;

  if (responseView.value === "json") {
    void nextTick(() => jsonEditorRef.value?.openSearch());
    return true;
  }

  responseSearchOpen.value = true;
  responseSearchHasNavigated.value = false;
  void nextTick(() => responseSearchBarRef.value?.focusInput(true));
  return true;
}

function resetResponseSearch(restoreFocus = false) {
  const wasOpen = responseSearchOpen.value;
  responseSearchOpen.value = false;
  responseSearchQuery.value = "";
  responseSearchMatchIndex.value = 0;
  responseSearchHasNavigated.value = false;
  // Resetting after a new response or a view switch must not steal focus.
  if (restoreFocus && wasOpen) void nextTick(() => responsePanelRef.value?.focus({ preventScroll: true }));
}

function closeResponseSearch() {
  resetResponseSearch(true);
}

function switchResponseView(view: "raw" | "json") {
  if (responseView.value === view) return;
  responseView.value = view;
  if (view !== "raw") resetResponseSearch();
}

function moveResponseSearchMatch(delta: -1 | 1) {
  const count = rawSearchMatches.value.length;
  if (count === 0) return;
  responseSearchMatchIndex.value = nextTextContentSearchMatchIndex(responseSearchActiveIndex.value, delta, count);
  responseSearchHasNavigated.value = true;
  void scrollResponseSearchMatchIntoView();
}

function activateResponseSearchMatch(delta: -1 | 1) {
  if (rawSearchMatches.value.length === 0) return;
  if (!responseSearchHasNavigated.value) {
    responseSearchHasNavigated.value = true;
    void scrollResponseSearchMatchIntoView();
    return;
  }
  moveResponseSearchMatch(delta);
}

async function scrollResponseSearchMatchIntoView() {
  await nextTick();

  const activeMark = rawPreRef.value?.querySelector<HTMLElement>('[data-document-search-active="true"]');
  if (activeMark) {
    activeMark.scrollIntoView({ block: "center", inline: "nearest" });
    return;
  }

  const match = rawSearchMatches.value[responseSearchActiveIndex.value];
  if (match) scrollRawTextRangeIntoView(match);
}

function scrollRawTextRangeIntoView(match: TextContentMatch) {
  const pre = rawPreRef.value;
  const textNode = [...(pre?.childNodes ?? [])].find((node) => node.nodeType === Node.TEXT_NODE);
  if (!pre || !textNode || typeof document.createRange !== "function") return;

  const start = Math.min(match.start, textNode.textContent?.length ?? 0);
  const end = Math.min(match.end, textNode.textContent?.length ?? 0);
  if (end <= start) return;

  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const rangeRect = range.getBoundingClientRect();
  const preRect = pre.getBoundingClientRect();
  pre.scrollTop = Math.max(0, pre.scrollTop + rangeRect.top - preRect.top - pre.clientHeight / 2);
  pre.scrollLeft = Math.max(0, pre.scrollLeft + rangeRect.left - preRect.left - pre.clientWidth / 2);
}

defineExpose({ focusSearch });
</script>

<template>
  <section ref="responsePanelRef" data-elasticsearch-json-response-root tabindex="-1" class="relative flex h-full min-h-0 flex-col bg-background" :aria-label="t('redis.jsonView')" @pointerdown="handleResponsePanelPointerDown">
    <TextContentSearchBar
      v-if="responseSearchOpen"
      ref="responseSearchBarRef"
      v-model="responseSearchQuery"
      :status="responseSearchStatus"
      :match-count="rawSearchMatches.length"
      :show-navigation="true"
      :placeholder="t('editor.search.find')"
      @activate="activateResponseSearchMatch"
      @prev="moveResponseSearchMatch(-1)"
      @next="moveResponseSearchMatch(1)"
      @close="closeResponseSearch"
    />
    <header class="flex min-h-11 shrink-0 items-center gap-2 border-b bg-muted/25 px-3 py-1.5 text-xs">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground shadow-sm" aria-hidden="true">
          <Code2 class="h-3.5 w-3.5" />
        </span>
        <div class="inline-flex h-7 items-center rounded-md border bg-muted/45 p-0.5">
          <button type="button" class="h-6 rounded-[4px] px-2 text-xs transition-colors" :class="responseView === 'raw' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" :aria-pressed="responseView === 'raw'" @click="switchResponseView('raw')">
            {{ t("redis.rawContent") }}
          </button>
          <button
            type="button"
            class="h-6 rounded-[4px] px-2 text-xs transition-colors"
            :class="responseView === 'json' ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
            :aria-pressed="responseView === 'json'"
            :disabled="!formattedBody.valid"
            @click="switchResponseView('json')"
          >
            {{ t("redis.jsonView") }}
          </button>
          <button v-if="canShowTable" type="button" class="h-6 rounded-[4px] px-2 text-xs transition-colors bg-background font-medium text-foreground shadow-sm" @click="emit('showTable')">
            {{ t("tabs.tableData") }}
          </button>
        </div>
      </div>
      <span class="shrink-0 rounded-full border px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums" :class="statusClass" role="status" :aria-label="statusLabel">
        {{ statusLabel }}
      </span>
      <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" :title="t('grid.copyJson')" :aria-label="t('grid.copyJson')" @click="copyResponse">
        <Copy class="h-3.5 w-3.5" />
      </Button>
    </header>
    <div class="min-h-0 flex-1 overflow-hidden bg-background">
      <pre v-if="responseView === 'raw' && canHighlightRawSearch" ref="rawPreRef" class="m-0 h-full overflow-auto bg-transparent p-4 font-mono text-sm leading-6 whitespace-pre" v-html="highlightedRawResponse" />
      <pre v-else-if="responseView === 'raw'" ref="rawPreRef" class="m-0 h-full overflow-auto bg-transparent p-4 font-mono text-sm leading-6 whitespace-pre">{{ body }}</pre>
      <RedisJsonEditor v-else-if="formattedBody.valid" ref="jsonEditorRef" :model-value="formattedBody.text" read-only class="min-h-0 flex-1" />
    </div>
  </section>
</template>

<style scoped>
:deep(.document-search-match) {
  border-radius: 2px;
  background: #fde68a;
  color: inherit;
  padding: 0;
}

:deep(.document-search-match-active) {
  background: #f59e0b;
  color: #111827;
  outline: 1px solid #d97706;
}

:global(.dark) :deep(.document-search-match) {
  background: #854d0e;
}

:global(.dark) :deep(.document-search-match-active) {
  background: #fbbf24;
  color: #111827;
}
</style>

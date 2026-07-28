<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AlertTriangle, Download, Loader2, Search, Square, XCircle } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { splitNacosContentLiteralMatches } from "@/lib/nacos/nacosAdmin";
import type { NacosContentMatch, NacosContentSearchResult, NacosNamespaceScope, NacosSearchProgress } from "@/types/nacos";

const props = defineProps<{
  open: boolean;
  loading: boolean;
  result: NacosContentSearchResult | null;
  progress: NacosSearchProgress | null;
  error?: string;
  initialQuery?: string;
  exporting?: boolean;
  resetKey?: number;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  search: [payload: { query: string; scope: NacosNamespaceScope }];
  cancel: [];
  navigate: [match: NacosContentMatch, query: string];
  export: [];
  clear: [];
}>();

const { t } = useI18n();
const query = ref("");
const scope = ref<NacosNamespaceScope>("currentNamespace");
const submittedQuery = ref("");
const activeMatchKey = ref("");

const matches = computed(() => props.result?.matches ?? props.progress?.matches ?? []);
const failures = computed(() => props.result?.failures ?? props.progress?.failures ?? []);
const scanned = computed(() => props.result?.scanned ?? props.progress?.scanned ?? 0);
const matched = computed(() => props.result?.matches.length ?? props.progress?.matched ?? 0);
const isIncomplete = computed(() => !!(props.result?.incomplete || props.result?.truncated || props.result?.cancelled || props.progress?.truncated || props.progress?.cancelled || failures.value.length));

watch(
  () => props.open,
  (open) => {
    if (open) {
      if (!query.value) query.value = props.initialQuery ?? "";
    }
  },
);

watch(
  () => props.resetKey,
  () => {
    query.value = "";
    scope.value = "currentNamespace";
    submittedQuery.value = "";
    activeMatchKey.value = "";
  },
);

function submit() {
  const value = query.value;
  if (!value || props.loading) return;
  submittedQuery.value = value;
  activeMatchKey.value = "";
  emit("search", { query: value, scope: scope.value });
}

function matchKey(match: NacosContentMatch): string {
  return `${match.namespace}\u0000${match.group}\u0000${match.dataId}`;
}

function navigateToMatch(match: NacosContentMatch) {
  activeMatchKey.value = matchKey(match);
  emit("navigate", match, submittedQuery.value || query.value);
}

function clearSearchResults() {
  query.value = "";
  scope.value = "currentNamespace";
  submittedQuery.value = "";
  activeMatchKey.value = "";
  emit("clear");
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="flex max-h-[82vh] sm:max-w-4xl flex-col overflow-hidden">
      <DialogHeader>
        <DialogTitle>{{ t("nacos.contentSearchTitle") }}</DialogTitle>
        <DialogDescription>{{ t("nacos.contentSearchDescription") }}</DialogDescription>
      </DialogHeader>

      <div class="flex min-h-0 flex-1 flex-col gap-3">
        <form class="grid items-stretch gap-2 md:grid-cols-[minmax(0,1fr)_14rem_auto]" @submit.prevent="submit">
          <Input v-model="query" class="!h-9 box-border px-3 text-sm" :placeholder="t('nacos.contentSearchPlaceholder')" autocomplete="off" />
          <Select v-model="scope" :disabled="loading">
            <SelectTrigger class="!h-9 w-full box-border px-3 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper">
              <SelectItem value="currentNamespace">{{ t("nacos.currentNamespace") }}</SelectItem>
              <SelectItem value="allNamespaces">{{ t("nacos.allNamespaces") }}</SelectItem>
            </SelectContent>
          </Select>
          <div class="flex h-9 gap-2">
            <Button type="submit" size="lg" class="!h-9 min-w-24 flex-1 box-border md:flex-none" :disabled="loading || !query">
              <Loader2 v-if="loading" class="h-4 w-4 animate-spin" />
              <Search v-else class="h-4 w-4" />
              {{ t("nacos.search") }}
            </Button>
            <Button v-if="loading" type="button" size="lg" variant="outline" class="!h-9 min-w-24 flex-1 box-border md:flex-none" @click="emit('cancel')">
              <Square class="h-3.5 w-3.5" />
              {{ t("nacos.cancel") }}
            </Button>
          </div>
        </form>

        <div v-if="scope === 'allNamespaces'" class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
          <span>{{ t("nacos.allNamespacesSearchWarning") }}</span>
        </div>

        <div v-if="loading || result || progress" class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{{ t("nacos.scannedCount", { count: scanned }) }}</Badge>
          <Badge variant="outline">{{ t("nacos.matchCount", { count: matched }) }}</Badge>
          <span v-if="progress?.namespace" class="truncate font-mono">{{ progress.namespace || "public" }}</span>
          <span v-if="progress?.total != null">{{ scanned }} / {{ progress.total }}</span>
          <Badge v-if="isIncomplete" variant="outline" class="border-amber-500/50 text-amber-700 dark:text-amber-300">{{ t("nacos.incompleteResult") }}</Badge>
          <Button v-if="matches.length" type="button" size="sm" variant="outline" class="ml-auto h-7 gap-1.5 px-2.5" :disabled="loading || exporting" @click="emit('export')">
            <Loader2 v-if="exporting" class="h-3.5 w-3.5 animate-spin" />
            <Download v-else class="h-3.5 w-3.5" />
            {{ t("nacos.exportSearchResults") }}
          </Button>
        </div>

        <p v-if="(result || progress) && matches.length" class="text-xs text-muted-foreground">{{ t("nacos.searchResultsRetainedHint") }}</p>

        <p v-if="error" class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{{ error }}</p>

        <div v-if="failures.length" class="max-h-24 overflow-auto rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
          <div v-for="failure in failures" :key="`${failure.namespace}:${failure.error}`" class="flex gap-2 py-0.5">
            <XCircle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
            <span class="font-mono">{{ failure.namespace || "public" }}</span>
            <span class="break-all text-muted-foreground">{{ failure.error }}</span>
          </div>
        </div>

        <div class="min-h-52 flex-1 overflow-auto rounded-md border">
          <button
            v-for="match in matches"
            :key="matchKey(match)"
            type="button"
            class="block w-full border-b px-3 py-2.5 text-left last:border-b-0 hover:bg-accent/60"
            :class="activeMatchKey === matchKey(match) ? 'bg-accent/80 shadow-[inset_3px_0_0_hsl(var(--primary))]' : ''"
            :aria-pressed="activeMatchKey === matchKey(match)"
            @click="navigateToMatch(match)"
          >
            <div class="flex min-w-0 items-center gap-2 text-sm">
              <span class="truncate font-medium">{{ match.dataId }}</span>
              <Badge variant="secondary" class="max-w-48 truncate">{{ match.group || "DEFAULT_GROUP" }}</Badge>
              <Badge variant="outline" class="max-w-48 truncate">{{ match.namespace || "public" }}</Badge>
              <Badge v-if="activeMatchKey === matchKey(match)" variant="outline" class="shrink-0">{{ t("nacos.openedSearchResult") }}</Badge>
              <span class="ml-auto shrink-0 text-xs text-muted-foreground">{{ t("nacos.lineNumber", { line: match.lineNumber }) }}</span>
            </div>
            <pre
              class="mt-1 overflow-hidden text-ellipsis whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground"
            ><template v-for="(segment, segmentIndex) in splitNacosContentLiteralMatches(match.snippet, submittedQuery)" :key="segmentIndex"><mark v-if="segment.matched" class="rounded-sm bg-amber-300/80 px-0.5 text-foreground dark:bg-amber-500/40">{{ segment.text }}</mark><span v-else>{{ segment.text }}</span></template></pre>
          </button>
          <div v-if="!loading && (result || progress) && matches.length === 0" class="flex min-h-52 items-center justify-center text-sm text-muted-foreground">{{ t("nacos.noContentMatches") }}</div>
          <div v-else-if="!result && !progress && !loading" class="flex min-h-52 items-center justify-center px-6 text-center text-sm text-muted-foreground">{{ t("nacos.contentSearchEmptyHint") }}</div>
        </div>
      </div>

      <DialogFooter class="sm:justify-between">
        <Button v-if="result || progress || error" type="button" variant="outline" @click="clearSearchResults">
          <XCircle class="h-4 w-4" />
          {{ t("nacos.clearSearchResults") }}
        </Button>
        <Button variant="outline" class="sm:ml-auto" @click="emit('update:open', false)">{{ t("common.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

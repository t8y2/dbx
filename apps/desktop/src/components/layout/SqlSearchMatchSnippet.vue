<script setup lang="ts">
import { computed, ref, watch, type ObjectDirective } from "vue";
import { useI18n } from "vue-i18n";
import { formatMatchTooltip, type SavedSqlLineMatch } from "@/lib/savedSql/savedSqlSearch";

/**
 * Presentational snippet list shared by the SQL library panel and the external
 * SQL file panel: line badge + highlighted segments, `initialVisible` rows by
 * default, expandable up to the matches the caller supplied.
 */
const props = withDefaults(
  defineProps<{
    matches: SavedSqlLineMatch[];
    totalMatches: number;
    query: string;
    /** Maximum available previews, including those built lazily on expansion. */
    previewLimit?: number;
    depth?: number;
    initialVisible?: number;
  }>(),
  {
    depth: 0,
    initialVisible: 3,
    previewLimit: 100,
  },
);

const emit = defineEmits<{
  selectMatch: [match: SavedSqlLineMatch];
  /** Lets a caller that computes matches lazily (e.g. from full file text)
   *  widen its own cap when the list is expanded. */
  expandedChange: [expanded: boolean];
}>();

const { t } = useI18n();
const expanded = ref(false);

const visibleMatches = computed(() => (expanded.value ? props.matches : props.matches.slice(0, props.initialVisible)));
const hasHiddenMatches = computed(() => Math.min(props.totalMatches, props.previewLimit) > props.initialVisible);
const previewLimited = computed(() => props.totalMatches > props.previewLimit);

// Measure rendered pixels so Chinese text, indentation and sidebar resizing
// all keep the first highlight visible without changing its editor position.
function centerFirstMatch(viewport: HTMLElement) {
  const mark = viewport.querySelector("mark");
  if (!mark || viewport.clientWidth === 0) {
    viewport.scrollLeft = 0;
    return;
  }
  const bounds = mark.getBoundingClientRect();
  const matchStart = bounds.left - viewport.getBoundingClientRect().left + viewport.scrollLeft;
  const leadingSpace = Math.max(0, (viewport.clientWidth - bounds.width) / 2);
  viewport.scrollLeft = Math.max(0, matchStart - leadingSpace);
}

const previewObservers = new WeakMap<HTMLElement, ResizeObserver>();
const vCenterSearchMatch: ObjectDirective<HTMLElement> = {
  mounted(viewport) {
    centerFirstMatch(viewport);
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => centerFirstMatch(viewport));
      observer.observe(viewport);
      previewObservers.set(viewport, observer);
    }
  },
  updated: centerFirstMatch,
  unmounted(viewport) {
    previewObservers.get(viewport)?.disconnect();
    previewObservers.delete(viewport);
  },
};

watch(
  () => props.query,
  () => {
    expanded.value = false;
    emit("expandedChange", false);
  },
);

function toggleExpanded() {
  expanded.value = !expanded.value;
  emit("expandedChange", expanded.value);
}

function handleSnippetClick(match: SavedSqlLineMatch) {
  emit("selectMatch", match);
}
</script>

<template>
  <div v-if="visibleMatches.length > 0" class="dbx-search-match-snippets mb-1 mt-0.5 space-y-0.5 select-none" :style="{ paddingLeft: `${24 + depth * 16}px` }" data-no-drag="true" @mousedown.stop @dblclick.stop>
    <div
      v-for="match in visibleMatches"
      :key="match.lineNumber"
      class="group/snippet flex cursor-pointer items-center gap-1.5 rounded py-0.5 pr-2 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      :title="formatMatchTooltip(match)"
      @click.stop="handleSnippetClick(match)"
    >
      <span class="shrink-0 text-[10px] text-muted-foreground/70 select-none"> L{{ match.lineNumber }} </span>
      <span v-center-search-match class="min-w-0 flex-1 overflow-hidden whitespace-nowrap">
        <template v-for="(seg, idx) in match.segments" :key="idx">
          <mark v-if="seg.matched" class="rounded-[2px] bg-amber-300/80 px-0.5 text-foreground dark:bg-amber-500/40">{{ seg.text }}</mark>
          <span v-else>{{ seg.text }}</span>
        </template>
      </span>
    </div>

    <div v-if="hasHiddenMatches" class="pt-0.5 text-[11px]">
      <button type="button" class="text-[11px] font-normal text-primary hover:underline hover:text-primary/80 select-none" @click.stop="toggleExpanded">
        {{ expanded ? t("sqlLibrary.collapseMatches") : t("sqlLibrary.moreMatches", { count: totalMatches - initialVisible }) }}
      </button>
    </div>
    <p v-if="previewLimited" class="pt-0.5 text-[11px] text-muted-foreground">
      {{ t("sqlLibrary.matchPreviewLimit", { limit: previewLimit, total: totalMatches }) }}
    </p>
  </div>
</template>

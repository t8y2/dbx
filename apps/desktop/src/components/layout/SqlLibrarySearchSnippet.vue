<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { SavedSqlFile } from "@/types/database";
import { findSavedSqlSearchMatches, formatMatchTooltip, type SavedSqlLineMatch } from "@/lib/savedSql/savedSqlSearch";

const props = withDefaults(
  defineProps<{
    file: SavedSqlFile;
    query: string;
    depth?: number;
  }>(),
  {
    depth: 0,
  },
);

const emit = defineEmits<{
  selectMatch: [match: SavedSqlLineMatch];
}>();

const { t } = useI18n();
const expanded = ref(false);

const searchResult = computed(() => {
  if (!props.query || !props.file.sql) {
    return { matches: [], totalMatches: 0 };
  }
  return findSavedSqlSearchMatches(props.file.sql, props.query, {
    maxMatches: expanded.value ? 100 : 3,
  });
});

const matches = computed(() => searchResult.value.matches);
const totalMatches = computed(() => searchResult.value.totalMatches);
const hasHiddenMatches = computed(() => totalMatches.value > 3);

function toggleExpanded() {
  expanded.value = !expanded.value;
}

function handleSnippetClick(match: SavedSqlLineMatch) {
  emit("selectMatch", match);
}
</script>

<template>
  <div v-if="matches.length > 0" class="dbx-sql-library-snippets mb-1 mt-0.5 space-y-0.5 select-none" :style="{ paddingLeft: `${24 + depth * 16}px` }" data-no-drag="true" @mousedown.stop>
    <div
      v-for="match in matches"
      :key="match.lineNumber"
      class="group/snippet flex cursor-pointer items-center gap-1.5 rounded py-0.5 pr-2 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
      :title="formatMatchTooltip(match)"
      @click.stop="handleSnippetClick(match)"
    >
      <span class="shrink-0 text-[10px] text-muted-foreground/70 select-none"> L{{ match.lineNumber }} </span>
      <span class="min-w-0 flex-1 truncate">
        <template v-for="(seg, idx) in match.segments" :key="idx">
          <mark v-if="seg.matched" class="rounded-[2px] bg-amber-300/80 px-0.5 text-foreground dark:bg-amber-500/40">{{ seg.text }}</mark>
          <span v-else>{{ seg.text }}</span>
        </template>
      </span>
    </div>

    <div v-if="hasHiddenMatches" class="pt-0.5 text-[11px]">
      <button type="button" class="text-[11px] font-normal text-primary hover:underline hover:text-primary/80 select-none" @click.stop="toggleExpanded">
        {{ expanded ? t("sqlLibrary.collapseMatches") : t("sqlLibrary.moreMatches", { count: totalMatches - 3 }) }}
      </button>
    </div>
  </div>
</template>

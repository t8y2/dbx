<script setup lang="ts">
import { computed, ref } from "vue";
import type { SavedSqlFile } from "@/types/database";
import { findSavedSqlSearchMatches, type SavedSqlLineMatch } from "@/lib/savedSql/savedSqlSearch";
import SqlSearchMatchSnippet from "@/components/layout/SqlSearchMatchSnippet.vue";

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

/** Collapsed view shows 3; expanding builds at most this many snippets. */
const COLLAPSED_MATCHES = 3;
const EXPANDED_MATCHES = 100;

const expanded = ref(false);

const searchResult = computed(() => {
  if (!props.query || !props.file.sql) {
    return { matches: [], totalMatches: 0 };
  }
  return findSavedSqlSearchMatches(props.file.sql, props.query, {
    // Snippet construction is per-line work, so it stays capped until the list
    // is actually expanded (unchanged behavior from before the shared component).
    maxMatches: expanded.value ? EXPANDED_MATCHES : COLLAPSED_MATCHES,
  });
});

const matches = computed(() => searchResult.value.matches);
const totalMatches = computed(() => searchResult.value.totalMatches);
</script>

<template>
  <!-- The class falls through to the shared component's root, keeping the
       historical `.dbx-sql-library-snippets` hook (and its spec) working. -->
  <SqlSearchMatchSnippet
    class="dbx-sql-library-snippets"
    :query="query"
    :matches="matches"
    :preview-limit="EXPANDED_MATCHES"
    :total-matches="totalMatches"
    :depth="depth"
    :initial-visible="COLLAPSED_MATCHES"
    @expanded-change="(next) => (expanded = next)"
    @select-match="(match) => emit('selectMatch', match)"
  />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Bookmark, Search } from "@lucide/vue";
import { useQueryStore } from "@/stores/queryStore";
import { normalizePersistedBookmarks } from "@/lib/editor/workspaceBookmarks";

const { t } = useI18n();
const queryStore = useQueryStore();
const search = ref("");
const list = ref<HTMLElement>();
const bookmarkGroups = computed(() => {
  return queryStore.tabs.flatMap((tab) => {
    if (tab.mode !== "query" || !tab.editorBookmarks?.length) return [];
    const lines = tab.sql.split(/\r\n?|\n/);
    const entries = normalizePersistedBookmarks(tab.editorBookmarks)
      .filter((line) => line <= lines.length)
      .map((line) => ({ line, text: lines[line - 1].trim() }));
    return entries.length ? [{ id: tab.id, title: tab.title, path: tab.externalSqlPath, entries }] : [];
  });
});
const groups = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase();
  if (!needle) return bookmarkGroups.value;
  return bookmarkGroups.value.flatMap((group) => {
    const fileMatches = `${group.title}\n${group.path ?? ""}`.toLocaleLowerCase().includes(needle);
    const entries = group.entries.filter((entry) => fileMatches || `${entry.line}\n${entry.text}`.toLocaleLowerCase().includes(needle));
    return entries.length ? [{ ...group, entries }] : [];
  });
});
const total = computed(() => groups.value.reduce((count, group) => count + group.entries.length, 0));

function onSearchKey(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Enter") {
    const group = groups.value[0];
    if (group) queryStore.revealBookmark(group.id, group.entries[0].line);
    event.preventDefault();
  } else if (event.key === "ArrowDown") {
    list.value?.querySelector<HTMLButtonElement>("[data-bookmark-line]")?.focus();
    event.preventDefault();
  } else if (event.key === "Escape") search.value = "";
}
</script>

<template>
  <section class="h-full min-h-0 flex flex-col" :aria-label="t('editor.bookmarks.workspaceTitle')">
    <div class="p-2 border-b shrink-0">
      <div class="flex items-center gap-1.5 rounded-md border bg-background px-2">
        <Search class="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <input v-model="search" type="search" class="min-w-0 w-full h-8 bg-transparent text-xs outline-none" :aria-label="t('editor.bookmarks.workspaceSearch')" :placeholder="t('editor.bookmarks.workspaceSearch')" @keydown="onSearchKey" />
        <span class="text-xs text-muted-foreground tabular-nums" aria-live="polite">{{ total }}</span>
      </div>
    </div>
    <div ref="list" class="flex-1 min-h-0 overflow-y-auto py-1">
      <div v-for="group in groups" :key="group.id" class="mb-2" :data-bookmark-tab="group.id">
        <div class="sticky top-0 bg-muted px-2 py-1.5 text-xs font-medium flex items-center gap-1.5" :title="group.path || group.title">
          <Bookmark class="h-3.5 w-3.5 shrink-0" />
          <span class="truncate flex-1">{{ group.title }}</span>
          <span class="text-muted-foreground">{{ group.entries.length }}</span>
        </div>
        <button
          v-for="entry in group.entries"
          :key="entry.line"
          type="button"
          class="w-full flex items-start gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
          :data-bookmark-line="entry.line"
          :title="`${group.title} · ${t('editor.bookmarks.line', { line: entry.line })}\n${entry.text}`"
          @click="queryStore.revealBookmark(group.id, entry.line)"
        >
          <span class="min-w-7 shrink-0 text-right text-muted-foreground tabular-nums">{{ entry.line }}</span>
          <span class="truncate font-mono">{{ entry.text || t("editor.bookmarks.emptyLine") }}</span>
        </button>
      </div>
      <p v-if="!total" class="px-4 py-8 text-center text-xs text-muted-foreground leading-6" role="status">{{ search.trim() ? t("editor.bookmarks.noMatches") : t("editor.bookmarks.workspaceEmpty") }}</p>
    </div>
  </section>
</template>

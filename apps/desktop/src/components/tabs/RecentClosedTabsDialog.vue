<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import TabModeIcon from "@/components/layout/TabModeIcon.vue";
import { matchesIdentifierSearch } from "@/lib/sql/identifierSearch";
import { tabSwitcherOrder } from "@/lib/tabs/tabSwitcher";
import type { QueryTab } from "@/types/database";
import { connectionDisplayName, tabDisplayTitle } from "@/lib/tabs/tabPresentation";
import { useQueryStore, type ClosedTabHistoryEntry } from "@/stores/queryStore";

const props = defineProps<{ open: boolean; tablesOnly?: boolean }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();
const { t } = useI18n();
const queryStore = useQueryStore();
const search = ref("");
const selectedIndex = ref(0);
const inputRef = ref<InstanceType<typeof Input>>();
const listRef = ref<HTMLElement>();
type RecentTabChoice = { tab: QueryTab; closed?: ClosedTabHistoryEntry };
const dialogTitle = computed(() => t(props.tablesOnly ? "tabs.recentTablesTitle" : "tabs.recentClosedTitle"));
const searchLabel = computed(() => t(props.tablesOnly ? "tabs.recentTablesSearch" : "tabs.recentClosedSearch"));
const entries = computed<RecentTabChoice[]>(() => {
  const closed = [...queryStore.closedTabsHistory].reverse().map((entry) => ({ tab: entry.tab, closed: entry }));
  if (!props.tablesOnly) return closed;

  const opened = tabSwitcherOrder(queryStore.tabs, queryStore.recentTabIds).map((tab) => ({ tab }));
  const identities = new Set<string>();
  // Prefer an already-open table to an older closed snapshot of the same object.
  return [...opened, ...closed].filter(({ tab }) => {
    if (tab.mode !== "data") return false;
    const meta = tab.tableMeta;
    const identity = JSON.stringify([tab.connectionId, meta?.catalog ?? tab.catalog ?? "", meta?.database ?? tab.database, meta?.schema ?? tab.schema ?? "", meta?.tableName ?? tab.title]);
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  });
});

const rows = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase();
  return entries.value
    .map((entry) => {
      const tab = entry.tab;
      const tableName = tab.tableMeta?.tableName ?? tab.title;
      const database = tab.tableMeta?.database ?? tab.database;
      const schema = tab.tableMeta?.schema ?? tab.schema;
      const scope = props.tablesOnly ? [tab.tableMeta?.catalog ?? tab.catalog, database, schema !== database ? schema : undefined].filter(Boolean).join(" / ") : tab.database;
      return {
        entry,
        title: props.tablesOnly ? tableName : tabDisplayTitle(tab, t),
        connection: connectionDisplayName(tab.connectionId),
        scope,
        preview: props.tablesOnly ? "" : tab.sql.slice(0, 200).replace(/\s+/g, " "),
      };
    })
    .filter((row) => {
      if (!needle) return true;
      const fields = [row.title, row.connection, row.scope, row.preview];
      return props.tablesOnly ? fields.some((value) => value && matchesIdentifierSearch(value, needle)) : fields.some((value) => value?.toLocaleLowerCase().includes(needle));
    });
});

watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    search.value = "";
    selectedIndex.value = 0;
    await nextTick();
    inputRef.value?.$el.focus();
  },
);
watch(rows, () => {
  selectedIndex.value = 0;
});
watch(selectedIndex, async () => {
  await nextTick();
  listRef.value?.querySelectorAll("[data-recent-closed-tab]")[selectedIndex.value]?.scrollIntoView({ block: "nearest" });
});

function select(entry: RecentTabChoice): void {
  if (entry.closed) queryStore.reopenClosedTabEntry(entry.closed);
  else queryStore.switchTab(entry.tab.id);
  emit("update:open", false);
}

function handleKeyDown(event: KeyboardEvent): void {
  if (event.isComposing) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const count = rows.value.length;
    if (count) selectedIndex.value = (selectedIndex.value + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
  } else if (event.key === "Enter") {
    event.preventDefault();
    const row = rows.value[selectedIndex.value];
    if (row) select(row.entry);
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-w-lg">
      <DialogHeader
        ><DialogTitle>{{ dialogTitle }}</DialogTitle></DialogHeader
      >
      <Input ref="inputRef" v-model="search" :placeholder="searchLabel" :aria-label="searchLabel" @keydown="handleKeyDown" />
      <div ref="listRef" class="max-h-[50vh] overflow-y-auto" role="listbox" :aria-label="dialogTitle">
        <button
          v-for="(row, index) in rows"
          :key="index"
          type="button"
          data-recent-closed-tab
          role="option"
          :aria-selected="index === selectedIndex"
          class="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          :class="{ 'bg-accent': index === selectedIndex }"
          @mouseenter="selectedIndex = index"
          @click="select(row.entry)"
        >
          <TabModeIcon :tab="row.entry.tab" class="h-4 w-4 shrink-0" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{{ row.title }}</span>
            <span class="block truncate text-xs text-muted-foreground"
              >{{ row.connection }}<template v-if="row.scope"> · {{ row.scope }}</template></span
            >
            <span v-if="row.preview" class="block truncate font-mono text-xs text-muted-foreground">{{ row.preview }}</span>
          </span>
          <span v-if="tablesOnly" class="shrink-0 text-xs text-muted-foreground">{{ t(row.entry.closed ? "tabs.recentTableClosed" : "tabs.recentTableOpen") }}</span>
        </button>
        <p v-if="!rows.length" class="p-4 text-center text-sm text-muted-foreground">{{ t("tabs.noMatchingTabs") }}</p>
      </div>
    </DialogContent>
  </Dialog>
</template>

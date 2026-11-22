<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import TabModeIcon from "@/components/layout/TabModeIcon.vue";
import { connectionDisplayName, tabDisplayTitle } from "@/lib/tabs/tabPresentation";
import { useQueryStore, type ClosedTabHistoryEntry } from "@/stores/queryStore";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();
const { t } = useI18n();
const queryStore = useQueryStore();
const search = ref("");
const selectedIndex = ref(0);
const inputRef = ref<InstanceType<typeof Input>>();
const listRef = ref<HTMLElement>();
const rows = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase();
  return [...queryStore.closedTabsHistory]
    .reverse()
    .map((entry) => ({
      entry,
      title: tabDisplayTitle(entry.tab, t),
      connection: connectionDisplayName(entry.tab.connectionId),
      preview: entry.tab.sql.slice(0, 200).replace(/\s+/g, " "),
    }))
    .filter((row) => !needle || [row.title, row.connection, row.entry.tab.database, row.preview].some((value) => value?.toLocaleLowerCase().includes(needle)));
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

function reopen(entry: ClosedTabHistoryEntry): void {
  queryStore.reopenClosedTabEntry(entry);
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
    if (row) reopen(row.entry);
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-w-lg">
      <DialogHeader
        ><DialogTitle>{{ t("tabs.recentClosedTitle") }}</DialogTitle></DialogHeader
      >
      <Input ref="inputRef" v-model="search" :placeholder="t('tabs.recentClosedSearch')" :aria-label="t('tabs.recentClosedSearch')" @keydown="handleKeyDown" />
      <div ref="listRef" class="max-h-[50vh] overflow-y-auto" role="listbox" :aria-label="t('tabs.recentClosedTitle')">
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
          @click="reopen(row.entry)"
        >
          <TabModeIcon :tab="row.entry.tab" class="h-4 w-4 shrink-0" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium">{{ row.title }}</span>
            <span class="block truncate text-xs text-muted-foreground"
              >{{ row.connection }}<template v-if="row.entry.tab.database"> · {{ row.entry.tab.database }}</template></span
            >
            <span v-if="row.preview" class="block truncate font-mono text-xs text-muted-foreground">{{ row.preview }}</span>
          </span>
        </button>
        <p v-if="!rows.length" class="p-4 text-center text-sm text-muted-foreground">{{ t("tabs.noMatchingTabs") }}</p>
      </div>
    </DialogContent>
  </Dialog>
</template>

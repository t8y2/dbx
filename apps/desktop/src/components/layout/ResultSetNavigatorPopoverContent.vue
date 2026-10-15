<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Check } from "@lucide/vue";
import { PopoverContent } from "@/components/ui/popover";
import { filterResultItems, type ResultItem } from "@/components/layout/resultSetNavigator";

const props = withDefaults(
  defineProps<{
    items: ResultItem[];
    activeIndex: number;
    active: boolean;
    align?: "start" | "center" | "end";
  }>(),
  {
    align: "start",
  },
);

const emit = defineEmits<{
  select: [item: ResultItem];
}>();

const { t } = useI18n();
const searchInput = ref<HTMLInputElement | null>(null);
const list = ref<HTMLElement | null>(null);
const search = ref("");

const filteredItems = computed(() => {
  return filterResultItems(props.items, search.value, t);
});

function onOpenAutoFocus() {
  search.value = "";
  searchInput.value?.focus();
}

function select(item: ResultItem) {
  emit("select", item);
}

function focusListItem(index: number) {
  const buttons = list.value?.querySelectorAll<HTMLButtonElement>("button");
  if (!buttons?.length) return;
  buttons[Math.max(0, Math.min(index, buttons.length - 1))]?.focus();
}

function onSearchKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    focusListItem(event.key === "ArrowDown" ? 0 : filteredItems.value.length - 1);
  } else if (event.key === "Enter" && filteredItems.value[0]) {
    event.preventDefault();
    select(filteredItems.value[0]);
  }
}

function onListKeydown(event: KeyboardEvent, index: number) {
  if (event.key === "ArrowUp" && index === 0) {
    event.preventDefault();
    searchInput.value?.focus();
  } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    focusListItem(event.key === "Home" ? 0 : event.key === "End" ? filteredItems.value.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1));
  }
}
</script>

<template>
  <PopoverContent :align="align" class="w-96 max-h-[var(--reka-popover-content-available-height)] max-w-[calc(100vw-2rem)] gap-1 p-1" @open-auto-focus.prevent="onOpenAutoFocus">
    <input ref="searchInput" v-model="search" type="search" class="m-1 shrink-0 rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" :placeholder="t('tabs.searchResults')" :aria-label="t('tabs.searchResults')" @keydown="onSearchKeydown" />
    <div ref="list" class="min-h-0 max-h-72 overflow-y-auto overscroll-contain" :aria-label="t('tabs.resultSets')">
      <button
        v-for="(item, index) in filteredItems"
        :key="item.index"
        type="button"
        class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
        :aria-pressed="active && activeIndex === item.index"
        @click="select(item)"
        @keydown="onListKeydown($event, index)"
      >
        <Check class="h-3.5 w-3.5 shrink-0" :class="{ invisible: !active || activeIndex !== item.index }" />
        <span class="min-w-0 flex-1">
          <span class="block truncate font-medium"
            >{{ t("tabs.resultN", { n: item.n }) }}<template v-if="item.label"> · {{ item.label }}</template></span
          >
          <span v-if="item.title" class="block truncate text-muted-foreground">{{ item.title }}</span>
        </span>
      </button>
      <p v-if="!filteredItems.length" role="status" class="p-4 text-center text-xs text-muted-foreground">{{ t("tabs.noMatchingResults") }}</p>
    </div>
  </PopoverContent>
</template>

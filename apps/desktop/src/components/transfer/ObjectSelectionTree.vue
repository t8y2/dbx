<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import type { TransferObjectKind } from "@/lib/backend/api";
import { Square, CheckSquare, MinusSquare, Search, ChevronRight } from "@lucide/vue";

const { t } = useI18n();

export interface ObjectTreeGroup {
  kind: TransferObjectKind;
  label: string;
  items: string[];
}

// Keep large groups safe both before and after the user expands them. The
// complete item arrays remain in the model; only their DOM representation is bounded.
const VIRTUALIZED_GROUP_ITEM_LIMIT = 200;
const OBJECT_ITEM_HEIGHT = 28;
const OBJECT_LIST_HEIGHT = 200;
const OBJECT_LIST_BUFFER = 160;
const EMPTY_SELECTION = new Set<string>();

const props = defineProps<{
  groups: ObjectTreeGroup[];
  disabledGroups: TransferObjectKind[];
  disabledHints: Record<string, string>;
  modelValue: Record<string, string[]>;
  search?: string;
  loading?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: Record<string, string[]>];
  "update:search": [value: string];
}>();

// Local search state: the input edits this ref directly and changes are
// forwarded up via update:search (v-model:search on the parent).
const localSearch = ref(props.search ?? "");
watch(
  () => props.search,
  (v) => {
    if (v !== localSearch.value) localSearch.value = v ?? "";
  },
);
watch(localSearch, (v) => {
  if (v !== (props.search ?? "")) emit("update:search", v);
});

const searchQuery = computed(() => localSearch.value.trim().toLowerCase());

function isVirtualizedGroup(group: ObjectTreeGroup): boolean {
  return group.items.length > VIRTUALIZED_GROUP_ITEM_LIMIT;
}

function hasSearchMatch(items: string[]): boolean {
  const query = searchQuery.value;
  return query.length > 0 && items.some((name) => name.toLowerCase().includes(query));
}

const expanded = ref<Set<string>>(new Set(props.groups.filter((group) => !isVirtualizedGroup(group) || hasSearchMatch(group.items)).map((group) => group.kind)));

function toggleGroup(kind: string) {
  const next = new Set(expanded.value);
  if (next.has(kind)) {
    next.delete(kind);
  } else {
    next.add(kind);
  }
  expanded.value = next;
}

function isGroupDisabled(kind: TransferObjectKind): boolean {
  return props.disabledGroups.includes(kind);
}

function selectedNames(kind: string): string[] {
  return props.modelValue[kind] ?? [];
}

const selectedSets = computed<Record<string, Set<string>>>(() => {
  const next: Record<string, Set<string>> = {};
  for (const [kind, names] of Object.entries(props.modelValue)) {
    if (names.length > 0) next[kind] = new Set(names);
  }
  return next;
});

function selectedSet(kind: string): Set<string> {
  return selectedSets.value[kind] ?? EMPTY_SELECTION;
}

function updateSelection(kind: string, names: string[]) {
  const next: Record<string, string[]> = { ...props.modelValue };
  if (names.length === 0) {
    delete next[kind];
  } else {
    next[kind] = names;
  }
  emit("update:modelValue", next);
}

function toggleItem(kind: string, item: string) {
  const current = selectedNames(kind);
  const next = selectedSet(kind).has(item) ? current.filter((n) => n !== item) : [...current, item];
  updateSelection(kind, next);
}

function toggleGroupAll(kind: TransferObjectKind, items: string[]) {
  const current = selectedNames(kind);
  const selected = selectedSet(kind);
  const visibleItems = new Set(items);
  const allVisibleSelected = items.length > 0 && items.every((n) => selected.has(n));
  if (allVisibleSelected) {
    // uncheck only the visible items, keep selections hidden by the search
    updateSelection(
      kind,
      current.filter((n) => !visibleItems.has(n)),
    );
  } else {
    // check the visible items, merging with existing (possibly hidden) ones
    updateSelection(kind, [...new Set([...current, ...items])]);
  }
}

const filteredGroups = computed<ObjectTreeGroup[]>(() => {
  const query = searchQuery.value;
  if (!query) {
    return props.groups;
  }
  return props.groups.map((group) => {
    const prefixMatches: string[] = [];
    const substringMatches: string[] = [];
    for (const name of group.items) {
      const normalizedName = name.toLowerCase();
      if (normalizedName.startsWith(query)) {
        prefixMatches.push(name);
      } else if (normalizedName.includes(query)) {
        substringMatches.push(name);
      }
    }
    return { ...group, items: [...prefixMatches, ...substringMatches] };
  });
});

function shouldAutoExpandGroup(group: ObjectTreeGroup): boolean {
  if (!isVirtualizedGroup(group)) return true;
  const visibleGroup = filteredGroups.value.find((candidate) => candidate.kind === group.kind);
  return searchQuery.value.length > 0 && (visibleGroup?.items.length ?? 0) > 0;
}

// Groups arrive after the tree mounts because object metadata is loaded
// asynchronously. New small groups keep the existing expanded behavior, while
// large groups stay collapsed unless search has a visible match.
watch(
  () => props.groups,
  (groups, previousGroups) => {
    const previousByKind = new Map((previousGroups ?? []).map((group) => [group.kind, group]));
    const currentKinds = new Set<string>(groups.map((group) => group.kind));
    const next = new Set([...expanded.value].filter((kind) => currentKinds.has(kind)));

    for (const group of groups) {
      const previousGroup = previousByKind.get(group.kind);
      const becameVirtualized = isVirtualizedGroup(group) && (!previousGroup || !isVirtualizedGroup(previousGroup));
      if (becameVirtualized && searchQuery.value.length === 0) {
        next.delete(group.kind);
      } else if (!next.has(group.kind) && shouldAutoExpandGroup(group)) {
        next.add(group.kind);
      }
    }

    const unchanged = next.size === expanded.value.size && [...next].every((kind) => expanded.value.has(kind));
    if (!unchanged) expanded.value = next;
  },
);

// Searching must reveal matching groups even when a large group starts
// collapsed. The virtualized branch still bounds the resulting DOM.
watch(searchQuery, (query) => {
  if (!query) return;
  const next = new Set(expanded.value);
  for (const group of filteredGroups.value) {
    if (group.items.length > 0) next.add(group.kind);
  }
  const unchanged = next.size === expanded.value.size && [...next].every((kind) => expanded.value.has(kind));
  if (!unchanged) expanded.value = next;
});

function selectAllEnabled() {
  const next: Record<string, string[]> = { ...props.modelValue };
  for (const group of filteredGroups.value) {
    if (isGroupDisabled(group.kind)) continue;
    next[group.kind] = [...new Set([...(next[group.kind] ?? []), ...group.items])];
  }
  emit("update:modelValue", next);
}

function deselectAll() {
  // Clear only the visible, enabled selections; selections hidden by the
  // current search and selections inside disabled groups are preserved so
  // bulk actions never silently drop what the user cannot see.
  const next: Record<string, string[]> = { ...props.modelValue };
  for (const group of filteredGroups.value) {
    if (isGroupDisabled(group.kind)) continue;
    const visibleItems = new Set(group.items);
    const kept = (next[group.kind] ?? []).filter((n) => !visibleItems.has(n));
    if (kept.length === 0) {
      delete next[group.kind];
    } else {
      next[group.kind] = kept;
    }
  }
  emit("update:modelValue", next);
}

// The bulk button flips between “select all” and “deselect all”. It shows
// “deselect all” only when every visible, enabled item is already selected
// (selecting more is then a no-op); otherwise “select all” is shown so the
// user can fill the remaining visible items. Groups with no visible items
// (fully filtered out by the search) and disabled groups are ignored.
const allVisibleEnabledSelected = computed(() => {
  const visibleEnabled = filteredGroups.value.filter((g) => !isGroupDisabled(g.kind) && g.items.length > 0);
  return (
    visibleEnabled.length > 0 &&
    visibleEnabled.every((g) => {
      const selected = selectedSet(g.kind);
      return g.items.every((item) => selected.has(item));
    })
  );
});

// Tri-state header checkbox: "all" when every visible item of the group is
// selected, "partial" when only some are, "none" otherwise. Mirrors
// toggleGroupAll, which only ever touches the visible items.
function groupSelectionState(kind: TransferObjectKind, items: string[]): "none" | "partial" | "all" {
  if (items.length === 0) return "none";
  const selected = selectedSet(kind);
  const visibleSelected = items.filter((item) => selected.has(item)).length;
  if (visibleSelected === 0) return "none";
  if (visibleSelected === items.length) return "all";
  return "partial";
}
</script>

<template>
  <div class="flex flex-col flex-1 min-h-0 gap-2.5">
    <!-- Sticky top bar: search input and action buttons -->
    <div class="flex items-center gap-2 shrink-0">
      <div class="relative flex-1 min-w-0">
        <Search class="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
        <input
          data-test="search"
          :placeholder="t('transfer.searchObjects')"
          v-model="localSearch"
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          class="pl-8 pr-2.5 h-8 w-full rounded-md border border-input bg-transparent text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:border-ring transition-colors placeholder:text-muted-foreground/70"
        />
      </div>
      <Button v-if="allVisibleEnabledSelected" variant="outline" size="sm" @click="deselectAll">
        {{ t("transfer.deselectAll") }}
      </Button>
      <Button v-else variant="outline" size="sm" @click="selectAllEnabled">
        {{ t("transfer.selectAll") }}
      </Button>
    </div>

    <div v-if="loading" class="py-4 text-center text-sm text-muted-foreground">
      {{ t("common.loading") }}
    </div>

    <div v-else-if="groups.length === 0" class="py-4 text-center text-sm text-muted-foreground">
      {{ t("transfer.noObjects") }}
    </div>

    <!-- Independent scroll area for tree groups. mr-4 keeps this box's own
         scrollbar clear of the dialog's outer scrollbar (only pr-1 away in
         DataTransferDialog.vue) so the two hit areas don't overlap. -->
    <div v-else class="flex-1 min-h-0 max-h-[240px] flex flex-col gap-1.5 overflow-y-auto rounded-md border border-border/80 bg-muted/10 p-1.5 mr-4 scrollbar-thin scrollbar-thumb-muted-foreground/20">
      <div v-for="group in filteredGroups" :key="group.kind" :data-test="`group-${group.kind}`" class="rounded-lg border border-border/60 bg-card/60 transition-all hover:bg-card flex flex-col p-1.5" :class="{ 'opacity-50 bg-muted/5 border-dashed border-muted': isGroupDisabled(group.kind) }">
        <div class="flex items-center gap-2 px-1 py-0.5 select-none">
          <button :data-test="'group-toggle'" :data-state="groupSelectionState(group.kind, group.items)" type="button" class="flex items-center gap-2 text-left shrink-0" :disabled="isGroupDisabled(group.kind)" @click="!isGroupDisabled(group.kind) && toggleGroupAll(group.kind, group.items)">
            <CheckSquare v-if="groupSelectionState(group.kind, group.items) === 'all'" class="h-4 w-4 text-primary" />
            <MinusSquare v-else-if="groupSelectionState(group.kind, group.items) === 'partial'" class="h-4 w-4 text-primary" />
            <Square v-else class="h-4 w-4 text-muted-foreground" />
          </button>
          <span class="flex-1 text-xs font-semibold text-foreground/90 cursor-pointer" @click="toggleGroup(group.kind)">
            {{ group.label }}
          </span>
          <span class="text-[10px] px-1 py-0.5 rounded-full bg-muted/60 text-muted-foreground font-mono shrink-0"> {{ (modelValue[group.kind] ?? []).length }}/{{ group.items.length }} </span>
          <span v-if="disabledHints[group.kind]" class="rounded bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-700 font-medium shrink-0">
            {{ disabledHints[group.kind] }}
          </span>
          <button data-test="group-expand" type="button" class="text-muted-foreground hover:text-foreground shrink-0 p-0.5" :aria-expanded="expanded.has(group.kind)" @click="toggleGroup(group.kind)">
            <ChevronRight class="h-3.5 w-3.5 text-muted-foreground/80 transition-transform duration-200" :class="{ 'rotate-90': expanded.has(group.kind) }" />
          </button>
        </div>

        <template v-if="expanded.has(group.kind)">
          <div v-if="!isVirtualizedGroup(group)" class="flex flex-col gap-0.5 pl-6 pr-1 mt-1">
            <label v-for="item in group.items" :key="item" class="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-muted/70 transition-colors" :class="{ 'pointer-events-none opacity-50': isGroupDisabled(group.kind) }" :data-test="`item-${group.kind}-${item}`">
              <input type="checkbox" class="h-3.5 w-3.5" :checked="selectedSet(group.kind).has(item)" :disabled="isGroupDisabled(group.kind)" @change="toggleItem(group.kind, item)" />
              <span class="truncate text-foreground/80">{{ item }}</span>
            </label>
            <div v-if="group.items.length === 0" class="px-1 py-1 text-xs text-muted-foreground">无匹配</div>
          </div>
          <div v-else class="pl-6 pr-1 mt-1" :style="{ height: `${OBJECT_LIST_HEIGHT}px` }">
            <RecycleScroller v-slot="{ item }" class="h-full" :items="group.items" :item-size="OBJECT_ITEM_HEIGHT" :buffer="OBJECT_LIST_BUFFER">
              <label class="flex h-7 cursor-pointer items-center gap-2 rounded px-1.5 text-xs hover:bg-muted/70 transition-colors" :class="{ 'pointer-events-none opacity-50': isGroupDisabled(group.kind) }" :data-test="`item-${group.kind}-${item}`">
                <input type="checkbox" class="h-3.5 w-3.5" :checked="selectedSet(group.kind).has(item)" :disabled="isGroupDisabled(group.kind)" @change="toggleItem(group.kind, item)" />
                <span class="truncate text-foreground/80">{{ item }}</span>
              </label>
            </RecycleScroller>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

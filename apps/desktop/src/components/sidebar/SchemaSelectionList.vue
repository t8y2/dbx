<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { CheckSquare, ChevronDown, ChevronRight, MinusSquare, Square } from "@lucide/vue";
import { RecycleScroller } from "vue-virtual-scroller";
import { isSystemSchemaName } from "@/lib/database/visibleDatabases";
import type { DatabaseType } from "@/types/database";

const props = defineProps<{
  names: string[];
  databaseType?: DatabaseType;
  systemNames?: ReadonlySet<string>;
  search?: string;
}>();
const selection = defineModel<Set<string>>({ required: true });
const { t } = useI18n();
const isSystem = (name: string) => props.systemNames?.has(name) ?? isSystemSchemaName(props.databaseType, name);
const expanded = ref({ ordinary: true, system: props.names.some((name) => isSystem(name) && selection.value.has(name)) });
const groups = computed(() => {
  const query = props.search?.trim().toLowerCase();
  const names = props.names.filter((name) => !query || name.toLowerCase().includes(query));
  return [
    { key: "ordinary" as const, label: t("visibleSchemas.ordinaryGroup"), names: names.filter((name) => !isSystem(name)) },
    { key: "system" as const, label: t("visibleSchemas.systemGroup"), names: names.filter(isSystem) },
  ];
});
const rows = computed(() =>
  groups.value.flatMap((group) => {
    if (!group.names.length) return [];
    const open = !!props.search?.trim() || expanded.value[group.key];
    return [{ id: `group:${group.key}`, name: "", group, open, header: true }, ...(open ? group.names.map((name) => ({ id: `schema:${name}`, name, group, open, header: false })) : [])];
  }),
);
function toggle(name: string) {
  const next = new Set(selection.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  selection.value = next;
}
function toggleGroup(names: string[]) {
  const checked = names.every((name) => selection.value.has(name));
  const next = new Set(selection.value);
  for (const name of names) {
    if (checked) next.delete(name);
    else next.add(name);
  }
  selection.value = next;
}
</script>

<template>
  <div v-if="!rows.length" class="h-72 overflow-y-auto rounded-md border bg-background/50 p-3 text-sm text-muted-foreground">{{ t("grid.noSearchResults") }}</div>
  <RecycleScroller v-else v-slot="{ item }" class="h-72 rounded-md border bg-background/50 p-1" :items="rows" :item-size="32" key-field="id" :buffer="160">
    <div v-if="item.header" class="flex h-8 items-center gap-1 rounded-sm bg-muted/50 px-1" :data-schema-group="item.group.key">
      <button type="button" class="flex h-7 min-w-0 flex-1 items-center gap-1 text-left text-sm font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-ring" :aria-expanded="item.open" @click="expanded[item.group.key as 'ordinary' | 'system'] = !item.open">
        <ChevronDown v-if="item.open" class="h-4 w-4 shrink-0" /><ChevronRight v-else class="h-4 w-4 shrink-0" />
        <span class="truncate">{{ item.group.label }}</span>
        <span class="ml-1 text-xs font-normal text-muted-foreground">{{ item.group.names.filter((name: string) => selection.has(name)).length }} / {{ item.group.names.length }}</span>
      </button>
      <button
        type="button"
        role="checkbox"
        class="flex h-7 w-7 items-center justify-center rounded-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        :aria-label="`${t('visibleSchemas.selectAll')} · ${item.group.label}`"
        :aria-checked="item.group.names.every((name: string) => selection.has(name)) ? true : item.group.names.some((name: string) => selection.has(name)) ? 'mixed' : false"
        @click="toggleGroup(item.group.names)"
      >
        <CheckSquare v-if="item.group.names.every((name: string) => selection.has(name))" class="h-4 w-4 text-primary" />
        <MinusSquare v-else-if="item.group.names.some((name: string) => selection.has(name))" class="h-4 w-4 text-primary" />
        <Square v-else class="h-4 w-4 text-muted-foreground" />
      </button>
    </div>
    <button
      v-else
      type="button"
      role="checkbox"
      :aria-checked="selection.has(item.name)"
      :data-schema-row="item.name"
      class="flex h-8 w-full min-w-0 items-center gap-2 rounded-sm pr-2 pl-6 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
      @click="toggle(item.name)"
    >
      <CheckSquare v-if="selection.has(item.name)" class="h-4 w-4 shrink-0 text-primary" /><Square v-else class="h-4 w-4 shrink-0 text-muted-foreground" />
      <span class="truncate">{{ item.name }}</span>
    </button>
  </RecycleScroller>
</template>

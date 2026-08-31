<script setup lang="ts">
import type { IndexSection } from "../docsIndex";
import { qualifiedTableKey } from "../docsKeys";
import { groupStyle } from "../groupColor";
import type { Translate } from "../docsWarnings";

defineProps<{
  sections: IndexSection[];
  mode: "schema" | "group";
  /** Qualified name of the table currently open, or null on the index. */
  activeKey: string | null;
  translate: Translate;
}>();

const emit = defineEmits<{
  "update:mode": ["schema" | "group"];
  select: [tableKey: string];
  home: [];
}>();
</script>

<template>
  <nav class="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border bg-background p-3">
    <button type="button" class="rounded px-2 py-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40" @click="emit('home')">{{ translate("docs.overview") }}</button>

    <div class="flex flex-col gap-1">
      <span class="px-2 text-[10px] uppercase tracking-wide text-muted-foreground">{{ translate("docs.groupBy") }}</span>
      <div class="flex rounded border border-border p-0.5">
        <button type="button" class="flex-1 rounded px-2 py-1 text-xs transition-colors" :class="mode === 'schema' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/40'" @click="emit('update:mode', 'schema')">{{ translate("docs.groupBySchema") }}</button>
        <button type="button" class="flex-1 rounded px-2 py-1 text-xs transition-colors" :class="mode === 'group' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/40'" @click="emit('update:mode', 'group')">{{ translate("docs.groupByTableGroup") }}</button>
      </div>
    </div>

    <div v-for="section in sections" :key="section.key" class="flex flex-col gap-0.5">
      <div class="flex items-center gap-1.5 px-2 py-1" :class="{ 'docs-group': section.hue !== null }" :style="groupStyle(section.hue)">
        <span v-if="section.hue !== null" class="h-2 w-2 shrink-0 rounded-full" style="background-color: var(--group-c)"></span>
        <span class="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {{ section.label || translate(section.fallbackKey) }}
        </span>
      </div>
      <button
        v-for="table in section.tables"
        :key="qualifiedTableKey(table)"
        type="button"
        class="truncate rounded px-2 py-1 text-left font-mono text-xs transition-colors"
        :class="activeKey === qualifiedTableKey(table) ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/40'"
        @click="emit('select', qualifiedTableKey(table))"
      >
        {{ table.name }}
      </button>
    </div>
  </nav>
</template>

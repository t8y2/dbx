<script setup lang="ts">
import type { IndexSection } from "../docsIndex";
import { qualifiedTableKey } from "../docsKeys";
import { groupStyle } from "../groupColor";
import { renderNote } from "../renderNote";
import type { Translate } from "../docsWarnings";

defineProps<{
  sections: IndexSection[];
  translate: Translate;
}>();

const emit = defineEmits<{
  select: [tableKey: string];
}>();
</script>

<template>
  <div class="flex flex-col gap-6">
    <section v-for="section in sections" :key="section.key" class="flex flex-col gap-2">
      <div class="flex flex-col gap-1 border-l-2 pl-3" :class="{ 'docs-group': section.hue !== null }" style="border-color: var(--group-c, var(--border))" :style="groupStyle(section.hue)">
        <div class="flex items-baseline gap-2">
          <h2 class="text-sm font-semibold text-foreground">{{ section.label || translate(section.fallbackKey) }}</h2>
          <span class="text-xs text-muted-foreground">{{ section.tables.length }} tables</span>
        </div>
        <div v-if="section.note" class="text-xs text-muted-foreground" v-html="renderNote(section.note)"></div>
      </div>

      <ul class="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        <!-- The note renders author markdown, so it can contain an <a>. Inside
             the <button> that would be invalid nesting and the link would not
             be keyboard reachable, so the note is a sibling of the button and
             the <li> carries the card. -->
        <li v-for="table in section.tables" :key="qualifiedTableKey(table)" class="flex flex-col gap-0.5 rounded border border-border bg-background px-2 py-1.5 transition-colors hover:bg-muted/40">
          <button type="button" class="flex w-full items-baseline gap-1.5 text-left" @click="emit('select', qualifiedTableKey(table))">
            <span class="font-mono text-xs font-medium text-foreground">{{ table.name }}</span>
            <span v-if="table.kind !== 'TABLE'" class="text-[10px] uppercase text-muted-foreground">
              {{ table.kind.toLowerCase().replace(/_/g, " ") }}
            </span>
          </button>
          <div v-if="table.note" class="line-clamp-2 text-[11px] text-muted-foreground" v-html="renderNote(table.note)"></div>
        </li>
      </ul>
    </section>
  </div>
</template>

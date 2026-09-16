<script setup lang="ts">
import { computed } from "vue";
import { columnsUsingEnum } from "../docsIndex";
import type { Translate } from "../docsWarnings";
import type { DocEnum, SchemaSnapshot } from "../types";
import NoteEditor from "./NoteEditor.vue";

const props = defineProps<{
  enumType: DocEnum;
  /** Every table in the snapshot; usedBy filters them down to enum columns. */
  snapshot: SchemaSnapshot;
  translate: Translate;
}>();

const emit = defineEmits<{
  select: [tableKey: string];
}>();

const qualifiedName = computed(() => (props.enumType.schema ? `${props.enumType.schema}.${props.enumType.name}` : props.enumType.name));

// No annotation storage exists for enum notes yet (AnnotationFile has no
// `enums` key), so this is always read-only — there is nowhere to save an
// edit to.
const usedBy = computed(() => columnsUsingEnum(props.snapshot, props.enumType.name));
</script>

<template>
  <article class="flex flex-col gap-5">
    <header class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="font-mono text-lg font-semibold text-foreground">{{ qualifiedName }}</h2>
        <span v-if="enumType.synthesized" class="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">synthesized</span>
      </div>

      <NoteEditor :model-value="enumType.note ?? ''" readonly :translate="translate" />
    </header>

    <section>
      <h3 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ translate("docs.enumValues") }}</h3>
      <ul class="flex flex-wrap gap-1">
        <li v-for="value in enumType.values" :key="value" class="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[11px] text-foreground">{{ value }}</li>
      </ul>
    </section>

    <section>
      <h3 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ translate("docs.usedBy") }}</h3>
      <p v-if="usedBy.length === 0" class="text-xs text-muted-foreground">No column uses this enum.</p>
      <ul v-else class="flex flex-col gap-1">
        <li v-for="hit in usedBy" :key="`${hit.tableKey}.${hit.column}`" class="text-xs">
          <button type="button" class="w-full rounded border border-border bg-background px-2 py-1.5 text-left font-mono transition-colors hover:bg-muted/40" @click="emit('select', hit.tableKey)">{{ hit.tableKey }}.{{ hit.column }}</button>
        </li>
      </ul>
    </section>
  </article>
</template>

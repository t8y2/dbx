<script setup lang="ts">
import { computed } from "vue";
import type { Translate } from "../docsWarnings";
import { qualifiedTableKey } from "../docsKeys";
import { groupStyle } from "../groupColor";
import type { DocsEdit, DocTable, GroupAnnotation, Relationship, TableGroup } from "../types";
import ColumnTable from "./ColumnTable.vue";
import GroupPicker from "./GroupPicker.vue";
import NoteEditor from "./NoteEditor.vue";
import RelationshipList from "./RelationshipList.vue";

const props = defineProps<{
  table: DocTable;
  /** Every relationship in the snapshot; RelationshipList filters them. */
  relationships: Relationship[];
  /** The table's group, or null when it belongs to none. */
  group: TableGroup | null;
  /** The editable group records, which `group` above cannot be written back to. */
  annotationGroups: GroupAnnotation[];
  readonly: boolean;
  translate: Translate;
}>();

const emit = defineEmits<{
  select: [tableKey: string];
  edit: [edit: DocsEdit];
  createGroup: [tableKey: string];
}>();

const qualified = computed(() => qualifiedTableKey(props.table));

const kindLabel = computed(() => props.table.kind.toLowerCase().replace(/_/g, " "));

/**
 * The database comment a local note replaced. Bound with `:title` so Vue
 * escapes it — it is author text, exactly like the note itself.
 */
const shadowedTitle = computed(() => (props.table.shadowedNote ? `Database comment: ${props.table.shadowedNote}` : undefined));
</script>

<template>
  <article class="flex flex-col gap-5">
    <header class="flex flex-col gap-2">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="font-mono text-lg font-semibold text-foreground">{{ qualified }}</h2>
        <span class="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{{ kindLabel }}</span>
        <span v-if="group" class="docs-group rounded px-1.5 py-0.5 text-[10px] font-medium" style="background-color: var(--group-tint); color: var(--group-c)" :style="groupStyle(group.hue)">
          {{ group.name }}
        </span>
        <span v-if="table.estimatedRows !== null" class="text-[10px] text-muted-foreground"> ~{{ table.estimatedRows }} rows </span>
      </div>

      <!-- NoteEditor is fed the MERGED note, not the local one. It renders and
           edits a single value, so seeding it from the annotation file would
           show nothing for a note that came from a database comment. Writing
           one shadows that comment, which is what noteSource and shadowedNote
           below exist to disclose. -->
      <div class="flex items-start gap-2">
        <span v-if="table.noteSource === 'LOCAL'" class="mt-0.5 shrink-0 text-[10px] font-medium text-muted-foreground" :title="shadowedTitle">⬤ LOCAL</span>
        <NoteEditor class="min-w-0 flex-1" :model-value="table.note ?? ''" :readonly="readonly" :translate="translate" @update:model-value="emit('edit', { kind: 'tableNote', tableKey: qualified, note: $event })" />
      </div>

      <GroupPicker v-if="!readonly" :groups="annotationGroups" :model-value="table.groupId" :translate="translate" @update:model-value="emit('edit', { kind: 'tableGroup', tableKey: qualified, groupId: $event })" @create="emit('createGroup', qualified)" />
    </header>

    <section>
      <h3 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Columns</h3>
      <ColumnTable :columns="table.columns" :column-notes="table.columnNotes" :table-key="qualified" :readonly="readonly" :translate="translate" @edit="emit('edit', $event)" />
    </section>

    <section v-if="table.indexes.length > 0">
      <h3 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Indexes</h3>
      <div class="overflow-hidden rounded-md border border-border">
        <table class="w-full text-xs">
          <thead>
            <tr class="bg-muted/30">
              <th class="px-2 py-1.5 text-left font-medium text-muted-foreground">Name</th>
              <th class="px-2 py-1.5 text-left font-medium text-muted-foreground">Columns</th>
              <th class="px-2 py-1.5 text-left font-medium text-muted-foreground">Settings</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="index in table.indexes" :key="index.name" class="border-t border-border align-top">
              <td class="px-2 py-1.5 font-mono">{{ index.name }}</td>
              <td class="px-2 py-1.5 font-mono text-muted-foreground">
                {{ index.columns.join(", ") }}<template v-if="index.included_columns && index.included_columns.length > 0"> (include {{ index.included_columns.join(", ") }}) </template>
              </td>
              <td class="px-2 py-1.5">
                <div class="flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                  <span v-if="index.is_primary" class="rounded bg-muted/50 px-1.5 py-0.5">pk</span>
                  <span v-if="index.is_unique" class="rounded bg-muted/50 px-1.5 py-0.5">unique</span>
                  <span v-if="index.index_type" class="rounded bg-muted/50 px-1.5 py-0.5">{{ index.index_type }}</span>
                  <span v-if="index.filter" class="rounded bg-muted/50 px-1.5 py-0.5">where {{ index.filter }}</span>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section>
      <h3 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Relationships</h3>
      <RelationshipList :relationships="relationships" :schema="table.schema" :table="table.name" @select="emit('select', $event)" />
    </section>

    <section v-if="table.viewDefinition">
      <h3 class="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Definition</h3>
      <pre class="overflow-x-auto rounded-md border border-border bg-muted/20 p-2 font-mono text-xs">{{ table.viewDefinition }}</pre>
    </section>
  </article>
</template>

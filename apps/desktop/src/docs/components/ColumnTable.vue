<script setup lang="ts">
import type { Translate } from "../docsWarnings";
import type { ColumnInfo, ColumnNote, DocsEdit } from "../types";
import NoteEditor from "./NoteEditor.vue";

const props = defineProps<{
  columns: ColumnInfo[];
  /** Keyed by the column's real name, exactly as the snapshot emits it. */
  columnNotes: Record<string, ColumnNote>;
  /** Qualified key of the table these columns belong to, for emitted edits. */
  tableKey: string;
  readonly: boolean;
  translate: Translate;
}>();

const emit = defineEmits<{
  edit: [edit: DocsEdit];
}>();

/** Rebuild the declared type from the parts the snapshot reports separately. */
function typeLabel(column: ColumnInfo): string {
  if (column.character_maximum_length !== null) {
    return `${column.data_type}(${column.character_maximum_length})`;
  }
  if (column.numeric_precision !== null) {
    const scale = column.numeric_scale === null ? "" : `,${column.numeric_scale}`;
    return `${column.data_type}(${column.numeric_precision}${scale})`;
  }
  return column.data_type;
}

function settings(column: ColumnInfo): string[] {
  const parts: string[] = [];
  if (column.is_primary_key) {
    parts.push("pk");
  }
  if (!column.is_nullable) {
    parts.push("not null");
  }
  if (column.column_default !== null) {
    parts.push(`default: ${column.column_default}`);
  }
  if (column.extra !== null && column.extra !== "") {
    parts.push(column.extra);
  }
  if (column.enum_values !== undefined && column.enum_values.length > 0) {
    parts.push(`enum: ${column.enum_values.join(", ")}`);
  }
  return parts;
}

function noteOf(column: ColumnInfo): ColumnNote | null {
  return props.columnNotes[column.name] ?? null;
}

/**
 * The database's own comment, when a local note replaced it. Bound with
 * `:title` so Vue escapes it — this is author text like any other note.
 */
function shadowedTitle(column: ColumnInfo): string | undefined {
  const shadowed = noteOf(column)?.shadowed;
  return shadowed ? `Database comment: ${shadowed}` : undefined;
}
</script>

<template>
  <div class="overflow-hidden rounded-md border border-border">
    <table class="w-full text-xs">
      <thead>
        <tr class="bg-muted/30">
          <th class="px-2 py-1.5 text-left font-medium text-muted-foreground">{{ translate("docs.columnHeader") }}</th>
          <th class="px-2 py-1.5 text-left font-medium text-muted-foreground">{{ translate("docs.typeHeader") }}</th>
          <th class="px-2 py-1.5 text-left font-medium text-muted-foreground">{{ translate("docs.settingsHeader") }}</th>
          <th class="px-2 py-1.5 text-left font-medium text-muted-foreground">{{ translate("docs.noteHeader") }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="column in columns" :key="column.name" class="border-t border-border align-top">
          <td class="px-2 py-1.5 font-mono font-medium text-foreground">{{ column.name }}</td>
          <td class="px-2 py-1.5 font-mono text-muted-foreground">{{ typeLabel(column) }}</td>
          <td class="px-2 py-1.5">
            <div class="flex flex-wrap gap-1">
              <span v-for="setting in settings(column)" :key="setting" class="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {{ setting }}
              </span>
            </div>
          </td>
          <td class="px-2 py-1.5 text-muted-foreground">
            <div class="flex items-start gap-1">
              <span v-if="noteOf(column)?.source === 'LOCAL'" class="mt-0.5 shrink-0 text-[10px] font-medium" :title="shadowedTitle(column)">⬤ {{ translate("docs.localNote") }}</span>
              <!-- Merged note, for the same reason as TablePage: NoteEditor
                   renders and edits one value, and the local layer alone would
                   hide notes that came from the database. -->
              <NoteEditor class="min-w-0 flex-1" :model-value="noteOf(column)?.note ?? ''" :readonly="readonly" :translate="translate" @update:model-value="emit('edit', { kind: 'columnNote', tableKey, column: column.name, note: $event })" />
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

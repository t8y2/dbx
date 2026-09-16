<script setup lang="ts">
import { computed } from "vue";
import { qualifiedTableKey } from "../docsKeys";
import type { Translate } from "../docsWarnings";
import type { FieldRef, Relationship } from "../types";

const props = defineProps<{
  /** Every relationship in the snapshot; filtered here on the current table. */
  relationships: Relationship[];
  schema: string | null;
  table: string;
  translate: Translate;
}>();

const emit = defineEmits<{
  select: [tableKey: string];
}>();

function isCurrent(field: FieldRef): boolean {
  return field.table === props.table && (field.schema ?? null) === props.schema;
}

// FieldRef names its table property `table`, not `name`, so it is remapped
// rather than passed to qualifiedTableKey directly.
function keyOf(field: FieldRef): string {
  return qualifiedTableKey({ schema: field.schema, name: field.table });
}

function label(field: FieldRef): string {
  return `${keyOf(field)}.${field.column}`;
}

function notation(relationship: Relationship): string {
  return relationship.cardinality === "ONE_TO_ONE" ? "1 – 1" : "* – 1";
}

function actions(relationship: Relationship): string[] {
  const parts: string[] = [];
  if (relationship.onUpdate) {
    parts.push(`on update ${relationship.onUpdate}`);
  }
  if (relationship.onDelete) {
    parts.push(`on delete ${relationship.onDelete}`);
  }
  return parts;
}

const outgoing = computed(() => props.relationships.filter((relationship) => isCurrent(relationship.from)));
const incoming = computed(() => props.relationships.filter((relationship) => isCurrent(relationship.to)));
</script>

<template>
  <div class="grid gap-4 sm:grid-cols-2">
    <section>
      <h4 class="mb-1.5 text-xs font-medium text-muted-foreground">{{ translate("docs.references") }} ({{ outgoing.length }})</h4>
      <p v-if="outgoing.length === 0" class="text-xs text-muted-foreground">{{ translate("docs.noOutgoingRelationships") }}</p>
      <ul v-else class="flex flex-col gap-1">
        <li v-for="relationship in outgoing" :key="relationship.id" class="text-xs">
          <button type="button" class="w-full rounded border border-border bg-background px-2 py-1.5 text-left transition-colors hover:bg-muted/40" @click="emit('select', keyOf(relationship.to))">
            <span class="font-mono">{{ relationship.from.column }}</span>
            <span class="mx-1.5 text-muted-foreground">{{ notation(relationship) }}</span>
            <span class="font-mono">{{ label(relationship.to) }}</span>
            <span v-if="actions(relationship).length > 0" class="ml-1.5 text-[10px] text-muted-foreground">
              {{ actions(relationship).join(", ") }}
            </span>
          </button>
        </li>
      </ul>
    </section>

    <section>
      <h4 class="mb-1.5 text-xs font-medium text-muted-foreground">{{ translate("docs.referencedBy") }} ({{ incoming.length }})</h4>
      <p v-if="incoming.length === 0" class="text-xs text-muted-foreground">{{ translate("docs.noIncomingRelationships") }}</p>
      <ul v-else class="flex flex-col gap-1">
        <li v-for="relationship in incoming" :key="relationship.id" class="text-xs">
          <button type="button" class="w-full rounded border border-border bg-background px-2 py-1.5 text-left transition-colors hover:bg-muted/40" @click="emit('select', keyOf(relationship.from))">
            <span class="font-mono">{{ label(relationship.from) }}</span>
            <span class="mx-1.5 text-muted-foreground">{{ notation(relationship) }}</span>
            <span class="font-mono">{{ relationship.to.column }}</span>
            <span v-if="actions(relationship).length > 0" class="ml-1.5 text-[10px] text-muted-foreground">
              {{ actions(relationship).join(", ") }}
            </span>
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>

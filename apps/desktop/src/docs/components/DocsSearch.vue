<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { searchDocs, type SearchHit } from "../docsSearch";
import type { SchemaSnapshot } from "../types";

const props = defineProps<{
  snapshot: SchemaSnapshot;
}>();

const emit = defineEmits<{
  select: [tableKey: string];
  selectEnum: [enumName: string];
}>();

const open = ref(false);
const query = ref("");
const input = ref<HTMLInputElement | null>(null);

// searchDocs caps its own results, per kind. Slicing again here would just
// re-create the bug where columns crowd out every other kind.
const hits = computed(() => searchDocs(props.snapshot, query.value));

async function show(): Promise<void> {
  open.value = true;
  query.value = "";
  await nextTick();
  input.value?.focus();
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (open.value) {
      open.value = false;
    } else {
      void show();
    }
    return;
  }
  if (event.key === "Escape" && open.value) {
    open.value = false;
  }
}

/** Enums navigate by name, everything else by table key; groups have neither. */
function isNavigable(hit: SearchHit): boolean {
  return hit.kind === "enum" || hit.tableKey !== null;
}

function choose(hit: SearchHit): void {
  // Enums navigate by name — they have no table key, and EnumPage resolves them
  // by bare name for the same reason columnsUsingEnum does.
  if (hit.kind === "enum") {
    emit("selectEnum", hit.label);
    open.value = false;
    return;
  }
  // Groups still have no page of their own, so they stay unclickable rather
  // than navigating somewhere arbitrary.
  if (hit.tableKey === null) {
    return;
  }
  emit("select", hit.tableKey);
  open.value = false;
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div>
    <button type="button" class="flex items-center gap-2 rounded border border-border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40" @click="show()">
      <span>Search</span>
      <span class="rounded bg-muted/50 px-1 py-0.5 text-[10px]">⌘K</span>
    </button>

    <div v-if="open" class="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24" @click.self="open = false">
      <div class="w-full max-w-lg overflow-hidden rounded-md border border-border bg-background shadow-lg">
        <input ref="input" v-model="query" type="text" placeholder="Search tables, columns, groups, enums…" class="w-full border-b border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none" />
        <ul class="max-h-80 overflow-y-auto">
          <li v-if="query.trim() !== '' && hits.length === 0" class="px-3 py-4 text-center text-xs text-muted-foreground">Nothing matches “{{ query }}”.</li>
          <li v-for="(hit, position) in hits" :key="`${hit.kind}-${hit.context}-${hit.label}-${position}`">
            <button type="button" class="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs transition-colors" :class="isNavigable(hit) ? 'hover:bg-muted/40' : 'cursor-default text-muted-foreground'" :disabled="!isNavigable(hit)" @click="choose(hit)">
              <span class="w-14 shrink-0 text-[10px] uppercase text-muted-foreground">{{ hit.kind }}</span>
              <span class="font-mono text-foreground">{{ hit.label }}</span>
              <span class="truncate text-[11px] text-muted-foreground">{{ hit.context }}</span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

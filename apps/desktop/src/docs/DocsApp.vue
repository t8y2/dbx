<script setup lang="ts">
import { computed, ref } from "vue";
import DocsSearch from "./components/DocsSearch.vue";
import DocsSidebar from "./components/DocsSidebar.vue";
import EnumPage from "./components/EnumPage.vue";
import GroupEditor from "./components/GroupEditor.vue";
import NoteEditor from "./components/NoteEditor.vue";
import TablePage from "./components/TablePage.vue";
import WarningBanner from "./components/WarningBanner.vue";
import WikiIndex from "./components/WikiIndex.vue";
import "./docs.css";
import type { Translate } from "./docsWarnings";
import { qualifiedTableKey } from "./docsKeys";
import { groupBySchema, groupByTableGroup } from "./docsIndex";
import type { AnnotationFile, DocsEdit, GroupAnnotation, SchemaSnapshot } from "./types";

const props = defineProps<{
  snapshot: SchemaSnapshot;
  /**
   * The local notes layer. `snapshot` already carries notes merged for display,
   * so this is here for what the merge erases: `groups` holds the editable
   * `GroupAnnotation` records, while `snapshot.groups` holds resolved
   * `TableGroup`s that GroupEditor and GroupPicker cannot write back to.
   */
  annotations: AnnotationFile;
  readonly?: boolean;
  translate: Translate;
}>();

const emit = defineEmits<{
  edit: [edit: DocsEdit];
}>();

/** `readonly` is the one optional prop; absent means editing is allowed. */
const isReadonly = computed(() => props.readonly ?? false);

const annotationGroups = computed<GroupAnnotation[]>(() => props.annotations.groups ?? []);

// Grouping is computed once here and handed to both the sidebar and the index,
// so the two can never disagree about what the sections are.
const mode = ref<"schema" | "group">(props.snapshot.groups.length > 0 ? "group" : "schema");
const activeKey = ref<string | null>(null);
const activeEnumName = ref<string | null>(null);

const sections = computed(() => (mode.value === "schema" ? groupBySchema(props.snapshot) : groupByTableGroup(props.snapshot)));

const activeTable = computed(() => props.snapshot.tables.find((table) => qualifiedTableKey(table) === activeKey.value) ?? null);

/**
 * Matched on the bare name because that is the only thing a column's
 * `data_type` can be compared against — `columnsUsingEnum` resolves enums the
 * same way, so both agree when one name appears in two schemas.
 */
const activeEnum = computed(() => (activeEnumName.value === null ? null : (props.snapshot.enums.find((value) => value.name === activeEnumName.value) ?? null)));

const view = computed<"index" | "table" | "enum">(() => {
  if (activeEnum.value !== null) {
    return "enum";
  }
  return activeTable.value === null ? "index" : "table";
});

const activeGroup = computed(() => {
  const groupId = activeTable.value?.groupId;
  if (!groupId) {
    return null;
  }
  return props.snapshot.groups.find((group) => group.id === groupId) ?? null;
});

function open(key: string): void {
  // A key naming no table leaves the reader where they are rather than
  // dropping them on a blank page.
  if (props.snapshot.tables.some((table) => qualifiedTableKey(table) === key)) {
    activeEnumName.value = null;
    activeKey.value = key;
  }
}

function openEnum(name: string): void {
  if (props.snapshot.enums.some((value) => value.name === name)) {
    activeKey.value = null;
    activeEnumName.value = name;
  }
}

function home(): void {
  activeKey.value = null;
  activeEnumName.value = null;
}

/**
 * GroupPicker asks for a new group without naming it, so the id and hue are
 * minted here. The hue rotates rather than repeating so two fresh groups are
 * visually distinct before anyone opens GroupEditor to choose a colour.
 */
function createGroupFor(tableKey: string): void {
  const group: GroupAnnotation = {
    id: crypto.randomUUID(),
    // Reuses the picker's own "New group" string rather than adding a locale
    // key for a placeholder the user renames immediately in GroupEditor.
    name: props.translate("docs.newGroup"),
    hue: (annotationGroups.value.length * 47) % 360,
  };
  emit("edit", { kind: "upsertGroup", group });
  emit("edit", { kind: "tableGroup", tableKey, groupId: group.id });
}
</script>

<template>
  <div class="flex h-full min-h-0 bg-background text-foreground">
    <DocsSidebar :sections="sections" :mode="mode" :active-key="activeKey" @update:mode="mode = $event" @select="open" @home="home()" />

    <main class="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex flex-col gap-1">
          <h1 class="text-base font-semibold">{{ snapshot.project.name }}</h1>
          <p class="text-xs text-muted-foreground">
            {{ snapshot.project.databaseType }}<template v-if="snapshot.project.database"> · {{ snapshot.project.database }}</template> · {{ snapshot.tables.length }} tables · generated {{ snapshot.project.generatedAt }}
          </p>
        </div>
        <DocsSearch :snapshot="snapshot" @select="open" @select-enum="openEnum" />
      </header>

      <WarningBanner :warnings="snapshot.warnings" :translate="translate" />

      <div v-if="view === 'index'" class="flex flex-col gap-4">
        <NoteEditor :model-value="snapshot.project.note ?? ''" :readonly="isReadonly" :translate="translate" @update:model-value="emit('edit', { kind: 'projectNote', note: $event })" />
        <WikiIndex :sections="sections" @select="open" />

        <section v-if="!isReadonly && annotationGroups.length > 0" class="flex flex-col gap-2">
          <h2 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Groups</h2>
          <GroupEditor v-for="group in annotationGroups" :key="group.id" :group="group" :translate="translate" @update:group="emit('edit', { kind: 'upsertGroup', group: $event })" @delete="emit('edit', { kind: 'removeGroup', groupId: $event })" />
        </section>
      </div>

      <TablePage
        v-else-if="view === 'table' && activeTable"
        :table="activeTable"
        :relationships="snapshot.relationships"
        :group="activeGroup"
        :annotation-groups="annotationGroups"
        :readonly="isReadonly"
        :translate="translate"
        @select="open"
        @edit="emit('edit', $event)"
        @create-group="createGroupFor"
      />

      <EnumPage v-else-if="activeEnum" :enum-type="activeEnum" :snapshot="snapshot" :translate="translate" @select="open" />
    </main>
  </div>
</template>

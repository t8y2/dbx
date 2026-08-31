<script setup lang="ts">
import { computed, ref } from "vue";
import DocsSearch from "./components/DocsSearch.vue";
import DocsSidebar from "./components/DocsSidebar.vue";
import EnumPage from "./components/EnumPage.vue";
import GroupEditor from "./components/GroupEditor.vue";
import NoteEditor from "./components/NoteEditor.vue";
import SchemaDiagram from "./components/SchemaDiagram.vue";
import TablePage from "./components/TablePage.vue";
import WarningBanner from "./components/WarningBanner.vue";
import WikiIndex from "./components/WikiIndex.vue";
import "./docs.css";
import type { Translate } from "./docsWarnings";
import { qualifiedTableKey } from "./docsKeys";
import type { DocsRoute } from "./docsRoute";
import { groupBySchema, groupByTableGroup } from "./docsIndex";
import type { AnnotationFile, DocsEdit, GroupAnnotation, SchemaSnapshot } from "./types";

const props = withDefaults(
  defineProps<{
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
    /**
     * When provided, navigation is controlled by the host and mirrored back
     * through `update:route`. Absent — the dialog's case — DocsApp owns its
     * own navigation exactly as before and never touches the URL.
     */
    route?: DocsRoute;
    /** `inline` renders SchemaDiagram; `external` leaves the host to offer its own. */
    diagram?: "inline" | "external";
  }>(),
  { diagram: "external" },
);

const emit = defineEmits<{
  edit: [edit: DocsEdit];
  "update:route": [route: DocsRoute];
}>();

/** `readonly` is the one optional prop; absent means editing is allowed. */
const isReadonly = computed(() => props.readonly ?? false);

const annotationGroups = computed<GroupAnnotation[]>(() => props.annotations.groups ?? []);

// Grouping is computed once here and handed to both the sidebar and the index,
// so the two can never disagree about what the sections are.
const mode = ref<"schema" | "group">(props.snapshot.groups.length > 0 ? "group" : "schema");

// Owned only when `route` is absent — see the prop doc above. `effectiveRoute`
// prefers `props.route`, so once the host controls navigation, a click here
// still updates these (harmless) but the DISPLAYED view tracks the prop, not
// this state. That is what keeps the two from disagreeing if the host
// declines to apply an `update:route`.
const internalKey = ref<string | null>(null);
const internalEnumName = ref<string | null>(null);
const internalDiagram = ref(false);

const effectiveRoute = computed<DocsRoute>(() => {
  if (props.route) return props.route;
  if (internalDiagram.value) return { kind: "diagram" };
  if (internalEnumName.value !== null) return { kind: "enum", name: internalEnumName.value };
  if (internalKey.value !== null) return { kind: "table", key: internalKey.value };
  return { kind: "index" };
});

const activeKey = computed(() => (effectiveRoute.value.kind === "table" ? effectiveRoute.value.key : null));
const activeEnumName = computed(() => (effectiveRoute.value.kind === "enum" ? effectiveRoute.value.name : null));

const sections = computed(() => (mode.value === "schema" ? groupBySchema(props.snapshot) : groupByTableGroup(props.snapshot)));

const activeTable = computed(() => props.snapshot.tables.find((table) => qualifiedTableKey(table) === activeKey.value) ?? null);

/**
 * Matched on the bare name because that is the only thing a column's
 * `data_type` can be compared against — `columnsUsingEnum` resolves enums the
 * same way, so both agree when one name appears in two schemas.
 */
const activeEnum = computed(() => (activeEnumName.value === null ? null : (props.snapshot.enums.find((value) => value.name === activeEnumName.value) ?? null)));

const view = computed<"index" | "table" | "enum" | "diagram">(() => {
  if (effectiveRoute.value.kind === "diagram") {
    return "diagram";
  }
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
    internalEnumName.value = null;
    internalDiagram.value = false;
    internalKey.value = key;
    emit("update:route", { kind: "table", key });
  }
}

function openEnum(name: string): void {
  if (props.snapshot.enums.some((value) => value.name === name)) {
    internalKey.value = null;
    internalDiagram.value = false;
    internalEnumName.value = name;
    emit("update:route", { kind: "enum", name });
  }
}

function openDiagram(): void {
  internalKey.value = null;
  internalEnumName.value = null;
  internalDiagram.value = true;
  emit("update:route", { kind: "diagram" });
}

function home(): void {
  internalKey.value = null;
  internalEnumName.value = null;
  internalDiagram.value = false;
  emit("update:route", { kind: "index" });
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
    <div class="flex h-full min-h-0 w-64 shrink-0 flex-col">
      <DocsSidebar class="min-h-0 flex-1" :sections="sections" :mode="mode" :active-key="activeKey" :translate="translate" @update:mode="mode = $event" @select="open" @home="home()" />
      <button
        v-if="diagram === 'inline'"
        type="button"
        class="shrink-0 border-t border-r border-border bg-background px-3 py-2 text-left text-xs font-medium transition-colors"
        :class="view === 'diagram' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/40'"
        @click="openDiagram()"
      >
        {{ translate("docs.diagram") }}
      </button>
    </div>

    <main class="flex min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex flex-col gap-1">
          <h1 class="text-base font-semibold">{{ snapshot.project.name }}</h1>
          <p class="text-xs text-muted-foreground">
            {{ snapshot.project.databaseType }}<template v-if="snapshot.project.database"> · {{ snapshot.project.database }}</template> · {{ snapshot.tables.length }} tables · generated {{ snapshot.project.generatedAt }}
          </p>
        </div>
        <DocsSearch :snapshot="snapshot" :translate="translate" @select="open" @select-enum="openEnum" />
      </header>

      <WarningBanner :warnings="snapshot.warnings" :translate="translate" />

      <div v-if="view === 'index'" class="flex flex-col gap-4">
        <NoteEditor :model-value="snapshot.project.note ?? ''" :readonly="isReadonly" :translate="translate" @update:model-value="emit('edit', { kind: 'projectNote', note: $event })" />
        <WikiIndex :sections="sections" :translate="translate" @select="open" />

        <section v-if="!isReadonly && annotationGroups.length > 0" class="flex flex-col gap-2">
          <h2 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{{ translate("docs.groups") }}</h2>
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

      <SchemaDiagram v-else-if="view === 'diagram'" :snapshot="snapshot" @select="open" />
    </main>
  </div>
</template>

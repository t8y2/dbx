<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Network } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DocsApp from "@/docs/DocsApp.vue";
import { emptyAnnotations, removeGroup, setColumnNote, setProjectNote, setTableGroup, setTableNote, upsertGroup } from "@/docs/annotationEdits";
import type { AnnotationFile, DocsEdit, SchemaSnapshot } from "@/docs/types";
import type { Translate } from "@/docs/docsWarnings";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { createAutosave } from "./docsAutosave";

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
}>();

const open = defineModel<boolean>("open", { default: false });

// This component lives OUTSIDE src/docs/, so it may and must use useI18n():
// it is what supplies the `translate` prop that the viewer components need,
// since they are banned from importing vue-i18n themselves.
const { t } = useI18n();

// `Translate` is one narrow signature; vue-i18n's `t` is heavily overloaded and
// does not assign to it directly, so bridge it explicitly.
const translate: Translate = (key, params) => (params === undefined ? t(key) : t(key, params));

const connectionStore = useConnectionStore();

/** The snapshot as collected, kept so every edit can re-derive the merged view. */
const rawSnapshot = ref<SchemaSnapshot | null>(null);
const snapshot = ref<SchemaSnapshot | null>(null);
const annotations = ref<AnnotationFile>(emptyAnnotations());
const loading = ref(false);
const loadError = ref<string | null>(null);

/**
 * Guards against a slow re-derivation landing after a newer one. Each load or
 * edit takes the next number and only writes if it is still the latest, so a
 * fast second edit is never overwritten by the first edit's stale response.
 */
let generation = 0;

const autosave = createAutosave(async (file) => {
  const connectionId = props.prefillConnectionId;
  if (connectionId === undefined || connectionId === "") {
    return;
  }
  await api.saveDocsAnnotations(connectionId, file);
}, 500);

const status = autosave.status;

const statusLabel = computed(() => {
  switch (status.value.state) {
    case "saving":
      return t("docs.saving");
    case "saved":
      return t("docs.saved");
    case "failed":
      return t("docs.saveFailed", { error: status.value.message });
    default:
      return "";
  }
});

const canOpenDiagram = computed(() => (props.prefillConnectionId ?? "") !== "" && (props.prefillDatabase ?? "") !== "");

async function load(): Promise<void> {
  const connectionId = props.prefillConnectionId;
  const database = props.prefillDatabase;
  if (connectionId === undefined || connectionId === "" || database === undefined || database === "") {
    return;
  }
  const mine = ++generation;
  loading.value = true;
  loadError.value = null;
  try {
    // An absent schema means "everything the collector finds" rather than a
    // filter naming nothing.
    const schemas = props.prefillSchema ? [props.prefillSchema] : [];
    const collected = await api.collectDocsSnapshot(connectionId, database, schemas, [], database);
    const file = (await api.loadDocsAnnotations(connectionId)) ?? emptyAnnotations();
    const merged = await api.applyDocsAnnotations(connectionId, collected, file);
    if (mine !== generation) {
      return;
    }
    rawSnapshot.value = collected;
    annotations.value = file;
    snapshot.value = merged;
  } catch (error) {
    if (mine === generation) {
      loadError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (mine === generation) {
      loading.value = false;
    }
  }
}

function nextAnnotations(file: AnnotationFile, edit: DocsEdit): AnnotationFile {
  switch (edit.kind) {
    case "projectNote":
      return setProjectNote(file, edit.note);
    case "tableNote":
      return setTableNote(file, edit.tableKey, edit.note);
    case "columnNote":
      return setColumnNote(file, edit.tableKey, edit.column, edit.note);
    case "tableGroup":
      return setTableGroup(file, edit.tableKey, edit.groupId);
    case "upsertGroup":
      return upsertGroup(file, edit.group);
    case "removeGroup":
      return removeGroup(file, edit.groupId);
  }
}

async function onEdit(edit: DocsEdit): Promise<void> {
  const connectionId = props.prefillConnectionId;
  const collected = rawSnapshot.value;
  if (connectionId === undefined || connectionId === "" || collected === null) {
    return;
  }
  const file = nextAnnotations(annotations.value, edit);
  annotations.value = file;
  // Schedule before re-deriving: the write must not wait on a display refresh.
  autosave.schedule(file);

  const mine = ++generation;
  try {
    const merged = await api.applyDocsAnnotations(connectionId, collected, file);
    if (mine === generation) {
      snapshot.value = merged;
    }
  } catch (error) {
    if (mine === generation) {
      loadError.value = error instanceof Error ? error.message : String(error);
    }
  }
}

function openDiagram(): void {
  const connectionId = props.prefillConnectionId;
  const database = props.prefillDatabase;
  if (connectionId === undefined || database === undefined) {
    return;
  }
  connectionStore.diagramSource = { connectionId, database, schema: props.prefillSchema };
}

watch(
  open,
  (isOpen, wasOpen) => {
    if (isOpen) {
      void load();
      return;
    }
    if (wasOpen) {
      // A note typed a moment before closing is still sitting behind the
      // debounce; flushing here is what keeps it.
      void autosave.flush();
    }
  },
  { immediate: true },
);
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="w-[94vw] max-w-[94vw] sm:max-w-[94vw] md:max-w-[94vw] lg:max-w-[94vw] xl:max-w-[94vw] h-[86vh] max-h-[86vh] gap-0 p-0 overflow-hidden flex flex-col">
      <DialogHeader class="px-4 py-3 border-b">
        <DialogTitle class="flex items-center gap-2">
          <span>{{ t("docs.title") }}</span>
          <span v-if="statusLabel" class="text-xs font-normal" :class="status.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'">
            {{ statusLabel }}
          </span>
          <Button v-if="canOpenDiagram" variant="outline" size="sm" class="ml-auto" @click="openDiagram()">
            <Network class="w-4 h-4" />
            {{ t("docs.openDiagram") }}
          </Button>
        </DialogTitle>
      </DialogHeader>

      <div class="min-h-0 flex-1 overflow-hidden">
        <p v-if="loadError" class="p-4 text-sm text-destructive">{{ loadError }}</p>
        <p v-else-if="loading || snapshot === null" class="p-4 text-sm text-muted-foreground">{{ t("common.loading") }}</p>
        <DocsApp v-else :snapshot="snapshot" :annotations="annotations" :readonly="false" :translate="translate" @edit="onEdit" />
      </div>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Download, FileText, Network, RefreshCw } from "@lucide/vue";
import DataDictionaryDialog from "@/components/docs/DataDictionaryDialog.vue";
import { Button } from "@/components/ui/button";
import { DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DocsApp from "@/docs/DocsApp.vue";
import type { DocsEdit } from "@/docs/types";
import type { Translate } from "@/docs/docsWarnings";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useConnectionStore } from "@/stores/connectionStore";
import { applyDatabaseDocsEdit, databaseDocsAutosaveStatus, ensureDatabaseDocsSession, flushDatabaseDocsAutosave, getDatabaseDocsSession, reloadDatabaseDocsSession, type DatabaseDocsSessionConfig } from "@/composables/useDatabaseDocsSession";
import type { DatabaseDocsTabState } from "@/types/database";

// The languages `to_standalone_html` accepts. Kept in sync manually — this
// component lives outside `src/docs/` and cannot import from dbx-core.
const EXPORT_LANGUAGES = ["en", "es", "it", "ja", "ko", "pt-BR", "zh-CN", "zh-TW"];

const props = withDefaults(
  defineProps<{
    prefillConnectionId?: string;
    prefillDatabase?: string;
    prefillSchema?: string;
    /** Dialog form factor: DialogHeader chrome. Tab form factor: top toolbar. */
    inDialog?: boolean;
    /** Serialized snapshot a converted tab (or dialog) resumes from. */
    initialState?: DatabaseDocsTabState;
  }>(),
  { prefillConnectionId: undefined, prefillDatabase: undefined, prefillSchema: undefined, inDialog: true, initialState: undefined },
);

const emit = defineEmits<{
  "update:state": [state: DatabaseDocsTabState];
  "update:initial-state": [state: DatabaseDocsTabState | undefined];
}>();

const open = defineModel<boolean>("open", { default: false });

// This component lives OUTSIDE src/docs/, so it may and must use useI18n():
// it is what supplies the `translate` prop that the viewer components need,
// since they are banned from importing vue-i18n themselves.
const { t, locale } = useI18n();

// `Translate` is one narrow signature; vue-i18n's `t` is heavily overloaded and
// does not assign to it directly, so bridge it explicitly.
const translate: Translate = (key, params) => (params === undefined ? t(key) : t(key, params));

const connectionStore = useConnectionStore();

/** The workspace target: from the converted snapshot, or from the dialog prefill props. */
const config = computed<DatabaseDocsSessionConfig>(() => {
  if (props.initialState) return props.initialState.config;
  return { connectionId: props.prefillConnectionId ?? "", database: props.prefillDatabase ?? "", schema: props.prefillSchema };
});

const activeSessionId = ref<string | null>(null);
const session = computed(() => getDatabaseDocsSession(activeSessionId.value));
const snapshot = computed(() => session.value?.snapshot ?? null);
const annotations = computed(() => session.value?.annotations ?? null);
const loading = computed(() => !session.value || session.value.status === "running" || snapshot.value === null);
const loadError = ref<string | null>(null);

const autosaveStatus = computed(() => databaseDocsAutosaveStatus(activeSessionId.value)?.value);
const statusLabel = computed(() => {
  const status = autosaveStatus.value;
  if (!status) return "";
  switch (status.state) {
    case "saving":
      return t("docs.saving");
    case "saved":
      return t("docs.saved");
    case "failed":
      return t("docs.saveFailed", { error: status.message });
    default:
      return "";
  }
});

const canOpenDiagram = computed(() => config.value.connectionId !== "" && config.value.database !== "");
const exporting = ref(false);
const exportError = ref<string | null>(null);
const showDataDictionary = ref(false);

function ensureSession() {
  const cfg = config.value;
  if (!cfg.connectionId || !cfg.database) return;
  const next = ensureDatabaseDocsSession(cfg);
  activeSessionId.value = next.id;
  // A failed session keeps its error for display; a retry is explicit.
  if (next.status === "failed") loadError.value = next.error;
}

function refresh() {
  if (activeSessionId.value) reloadDatabaseDocsSession(activeSessionId.value);
  else ensureSession();
}

function openDiagram(): void {
  const { connectionId, database, schema } = config.value;
  if (!connectionId || !database) return;
  connectionStore.diagramSource = { connectionId, database, schema };
}

async function exportHtml(): Promise<void> {
  const currentSnapshot = snapshot.value;
  if (!currentSnapshot || !annotations.value) return;
  exporting.value = true;
  exportError.value = null;
  try {
    let outputPath = `${currentSnapshot.project.name}-docs.html`;
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const chosen = await save({ defaultPath: outputPath, filters: [{ name: "HTML", extensions: ["html"] }] });
      if (!chosen) return; // the user cancelled; not an error
      outputPath = chosen as string;
    }
    // `to_standalone_html` rejects any language outside its fixed list; the
    // app's locale is otherwise a superset risk, so fall back rather than
    // surface that rejection to the user.
    const lang = EXPORT_LANGUAGES.includes(locale.value) ? locale.value : "en";
    await api.exportDocsHtml(outputPath, currentSnapshot, annotations.value, lang);
  } catch (error) {
    // Never swallowed: a failed export that reports success is the worst
    // outcome here, exactly as with a failed autosave.
    exportError.value = t("docs.exportFailed", { error: String(error) });
  } finally {
    exporting.value = false;
  }
}

async function onEdit(edit: DocsEdit): Promise<void> {
  if (!activeSessionId.value) return;
  await applyDatabaseDocsEdit(activeSessionId.value, edit);
}

/** Serializable snapshot for dialog/tab conversion; persistence keeps only config. */
function getCurrentState(): DatabaseDocsTabState {
  return { config: config.value };
}

function restoreDialogSnapshot(): boolean {
  const state = props.initialState;
  if (!state) return false;
  loadError.value = null;
  ensureSession();
  emit("update:initial-state", undefined);
  return true;
}

// Dialog form factor keeps the original open-driven load / autosave-flush lifecycle.
watch(
  open,
  (isOpen, wasOpen) => {
    if (!props.inDialog) return;
    if (isOpen) {
      loadError.value = null;
      if (restoreDialogSnapshot()) return;
      ensureSession();
      return;
    }
    if (wasOpen) {
      // A note typed a moment before closing is still sitting behind the
      // debounce; flushing here is what keeps it.
      if (activeSessionId.value) flushDatabaseDocsAutosave(activeSessionId.value);
    }
  },
  { immediate: true },
);

// A snapshot can also arrive while the dialog is already open (tab -> dialog conversion).
watch(
  () => props.initialState,
  (state) => {
    if (!props.inDialog || !state || !open.value) return;
    restoreDialogSnapshot();
  },
);

onMounted(() => {
  if (props.inDialog) return;
  ensureSession();
});

// Tab form factor mirrors the config (the workspace identity) to the tab payload.
let stateEmitTimer: ReturnType<typeof setTimeout> | undefined;
let componentUnmounted = false;
watch(
  () => [config.value.connectionId, config.value.database, config.value.schema] as const,
  () => {
    if (props.inDialog) return;
    if (stateEmitTimer) clearTimeout(stateEmitTimer);
    stateEmitTimer = setTimeout(() => {
      stateEmitTimer = undefined;
      if (!componentUnmounted) emit("update:state", getCurrentState());
    }, 400);
  },
);

onBeforeUnmount(() => {
  componentUnmounted = true;
  if (stateEmitTimer) clearTimeout(stateEmitTimer);
});

defineExpose({ getCurrentState });
</script>

<template>
  <div :class="['flex min-h-0 min-w-0 flex-col', props.inDialog ? 'flex-1 gap-0' : 'h-full bg-background']">
    <!-- Tab form factor: toolbar carries the header actions. -->
    <div v-if="!props.inDialog" class="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/10 px-5 py-2">
      <span class="font-medium text-sm">{{ t("docs.title") }}</span>
      <span class="text-xs text-muted-foreground truncate">{{ [config.database, config.schema].filter(Boolean).join(" / ") }}</span>
      <span v-if="statusLabel" class="text-xs font-normal" :class="autosaveStatus?.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'">{{ statusLabel }}</span>
      <span v-if="exportError" class="text-xs font-normal text-destructive">{{ exportError }}</span>
      <span class="flex-1" />
      <Button variant="outline" size="sm" :disabled="loading" @click="refresh">
        <RefreshCw class="h-3.5 w-3.5 mr-1" />
        {{ t("common.refresh") }}
      </Button>
      <Button v-if="canOpenDiagram" variant="outline" size="sm" @click="openDiagram()">
        <Network class="w-4 h-4" />
        {{ t("docs.openDiagram") }}
      </Button>
      <Button v-if="snapshot" variant="outline" size="sm" @click="showDataDictionary = true">
        <FileText class="w-4 h-4" />
        {{ t("dataDictionary.title") }}
      </Button>
      <Button v-if="snapshot" variant="outline" size="sm" :disabled="exporting" @click="exportHtml()">
        <Download class="w-4 h-4" />
        {{ exporting ? t("docs.exporting") : t("docs.exportHtml") }}
      </Button>
    </div>

    <!-- Dialog form factor: header with title, status and actions. -->
    <DialogHeader v-if="props.inDialog" class="px-4 py-3 border-b pr-16">
      <DialogTitle class="flex flex-wrap items-center gap-2">
        <span>{{ t("docs.title") }}</span>
        <span v-if="statusLabel" class="text-xs font-normal" :class="autosaveStatus?.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'">
          {{ statusLabel }}
        </span>
        <span v-if="exportError" class="text-xs font-normal text-destructive">{{ exportError }}</span>
        <Button v-if="canOpenDiagram" variant="outline" size="sm" class="ml-auto" @click="openDiagram()">
          <Network class="w-4 h-4" />
          {{ t("docs.openDiagram") }}
        </Button>
        <Button v-if="snapshot" variant="outline" size="sm" @click="showDataDictionary = true">
          <FileText class="w-4 h-4" />
          {{ t("dataDictionary.title") }}
        </Button>
        <Button v-if="snapshot" variant="outline" size="sm" :disabled="exporting" @click="exportHtml()">
          <Download class="w-4 h-4" />
          {{ exporting ? t("docs.exporting") : t("docs.exportHtml") }}
        </Button>
      </DialogTitle>
    </DialogHeader>

    <div class="min-h-0 flex-1 overflow-hidden">
      <p v-if="loadError" class="p-4 text-sm text-destructive">{{ loadError }}</p>
      <p v-else-if="loading" class="p-4 text-sm text-muted-foreground">{{ t("common.loading") }}</p>
      <DocsApp v-else-if="snapshot && annotations" :snapshot="snapshot" :annotations="annotations" :readonly="false" :translate="translate" @edit="onEdit" />
    </div>

    <DataDictionaryDialog v-if="showDataDictionary && snapshot" v-model:open="showDataDictionary" :prefill-connection-id="config.connectionId" :prefill-database="config.database" :prefill-schema="config.schema" :snapshot="snapshot" />
  </div>
</template>

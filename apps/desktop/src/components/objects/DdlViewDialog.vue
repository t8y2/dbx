<script setup lang="ts">
import { nextTick, onUnmounted, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Clipboard, Loader2, RefreshCw } from "@lucide/vue";
import { useToast } from "@/composables/useToast";
import { useTheme } from "@/composables/useTheme";
import { useSettingsStore } from "@/stores/settingsStore";
import { loadEditorTheme, editorFontTheme } from "@/lib/editor/editorThemes";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatSqlForDisplay, type SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import * as api from "@/lib/backend/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import EditorSearchPanel from "@/components/editor/EditorSearchPanel.vue";
import type { EditorView } from "@codemirror/view";

const props = withDefaults(
  defineProps<{
    open: boolean;
    connectionId: string;
    database: string;
    schema?: string;
    tableName: string;
    /** SQL dialect for syntax highlighting. Non-PG/non-MSSQL databases fall back to MySQL (same as QueryEditor's source viewer). */
    dialect: "mysql" | "postgres" | "sqlserver";
    /** SQL formatter dialect. Kept separate from the syntax-highlighting dialect because several PG-compatible DBs highlight as MySQL. */
    formatDialect?: SqlFormatDialect;
  }>(),
  {},
);

const emit = defineEmits<{
  "update:open": [value: boolean];
}>();

const { t } = useI18n();
const { toast } = useToast();
const { isDark, themePalette } = useTheme();
const settingsStore = useSettingsStore();

const ddlContent = ref("");
const ddlLoading = ref(false);
const ddlError = ref("");
const ddlEditorContainer = ref<HTMLDivElement>();
const ddlSearchPanelRef = ref<InstanceType<typeof EditorSearchPanel>>();
const ddlEditorView = shallowRef<EditorView | null>(null);

/** Fetches the table DDL when the dialog opens. */
watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    ddlContent.value = "";
    ddlError.value = "";
    ddlLoading.value = true;
    try {
      const schema = props.schema || props.database;
      const ddl = await api.getTableDdl(props.connectionId, props.database, schema, props.tableName);
      ddlContent.value = await formatSqlForDisplay(ddl, props.formatDialect ?? props.dialect, settingsStore.editorSettings.sqlFormatter);
    } catch (e: any) {
      ddlError.value = e?.message || String(e);
    } finally {
      ddlLoading.value = false;
    }
  },
  { immediate: true },
);

/**
 * Creates a lightweight read-only CodeMirror editor inside the dialog.
 *
 * Follows the same pattern as QueryEditor:
 * - cmSearch with hidden createPanel replaces the default search UI,
 *   so EditorSearchPanel is the only visible search panel.
 * - Prec.highest overrides Cmd+F to open EditorSearchPanel.
 * - Editor theme/font are loaded from user settings for consistent appearance.
 */
async function initDdlEditor(content: string) {
  if (!ddlEditorContainer.value) return;
  destroyDdlEditor();
  const [{ EditorView, keymap }, { EditorState, Prec }, langSql, { basicSetup }, { search: cmSearch }] = await Promise.all([import("@codemirror/view"), import("@codemirror/state"), import("@codemirror/lang-sql"), import("codemirror"), import("@codemirror/search")]);
  const editorTheme = settingsStore.editorSettings.theme;
  const appAppearance = isDark.value ? "dark" : "light";
  const fontSize = settingsStore.editorSettings.fontSize;
  const fontFamily = settingsStore.editorSettings.fontFamily;
  const themeExt = await loadEditorTheme(editorTheme, appAppearance, undefined, themePalette.value);
  const fontExt = editorFontTheme(EditorView, fontSize, fontFamily, { fixedHeight: true, scrollable: true });
  const dialect = createDbxCodeMirrorSqlDialect(langSql, props.dialect);
  const state = EditorState.create({
    doc: content,
    extensions: [
      // Enable search functionality but hide the default panel —
      // EditorSearchPanel provides the visible search UI instead, same as QueryEditor.
      cmSearch({
        top: true,
        createPanel: () => {
          const dom = document.createElement("span");
          dom.style.display = "none";
          return { dom };
        },
      }),
      basicSetup,
      langSql.sql({ dialect }),
      themeExt,
      fontExt,
      // Intercept Cmd+F at highest precedence so EditorSearchPanel opens
      // instead of the default search panel (which is hidden above).
      Prec.highest(keymap.of([{ key: "Mod-f", run: () => ddlSearchPanelRef.value?.openSearch() ?? false, preventDefault: true }])),
      // Remove CodeMirror's default 1px dotted focus outline,
      // which is visible below the content when the DDL is short.
      EditorView.theme({
        "&.cm-focused": { outline: "none" },
      }),
      EditorState.readOnly.of(true),
    ],
  });
  const editorView = new EditorView({ state, parent: ddlEditorContainer.value });
  ddlEditorView.value = editorView;
  editorView.focus();
}

/** Tears down the CodeMirror instance when the dialog closes. */
function destroyDdlEditor() {
  ddlEditorView.value?.destroy();
  ddlEditorView.value = null;
}

/** Copies the DDL text to clipboard. */
function copyDdlContent() {
  if (ddlContent.value) {
    copyToClipboard(ddlContent.value);
    toast(t("contextMenu.ddlCopied"), 2000);
  }
}

// When DDL finishes loading, create the editor inside the dialog.
watch(ddlLoading, (loading) => {
  if (!loading && ddlContent.value && props.open) {
    nextTick(() => initDdlEditor(ddlContent.value));
  }
});

// Destroy CodeMirror when the dialog hides, so the editor's event listeners
// and DOM aren't consuming resources while the dialog is closed.
// The editor is re-created on next open via the ddlLoading watch.
watch(
  () => props.open,
  (open) => {
    if (!open) destroyDdlEditor();
  },
);

// Safety net: destroy editor when component eventually unmounts.
onUnmounted(() => {
  destroyDdlEditor();
});

function retry() {
  ddlError.value = "";
  ddlLoading.value = true;
  ddlContent.value = "";
  const schema = props.schema || props.database;
  api
    .getTableDdl(props.connectionId, props.database, schema, props.tableName)
    .then(async (ddl) => {
      ddlContent.value = await formatSqlForDisplay(ddl, props.formatDialect ?? props.dialect, settingsStore.editorSettings.sqlFormatter);
    })
    .catch((e: any) => {
      ddlError.value = e?.message || String(e);
    })
    .finally(() => {
      ddlLoading.value = false;
    });
}

function onClose() {
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="props.open" @update:open="onClose">
    <DialogContent class="sm:max-w-190">
      <DialogHeader>
        <DialogTitle>DDL - {{ props.tableName }}</DialogTitle>
      </DialogHeader>
      <div class="grid gap-3">
        <div v-if="ddlLoading" class="flex min-h-80 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          <span>{{ t("contextMenu.viewDdlLoading") }}</span>
        </div>
        <div v-else-if="ddlError" class="flex min-h-80 flex-col items-center justify-center gap-3 text-sm">
          <p class="text-destructive">{{ ddlError }}</p>
          <Button variant="outline" size="sm" @click="retry">
            <RefreshCw />
            {{ t("common.retry") }}
          </Button>
        </div>
        <div v-else class="relative min-h-80 max-h-[60vh] overflow-hidden rounded border">
          <div ref="ddlEditorContainer" class="h-full" />
          <EditorSearchPanel v-if="ddlEditorView" ref="ddlSearchPanelRef" :view="ddlEditorView" />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="onClose">{{ t("common.close") }}</Button>
        <Button variant="outline" :disabled="!ddlContent" @click="copyDdlContent">
          <Clipboard class="h-4 w-4" />
          {{ t("grid.copyDdl") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

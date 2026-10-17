<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Compartment, EditorState, type Text } from "@codemirror/state";
import { Decoration, drawSelection, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import { Copy, Pencil, Save } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/common/clipboard";
import { editorClipboardLineEndingsExtension } from "@/lib/editor/editorClipboardLineEndings";
import { editorFontTheme, loadEditorTheme } from "@/lib/editor/editorThemes";
import * as api from "@/lib/backend/api";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import { useToast } from "@/composables/useToast";
import type { QuickOpenItem } from "@/composables/useQuickOpen";

const props = defineProps<{ item: QuickOpenItem }>();
const emit = defineEmits<{ navigate: [direction: -1 | 1]; open: []; close: []; editing: [value: boolean] }>();
const { t } = useI18n();
const { toast } = useToast();
const settingsStore = useSettingsStore();
const { isDark, themePalette } = useTheme();
const editorHost = ref<HTMLElement | null>(null);
const content = ref<string | null>(null);
const loading = ref(true);
const failed = ref(false);
const editing = ref(false);
const saving = ref(false);
const dirty = ref(false);
const saveError = ref("");
let snapshot: Awaited<ReturnType<typeof api.readExternalSqlFileSnapshot>> | null = null;
let savedDocument: Text | null = null;
const fileName = computed(() => props.item.fileName || props.item.label);
const theme = new Compartment();
const font = new Compartment();
const match = new Compartment();
const editability = new Compartment();
const undoHistory = new Compartment();
let view: EditorView | null = null;

// Match the global-search file-size bound. The backend checks the limit before reading.
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

async function copyPreview(): Promise<void> {
  if (loading.value || failed.value || content.value === null) return;
  const selection = view?.state.selection;
  const text = view && selection && !selection.main.empty ? view.state.sliceDoc(selection.main.from, selection.main.to) : view ? view.state.sliceDoc() : content.value;
  try {
    await copyToClipboard(text);
    toast(t("grid.copied"));
  } catch (error) {
    toast(t("grid.copyFailed", { message: error instanceof Error ? error.message : String(error) }), 5000);
  }
}

async function startEditing(): Promise<void> {
  if (loading.value || failed.value || !snapshot || editing.value) return;
  saveError.value = "";
  editing.value = true;
  emit("editing", true);
  // An empty preview creates its editor when editing starts.
  await nextTick();
  if (!view) return;
  savedDocument = view.state.doc;
  view.dispatch({ effects: [editability.reconfigure([]), undoHistory.reconfigure(history()), match.reconfigure([])] });
  view.focus();
}

function finishEditing(): void {
  editing.value = false;
  dirty.value = false;
  saveError.value = "";
  view?.dispatch({ effects: [editability.reconfigure([EditorState.readOnly.of(true), EditorView.editable.of(false)]), undoHistory.reconfigure([])] });
  emit("editing", false);
}

function cancelEditing(): void {
  if (saving.value) return;
  if (view && savedDocument) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: savedDocument } });
  finishEditing();
  revealMatch();
}

async function savePreview(): Promise<void> {
  if (!editing.value || saving.value || !view || !snapshot || !props.item.filePath) return;
  if (!dirty.value) {
    finishEditing();
    return;
  }
  const lineEnding = snapshot.content.includes("\r\n") ? "\r\n" : snapshot.content.includes("\r") ? "\r" : "\n";
  const text = view.state.doc.toString().replace(/\n/g, lineEnding);
  saving.value = true;
  saveError.value = "";
  view.dispatch({ effects: editability.reconfigure([EditorState.readOnly.of(true), EditorView.editable.of(false)]) });
  try {
    const result = await api.writeExternalSqlFile(props.item.filePath, text, { expectedContentHash: snapshot.version.contentHash, encoding: snapshot.encoding === "auto" ? "utf8" : snapshot.encoding });
    if (result.kind !== "written") {
      saveError.value = t(result.kind === "conflict" ? "externalSqlFile.modifiedDescription" : "externalSqlFile.deletedDescription", { path: props.item.filePath });
      return;
    }
    snapshot = { ...snapshot, content: text, version: result.version };
    savedDocument = view.state.doc;
    content.value = text;
    // Keep the editor instance and selection after saving.
    finishEditing();
    toast(t("savedSql.saved"));
  } catch (error) {
    saveError.value = t("savedSql.saveFailed", { message: error instanceof Error ? error.message : String(error) });
  } finally {
    saving.value = false;
    if (editing.value) view?.dispatch({ effects: editability.reconfigure([]) });
  }
}

watch(
  () => props.item.filePath,
  (path, _previous, onCleanup) => {
    let cancelled = false;
    loading.value = true;
    failed.value = false;
    content.value = null;
    snapshot = null;
    savedDocument = null;
    dirty.value = false;
    saveError.value = "";
    // Briefly debounce navigation across files; line changes within a file never reread it.
    const timer = setTimeout(async () => {
      try {
        if (!path) throw new Error("Missing preview path");
        const result = await api.readExternalSqlFileSnapshot(path, MAX_PREVIEW_BYTES);
        if (!cancelled) {
          snapshot = result;
          content.value = result.content;
        }
      } catch {
        if (!cancelled) failed.value = true;
      } finally {
        if (!cancelled) loading.value = false;
      }
    }, 100);
    onCleanup(() => {
      cancelled = true;
      clearTimeout(timer);
    });
  },
  { immediate: true },
);

function revealMatch(): void {
  if (!view) return;
  const lineNumber = props.item.line ?? 0;
  if (lineNumber <= 0) {
    view.dispatch({ selection: { anchor: 0 }, effects: [match.reconfigure([]), EditorView.scrollIntoView(0, { y: "start" })] });
    return;
  }
  const line = view.state.doc.line(Math.min(lineNumber, view.state.doc.lines));
  // The backend counts Unicode characters; CodeMirror positions use UTF-16.
  let remainingCharacters = Math.max(0, (props.item.column ?? 1) - 1);
  let columnOffset = 0;
  for (const character of line.text) {
    if (remainingCharacters-- <= 0) break;
    columnOffset += character.length;
  }
  const start = line.from + columnOffset;
  const end = Math.min(start + (props.item.matchText?.length ?? 0), line.to);
  const decorations = [Decoration.line({ class: "cm-preview-match-line" }).range(line.from)];
  if (end > start) decorations.push(Decoration.mark({ class: "cm-preview-match" }).range(start, end));
  view.dispatch({
    selection: { anchor: start },
    effects: [match.reconfigure(EditorView.decorations.of(Decoration.set(decorations, true))), EditorView.scrollIntoView(start, { y: "center", x: "nearest" })],
  });
}

watch(
  [editorHost, content],
  ([host, text]) => {
    if (view && host && view.dom.parentNode === host && text === snapshot?.content) return;
    view?.destroy();
    view = null;
    if (!host || text === null) return;
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: [
          editability.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
          undoHistory.of([]),
          EditorView.contentAttributes.of({ tabindex: "0", "aria-label": props.item.filePath || fileName.value }),
          lineNumbers(),
          drawSelection(),
          editorClipboardLineEndingsExtension(EditorView),
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                if (!editing.value) return false;
                void savePreview();
                return true;
              },
            },
            {
              key: "Escape",
              run: () => {
                if (editing.value) {
                  view?.contentDOM.blur();
                  return true;
                }
                emit("close");
                return true;
              },
            },
            {
              key: "Enter",
              run: () => {
                if (editing.value) return false;
                emit("open");
                return true;
              },
            },
            {
              key: "ArrowUp",
              run: () => {
                if (editing.value) return false;
                emit("navigate", -1);
                return true;
              },
            },
            {
              key: "ArrowDown",
              run: () => {
                if (editing.value) return false;
                emit("navigate", 1);
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && editing.value && savedDocument) dirty.value = !update.state.doc.eq(savedDocument);
          }),
          /\.sql$/i.test(props.item.filePath || "") ? sql() : [],
          theme.of([]),
          font.of(editorFontTheme(EditorView, settingsStore.editorSettings.fontSize, settingsStore.editorSettings.fontFamily, { fixedHeight: true, scrollable: true })),
          match.of([]),
          EditorView.theme({
            "&": { height: "100%", backgroundColor: "var(--background)", color: "var(--foreground)" },
            ".cm-scroller": { overflow: "auto" },
            ".cm-gutters": { backgroundColor: "var(--muted)", color: "var(--muted-foreground)", border: "none" },
            ".cm-selectionLayer .cm-selectionBackground": { display: "block" },
            ".cm-preview-match-line": { backgroundColor: "var(--info-bg)", boxShadow: "inset 3px 0 0 var(--info)" },
            ".cm-preview-match": { backgroundColor: "var(--warning-bg)", color: "var(--foreground)", borderRadius: "2px" },
          }),
        ],
      }),
    });
    revealMatch();
    void applyTheme();
  },
  { flush: "post" },
);

watch(
  () => [props.item.line, props.item.column, props.item.matchText],
  () => {
    if (!editing.value) revealMatch();
  },
  { flush: "post" },
);

let themeRevision = 0;
async function applyTheme(): Promise<void> {
  const revision = ++themeRevision;
  const target = view;
  if (!target) return;
  try {
    const extension = await loadEditorTheme(settingsStore.editorSettings.theme, isDark.value ? "dark" : "light", settingsStore.editorSettings.customThemeColors, themePalette.value);
    if (view === target && revision === themeRevision) target.dispatch({ effects: theme.reconfigure(extension) });
  } catch {
    // File contents remain readable even if an optional editor theme cannot load.
  }
}

watch(() => [isDark.value, themePalette.value, settingsStore.editorSettings.theme, settingsStore.editorSettings.customThemeColors], applyTheme, { deep: true });
watch(
  () => [settingsStore.editorSettings.fontSize, settingsStore.editorSettings.fontFamily],
  () => view?.dispatch({ effects: font.reconfigure(editorFontTheme(EditorView, settingsStore.editorSettings.fontSize, settingsStore.editorSettings.fontFamily, { fixedHeight: true, scrollable: true })) }),
);

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});
</script>

<template>
  <section class="flex min-h-0 flex-col border-t" :aria-label="t('quickOpen.filePreview')" :aria-busy="loading">
    <div class="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/30 px-4 text-xs text-muted-foreground">
      <span class="shrink-0">{{ t("quickOpen.filePreview") }}</span>
      <span v-if="dirty" class="shrink-0 text-warning" :title="t('editor.unsavedChangesTitle')" :aria-label="t('editor.unsavedChangesTitle')">●</span>
      <span class="min-w-0 flex-1 truncate" :title="item.filePath">{{ item.filePath || fileName }}</span>
      <span v-if="item.line && item.line > 0" class="shrink-0 font-mono">{{ item.line }}:{{ item.column || 1 }}</span>
      <Button variant="ghost" size="icon-sm" :title="t('common.copy')" :aria-label="t('common.copy')" :disabled="loading || failed || content === null" @click="copyPreview"><Copy class="h-3.5 w-3.5" /></Button>
      <template v-if="editing">
        <Button variant="ghost" size="xs" :disabled="saving" @click="savePreview"><Save class="h-3.5 w-3.5" />{{ t("common.save") }}</Button>
        <Button variant="ghost" size="xs" :disabled="saving" @click="cancelEditing">{{ t("common.cancel") }}</Button>
      </template>
      <Button v-else variant="ghost" size="icon-sm" :title="t('common.edit')" :aria-label="t('common.edit')" :disabled="loading || failed || content === null" @click="startEditing"><Pencil class="h-3.5 w-3.5" /></Button>
    </div>
    <div v-if="saveError" role="alert" class="shrink-0 border-b px-4 py-2 text-xs text-destructive">{{ saveError }}</div>
    <div class="relative min-h-0 flex-1">
      <div v-if="loading" role="status" class="flex h-full items-center justify-center text-xs text-muted-foreground">{{ t("common.loading") }}</div>
      <div v-else-if="failed" role="status" class="flex h-full items-center justify-center text-xs text-muted-foreground">{{ t("quickOpen.previewFailed") }}</div>
      <div v-else-if="content === '' && !editing" role="status" class="flex h-full items-center justify-center text-xs text-muted-foreground">{{ t("quickOpen.previewEmpty") }}</div>
      <div v-else ref="editorHost" data-native-clipboard class="h-full overflow-hidden" />
    </div>
  </section>
</template>

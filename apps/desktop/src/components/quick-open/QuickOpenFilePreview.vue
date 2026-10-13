<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Compartment, EditorState } from "@codemirror/state";
import { Decoration, drawSelection, EditorView, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { sql } from "@codemirror/lang-sql";
import { editorFontTheme, loadEditorTheme } from "@/lib/editor/editorThemes";
import * as api from "@/lib/backend/api";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import type { QuickOpenItem } from "@/composables/useQuickOpen";

const props = defineProps<{ item: QuickOpenItem }>();
const { t } = useI18n();
const settingsStore = useSettingsStore();
const { isDark, themePalette } = useTheme();
const editorHost = ref<HTMLElement | null>(null);
const content = ref<string | null>(null);
const loading = ref(true);
const failed = ref(false);
const fileName = computed(() => props.item.fileName || props.item.label);
const theme = new Compartment();
const font = new Compartment();
const match = new Compartment();
let view: EditorView | null = null;

// Match the global-search file-size bound. The backend checks the limit before reading.
const MAX_PREVIEW_BYTES = 32 * 1024 * 1024;

watch(
  () => props.item.filePath,
  (path, _previous, onCleanup) => {
    let cancelled = false;
    loading.value = true;
    failed.value = false;
    content.value = null;
    // Briefly debounce navigation across files; line changes within a file never reread it.
    const timer = setTimeout(async () => {
      try {
        if (!path) throw new Error("Missing preview path");
        const text = await api.readExternalSqlFile(path, MAX_PREVIEW_BYTES);
        if (!cancelled) content.value = text;
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
  const start = line.from + Math.max(0, Math.min((props.item.column ?? 1) - 1, line.length));
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
    view?.destroy();
    view = null;
    if (!host || text === null) return;
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ tabindex: "0", "aria-label": props.item.filePath || fileName.value }),
          lineNumbers(),
          drawSelection(),
          keymap.of(defaultKeymap),
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

watch(() => [props.item.line, props.item.column, props.item.matchText], revealMatch, { flush: "post" });

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
      <span class="min-w-0 flex-1 truncate" :title="item.filePath">{{ item.filePath || fileName }}</span>
      <span v-if="item.line && item.line > 0" class="shrink-0 font-mono">{{ item.line }}:{{ item.column || 1 }}</span>
    </div>
    <div class="relative min-h-0 flex-1">
      <div v-if="loading" role="status" class="flex h-full items-center justify-center text-xs text-muted-foreground">{{ t("common.loading") }}</div>
      <div v-else-if="failed" role="status" class="flex h-full items-center justify-center text-xs text-muted-foreground">{{ t("quickOpen.previewFailed") }}</div>
      <div v-else-if="content === ''" role="status" class="flex h-full items-center justify-center text-xs text-muted-foreground">{{ t("quickOpen.previewEmpty") }}</div>
      <div v-else ref="editorHost" data-native-clipboard class="h-full overflow-hidden" />
    </div>
  </section>
</template>

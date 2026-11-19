<script setup lang="ts">
import { ref, watch } from "vue";
import { useCellDetailEditor } from "@/composables/useCellDetailEditor";
import { useTheme } from "@/composables/useTheme";
import { isSaveShortcut } from "@/lib/editor/keyboardShortcuts";
import { useSettingsStore } from "@/stores/settingsStore";
import { EditorView } from "@codemirror/view";
import { StateEffect, Transaction } from "@codemirror/state";
import { isolateHistory } from "@codemirror/commands";
import { foldedRanges, unfoldEffect } from "@codemirror/language";
import { externalSearchHighlights, setExternalSearchHighlights, type ExternalSearchHighlight } from "@/lib/editor/codemirrorExternalSearchHighlights";

defineOptions({ name: "RedisJsonEditor" });

const props = withDefaults(
  defineProps<{
    modelValue: string;
    language?: "json" | "text";
    autofocus?: boolean;
    /** Save shortcuts are still consumed while disabled so global handlers cannot act on them. */
    saveDisabled?: boolean;
    readOnly?: boolean;
    wordWrap?: boolean;
    /** Document previews keep folding controls but do not need source line numbers. */
    lineNumbers?: boolean;
    /** A lighter reading surface for read-only JSON previews. */
    presentation?: "editor" | "viewer";
    /**
     * When false, Mod+F is left to a parent find surface (RedisValueViewer).
     * Default true so DocumentBrowser and other callers keep CodeMirror find.
     */
    enableBuiltinFind?: boolean;
    searchHighlights?: ExternalSearchHighlight[];
  }>(),
  {
    language: "json",
    autofocus: false,
    saveDisabled: false,
    readOnly: false,
    wordWrap: false,
    lineNumbers: true,
    presentation: "editor",
    enableBuiltinFind: true,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  save: [];
}>();

const editorContainer = ref<HTMLElement>();
let searchHighlightsInstalled = false;
const settingsStore = useSettingsStore();
const { isDark, themePalette } = useTheme();

const editor = useCellDetailEditor({
  language: props.language,
  preserveLineEndings: props.language === "text",
  lineNumbers: props.lineNumbers,
  folding: props.language === "json",
  lineWrapping: () => props.wordWrap,
  readOnly: () => props.readOnly,
  enableBuiltinFind: props.enableBuiltinFind,
  onChange(value) {
    emit("update:modelValue", value);
  },
  onSaveShortcut(event) {
    if (!isSaveShortcut(event, settingsStore.editorSettings.shortcuts)) return false;
    if (!props.saveDisabled) emit("save");
    return true;
  },
  editorTheme: () => settingsStore.editorSettings.theme,
  appAppearance: () => (isDark.value ? "dark" : "light"),
  appPalette: () => themePalette.value,
  fontSize: () => settingsStore.editorSettings.fontSize,
  fontFamily: () => settingsStore.editorSettings.fontFamily,
});

watch(editorContainer, async (container) => {
  if (!container) return;
  await editor.create(container, props.modelValue, "json");
  if (editor.getValue() !== props.modelValue) editor.setValue(props.modelValue, "json");
  syncSearchHighlights();
  if (props.autofocus) editor.view.value?.focus();
});

watch(
  () => props.modelValue,
  (value) => {
    // Do not reset the cursor after this editor emitted a normal v-model update.
    if (editor.getValue() !== value) editor.setValue(value, "json");
  },
);

function syncSearchHighlights() {
  const view = editor.view.value;
  if (!view || (!props.searchHighlights && !searchHighlightsInstalled)) return;
  if (!searchHighlightsInstalled) {
    view.dispatch({ effects: StateEffect.appendConfig.of(externalSearchHighlights()) });
    searchHighlightsInstalled = true;
  }
  const highlights = props.searchHighlights ?? [];
  view.dispatch({ effects: setExternalSearchHighlights.of(highlights) });
  const active = highlights.find((highlight) => highlight.active);
  if (active && !view.hasFocus) selectRange(active.from, active.to, { focus: false });
}

watch([() => props.searchHighlights, () => props.modelValue], syncSearchHighlights, { flush: "post" });

function openSearch(): boolean {
  return editor.openSearch();
}

function selectRange(from: number, to: number, options?: { focus?: boolean }): boolean {
  const view = editor.view.value;
  if (view && props.searchHighlights !== undefined) {
    const effects: StateEffect<unknown>[] = [];
    // Reveal only folds containing the target; keep unrelated nodes collapsed.
    foldedRanges(view.state).between(from, to, (start, end) => {
      if (start < to && end > from) effects.push(unfoldEffect.of({ from: start, to: end }));
    });
    if (effects.length) view.dispatch({ effects });
  }
  if (view && props.searchHighlights !== undefined) {
    view.dispatch({ effects: EditorView.scrollIntoView(Math.max(0, Math.min(from, view.state.doc.length)), { y: "center" }) });
    if (options?.focus !== false) view.focus();
    return true;
  }
  return editor.selectRange(from, to, options);
}

function replaceRanges(text: string, changes: { from: number; to: number; insert: string }[]): boolean {
  const view = editor.view.value;
  if (!view || props.readOnly || view.state.doc.toString() !== text || !changes.length) return false;
  view.dispatch({ changes, annotations: [Transaction.userEvent.of("input.replace"), isolateHistory.of("full")] });
  return true;
}

defineExpose({ openSearch, selectRange, replaceRanges, hasFocus: () => editor.view.value?.hasFocus ?? false });
</script>

<template>
  <div ref="editorContainer" class="h-full min-h-0 w-full" :class="{ 'redis-json-editor--viewer': presentation === 'viewer', 'redis-json-editor--dark': isDark }" data-redis-json-editor />
</template>

<style scoped>
:deep(.cm-externalSearchMatch),
:deep(.cm-externalSearchMatchActive) {
  border-radius: 2px;
  background: #fde68a;
}

:deep(.cm-externalSearchMatchActive) {
  background: #f59e0b;
  outline: 1px solid #d97706;
}

:deep(.cm-externalSearchMatchActive),
:deep(.cm-externalSearchMatchActive *) {
  color: #111827;
}

.redis-json-editor--dark :deep(.cm-externalSearchMatch) {
  background: #854d0e;
}

.redis-json-editor--dark :deep(.cm-externalSearchMatchActive) {
  background: #fbbf24;
}

.redis-json-editor--viewer :deep(.cm-editor) {
  background: transparent;
}

.redis-json-editor--viewer :deep(.cm-scroller) {
  padding-block: 0.75rem;
}

.redis-json-editor--viewer :deep(.cm-content) {
  padding: 0 1rem 1rem 0.375rem;
}

.redis-json-editor--viewer :deep(.cm-gutters) {
  background: transparent;
  border-right: 1px solid var(--border);
  padding-inline: 0.25rem;
}

.redis-json-editor--viewer :deep(.cm-foldGutter .cm-gutterElement) {
  border-radius: 3px;
  color: var(--muted-foreground);
  cursor: pointer;
  transition:
    background-color 0.15s,
    color 0.15s;
}

.redis-json-editor--viewer :deep(.cm-foldGutter .cm-gutterElement:hover) {
  background: var(--accent);
  color: var(--foreground);
}
</style>

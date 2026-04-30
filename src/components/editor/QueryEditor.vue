<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, shallowRef } from "vue";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { resolveExecutableSql } from "@/lib/sqlExecutionTarget";
import { formatSqlText, type SqlFormatDialect } from "@/lib/sqlFormatter";

const props = defineProps<{
  modelValue: string;
  dialect?: "mysql" | "postgres";
  formatDialect?: SqlFormatDialect;
  formatRequestId?: number;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
  "selectionChange": [value: string];
  "formatError": [message: string];
  execute: [sql: string];
}>();

const editorRef = ref<HTMLDivElement>();
const view = shallowRef<EditorViewType | null>(null);
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
let editorViewModule: typeof import("@codemirror/view") | null = null;
let fontSizeTheme: import("@codemirror/state").Compartment | null = null;

const savedFontSize = Number(localStorage.getItem("dbx-query-editor-font-size"));
const fontSize = ref(
  Number.isFinite(savedFontSize)
    ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, savedFontSize))
    : DEFAULT_FONT_SIZE,
);

function fontTheme(EditorView: typeof import("@codemirror/view").EditorView, size: number) {
  return EditorView.theme({
    "&": { height: "100%", fontSize: `${size}px` },
    ".cm-scroller": { overflow: "auto" },
    ".cm-content": { fontFamily: "'JetBrains Mono', 'Fira Code', monospace" },
  });
}

function setFontSize(size: number) {
  const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size));
  fontSize.value = next;
  localStorage.setItem("dbx-query-editor-font-size", String(next));
  if (view.value && fontSizeTheme && editorViewModule) {
    view.value.dispatch({
      effects: fontSizeTheme.reconfigure(fontTheme(editorViewModule.EditorView, next)),
    });
  }
}

function zoomIn() {
  setFontSize(fontSize.value + 1);
}

function zoomOut() {
  setFontSize(fontSize.value - 1);
}

function resetZoom() {
  setFontSize(DEFAULT_FONT_SIZE);
}

function selectedSqlFromView(currentView: EditorViewType): string {
  const selection = currentView.state.selection.main;
  return currentView.state.sliceDoc(selection.from, selection.to);
}

function executableSqlFromView(currentView: EditorViewType): string {
  return resolveExecutableSql(currentView.state.doc.toString(), selectedSqlFromView(currentView));
}

async function formatCurrentSql() {
  const currentView = view.value;
  if (!currentView) return;

  const selection = currentView.state.selection.main;
  const formatsSelection = !selection.empty;
  const from = formatsSelection ? selection.from : 0;
  const to = formatsSelection ? selection.to : currentView.state.doc.length;
  const source = currentView.state.sliceDoc(from, to);
  if (!source.trim()) return;

  try {
    const formatted = await formatSqlText(source, props.formatDialect ?? props.dialect ?? "generic");
    if (formatted === source) return;
    currentView.dispatch({
      changes: { from, to, insert: formatted },
      selection: formatsSelection
        ? { anchor: from, head: from + formatted.length }
        : { anchor: from + formatted.length },
    });
  } catch (e: any) {
    emit("formatError", String(e?.message || e));
  }
}

onMounted(async () => {
  if (!editorRef.value) return;

  const [
    { EditorView, keymap },
    { EditorState, Compartment },
    { sql, MySQL, PostgreSQL },
    { basicSetup },
    { oneDark },
  ] = await Promise.all([
    import("@codemirror/view"),
    import("@codemirror/state"),
    import("@codemirror/lang-sql"),
    import("codemirror"),
    import("@codemirror/theme-one-dark"),
  ]);
  editorViewModule = { EditorView, keymap } as typeof import("@codemirror/view");
  fontSizeTheme = new Compartment();

  const dialect = props.dialect === "postgres" ? PostgreSQL : MySQL;

  const runKeymap = keymap.of([
    {
      key: "Mod-=",
      run: () => {
        zoomIn();
        return true;
      },
    },
    {
      key: "Mod-+",
      run: () => {
        zoomIn();
        return true;
      },
    },
    {
      key: "Mod--",
      run: () => {
        zoomOut();
        return true;
      },
    },
    {
      key: "Mod-0",
      run: () => {
        resetZoom();
        return true;
      },
    },
    {
      key: "Mod-Enter",
      run: () => {
        if (view.value) emit("execute", executableSqlFromView(view.value));
        return true;
      },
    },
  ]);

  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      basicSetup,
      sql({ dialect }),
      oneDark,
      runKeymap,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          emit("update:modelValue", update.state.doc.toString());
        }
        if (update.selectionSet || update.docChanged) {
          emit("selectionChange", selectedSqlFromView(update.view));
        }
      }),
      fontSizeTheme.of(fontTheme(EditorView, fontSize.value)),
      EditorView.domEventHandlers({
        wheel(event) {
          if (!event.metaKey && !event.ctrlKey) return false;
          event.preventDefault();
          if (event.deltaY < 0) zoomIn();
          else if (event.deltaY > 0) zoomOut();
          return true;
        },
      }),
    ],
  });

  view.value = new EditorView({ state, parent: editorRef.value });
});

watch(
  () => props.modelValue,
  (val) => {
    if (view.value && val !== view.value.state.doc.toString()) {
      view.value.dispatch({
        changes: { from: 0, to: view.value.state.doc.length, insert: val },
      });
    }
  }
);

watch(
  () => props.formatRequestId,
  (val, oldVal) => {
    if (val && val !== oldVal) formatCurrentSql();
  }
);

onBeforeUnmount(() => {
  view.value?.destroy();
});
</script>

<template>
  <div ref="editorRef" data-query-editor-root class="h-full w-full overflow-hidden" />
</template>

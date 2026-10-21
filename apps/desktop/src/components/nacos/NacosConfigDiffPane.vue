<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Decoration, EditorView, lineNumbers, type DecorationSet } from "@codemirror/view";
import { EditorState, StateEffect, StateField, type Range } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { editorFontTheme, loadEditorTheme } from "@/lib/editor/editorThemes";
import { loadNacosConfigLanguage } from "@/lib/nacos/nacosConfigLanguage";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import type { NacosSideBySideDiffRow } from "@/lib/nacos/nacosAdmin";

const props = defineProps<{
  rows: NacosSideBySideDiffRow[];
  side: "left" | "right";
  format: string;
  activeRow?: number | null;
}>();

const emit = defineEmits<{
  ready: [];
}>();

const host = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
let generation = 0;
const settingsStore = useSettingsStore();
const { isDark, themePalette } = useTheme();
const setDecorations = StateEffect.define<DecorationSet>();

function currentCustomThemeColors() {
  const settings = settingsStore.editorSettings;
  if (settings.theme !== "custom") return settings.customThemeColors;
  const activeTheme = settings.customThemes?.find((theme) => theme.id === settings.activeCustomThemeId) || settings.customThemes?.[0];
  return activeTheme?.colors ?? settings.customThemeColors;
}

function lineContent(row: NacosSideBySideDiffRow) {
  return props.side === "left" ? row.leftContent : row.rightContent;
}

function lineType(row: NacosSideBySideDiffRow) {
  return props.side === "left" ? row.leftType : row.rightType;
}

function lineNumber(row?: NacosSideBySideDiffRow) {
  if (!row) return null;
  return props.side === "left" ? row.leftLineNumber : row.rightLineNumber;
}

function inlineSegments(row: NacosSideBySideDiffRow) {
  return props.side === "left" ? row.leftInline : row.rightInline;
}

function buildDecorations(state: EditorState) {
  const ranges: Range<Decoration>[] = [];
  props.rows.forEach((row, index) => {
    const line = state.doc.line(index + 1);
    const type = lineType(row);
    const changeClass = type === "delete" || (type === "modify" && props.side === "left") ? "nacos-diff-line-delete" : type === "insert" || (type === "modify" && props.side === "right") ? "nacos-diff-line-insert" : type === "padding" ? "nacos-diff-line-padding" : "";
    const baseClass = changeClass;
    const classes = [baseClass, props.activeRow === index ? "nacos-diff-line-active" : ""].filter(Boolean).join(" ");
    if (classes) ranges.push(Decoration.line({ attributes: { class: classes } }).range(line.from));
    let offset = line.from;
    for (const segment of inlineSegments(row)) {
      if (segment.changed && segment.value) {
        const charClass = type === "delete" || (type === "modify" && props.side === "left") ? "nacos-diff-char-delete" : "nacos-diff-char-insert";
        ranges.push(Decoration.mark({ class: charClass }).range(offset, offset + segment.value.length));
      }
      offset += segment.value.length;
    }
  });
  return Decoration.set(ranges, true);
}

const decorationsField = StateField.define<DecorationSet>({
  create: (state) => buildDecorations(state),
  update: (decorations, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(setDecorations)) return effect.value;
    }
    return decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

async function mount() {
  const target = host.value;
  if (!target) return;
  const currentGeneration = ++generation;
  view?.destroy();
  view = null;
  const [language, theme] = await Promise.all([loadNacosConfigLanguage(props.format), loadEditorTheme(settingsStore.editorSettings.theme, isDark.value ? "dark" : "light", currentCustomThemeColors(), themePalette.value)]);
  if (currentGeneration !== generation || target !== host.value) return;
  const content = props.rows.map(lineContent).join("\n");
  const state = EditorState.create({
    doc: content,
    extensions: [
      basicSetup,
      language,
      theme,
      editorFontTheme(EditorView, settingsStore.editorSettings.fontSize, settingsStore.editorSettings.fontFamily, { fixedHeight: true, scrollable: true }),
      lineNumbers({ formatNumber: (number) => String(lineNumber(props.rows[number - 1]) ?? "") }),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      decorationsField,
      EditorView.theme({
        "&": { height: "100%", backgroundColor: "transparent" },
        ".cm-scroller": { overflow: "auto" },
        ".cm-content": { minHeight: "100%", userSelect: "text", WebkitUserSelect: "text" },
        ".cm-line": { padding: "0 8px" },
        ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 8px" },
      }),
    ],
  });
  view = new EditorView({ parent: target, state });
  emit("ready");
}

function scrollToRow(index: number) {
  if (!view || index < 0 || index >= props.rows.length) return;
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(index + 1).from, { y: "center" }) });
}

function scrollerElement() {
  return view?.scrollDOM;
}

defineExpose({ scrollToRow, scrollerElement });
onMounted(() => void mount());
watch(
  () => [props.rows, props.format],
  () => void mount(),
  { deep: true },
);
watch(
  () => props.activeRow,
  () => {
    if (!view) return;
    view.dispatch({ effects: setDecorations.of(buildDecorations(view.state)) });
  },
);
onBeforeUnmount(() => {
  generation += 1;
  view?.destroy();
  view = null;
});
</script>

<template>
  <div ref="host" class="nacos-config-diff-pane h-full min-h-0 overflow-hidden rounded-sm border bg-background text-[13px] leading-6 text-foreground" />
</template>

<style>
.nacos-config-diff-pane {
  --nacos-diff-delete-background: #fef2f2;
  --nacos-diff-delete-foreground: #7f1d1d;
  --nacos-diff-delete-char-background: #fecaca;
  --nacos-diff-insert-background: #f0fdf4;
  --nacos-diff-insert-foreground: #14532d;
  --nacos-diff-insert-char-background: #bbf7d0;
}
.dark .nacos-config-diff-pane {
  --nacos-diff-delete-background: #3f1d20;
  --nacos-diff-delete-foreground: #fee2e2;
  --nacos-diff-delete-char-background: #7f1d1d;
  --nacos-diff-insert-background: #142f22;
  --nacos-diff-insert-foreground: #dcfce7;
  --nacos-diff-insert-char-background: #14532d;
}
.nacos-config-diff-pane .nacos-diff-line-delete {
  --nacos-diff-foreground: var(--nacos-diff-delete-foreground);
  background: var(--nacos-diff-delete-background);
}
.nacos-config-diff-pane .nacos-diff-line-insert {
  --nacos-diff-foreground: var(--nacos-diff-insert-foreground);
  background: var(--nacos-diff-insert-background);
}
/* Keep syntax tokens, including nested comment spans, readable on diff backgrounds.
   Opaque color pairs also avoid blending with unrelated custom editor colors. */
.nacos-config-diff-pane .cm-line:is(.nacos-diff-line-delete, .nacos-diff-line-insert),
.nacos-config-diff-pane .cm-line:is(.nacos-diff-line-delete, .nacos-diff-line-insert) * {
  color: var(--nacos-diff-foreground);
}
.nacos-config-diff-pane .nacos-diff-line-padding {
  background: rgb(113 113 122 / 0.15);
}
.dark .nacos-config-diff-pane .nacos-diff-line-padding {
  background: rgb(24 24 27 / 0.6);
}
.nacos-config-diff-pane .nacos-diff-line-active {
  box-shadow: inset 3px 0 0 rgb(250 204 21 / 0.95);
}
.nacos-config-diff-pane .nacos-diff-char-delete {
  background: var(--nacos-diff-delete-char-background);
}
.nacos-config-diff-pane .nacos-diff-char-insert {
  background: var(--nacos-diff-insert-char-background);
}
</style>

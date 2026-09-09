<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import { editorFontTheme, loadEditorTheme } from "@/lib/editor/editorThemes";
import { loadNacosConfigLanguage, resolveNacosConfigFormat } from "@/lib/nacos/nacosConfigLanguage";

const props = withDefaults(
  defineProps<{
    content: string;
    format?: string;
    dataId?: string;
    lineNumbers?: boolean;
  }>(),
  { format: "", dataId: "", lineNumbers: true },
);

const host = ref<HTMLElement | null>(null);
const settingsStore = useSettingsStore();
const { isDark, themePalette } = useTheme();
let view: EditorView | null = null;
let generation = 0;

function currentCustomThemeColors() {
  const settings = settingsStore.editorSettings;
  if (settings.theme !== "custom") return settings.customThemeColors;
  const activeTheme = settings.customThemes?.find((theme) => theme.id === settings.activeCustomThemeId) || settings.customThemes?.[0];
  return activeTheme?.colors ?? settings.customThemeColors;
}

async function mount() {
  const target = host.value;
  if (!target) return;
  const currentGeneration = ++generation;
  view?.destroy();
  view = null;
  const format = resolveNacosConfigFormat(props.format, props.dataId);
  const [language, theme] = await Promise.all([loadNacosConfigLanguage(format), loadEditorTheme(settingsStore.editorSettings.theme, isDark.value ? "dark" : "light", currentCustomThemeColors(), themePalette.value)]);
  if (currentGeneration !== generation || target !== host.value) return;
  const state = EditorState.create({
    doc: props.content,
    extensions: [
      basicSetup,
      language,
      theme,
      editorFontTheme(EditorView, settingsStore.editorSettings.fontSize, settingsStore.editorSettings.fontFamily, { fixedHeight: true, scrollable: true }),
      ...(props.lineNumbers ? [lineNumbers()] : []),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.theme({
        "&": { height: "100%", backgroundColor: "transparent" },
        ".cm-scroller": { overflow: "auto" },
        ".cm-content": { minHeight: "100%", userSelect: "text", WebkitUserSelect: "text" },
        ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 8px" },
      }),
    ],
  });
  view = new EditorView({ parent: target, state });
}

onMounted(() => void mount());
watch(
  () => [props.content, props.format, props.dataId, props.lineNumbers],
  () => void mount(),
);
onBeforeUnmount(() => {
  generation += 1;
  view?.destroy();
  view = null;
});
</script>

<template>
  <div ref="host" class="nacos-config-code-viewer h-full min-h-0 overflow-hidden rounded-md border bg-background" />
</template>

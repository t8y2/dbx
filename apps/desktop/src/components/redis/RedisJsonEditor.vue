<script setup lang="ts">
import { ref, watch } from "vue";
import { useCellDetailEditor } from "@/composables/useCellDetailEditor";
import { useTheme } from "@/composables/useTheme";
import { isSaveShortcut } from "@/lib/editor/keyboardShortcuts";
import { useSettingsStore } from "@/stores/settingsStore";

defineOptions({ name: "RedisJsonEditor" });

const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** Save shortcuts are still consumed while disabled so global handlers cannot act on them. */
    saveDisabled?: boolean;
    readOnly?: boolean;
    wordWrap?: boolean;
  }>(),
  {
    saveDisabled: false,
    readOnly: false,
    wordWrap: false,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  save: [];
}>();

const editorContainer = ref<HTMLElement>();
const settingsStore = useSettingsStore();
const { isDark, themePalette } = useTheme();

const editor = useCellDetailEditor({
  language: "json",
  lineNumbers: true,
  folding: true,
  lineWrapping: () => props.wordWrap,
  readOnly: () => props.readOnly,
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
});

watch(
  () => props.modelValue,
  (value) => {
    // Do not reset the cursor after this editor emitted a normal v-model update.
    if (editor.getValue() !== value) editor.setValue(value, "json");
  },
);
</script>

<template>
  <div ref="editorContainer" class="h-full min-h-0 w-full" data-redis-json-editor />
</template>

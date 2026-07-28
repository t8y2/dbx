<script setup lang="ts">
import { ref, watch } from "vue";
import { Code2, Copy, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { useCellDetailEditor, type UseCellDetailEditorReturn } from "@/composables/useCellDetailEditor";
import { useTheme } from "@/composables/useTheme";
import { useSettingsStore } from "@/stores/settingsStore";

const { t } = useI18n();
const settingsStore = useSettingsStore();
const { isDark, themePalette } = useTheme();

const props = defineProps<{
  fullText: string;
  text: string;
  usesCodeEditor: boolean;
  panelStyle?: Record<string, string>;
  resizing: boolean;
}>();

const emit = defineEmits<{
  copy: [];
  close: [];
  resizeStart: [event: MouseEvent];
  contextMenu: [event: MouseEvent];
}>();

const previewContainer = ref<HTMLElement>();
let previewEditor: UseCellDetailEditorReturn | null = null;

watch(previewContainer, async (element) => {
  if (element && !previewEditor) {
    previewEditor = useCellDetailEditor({
      language: "json",
      readOnly: true,
      editorTheme: () => settingsStore.editorSettings.theme,
      appAppearance: () => (isDark.value ? "dark" : "light") as import("@/lib/app/appTheme").AppThemeAppearance,
      appPalette: () => themePalette.value,
      fontSize: () => settingsStore.editorSettings.fontSize,
      fontFamily: () => settingsStore.editorSettings.tableFontFamily,
    });
    await previewEditor.create(element, props.text, "json");
  } else if (!element && previewEditor) {
    previewEditor.destroy();
    previewEditor = null;
  }
});

watch(
  () => props.text,
  (value) => previewEditor?.setValue(value, "json"),
);
</script>

<template>
  <div class="relative col-start-3 row-start-1 flex min-w-0 flex-col border-l bg-background" :class="{ 'detail-drawer-resizing': resizing }" :style="panelStyle" @contextmenu="emit('contextMenu', $event)">
    <div class="absolute bottom-0 left-0 top-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-primary/30" @mousedown.prevent="emit('resizeStart', $event)" />
    <div class="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/20 px-3">
      <Code2 class="h-3.5 w-3.5 text-muted-foreground" />
      <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ t("grid.mongoJsonPreview") }}</span>
      <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="!fullText" :title="t('grid.copyJson')" @click="emit('copy')"><Copy class="h-3 w-3" /></Button>
      <Button variant="ghost" size="icon" class="h-5 w-5" @click="emit('close')"><X class="h-3 w-3" /></Button>
    </div>
    <div v-if="text" class="flex min-h-0 flex-1 flex-col overflow-hidden p-2">
      <div v-if="usesCodeEditor" ref="previewContainer" data-cell-detail-editor-root class="min-h-0 flex-1 overflow-hidden" />
      <template v-else>
        <pre class="dbx-data-grid-value-font min-h-0 flex-1 overflow-auto rounded border bg-muted/20 p-3 text-xs whitespace-pre-wrap break-words">{{ text }}</pre>
        <div class="mt-1 text-[11px] text-muted-foreground">{{ t("grid.largeValuePreviewHint", { count: text.length }) }}</div>
      </template>
    </div>
    <div v-else class="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">{{ t("grid.mongoJsonPreviewEmpty") }}</div>
  </div>
</template>

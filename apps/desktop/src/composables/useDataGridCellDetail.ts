import { nextTick, ref, watch, type Ref } from "vue";
import { useCellDetailEditor, type UseCellDetailEditorReturn } from "@/composables/useCellDetailEditor";
import { isSaveShortcut } from "@/lib/editor/keyboardShortcuts";
import { useTheme } from "@/composables/useTheme";
import { useSettingsStore } from "@/stores/settingsStore";
import { renderWktOnCanvas } from "@/lib/dataGrid/geometryPreview";
import type { DataGridCellDetail } from "@/lib/dataGrid/dataGridDetail";

export function useDataGridCellDetail(options: { detail: Ref<DataGridCellDetail>; editValue: Ref<string>; onCancel: () => void; onSave?: () => void }) {
  const settingsStore = useSettingsStore();
  const { isDark, themePalette } = useTheme();
  const geometryPreviewOpen = ref(false);
  const geometryCanvas = ref<HTMLCanvasElement | null>(null);
  const detailsEditorContainer = ref<HTMLElement>();
  const sideJsonPreviewContainer = ref<HTMLElement>();
  let detailsEditor: UseCellDetailEditorReturn | null = null;
  let sideJsonEditor: UseCellDetailEditorReturn | null = null;

  const editorOptions = () => ({
    editorTheme: () => settingsStore.editorSettings.theme,
    appAppearance: () => (isDark.value ? "dark" : "light") as import("@/lib/app/appTheme").AppThemeAppearance,
    appPalette: () => themePalette.value,
    fontSize: () => settingsStore.editorSettings.fontSize,
    fontFamily: () => settingsStore.editorSettings.tableFontFamily,
    lineWrapping: () => settingsStore.editorSettings.wordWrap,
  });

  watch(geometryPreviewOpen, async (open) => {
    if (!open) return;
    await nextTick();
    const canvas = geometryCanvas.value;
    const detail = options.detail.value;
    if (canvas && detail.value !== null && detail.value !== undefined) renderWktOnCanvas(canvas, String(detail.value));
  });

  watch(detailsEditorContainer, async (element) => {
    if (element && !detailsEditor) {
      const editor = useCellDetailEditor({
        onChange: (value) => (options.editValue.value = value),
        onEscape: options.onCancel,
        // 详情面板 CodeMirror 里的 Ctrl/Cmd+S：提交草稿成待保存变更并保存（#10515）。
        // useCellDetailEditor 对每个 keydown 都会回调本钩子，必须先用 isSaveShortcut
        // 过滤，否则普通按键也会被吞掉（preventDefault）导致无法输入。
        onSaveShortcut: options.onSave
          ? (event) => {
              if (!isSaveShortcut(event, settingsStore.editorSettings.shortcuts)) return false;
              options.onSave?.();
              return true;
            }
          : undefined,
        ...editorOptions(),
      });
      detailsEditor = editor;
      await editor.create(element, options.editValue.value, options.detail.value.type);
      if (detailsEditor === editor && editor.getValue() !== options.editValue.value) {
        editor.setValue(options.editValue.value, options.detail.value.type);
      }
      if (detailsEditor === editor) editor.view.value?.focus();
    } else if (!element && detailsEditor) {
      detailsEditor.destroy();
      detailsEditor = null;
    }
  });

  watch(sideJsonPreviewContainer, async (element) => {
    if (element && !sideJsonEditor) {
      const editor = useCellDetailEditor({ language: "json", readOnly: true, ...editorOptions() });
      sideJsonEditor = editor;
      await editor.create(element, options.detail.value.formattedJson ?? "", "json");
      if (sideJsonEditor === editor) {
        const value = options.detail.value.formattedJson ?? "";
        if (editor.getValue() !== value) editor.setValue(value, "json");
      }
    } else if (!element && sideJsonEditor) {
      sideJsonEditor.destroy();
      sideJsonEditor = null;
    }
  });

  watch(
    () => options.detail.value.formattedJson ?? "",
    (value) => sideJsonEditor?.setValue(value, "json"),
  );
  watch(options.editValue, (value) => {
    if (!detailsEditor || detailsEditor.getValue() === value) return;
    detailsEditor.setValue(value, options.detail.value.type);
  });

  return {
    geometryPreviewOpen,
    geometryCanvas,
    detailsEditorContainer,
    sideJsonPreviewContainer,
    openSearch: () => detailsEditor?.openSearch() ?? sideJsonEditor?.openSearch() ?? false,
  };
}

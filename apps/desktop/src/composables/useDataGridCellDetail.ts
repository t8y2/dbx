import { nextTick, ref, watch, type Ref } from "vue";
import { useCellDetailEditor, type UseCellDetailEditorReturn } from "@/composables/useCellDetailEditor";
import { useTheme } from "@/composables/useTheme";
import { useSettingsStore } from "@/stores/settingsStore";
import { renderWktOnCanvas } from "@/lib/dataGrid/geometryPreview";
import type { DataGridCellDetail } from "@/lib/dataGrid/dataGridDetail";

export function useDataGridCellDetail(options: { detail: Ref<DataGridCellDetail>; editValue: Ref<string>; onCancel: () => void }) {
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
    fontFamily: () => settingsStore.editorSettings.fontFamily,
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
      const editor = useCellDetailEditor({ onChange: (value) => (options.editValue.value = value), onEscape: options.onCancel, ...editorOptions() });
      detailsEditor = editor;
      await editor.create(element, options.editValue.value, options.detail.value.type);
      if (detailsEditor === editor) editor.view.value?.focus();
    } else if (!element && detailsEditor) {
      detailsEditor.destroy();
      detailsEditor = null;
    }
  });

  watch(sideJsonPreviewContainer, async (element) => {
    if (element && !sideJsonEditor) {
      sideJsonEditor = useCellDetailEditor({ language: "json", readOnly: true, ...editorOptions() });
      await sideJsonEditor.create(element, options.detail.value.formattedJson ?? "", "json");
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

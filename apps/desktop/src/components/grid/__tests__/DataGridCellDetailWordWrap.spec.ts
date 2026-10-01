// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createApp, defineComponent, h, nextTick, type App } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { createI18n } from "vue-i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DataGridCellDetailHeader from "../DataGridCellDetailHeader.vue";
import DataGridCellDetailDialog from "../DataGridCellDetailDialog.vue";
import { Tabs } from "@/components/ui/tabs";
import { useSettingsStore } from "@/stores/settingsStore";
import { useCellDetailEditor } from "@/composables/useCellDetailEditor";
import type { DataGridCellDetail } from "@/lib/dataGrid/dataGridDetail";

const dataGridSource = readFileSync(resolve(import.meta.dirname, "../DataGrid.vue"), "utf8");
const useDataGridCellDetailSource = readFileSync(resolve(import.meta.dirname, "../../../composables/useDataGridCellDetail.ts"), "utf8");
const cellDetailDialogSource = readFileSync(resolve(import.meta.dirname, "../DataGridCellDetailDialog.vue"), "utf8");

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

const i18n = createI18n({
  legacy: false,
  locale: "en",
  messages: {
    en: {
      settings: {
        wordWrap: "Word Wrap",
      },
      grid: {
        cellDetails: "Cell Details",
        hexViewer: "Hex Viewer",
        valueEditor: "Value Editor",
        openCellDetailsDialog: "Maximize",
        openRowDetailsDialog: "Row details",
        openColumnDetailsDialog: "Column details",
        cellDetailLayoutRight: "Layout right",
        cellDetailLayoutBottom: "Layout bottom",
        collapseCellDetailMetadata: "Collapse",
        expandCellDetailMetadata: "Expand",
        editValue: "Edit",
        copyValue: "Copy",
        copyColumnName: "Copy column name",
        cellValue: "Value",
        formattedJson: "JSON",
      },
      common: {
        close: "Close",
      },
    },
  },
});

function createMockDetail(): DataGridCellDetail {
  return {
    rowNumber: 1,
    rowId: 1,
    colIndex: 0,
    column: "description",
    type: "TEXT",
    comment: "",
    value: "Line 1 that is very long and needs word wrap to be read comfortably without scrolling\nLine 2",
    rawValue: "Line 1 that is very long and needs word wrap to be read comfortably without scrolling\nLine 2",
    rawValuePreview: "Line 1...",
    displayValue: "Line 1...",
    displayValuePreview: "Line 1...",
    isValuePreviewTruncated: false,
    imagePreviewUrl: null,
    length: 90,
    formattedJson: null,
    isEditable: true,
  };
}

beforeEach(() => {
  const pinia = createPinia();
  setActivePinia(pinia);
});

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGrid cell editor and value editor word wrap (#10506)", () => {
  it("binds lineWrapping in useDataGridCellDetail, DataGrid valueDetailEditor, and cell detail dialog", () => {
    // #10506: useDataGridCellDetail, DataGrid.vue (valueDetailEditor), and DataGridCellDetailDialog
    // must connect CodeMirror lineWrapping to settingsStore.editorSettings.wordWrap
    expect(useDataGridCellDetailSource).toMatch(/lineWrapping:\s*\(\)\s*=>\s*settingsStore\.editorSettings\.wordWrap/);
    expect(dataGridSource).toMatch(/lineWrapping:\s*\(\)\s*=>\s*settingsStore\.editorSettings\.wordWrap/);
    expect(cellDetailDialogSource).toMatch(/lineWrapping:\s*\(\)\s*=>\s*settingsStore\.editorSettings\.wordWrap/);
  });

  it("dynamically toggles CodeMirror cm-lineWrapping in useCellDetailEditor based on wordWrap setting", async () => {
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.wordWrap = false;

    const host = document.createElement("div");
    document.body.append(host);

    const editor = useCellDetailEditor({
      editorTheme: () => "default",
      appAppearance: () => "light",
      appPalette: () => ({}) as any,
      fontSize: () => 13,
      fontFamily: () => "monospace",
    });

    await editor.create(host, "A very long line of text that should wrap when wordWrap is enabled");
    const cmContent = host.querySelector(".cm-content");
    expect(cmContent).not.toBeNull();
    expect(cmContent?.classList.contains("cm-lineWrapping")).toBe(false);

    // Toggle wordWrap to true
    settingsStore.editorSettings.wordWrap = true;
    await nextTick();
    expect(cmContent?.classList.contains("cm-lineWrapping")).toBe(true);

    // Toggle wordWrap back to false
    settingsStore.editorSettings.wordWrap = false;
    await nextTick();
    expect(cmContent?.classList.contains("cm-lineWrapping")).toBe(false);

    editor.destroy();
    host.remove();
  });

  it("renders word wrap toggle button in DataGridCellDetailHeader and updates settingsStore", async () => {
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.wordWrap = false;

    const host = document.createElement("div");
    document.body.append(host);

    const Root = defineComponent({
      setup() {
        return () =>
          h(Tabs, { defaultValue: "details" }, () =>
            h(DataGridCellDetailHeader, {
              metadataCollapsed: false,
              panelIsBottom: false,
              activeTabs: ["details", "valueEditor"],
            }),
          );
      },
    });

    const app = createApp(Root);
    app.use(i18n);
    app.mount(host);
    mountedApps.push({ app, host });

    const wrapButton = host.querySelector<HTMLButtonElement>('button[aria-label="Word Wrap"]');
    expect(wrapButton).not.toBeNull();
    expect(wrapButton?.getAttribute("aria-pressed")).toBe("false");

    wrapButton?.click();
    await nextTick();
    expect(settingsStore.editorSettings.wordWrap).toBe(true);
    expect(wrapButton?.getAttribute("aria-pressed")).toBe("true");

    wrapButton?.click();
    await nextTick();
    expect(settingsStore.editorSettings.wordWrap).toBe(false);
    expect(wrapButton?.getAttribute("aria-pressed")).toBe("false");
  });

  it("renders word wrap toggle button in DataGridCellDetailDialog and updates settingsStore", async () => {
    const settingsStore = useSettingsStore();
    settingsStore.editorSettings.wordWrap = false;

    const host = document.createElement("div");
    document.body.append(host);

    const detail = createMockDetail();
    const Root = defineComponent({
      setup() {
        return () =>
          h(DataGridCellDetailDialog, {
            open: true,
            detail,
            typeColorClass: () => "",
            openImagePreview: vi.fn(),
            copyText: vi.fn(),
            canDownloadBinaryValue: () => false,
            downloadBinaryValue: vi.fn(),
            canImportBinaryValue: () => false,
            importBinaryValue: vi.fn(),
          });
      },
    });

    const app = createApp(Root);
    app.use(i18n);
    app.mount(host);
    mountedApps.push({ app, host });

    await nextTick();

    const wrapButton = document.body.querySelector<HTMLButtonElement>('button[aria-label="Word Wrap"]');
    expect(wrapButton).not.toBeNull();
    expect(wrapButton?.getAttribute("aria-pressed")).toBe("false");

    wrapButton?.click();
    await nextTick();
    expect(settingsStore.editorSettings.wordWrap).toBe(true);
    expect(wrapButton?.getAttribute("aria-pressed")).toBe("true");

    wrapButton?.click();
    await nextTick();
    expect(settingsStore.editorSettings.wordWrap).toBe(false);
    expect(wrapButton?.getAttribute("aria-pressed")).toBe("false");
  });
});

// @vitest-environment happy-dom

import { createApp, defineComponent, h, KeepAlive, markRaw, nextTick, shallowRef, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";

// DataGrid.vue imports RecycleScroller directly (no global registration),
// so the module itself must be stubbed for deterministic row rendering.
vi.mock("vue-virtual-scroller", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    RecycleScroller: defineComponent({
      props: {
        items: {
          type: Array as PropType<unknown[]>,
          default: () => [],
        },
      },
      setup(props, { attrs, slots }) {
        return () =>
          h(
            "div",
            attrs,
            props.items.map((item) => slots.default?.({ item })),
          );
      },
    }),
  };
});

vi.mock("@/composables/useDataGridColumnResize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useDataGridColumnResize")>();
  const { ref } = await import("vue");
  return {
    ...actual,
    useDataGridColumnResize: () => ({
      initColumnWidths: vi.fn(),
      onResizeStart: vi.fn(),
      autoFitColumn: vi.fn(),
      hasUserSizedColumns: ref(false),
      renderedColumnWidths: ref([120, 120, 120]),
      totalWidth: ref(360),
      columnVars: ref({ "--total-w": "360px" }),
      getIsResizing: () => false,
    }),
  };
});

import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const RecycleScroller = defineComponent({
  props: {
    items: {
      type: Array as PropType<unknown[]>,
      default: () => [],
    },
  },
  setup(props, { attrs, slots }) {
    return () =>
      h(
        "div",
        attrs,
        props.items.map((item) => slots.default?.({ item })),
      );
  },
});

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function multilineResult(): QueryResult {
  return {
    columns: ["id", "note", "tag"],
    rows: [[1, "seed-note", "seed-tag"]],
    affected_rows: 0,
    execution_time_ms: 0,
  };
}

function mountGrid(renderMode: "canvas" | "dom" = "dom", resultOnlyType?: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ dataGridRenderMode: "canvas", dataGridMultiRowTranspose: false, dataGridHideNullColumns: false, dataGridQuickEntry: false });
  const result = multilineResult();
  if (resultOnlyType) result.column_types = [resultOnlyType, "varchar", "varchar"];
  const resultRef = shallowRef(markRaw(result));
  const visibleRef = shallowRef(true);
  const gridRef = shallowRef<InstanceType<typeof DataGrid> | null>(null);

  const host = document.createElement("div");
  document.body.append(host);
  const Root = defineComponent({
    setup() {
      return () =>
        h(
          TooltipProvider,
          { delayDuration: 0 },
          {
            default: () =>
              h(KeepAlive, null, {
                default: () =>
                  visibleRef.value
                    ? h(DataGrid, {
                        ref: gridRef,
                        result: resultRef.value,
                        databaseType: "dameng",
                        context: resultOnlyType ? "results" : "table-data",
                        editable: true,
                        customSaveHandler: resultOnlyType ? { save: async () => {} } : undefined,
                        tableMeta: resultOnlyType
                          ? undefined
                          : {
                              tableName: "multiline_paste",
                              columns: [
                                { name: "id", data_type: "int", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
                                { name: "note", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
                                { name: "tag", data_type: "varchar", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
                              ],
                              primaryKeys: ["id"],
                            },
                      })
                    : null,
              }),
          },
        );
    },
  });
  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.component("RecycleScroller", RecycleScroller);
  app.mount(host);
  if (renderMode === "dom") settingsStore.updateEditorSettings({ dataGridRenderMode: "dom" });
  const mounted = { app, host, gridRef };
  mountedApps.push(mounted);
  return mounted;
}

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function openCellEditor(host: HTMLElement, gridRef: { value: InstanceType<typeof DataGrid> | null }, rowIndex: number, colIndex: number) {
  gridRef.value?.selectSingleCell(rowIndex, colIndex);
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const root = host.querySelector<HTMLElement>("[data-grid-root]");
  root?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function dispatchPasteOn(target: Element, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  target.dispatchEvent(event);
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGrid inline cell editor multiline paste (#15307)", () => {
  it("hands a multiline paste to the expanded textarea editor and keeps the line breaks", async () => {
    const { host, gridRef } = mountGrid();
    await openCellEditor(host, gridRef, 0, 1);

    const input = host.querySelector<HTMLInputElement>("input.cell-edit-input");
    expect(input).not.toBeNull();
    if (!input) return;
    dispatchPasteOn(input, "line1\nline2\nline3");
    await settle();

    const textarea = host.querySelector<HTMLTextAreaElement>("textarea.cell-edit-input--expanded");
    expect(textarea).not.toBeNull();
    expect(host.querySelector("input.cell-edit-input")).toBeNull();
    if (!textarea) return;
    expect(textarea.value).toBe("line1\nline2\nline3");
    expect(textarea.selectionStart).toBe(textarea.value.length);
    expect(textarea.selectionEnd).toBe(textarea.value.length);

    // The expanded editor is multi-line: plain Enter inserts a newline, only
    // Ctrl/Cmd+Enter commits the cell (useDataGridEditor.onEditKeydown).
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ctrlKey: true }));
    await settle();
    expect(gridRef.value?.displayItems[0]?.data[1]).toBe("line1\nline2\nline3");
  });

  it("applies the paste at the collapsed caret of existing content", async () => {
    const { host, gridRef } = mountGrid();
    await openCellEditor(host, gridRef, 0, 1);

    const input = host.querySelector<HTMLInputElement>("input.cell-edit-input");
    expect(input).not.toBeNull();
    if (!input) return;
    input.setSelectionRange(4, 4);
    dispatchPasteOn(input, "N\nL");
    await settle();

    const textarea = host.querySelector<HTMLTextAreaElement>("textarea.cell-edit-input--expanded");
    expect(textarea).not.toBeNull();
    if (!textarea) return;
    expect(textarea.value).toBe("seedN\nL-note");
    expect(textarea.selectionStart).toBe(7);
  });

  it("restores the middle caret when the paste handler has to reopen the editor", async () => {
    const { host, gridRef } = mountGrid();
    await openCellEditor(host, gridRef, 0, 1);

    const root = host.querySelector<HTMLElement>("[data-grid-root]")!;
    const input = host.querySelector<HTMLInputElement>("input.cell-edit-input")!;
    input.setSelectionRange(4, 4);
    const querySelector = root.querySelector.bind(root);
    let missedHandoff = false;
    // Model the editor being temporarily unavailable during the input swap.
    const lookup = vi.spyOn(root, "querySelector").mockImplementation((selector: string) => {
      if (selector === ".cell-edit-input--expanded" && !missedHandoff) {
        missedHandoff = true;
        return null;
      }
      return querySelector(selector);
    });
    try {
      dispatchPasteOn(input, "N\nL");
      await vi.waitFor(() => {
        expect(missedHandoff).toBe(true);
        const textarea = host.querySelector<HTMLTextAreaElement>("textarea.cell-edit-input--expanded");
        expect(textarea?.value).toBe("seedN\nL-note");
        expect(textarea?.selectionStart).toBe(7);
        expect(textarea?.selectionEnd).toBe(7);
      });
    } finally {
      lookup.mockRestore();
    }
  });

  it("keeps the inline editor for a single-line paste", async () => {
    const { host, gridRef } = mountGrid();
    await openCellEditor(host, gridRef, 0, 2);

    const input = host.querySelector<HTMLInputElement>("input.cell-edit-input");
    expect(input).not.toBeNull();
    if (!input) return;
    dispatchPasteOn(input, "plain-text");
    await settle();

    expect(host.querySelector("textarea.cell-edit-input--expanded")).toBeNull();
    expect(host.querySelector("input.cell-edit-input")).not.toBeNull();
  });

  it("keeps the inline editor for a multiline paste into a numeric column", async () => {
    const { host, gridRef } = mountGrid();
    await openCellEditor(host, gridRef, 0, 0);

    const input = host.querySelector<HTMLInputElement>("input.cell-edit-input");
    expect(input).not.toBeNull();
    if (!input) return;
    dispatchPasteOn(input, "1\n2");
    await settle();

    expect(host.querySelector("textarea.cell-edit-input--expanded")).toBeNull();
    expect(host.querySelector("input.cell-edit-input")).not.toBeNull();
  });

  it.each(["integer", "decimal(8,2)"])("keeps a single-line editor for a %s result column without table metadata", async (resultType) => {
    const { host, gridRef } = mountGrid("dom", resultType);
    await openCellEditor(host, gridRef, 0, 0);

    const input = host.querySelector<HTMLInputElement>("input.cell-edit-input")!;
    expect(input?.inputMode).toBe(resultType === "integer" ? "numeric" : "decimal");
    dispatchPasteOn(input, "1\n2");
    await settle();

    expect(host.querySelector("textarea.cell-edit-input--expanded")).toBeNull();
    expect(host.querySelector("input.cell-edit-input")).toBe(input);
  });

  it("switches to the expanded editor in canvas render mode too", async () => {
    const { host, gridRef } = mountGrid("canvas");
    await openCellEditor(host, gridRef, 0, 1);

    const input = host.querySelector<HTMLInputElement>("input.cell-edit-input");
    expect(input).not.toBeNull();
    if (!input) return;
    dispatchPasteOn(input, "line1\nline2\nline3");
    await settle();

    const textarea = host.querySelector<HTMLTextAreaElement>("textarea.cell-edit-input--expanded");
    expect(textarea).not.toBeNull();
    if (!textarea) return;
    expect(textarea.value).toBe("line1\nline2\nline3");
    expect(textarea.selectionStart).toBe(textarea.value.length);
  });
});

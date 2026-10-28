// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, ref, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import { TooltipProvider } from "@/components/ui/tooltip";

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
        return () => h("div", attrs, [slots.before?.(), props.items.map((item, index) => slots.default?.({ item, index }))]);
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
      renderedColumnWidths: ref([120, 120]),
      totalWidth: ref(240),
      columnVars: ref({ "--total-w": "240px" }),
      getIsResizing: () => false,
    }),
  };
});

import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function transposeFieldNames(host: HTMLElement): string[] {
  return [...host.querySelectorAll<HTMLElement>("[data-grid-transpose-column-index]")].map((field) => field.querySelector<HTMLElement>("[data-grid-transpose-field-name]")?.textContent?.trim() ?? field.textContent?.trim().split("\n")[0] ?? "");
}

function mountGrid(context: "table-data" | "results" = "table-data") {
  const pinia = createPinia();
  setActivePinia(pinia);
  const settingsStore = useSettingsStore();
  settingsStore.updateEditorSettings({ dataGridRenderMode: "dom", dataGridMultiRowTranspose: true });

  const originalRows: QueryResult["rows"] = [
    ["b", "10"],
    ["a", null],
    ["c", "2"],
  ];
  const result = ref<QueryResult>(
    markRaw({
      columns: ["zeta", "alpha"],
      column_types: ["varchar", "bigint"],
      rows: originalRows,
      affected_rows: 0,
      execution_time_ms: 0,
    }),
  );
  const resultColumnComments = ref<Array<string | undefined>>();

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
              h(DataGrid, {
                result: result.value,
                resultColumnComments: resultColumnComments.value,
                databaseType: "mysql",
                context,
                tableMeta: {
                  tableName: "scores",
                  columns: [
                    { name: "zeta", data_type: "varchar", comment: "Display name with a long comment", is_nullable: false, column_default: null, is_primary_key: true, extra: null },
                    { name: "alpha", data_type: "bigint", comment: "Score", is_nullable: true, column_default: null, is_primary_key: false, extra: null },
                  ],
                  primaryKeys: ["zeta"],
                },
              }),
          },
        );
    },
  });
  const app = createApp(Root);
  app.use(pinia);
  app.use(i18n);
  app.mount(host);
  mountedApps.push({ app, host });
  return { host, settingsStore, result, resultColumnComments };
}

async function openTranspose(host: HTMLElement) {
  const firstRowNumber = host.querySelector<HTMLElement>(".data-grid-row-number");
  if (!firstRowNumber) throw new Error("Row number not found");
  firstRowNumber.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
  firstRowNumber.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, button: 0 }));
  await settle();
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
});

describe("DataGrid transpose sorting", () => {
  it.each(["table-data", "results"] as const)("moves all field metadata into an independent information column for %s", async (context) => {
    const { host, settingsStore } = mountGrid(context);
    settingsStore.updateEditorSettings({ dataGridShowTransposeFieldMetadata: true });
    await settle();
    await openTranspose(host);
    expect(host.querySelectorAll("[data-grid-transpose-comment-line]")).toHaveLength(2);
    expect(host.querySelector("[data-grid-transpose-column-info]")).toBeNull();

    settingsStore.updateEditorSettings({ dataGridTransposeMetadataInInfoColumn: true });
    await settle();
    expect(host.querySelectorAll("[data-grid-transpose-comment-line]")).toHaveLength(0);
    expect(host.querySelectorAll("[data-grid-transpose-type-line]")).toHaveLength(0);
    const info = [...host.querySelectorAll<HTMLElement>("[data-grid-transpose-column-info]")];
    expect(info).toHaveLength(2);
    expect(info[0].textContent).toContain("Display name with a long comment");
    expect(info[0].textContent).toContain("varchar");
    expect(info[0].textContent).toContain("Nullable: No");
    expect(info[0].textContent).not.toContain("zeta");
    expect(info[0].title).toContain("Display name with a long comment");
    expect(info[1].textContent).toContain("Score");
    expect(info[1].textContent).toContain("Nullable: Yes");

    settingsStore.updateEditorSettings({ dataGridTransposeMetadataInInfoColumn: false });
    await settle();
    expect(host.querySelectorAll("[data-grid-transpose-column-info]")).toHaveLength(0);
    expect(host.querySelectorAll("[data-grid-transpose-comment-line]")).toHaveLength(2);
    expect(host.querySelectorAll("[data-grid-transpose-type-line]")).toHaveLength(2);
  });

  it("keeps normal and transposed comment placement independent", async () => {
    const { host, settingsStore } = mountGrid("results");
    settingsStore.updateEditorSettings({ dataGridColumnCommentsInInfoArea: true, dataGridShowTransposeFieldMetadata: true });
    await settle();
    // #13171: the info-area comment is additive; the header line stays visible.
    expect(host.querySelectorAll("[data-grid-header-comment-line]")).toHaveLength(2);
    await openTranspose(host);
    expect(host.querySelectorAll("[data-grid-transpose-column-info]")).toHaveLength(0);
    expect(host.querySelectorAll("[data-grid-transpose-comment-line]")).toHaveLength(2);

    settingsStore.updateEditorSettings({ dataGridColumnCommentsInInfoArea: false, dataGridTransposeMetadataInInfoColumn: true, dataGridShowTransposeFieldMetadata: false });
    await settle();
    expect(host.querySelectorAll("[data-grid-transpose-column-info]")).toHaveLength(2);
    expect(host.querySelectorAll("[data-grid-transpose-type-line]")).toHaveLength(0);
    expect(host.querySelectorAll("[data-grid-transpose-comment-line]")).toHaveLength(0);
  });

  it("uses ordinal query comments for duplicate names and clears stale metadata for a new result", async () => {
    const { host, settingsStore, result, resultColumnComments } = mountGrid();
    settingsStore.updateEditorSettings({ dataGridColumnCommentsInInfoArea: true });
    result.value = { ...result.value, columns: ["name", "name"] };
    resultColumnComments.value = ["First source", "Second source"];
    await settle();
    host.querySelector<HTMLElement>('[data-grid-column-index="1"]')!.click();
    await settle();
    expect(host.querySelector("[data-grid-column-info]")?.textContent).toContain("Second source");
    expect(host.querySelector("[data-grid-column-info]")?.textContent).not.toContain("First source");

    resultColumnComments.value = [undefined, undefined];
    await settle();
    expect(host.querySelector("[data-grid-column-info]")?.textContent).toContain("bigint");
    expect(host.querySelector("[data-grid-column-info]")?.textContent).not.toContain("Second source");
    expect(host.querySelector("[data-grid-column-info]")?.textContent).not.toContain("undefined");
  });

  it("shows selected column metadata in the status area while keeping header comments", async () => {
    const { host, settingsStore } = mountGrid();
    await settle();
    expect(host.querySelectorAll("[data-grid-header-comment-line]")).toHaveLength(2);
    settingsStore.updateEditorSettings({ dataGridColumnCommentsInInfoArea: true });
    await settle();
    // #13171: both surfaces show at once.
    expect(host.querySelectorAll("[data-grid-header-comment-line]")).toHaveLength(2);
    host.querySelector<HTMLElement>('[data-grid-column-index="0"]')!.click();
    await settle();
    expect(host.querySelector("[data-grid-column-info]")?.textContent).toContain("Display name with a long comment");
    host.querySelector<HTMLElement>('[data-grid-column-index="1"]')!.click();
    await settle();
    expect(host.querySelector("[data-grid-column-info]")?.textContent).toContain("Score");
    expect(host.querySelector("[data-grid-column-info]")?.textContent).toContain("bigint");
    settingsStore.updateEditorSettings({ dataGridColumnCommentsInInfoArea: false });
    await settle();
    expect(host.querySelector("[data-grid-column-info]")).toBeNull();
    expect(host.querySelectorAll("[data-grid-header-comment-line]")).toHaveLength(2);
  });

  it("sorts transpose field rows from the column-name header", async () => {
    const { host } = mountGrid();
    await settle();
    await openTranspose(host);
    expect(transposeFieldNames(host)).toEqual(["zeta", "alpha"]);
    host.querySelector<HTMLButtonElement>("[data-grid-transpose-column-sort]")!.click();
    await settle();
    expect(transposeFieldNames(host)).toEqual(["alpha", "zeta"]);
  });

  it("toggles descending field-name order from the same header button", async () => {
    const { host } = mountGrid();
    await settle();
    await openTranspose(host);
    const trigger = host.querySelector<HTMLButtonElement>("[data-grid-transpose-column-sort]");
    if (!trigger) throw new Error("Transpose column sort trigger not found");
    trigger.click();
    await settle();
    trigger.click();
    await settle();
    expect(transposeFieldNames(host)).toEqual(["zeta", "alpha"]);
  });

  it("allows resizing and auto-fitting the independent transpose info column", async () => {
    const { host, settingsStore } = mountGrid();
    settingsStore.updateEditorSettings({ dataGridTransposeMetadataInInfoColumn: true });
    await settle();
    await openTranspose(host);

    const handle = host.querySelector<HTMLElement>("[data-grid-transpose-info-resize-handle]");
    expect(handle).not.toBeNull();

    const headerInfoCell = handle!.parentElement as HTMLElement;
    expect(headerInfoCell.style.width).toBe("360px");
    const rowInfoCell = host.querySelector<HTMLElement>("[data-grid-transpose-column-info]");
    expect(rowInfoCell?.style.width).toBe("360px");

    // Drag to widen (+150px)
    handle!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 200 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: 350 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    await settle();

    expect(headerInfoCell.style.width).toBe("510px");
    expect(rowInfoCell?.style.width).toBe("510px");

    // Drag to narrow below min width (should clamp to minTransposeInfoWidth = 120px)
    handle!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: 350 }));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: -100 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    await settle();

    expect(headerInfoCell.style.width).toBe("120px");
    expect(rowInfoCell?.style.width).toBe("120px");

    // Double-click to auto-fit
    handle!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await settle();

    const autoFittedWidth = parseInt(headerInfoCell.style.width, 10);
    expect(autoFittedWidth).toBeGreaterThan(120);
    expect(rowInfoCell?.style.width).toBe(`${autoFittedWidth}px`);
  });

  it("displays column comments and types in transpose view by default and allows toolbar toggling", async () => {
    const { host, settingsStore } = mountGrid();
    await settle();
    await openTranspose(host);

    // Displayed by default without manual configuration
    expect(host.querySelectorAll("[data-grid-transpose-comment-line]")).toHaveLength(2);
    expect(host.querySelectorAll("[data-grid-transpose-type-line]")).toHaveLength(2);
    expect(host.querySelector("[data-grid-transpose-comment-line]")?.textContent).toContain("Display name with a long comment");
    expect(host.querySelector("[data-grid-transpose-type-line]")?.textContent).toContain("varchar");

    // Toggle via toolbar button
    const toggleBtn = host.querySelector<HTMLButtonElement>("[data-grid-transpose-toggle-metadata]");
    expect(toggleBtn).not.toBeNull();
    toggleBtn!.click();
    await settle();

    expect(settingsStore.editorSettings.dataGridShowTransposeFieldMetadata).toBe(false);
    expect(host.querySelectorAll("[data-grid-transpose-comment-line]")).toHaveLength(0);
    expect(host.querySelectorAll("[data-grid-transpose-type-line]")).toHaveLength(0);

    // Toggle back on via toolbar button
    toggleBtn!.click();
    await settle();
    expect(settingsStore.editorSettings.dataGridShowTransposeFieldMetadata).toBe(true);
    expect(host.querySelectorAll("[data-grid-transpose-comment-line]")).toHaveLength(2);
    expect(host.querySelectorAll("[data-grid-transpose-type-line]")).toHaveLength(2);
  });
});

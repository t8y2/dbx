// @vitest-environment happy-dom

import { createApp, defineComponent, h, markRaw, nextTick, type App, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import i18n from "@/i18n";
import { useSettingsStore } from "@/stores/settingsStore";
import type { QueryResult } from "@/types/database";

vi.mock("@/composables/useDataGridColumnResize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/composables/useDataGridColumnResize")>();
  const { ref } = await import("vue");
  return {
    ...actual,
    useDataGridColumnResize: () => ({
      initColumnWidths: vi.fn(),
      onResizeStart: vi.fn(),
      autoFitColumn: vi.fn(),
      renderedColumnWidths: ref([120, 180]),
      totalWidth: ref(300),
      columnVars: ref({ "--total-w": "300px" }),
      getIsResizing: () => false,
    }),
  };
});

import DataGrid from "../DataGrid.vue";

const RecycleScroller = defineComponent({
  props: {
    items: {
      type: Array as PropType<unknown[]>,
      default: () => [],
    },
  },
  setup(props, { attrs, slots }) {
    return () => h("div", attrs, [slots.before?.(), ...props.items.map((item, index) => slots.default?.({ item, index })), slots.after?.()]);
  },
});

const mountedApps: Array<{ app: App; host: HTMLElement }> = [];

function result(): QueryResult {
  return {
    columns: ["id", "notes"],
    rows: [[1, "short value"]],
    affected_rows: 0,
    execution_time_ms: 0,
  };
}

function mountGrid(renderMode: "canvas" | "dom") {
  const pinia = createPinia();
  setActivePinia(pinia);
  useSettingsStore().updateEditorSettings({ dataGridRenderMode: renderMode });
  const gridResult = markRaw(result());

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
                result: gridResult,
                databaseType: "mysql",
                context: "table-data",
                editable: true,
                tableMeta: {
                  tableName: "editing_target",
                  columns: [
                    { name: "id", data_type: "int" },
                    { name: "notes", data_type: "varchar" },
                  ],
                  primaryKeys: ["id"],
                },
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
  mountedApps.push({ app, host });
  return host;
}

async function settle() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function doubleClick(target: HTMLElement, options: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, ...options }));
  await settle();
}

function expandedEditor(host: HTMLElement): HTMLTextAreaElement | null {
  return host.querySelector<HTMLTextAreaElement>('textarea[data-expanded-cell-editor="true"]');
}

afterEach(() => {
  for (const { app, host } of mountedApps.splice(0)) {
    app.unmount();
    host.remove();
  }
  vi.restoreAllMocks();
});

describe("DataGrid expanded cell editing", () => {
  it("opens the expanded editor when a DOM cell is double-clicked", async () => {
    const host = mountGrid("dom");
    await settle();
    const cell = host.querySelector<HTMLElement>('[data-row-index="0"] [data-visible-col-index="1"]');

    expect(cell).not.toBeNull();
    await doubleClick(cell!);

    expect(expandedEditor(host)?.value).toBe("short value");
  });

  it("opens the expanded editor when a Canvas cell is double-clicked", async () => {
    const host = mountGrid("canvas");
    await settle();
    const scroller = host.querySelector<HTMLElement>(".canvas-grid-scroller");
    const eventSurface = scroller?.querySelector<HTMLElement>(":scope > .relative");
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 400, bottom: 120, width: 400, height: 120, toJSON: () => ({}) } as DOMRect;
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue(rect);

    expect(eventSurface).not.toBeNull();
    await doubleClick(eventSurface!, { clientX: 200, clientY: 13 });

    expect(expandedEditor(host)?.value).toBe("short value");
  });

  it("opens the expanded editor when a transposed cell is double-clicked", async () => {
    const host = mountGrid("dom");
    await settle();
    const rowNumber = host.querySelector<HTMLElement>('[data-row-index="0"] .data-grid-row-number');

    expect(rowNumber).not.toBeNull();
    await doubleClick(rowNumber!);
    const cell = host.querySelector<HTMLElement>('.data-grid-transpose-row [title="short value"]');
    expect(cell).not.toBeNull();
    await doubleClick(cell!);

    expect(expandedEditor(host)?.value).toBe("short value");
  });
});

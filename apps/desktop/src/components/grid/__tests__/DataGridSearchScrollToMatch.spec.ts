// @vitest-environment happy-dom
import { createApp, defineComponent, h, markRaw, nextTick, ref, type PropType } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it, vi } from "vitest";

const scrollToPosition = vi.hoisted(() => vi.fn());

// Like the real virtual scroller, only the rows near the top are rendered.
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
      setup(props, { attrs, slots, expose }) {
        expose({ scrollToPosition });
        return () =>
          h(
            "div",
            attrs,
            props.items.slice(0, 20).map((item) => slots.default?.({ item })),
          );
      },
    }),
  };
});

vi.mock("@/lib/backend/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/backend/api")>()),
  saveEditorSettings: vi.fn().mockResolvedValue(undefined),
}));

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

import i18n from "@/i18n";
import type { QueryResult } from "@/types/database";
import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { TooltipProvider } from "@/components/ui/tooltip";

describe("DataGrid search scrolls to an unrendered match (#13981)", () => {
  it("scrolls the DOM grid to a match outside the rendered rows", async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    useSettingsStore().updateEditorSettings({ dataGridRenderMode: "dom", dataGridSearchMode: "highlight" });

    const rows = Array.from({ length: 200 }, (_, index) => [index + 1, index === 150 ? "CSC45410400100" : `CSC${index + 1}`]);
    const result = markRaw<QueryResult>({ columns: ["id", "bl_no"], rows, affected_rows: 0, execution_time_ms: 0 });
    const host = document.createElement("div");
    document.body.append(host);
    const gridRef = ref<any>();
    const app = createApp(
      defineComponent({
        setup: () => () => h(TooltipProvider, { delayDuration: 0 }, { default: () => h(DataGrid, { ref: gridRef, result, databaseType: "dameng", context: "query" }) }),
      }),
    );
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 100));

    gridRef.value?.focusSearch();
    await nextTick();
    const searchInput = host.querySelector<HTMLInputElement>("input[type='search']")!;
    searchInput.value = "CSC45410400100";
    searchInput.dispatchEvent(new Event("input"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await nextTick();

    expect(host.querySelector("[data-grid-search-bar]")?.textContent).toContain("1/1");
    expect(host.querySelector('[data-row-index="150"]')).toBeNull();
    expect(scrollToPosition).toHaveBeenCalled();
    expect(scrollToPosition.mock.lastCall?.[0]).toBeGreaterThan(0);

    app.unmount();
    host.remove();
  });
});

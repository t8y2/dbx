// @vitest-environment happy-dom

import { createApp, defineComponent, h, KeepAlive, markRaw, nextTick, ref } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { QueryResult } from "@/types/database";

vi.mock("@/lib/backend/api", async (original) => ({
  ...(await original<typeof import("@/lib/backend/api")>()),
  loadEditorSettings: vi.fn().mockResolvedValue({}),
  saveEditorSettings: vi.fn().mockResolvedValue(undefined),
}));

import DataGrid from "../DataGrid.vue";
import { useSettingsStore } from "@/stores/settingsStore";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
});

describe("DataGrid cached canvas resources", () => {
  it("releases inactive table bitmaps and repaints the cached table at its previous scroll position", async () => {
    const pixelRatioDescriptor = Object.getOwnPropertyDescriptor(window, "devicePixelRatio")!;
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    cleanups.push(() => Object.defineProperty(window, "devicePixelRatio", pixelRatioDescriptor));
    const fillText = vi.fn();
    const context = new Proxy({ font: "13px sans-serif", fillText, measureText: (text: string) => ({ width: text.length * 7 }) }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    let viewportHeight = 400;
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => viewportHeight);

    const pinia = createPinia();
    setActivePinia(pinia);
    useSettingsStore().updateEditorSettings({ dataGridRenderMode: "canvas" });
    const result = markRaw<QueryResult>({
      columns: ["id", "name"],
      rows: Array.from({ length: 100 }, (_, index) => [index, `item-${index}`]),
      affected_rows: 0,
      execution_time_ms: 1,
    });
    const activeTab = ref("table-a");
    const SqlPage = defineComponent({ render: () => h("div", "SQL page") });
    const host = document.createElement("div");
    document.body.append(host);
    const app = createApp({
      render: () =>
        h(
          TooltipProvider,
          {},
          {
            default: () =>
              h(
                KeepAlive,
                { max: 6 },
                {
                  default: () => (activeTab.value === "sql" ? h(SqlPage, { key: "sql" }) : h(DataGrid, { key: activeTab.value, cacheKey: activeTab.value, result, databaseType: "mysql", context: "table-data" })),
                },
              ),
          },
        ),
    });
    app.use(pinia);
    app.use(i18n);
    app.mount(host);
    cleanups.push(() => {
      app.unmount();
      host.remove();
    });
    const backingPixels = (surfaces: HTMLCanvasElement[]) => surfaces.reduce((total, canvas) => total + canvas.width * canvas.height, 0);
    const surfaces = () => [...host.querySelectorAll<HTMLCanvasElement>(".canvas-grid-surface")];
    const firstTableSurfaces = surfaces();
    await vi.waitFor(() => expect(backingPixels(firstTableSurfaces)).toBeGreaterThan(800 * 400));

    // A resize exercises both physical surfaces, as on a Retina desktop.
    viewportHeight = 450;
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(firstTableSurfaces.every((canvas) => canvas.height >= 800)).toBe(true));
    const scroller = host.querySelector<HTMLElement>(".canvas-grid-scroller")!;
    scroller.scrollTop = 270;
    scroller.dispatchEvent(new Event("scroll"));

    activeTab.value = "table-b";
    await nextTick();
    const secondTableSurfaces = surfaces();
    await vi.waitFor(() => expect(backingPixels(secondTableSurfaces)).toBeGreaterThan(800 * 400));
    activeTab.value = "sql";
    await nextTick();

    expect(backingPixels(firstTableSurfaces)).toBe(0);
    expect(backingPixels(secondTableSurfaces)).toBe(0);

    fillText.mockClear();
    activeTab.value = "table-a";
    await nextTick();
    await vi.waitFor(() => expect(backingPixels(firstTableSurfaces)).toBeGreaterThan(800 * 400));
    expect(host.querySelector(".canvas-grid-scroller")).toBe(scroller);
    expect(scroller.scrollTop).toBe(270);
    await vi.waitFor(() => expect(fillText.mock.calls.some(([text]) => text === "item-10")).toBe(true));
    expect(result.rows).toHaveLength(100);
  });
});

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import QueryChart from "../QueryChart.vue";
import type { QueryResult } from "@/types/database";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/composables/useTheme", () => ({
  useTheme: () => ({ isDark: { value: false } }),
}));

vi.mock("echarts/core", () => ({ use: vi.fn() }));
vi.mock("echarts/renderers", () => ({ CanvasRenderer: {} }));
vi.mock("echarts/charts", () => ({ LineChart: {}, BarChart: {}, PieChart: {} }));
vi.mock("echarts/components", () => ({ GridComponent: {}, LegendComponent: {}, TooltipComponent: {} }));

vi.mock("vue-echarts", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      name: "VChart",
      props: { option: { type: Object, default: () => ({}) } },
      setup: (props) => () => h("div", { "data-chart-option": JSON.stringify(props.option) }),
    }),
  };
});

function createQueryResult(): QueryResult {
  return {
    columns: ["item", "amount"],
    rows: [
      ["A", 100],
      ["B", 200],
    ],
    affected_rows: 2,
    execution_time_ms: 5,
  };
}

describe("QueryChart", () => {
  let app: App | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (app) {
      app.unmount();
      app = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
    localStorage.clear();
  });

  it("renders showLabels toggle button and updates chart option on click", async () => {
    app = createApp(QueryChart, { result: createQueryResult() });
    app.mount(container!);
    await nextTick();

    const btn = container!.querySelector('[data-testid="query-chart-show-labels-btn"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain("chart.showLabels");

    const vchart = container!.querySelector("[data-chart-option]") as HTMLDivElement;
    let option = JSON.parse(vchart.getAttribute("data-chart-option") || "{}");
    expect(option.series[0].label.show).toBe(false);

    btn.click();
    await nextTick();

    expect(localStorage.getItem("dbx-query-chart-show-labels")).toBe("true");
    option = JSON.parse(vchart.getAttribute("data-chart-option") || "{}");
    expect(option.series[0].label.show).toBe(true);
    expect(option.series[0].label.position).toBe("top");

    btn.click();
    await nextTick();

    expect(localStorage.getItem("dbx-query-chart-show-labels")).toBe("false");
    option = JSON.parse(vchart.getAttribute("data-chart-option") || "{}");
    expect(option.series[0].label.show).toBe(false);
  });

  it("initializes showLabels from localStorage if previously enabled", async () => {
    localStorage.setItem("dbx-query-chart-show-labels", "true");

    app = createApp(QueryChart, { result: createQueryResult() });
    app.mount(container!);
    await nextTick();

    const vchart = container!.querySelector("[data-chart-option]") as HTMLDivElement;
    const option = JSON.parse(vchart.getAttribute("data-chart-option") || "{}");
    expect(option.series[0].label.show).toBe(true);
  });
});

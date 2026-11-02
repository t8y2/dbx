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

  it("renders check indicators for selected y columns and updates chart option on toggle", async () => {
    const multiResult: QueryResult = {
      columns: ["item", "val1", "val2"],
      rows: [
        ["A", 10, 20],
        ["B", 30, 40],
      ],
      affected_rows: 2,
      execution_time_ms: 1,
    };
    app = createApp(QueryChart, { result: multiResult });
    app.mount(container!);
    await nextTick();

    const trigger = container!.querySelector(".max-w-48") as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    trigger.click();
    await nextTick();

    const items = document.querySelectorAll('[role="menuitemcheckbox"]');
    expect(items.length).toBe(2);

    // Initial state: first numeric column (val1) is selected, second (val2) is not
    expect(items[0].getAttribute("aria-checked")).toBe("true");
    expect(items[0].querySelector("svg")).not.toBeNull();
    expect(items[1].getAttribute("aria-checked")).toBe("false");
    expect(items[1].querySelector("svg")).toBeNull();

    const vchart = container!.querySelector("[data-chart-option]") as HTMLDivElement;
    let option = JSON.parse(vchart.getAttribute("data-chart-option") || "{}");
    expect(option.series.map((s: { name: string }) => s.name)).toEqual(["val1"]);

    // Click on item 1 (val2) to select it
    (items[1] as HTMLElement).click();
    await nextTick();

    expect(items[0].getAttribute("aria-checked")).toBe("true");
    expect(items[0].querySelector("svg")).not.toBeNull();
    expect(items[1].getAttribute("aria-checked")).toBe("true");
    expect(items[1].querySelector("svg")).not.toBeNull();

    option = JSON.parse(vchart.getAttribute("data-chart-option") || "{}");
    expect(option.series.map((s: { name: string }) => s.name)).toEqual(["val1", "val2"]);

    // Click on item 0 (val1) to deselect it
    (items[0] as HTMLElement).click();
    await nextTick();

    expect(items[0].getAttribute("aria-checked")).toBe("false");
    expect(items[0].querySelector("svg")).toBeNull();
    expect(items[1].getAttribute("aria-checked")).toBe("true");
    expect(items[1].querySelector("svg")).not.toBeNull();

    option = JSON.parse(vchart.getAttribute("data-chart-option") || "{}");
    expect(option.series.map((s: { name: string }) => s.name)).toEqual(["val2"]);
  });
});

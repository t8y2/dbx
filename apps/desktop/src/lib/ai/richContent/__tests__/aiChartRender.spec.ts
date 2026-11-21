/**
 * Render smoke test: every chart type the protocol accepts must actually render
 * with the ECharts modules the renderer registers.
 *
 * This is the guard against the failure mode that motivates
 * `aiChartEchartsModules.ts`: the option layer and the renderer can drift apart
 * silently. `MarkLineComponent` missing draws nothing (no warning at all), and a
 * cartesian heatmap without a `visualMap` throws only at render time — both are
 * invisible to a unit test that only inspects the option object.
 *
 * Rendering runs in ECharts' SSR mode with the SVG renderer, so no canvas is
 * needed and the test works under happy-dom.
 */
import { describe, expect, it } from "vitest";
import * as echarts from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { AI_CHART_ECHARTS_MODULES } from "@/lib/ai/richContent/aiChartEchartsModules";
import { buildAiChartOption } from "@/lib/ai/richContent/aiChartOption";
import { parseAiChartSpec, type AiChartSpec } from "@/lib/ai/richContent/aiChartSpec";

// The renderer's own list, plus the SVG renderer (the renderer component uses
// CanvasRenderer; SSR has no canvas). Registering both is uncontroversial —
// `use` is additive.
echarts.use([...AI_CHART_ECHARTS_MODULES, SVGRenderer]);

function specOf(json: unknown): AiChartSpec {
  const result = parseAiChartSpec(typeof json === "string" ? json : JSON.stringify(json));
  if (!result.ok) throw new Error(`unexpected parse failure: ${result.reason}`);
  return result.spec;
}

function renderSvg(spec: AiChartSpec): string {
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 480, height: 320 });
  try {
    chart.setOption(buildAiChartOption(spec, { isDark: false }));
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

const CASES: [string, unknown][] = [
  [
    "line with area, step, stack and markLine",
    {
      version: 1,
      type: "line",
      area: true,
      step: "middle",
      stack: "total",
      marks: [{ name: "target", value: 180 }],
      xAxis: { values: ["Jan", "Feb", "Mar"] },
      series: [
        { name: "a", data: [120, 200, 150] },
        { name: "b", data: [60, 90, 70] },
      ],
    },
  ],
  ["bar", { version: 1, type: "bar", xAxis: { values: ["Jan", "Feb"] }, series: [{ name: "s", data: [1, 2] }] }],
  ["pictorialBar", { version: 1, type: "pictorialBar", xAxis: { values: ["a", "b"] }, series: [{ name: "s", data: [3, 1] }] }],
  [
    "pie",
    {
      version: 1,
      type: "pie",
      data: [
        { name: "A", value: 40 },
        { name: "B", value: 60 },
      ],
    },
  ],
  [
    "funnel",
    {
      version: 1,
      type: "funnel",
      data: [
        { name: "visit", value: 100 },
        { name: "cart", value: 40 },
      ],
    },
  ],
  [
    "scatter",
    {
      version: 1,
      type: "scatter",
      xAxis: { label: "requests" },
      yAxis: { label: "latency" },
      series: [
        {
          name: "endpoint",
          data: [
            [10, 20],
            [30, 45, 7],
          ],
        },
      ],
    },
  ],
  [
    "heatmap",
    {
      version: 1,
      type: "heatmap",
      xAxis: { values: ["Mon", "Tue"] },
      yAxis: { values: ["9am", "5pm"] },
      data: [
        { x: "Mon", y: "9am", value: 12 },
        { x: "Tue", y: "5pm", value: 30 },
        { x: "Tue", y: "9am", value: 3 },
      ],
    },
  ],
];

describe("AI chart render smoke test", () => {
  for (const [name, json] of CASES) {
    it(`renders ${name} without throwing`, () => {
      const svg = renderSvg(specOf(json));
      expect(svg).toContain("<svg");
      // A chart that silently rendered nothing still produces an <svg> wrapper,
      // so assert on actual drawn content instead.
      expect(svg.length).toBeGreaterThan(1_000);
    });
  }

  it("draws the reference line for a spec with marks", () => {
    const withoutMarks = renderSvg(specOf({ version: 1, type: "bar", xAxis: { values: ["a", "b"] }, series: [{ name: "s", data: [1, 2] }] }));
    const withMarks = renderSvg(
      specOf({
        version: 1,
        type: "bar",
        marks: [{ name: "target", value: 1.5 }],
        xAxis: { values: ["a", "b"] },
        series: [{ name: "s", data: [1, 2] }],
      }),
    );
    // markLine adds path/label markup, so the output must grow.
    expect(withMarks.length).toBeGreaterThan(withoutMarks.length);
    expect(withMarks).toContain("target");
  });

  it("still draws a reference line that lies outside the series extent", () => {
    // ECharts drops a markLine whose value is outside the axis range, and the
    // axis range comes from the series data unless it is widened. A "target"
    // above every bar is the normal case for a goal line, so it must be drawn.
    const above = renderSvg(
      specOf({
        version: 1,
        type: "bar",
        marks: [{ name: "goal", value: 400 }],
        xAxis: { values: ["a", "b"] },
        series: [{ name: "s", data: [1, 2] }],
      }),
    );
    expect(above).toContain("goal");

    const below = renderSvg(
      specOf({
        version: 1,
        type: "bar",
        marks: [{ name: "floor", value: -9 }],
        xAxis: { values: ["a", "b"] },
        series: [{ name: "s", data: [1, 2] }],
      }),
    );
    expect(below).toContain("floor");
  });

  it("keeps the heatmap visualMap labels clear of the category labels", () => {
    // The visualMap bar is positioned from the canvas bottom and draws its
    // min/max beside it; the grid must reserve a band tall enough for both.
    const svg = renderSvg(
      specOf({
        version: 1,
        type: "heatmap",
        xAxis: { values: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], label: "Day" },
        yAxis: { values: ["0am", "6am", "12pm", "6pm"], label: "Hour" },
        data: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day, i) => ({
          x: day,
          y: ["0am", "6am", "12pm", "6pm"][i % 4],
          value: i + 1,
        })),
      }),
    );
    const labels = [...svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)].map((match) => {
      const translate = match[1].match(/translate\(([-\d.]+) ([-\d.]+)\)/);
      const ownY = match[1].match(/(?:^| )y="([-\d.]+)"/);
      return { text: match[2], y: Number(translate?.[2] ?? 0) + Number(ownY?.[1] ?? 0) };
    });
    const categoryLabels = labels.filter((label) => ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].includes(label.text));
    // The visualMap prints its `min` / `max` ("1" and "7") on the same row.
    const valueLabels = labels.filter((label) => label.text === "1" || label.text === "7");
    expect(categoryLabels.length).toBeGreaterThan(0);
    expect(valueLabels).toHaveLength(2);
    const categoryRow = categoryLabels[0].y;
    for (const valueLabel of valueLabels) expect(Math.abs(valueLabel.y - categoryRow)).toBeGreaterThanOrEqual(12);
  });

  it("keeps the markLine label clear of the chart title", () => {
    // The reference-line label is anchored at the grid's top edge, which is the
    // same row the title occupies. Without the extra grid top they collide
    // (measured: title y=27, label y=29 on a 480px canvas).
    const svg = renderSvg(
      specOf({
        version: 1,
        type: "bar",
        title: "Monthly recurring revenue",
        marks: [{ name: "quarterly target", value: 200 }],
        xAxis: { values: ["a", "b"] },
        series: [{ name: "s", data: [1, 2] }],
      }),
    );
    const rows = [...svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)].map((match) => {
      const translate = match[1].match(/translate\(([-\d.]+) ([-\d.]+)\)/);
      const ownY = match[1].match(/(?:^| )y="([-\d.]+)"/);
      return { text: match[2], y: Number(translate?.[2] ?? 0) + Number(ownY?.[1] ?? 0) };
    });
    const titleRow = rows.find((row) => row.text === "Monthly recurring revenue");
    const markRow = rows.find((row) => row.text.includes("quarterly target"));
    expect(titleRow).toBeDefined();
    expect(markRow).toBeDefined();
    expect(Math.abs(markRow!.y - titleRow!.y)).toBeGreaterThanOrEqual(12);
  });

  it("renders a heatmap only because a visualMap is registered", () => {
    // Pinned deliberately: without a visualMap the heatmap view throws
    // "Heatmap must use with visualMap" — i.e. removing
    // VisualMapContinuousComponent from the module list breaks this test.
    const svg = renderSvg(
      specOf({
        version: 1,
        type: "heatmap",
        xAxis: { values: ["a", "b"] },
        yAxis: { values: ["c", "d"] },
        data: [{ x: "a", y: "c", value: 1 }],
      }),
    );
    expect(svg).toContain("<svg");
  });
});

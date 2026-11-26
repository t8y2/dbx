import { describe, expect, it } from "vitest";
import { buildAiChartOption, type AiChartTheme } from "@/lib/ai/richContent/aiChartOption";
import { parseAiChartSpec, type AiChartSpec } from "@/lib/ai/richContent/aiChartSpec";

const light: AiChartTheme = { isDark: false };
const dark: AiChartTheme = { isDark: true };

function specOf(json: unknown): AiChartSpec {
  const result = parseAiChartSpec(typeof json === "string" ? json : JSON.stringify(json));
  if (!result.ok) throw new Error(`unexpected parse failure: ${result.reason}`);
  return result.spec;
}

const lineBar = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  type: "line",
  xAxis: { values: ["Jan", "Feb", "Mar"] },
  series: [{ name: "Revenue", data: [120, 200, 150] }],
  ...overrides,
});

describe("cartesian option extras", () => {
  it("maps area:true to areaStyle on a line series", () => {
    const option = buildAiChartOption(specOf(lineBar({ area: true })), light);
    if (!Array.isArray(option.series)) throw new Error("expected a series array");
    expect(option.series[0]).toMatchObject({ type: "line", areaStyle: {} });
  });

  it("omits areaStyle when the spec has no area", () => {
    const option = buildAiChartOption(specOf(lineBar()), light);
    if (!Array.isArray(option.series)) throw new Error("expected a series array");
    expect(option.series[0]).not.toHaveProperty("areaStyle");
  });

  it("maps step to the series step field and turns smoothing off", () => {
    const option = buildAiChartOption(specOf(lineBar({ step: "middle" })), light);
    if (!Array.isArray(option.series)) throw new Error("expected a series array");
    // ECharts applies `smooth` to the stair geometry itself, which would round
    // every step corner away — a step line must stay piecewise-linear.
    expect(option.series[0]).toMatchObject({ step: "middle", smooth: false });
  });

  it("keeps smoothing on a plain line series", () => {
    const option = buildAiChartOption(specOf(lineBar({ type: "line" })), light);
    if (!Array.isArray(option.series)) throw new Error("expected a series array");
    expect(option.series[0]).toMatchObject({ smooth: true });
  });

  it("gives every series the same stack id", () => {
    const option = buildAiChartOption(
      specOf(
        lineBar({
          stack: "total",
          series: [
            { name: "a", data: [1, 2, 3] },
            { name: "b", data: [4, 5, 6] },
          ],
        }),
      ),
      light,
    );
    if (!Array.isArray(option.series)) throw new Error("expected a series array");
    expect(option.series.map((series) => (series as { stack?: string }).stack)).toEqual(["total", "total"]);
  });

  it("emits markLine with `yAxis` (never `value`) on a dedicated legend-excluded series", () => {
    // `{ name, value }` makes ECharts 6 log "Invalid markLine data." and then
    // throw, in dev AND production — the shape is pinned here on purpose.
    const option = buildAiChartOption(
      specOf(
        lineBar({
          marks: [{ name: "target", value: 180 }],
          series: [
            { name: "a", data: [1, 2, 3] },
            { name: "b", data: [4, 5, 6] },
          ],
        }),
      ),
      light,
    );
    if (!Array.isArray(option.series)) throw new Error("expected a series array");
    // Business series carry no markLine: a legend toggle hides a series and its
    // markLine together, so the reference line needs a lifetime of its own.
    expect(option.series[0]).not.toHaveProperty("markLine");
    expect(option.series[1]).not.toHaveProperty("markLine");
    const marks = option.series[2] as { name: string; data: unknown[]; markLine: { data: unknown[] } };
    expect(marks.data).toEqual([]);
    expect(marks.markLine.data).toEqual([{ name: "target", yAxis: 180 }]);
    // The marks series gets no legend entry, which requires the legend to list
    // the business series explicitly (an unlisted series is not collected).
    expect(option.legend).toMatchObject({ data: ["a", "b"] });
    expect((option.legend as { data: string[] }).data).not.toContain(marks.name);
  });

  it("gives the marks series a name no business series can collide with", () => {
    const option = buildAiChartOption(
      specOf(
        lineBar({
          marks: [{ value: 1 }],
          series: [{ name: "__marks__", data: [1, 2, 3] }],
        }),
      ),
      light,
    );
    if (!Array.isArray(option.series)) throw new Error("expected a series array");
    const names = option.series.map((series) => (series as { name: string }).name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("maps pictorialBar to a pictorialBar series with a symbol", () => {
    const option = buildAiChartOption(specOf(lineBar({ type: "pictorialBar", symbol: "rect" })), light);
    if (!Array.isArray(option.series)) throw new Error("expected a series array");
    expect(option.series[0]).toMatchObject({ type: "pictorialBar", symbol: "rect", data: [120, 200, 150] });
    expect(option.series[0]).not.toHaveProperty("smooth");
  });

  it("defaults the pictorial symbol to circle", () => {
    const option = buildAiChartOption(specOf(lineBar({ type: "pictorialBar" })), light);
    if (!Array.isArray(option.series)) throw new Error("expected a series array");
    expect(option.series[0]).toMatchObject({ symbol: "circle" });
  });
});

describe("scatter option", () => {
  const scatter = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    type: "scatter",
    series: [
      {
        name: "endpoint",
        data: [
          [10, 20],
          [30, 45, 7],
        ],
      },
    ],
    ...overrides,
  });

  it("uses value axes on both sides with labels", () => {
    const option = buildAiChartOption(specOf(scatter({ xAxis: { label: "requests" }, yAxis: { label: "latency" } })), light);
    expect(option.xAxis).toMatchObject({ type: "value", name: "requests" });
    expect(option.yAxis).toMatchObject({ type: "value", name: "latency" });
  });

  it("emits points as item objects carrying symbolSize", () => {
    const option = buildAiChartOption(specOf(scatter()), light);
    if (!Array.isArray(option.series)) throw new Error("expected a series array");
    expect(option.series[0]).toMatchObject({
      type: "scatter",
      data: [{ value: [10, 20] }, { value: [30, 45, 7], symbolSize: 7 }],
    });
  });

  it("carries an item name into the point object", () => {
    const option = buildAiChartOption(specOf(scatter({ series: [{ name: "s", data: [{ name: "A", value: [1, 2] }] }] })), light);
    if (!Array.isArray(option.series)) throw new Error("expected a series array");
    expect(option.series[0]).toMatchObject({ data: [{ value: [1, 2], name: "A" }] });
  });
});

describe("heatmap option", () => {
  const heatmap = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    type: "heatmap",
    xAxis: { values: ["Mon", "Tue"] },
    yAxis: { values: ["9am", "5pm"] },
    data: [
      { x: "Mon", y: "9am", value: 12 },
      { x: "Tue", y: "5pm", value: 30 },
    ],
    ...overrides,
  });

  it("uses two category axes with boundaryGap (required or ECharts renders garbage in prod)", () => {
    const option = buildAiChartOption(specOf(heatmap()), light);
    expect(option.xAxis).toMatchObject({ type: "category", data: ["Mon", "Tue"], boundaryGap: true });
    expect(option.yAxis).toMatchObject({ type: "category", data: ["9am", "5pm"], boundaryGap: true });
  });

  it("always emits a visualMap with data-derived min/max (never the 0/200 default)", () => {
    const option = buildAiChartOption(specOf(heatmap()), light);
    expect(option.visualMap).toMatchObject({ min: 12, max: 30, inRange: { color: expect.any(Array) } });
  });

  it("converts long-form cells to [xIndex, yIndex, value]", () => {
    const option = buildAiChartOption(specOf(heatmap()), light);
    if (!Array.isArray(option.series)) throw new Error("expected a series array");
    expect(option.series[0]).toMatchObject({
      type: "heatmap",
      data: [
        [0, 0, 12],
        [1, 1, 30],
      ],
    });
  });

  it("centres a flat dataset on the ramp instead of pinning it to one end", () => {
    const flat = buildAiChartOption(specOf(heatmap({ data: [{ x: "Mon", y: "9am", value: 5 }] })), light);
    expect(flat.visualMap).toMatchObject({ min: 4.5, max: 5.5 });
  });

  it("uses a different colour ramp per theme", () => {
    const lightRamp = buildAiChartOption(specOf(heatmap()), light).visualMap as { inRange: { color: string[] } };
    const darkRamp = buildAiChartOption(specOf(heatmap()), dark).visualMap as { inRange: { color: string[] } };
    expect(lightRamp.inRange.color).not.toEqual(darkRamp.inRange.color);
  });
});

describe("funnel option", () => {
  it("emits a vertical funnel that keeps the input stage order", () => {
    const option = buildAiChartOption(
      specOf({
        version: 1,
        type: "funnel",
        data: [
          { name: "visit", value: 100 },
          { name: "cart", value: 40 },
        ],
      }),
      light,
    );
    if (!Array.isArray(option.series)) throw new Error("expected a series array");
    // 'none' (not ECharts' default 'descending'): the stages are listed in
    // process order and a non-monotonic value sequence must not reshuffle them.
    expect(option.series[0]).toMatchObject({
      type: "funnel",
      sort: "none",
      data: [
        { name: "visit", value: 100 },
        { name: "cart", value: 40 },
      ],
    });
    expect(option.tooltip).toMatchObject({ trigger: "item" });
  });

  it("still builds a pie option for type pie", () => {
    const option = buildAiChartOption(specOf({ version: 1, type: "pie", data: [{ name: "A", value: 1 }] }), light);
    if (!Array.isArray(option.series)) throw new Error("expected a series array");
    expect(option.series[0]).toMatchObject({ type: "pie", radius: ["30%", "60%"] });
  });
});

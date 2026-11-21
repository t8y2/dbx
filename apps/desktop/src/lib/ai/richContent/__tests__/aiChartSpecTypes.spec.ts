import { describe, expect, it } from "vitest";
import { AI_CHART_MAX_FUNNEL_ENTRIES, AI_CHART_MAX_HEATMAP_AXIS_CATEGORIES, AI_CHART_MAX_HEATMAP_CELLS, AI_CHART_MAX_HEATMAP_GRID, AI_CHART_MAX_MARKS, AI_CHART_MAX_SCATTER_SYMBOL_SIZE, AI_CHART_MAX_SYMBOL_PATH_LENGTH, parseAiChartSpec } from "@/lib/ai/richContent/aiChartSpec";

function parsed(json: unknown) {
  const result = parseAiChartSpec(typeof json === "string" ? json : JSON.stringify(json));
  if (!result.ok) throw new Error(`unexpected parse failure: ${result.reason}`);
  return result.spec;
}

function reasonOf(json: unknown): string {
  const result = parseAiChartSpec(typeof json === "string" ? json : JSON.stringify(json));
  if (result.ok) throw new Error("expected a rejection");
  return result.reason;
}

const lineBar = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  type: "bar",
  xAxis: { values: ["Jan", "Feb", "Mar"] },
  series: [{ name: "Revenue", data: [120, 200, 150] }],
  ...overrides,
});

describe("cartesian extras: area / step / stack / marks", () => {
  it("accepts a plain line chart with no extras", () => {
    const spec = parsed(lineBar({ type: "line" }));
    expect(spec.type).toBe("line");
    if (spec.type !== "line") return;
    expect(spec.area).toBeUndefined();
    expect(spec.step).toBeUndefined();
    expect(spec.stack).toBeUndefined();
    expect(spec.marks).toBeUndefined();
  });

  it("carries area: true and step through to the normalized spec", () => {
    const spec = parsed(lineBar({ type: "line", area: true, step: "middle" }));
    if (spec.type !== "line") throw new Error("expected a line spec");
    expect(spec.area).toBe(true);
    expect(spec.step).toBe("middle");
  });

  it("accepts every documented step value", () => {
    for (const step of ["start", "middle", "end"] as const) {
      const spec = parsed(lineBar({ type: "line", step }));
      if (spec.type !== "line") throw new Error("expected a line spec");
      expect(spec.step).toBe(step);
    }
  });

  it("rejects area on a bar chart instead of silently ignoring it", () => {
    expect(reasonOf(lineBar({ area: true }))).toContain("area is only supported on line charts");
  });

  it("rejects step on a bar chart instead of silently ignoring it", () => {
    expect(reasonOf(lineBar({ step: "start" }))).toContain("step is only supported on line charts");
  });

  it("rejects a non-boolean area and an unknown step value", () => {
    expect(reasonOf(lineBar({ type: "line", area: "yes" }))).toContain("area must be a boolean");
    expect(reasonOf(lineBar({ type: "line", step: "diagonal" }))).toContain("step must be one of");
  });

  it("carries a stack id through to the spec", () => {
    const spec = parsed(lineBar({ stack: "total" }));
    expect(spec.stack).toBe("total");
  });

  it("rejects an empty or non-string stack", () => {
    expect(reasonOf(lineBar({ stack: "" }))).toContain("stack must be a non-empty string");
    expect(reasonOf(lineBar({ stack: 3 }))).toContain("stack must be a non-empty string");
  });

  it("carries horizontal reference lines through to the spec", () => {
    const spec = parsed(lineBar({ marks: [{ name: "target", value: 180 }, { value: 100 }] }));
    expect(spec.marks).toEqual([{ name: "target", value: 180 }, { value: 100 }]);
  });

  it("coerces a numeric string mark value and rejects a non-finite one", () => {
    expect(parsed(lineBar({ marks: [{ value: "180" }] })).marks).toEqual([{ value: 180 }]);
    expect(reasonOf(lineBar({ marks: [{ value: "NaN" }] }))).toContain("must be a finite number");
  });

  it("rejects an empty, oversized, or non-object marks payload", () => {
    expect(reasonOf(lineBar({ marks: [] }))).toContain("must not be empty");
    expect(reasonOf(lineBar({ marks: "target" }))).toContain("must be an array");
    expect(reasonOf(lineBar({ marks: Array.from({ length: AI_CHART_MAX_MARKS + 1 }, () => ({ value: 1 })) }))).toContain(`exceeds ${AI_CHART_MAX_MARKS} marks`);
    expect(reasonOf(lineBar({ marks: [1] }))).toContain("must be an object");
  });
});

describe("pictorialBar", () => {
  it("accepts the bar payload and an optional symbol", () => {
    const spec = parsed(lineBar({ type: "pictorialBar", symbol: "rect" }));
    expect(spec.type).toBe("pictorialBar");
    if (spec.type !== "pictorialBar") return;
    expect(spec.symbol).toBe("rect");
    expect(spec.series[0].data).toEqual([120, 200, 150]);
  });

  it("shares the bar validation (series length must match the category axis)", () => {
    expect(reasonOf(lineBar({ type: "pictorialBar", series: [{ name: "s", data: [1] }] }))).toContain("length does not match");
  });

  it("rejects the line-only fields instead of silently dropping them", () => {
    // pictorialBar shares bar's payload, so the bar rule applies: a field that
    // cannot take effect is rejected with a reason rather than ignored.
    expect(reasonOf(lineBar({ type: "pictorialBar", area: true }))).toContain("area is only supported on line charts");
    expect(reasonOf(lineBar({ type: "pictorialBar", step: "start" }))).toContain("step is only supported on line charts");
    const spec = parsed(lineBar({ type: "pictorialBar" }));
    expect(spec).not.toHaveProperty("area");
    expect(spec).not.toHaveProperty("step");
  });

  it("rejects a non-string symbol", () => {
    expect(reasonOf(lineBar({ type: "pictorialBar", symbol: 42 }))).toContain("symbol must be a non-empty string");
  });

  it("accepts built-in symbol names and inline path data", () => {
    for (const symbol of ["circle", "rect", "roundRect", "square", "line", "diamond", "pin", "arrow", "triangle", "none"]) {
      const spec = parsed(lineBar({ type: "pictorialBar", symbol }));
      if (spec.type !== "pictorialBar") throw new Error("expected a pictorialBar spec");
      expect(spec.symbol).toBe(symbol);
    }
    const path = parsed(lineBar({ type: "pictorialBar", symbol: "path://M0,10L10,10L5,0Z" }));
    if (path.type !== "pictorialBar") throw new Error("expected a pictorialBar spec");
    expect(path.symbol).toBe("path://M0,10L10,10L5,0Z");
  });

  it("rejects image:// and bare URLs (they would make the chart fetch a remote resource)", () => {
    // ECharts assigns an `image://` symbol to `Image.src`, i.e. a real outbound
    // request. The chart block must stay pure data, so the scheme is refused.
    expect(reasonOf(lineBar({ type: "pictorialBar", symbol: "image://https://attacker.example/p.gif?leak=1" }))).toContain("built-in name or path://");
    expect(reasonOf(lineBar({ type: "pictorialBar", symbol: "https://attacker.example/p.gif" }))).toContain("built-in name or path://");
    expect(reasonOf(lineBar({ type: "pictorialBar", symbol: "bogusShape" }))).toContain("built-in name or path://");
  });

  it("rejects an over-long path:// definition", () => {
    const longPath = `path://M0,0${"L1,1".repeat(AI_CHART_MAX_SYMBOL_PATH_LENGTH)}`;
    expect(reasonOf(lineBar({ type: "pictorialBar", symbol: longPath }))).toContain(`${AI_CHART_MAX_SYMBOL_PATH_LENGTH} characters`);
  });
});

describe("scatter", () => {
  const scatter = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    type: "scatter",
    series: [
      {
        name: "endpoint",
        data: [
          [10, 20],
          [30, 45],
        ],
      },
    ],
    ...overrides,
  });

  it("normalizes tuple points into { x, y }", () => {
    const spec = parsed(scatter());
    if (spec.type !== "scatter") throw new Error("expected a scatter spec");
    expect(spec.series[0].data).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 45 },
    ]);
  });

  it("accepts a third tuple element as the bubble size and allows 2/3 mixing", () => {
    const spec = parsed(
      scatter({
        series: [
          {
            name: "s",
            data: [
              [10, 20],
              [30, 45, 7],
            ],
          },
        ],
      }),
    );
    if (spec.type !== "scatter") throw new Error("expected a scatter spec");
    expect(spec.series[0].data).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 45, size: 7 },
    ]);
  });

  it("accepts named object points and carries name/size", () => {
    const spec = parsed(scatter({ series: [{ name: "s", data: [{ name: "A", value: [1, 2], size: 4 }] }] }));
    if (spec.type !== "scatter") throw new Error("expected a scatter spec");
    expect(spec.series[0].data).toEqual([{ name: "A", x: 1, y: 2, size: 4 }]);
  });

  it("rejects mixing array and object points inside one series", () => {
    expect(reasonOf(scatter({ series: [{ name: "s", data: [[1, 2], { value: [3, 4] }] }] }))).toContain("mixes array and object points");
  });

  it("rejects a tuple with the wrong arity or a non-finite coordinate", () => {
    expect(reasonOf(scatter({ series: [{ name: "s", data: [[1]] }] }))).toContain("[x, y] or [x, y, size]");
    expect(reasonOf(scatter({ series: [{ name: "s", data: [[1, 2, 3, 4]] }] }))).toContain("[x, y] or [x, y, size]");
    expect(reasonOf(scatter({ series: [{ name: "s", data: [["NaN", 2]] }] }))).toContain("finite numeric x and y");
  });

  it("rejects a negative size", () => {
    expect(reasonOf(scatter({ series: [{ name: "s", data: [[1, 2, -3]] }] }))).toContain("non-negative");
  });

  it("caps the bubble size so the symbol scale cannot run away", () => {
    // An unbounded size renders a 5e8x scale matrix (measured with size: 1e9).
    expect(reasonOf(scatter({ series: [{ name: "s", data: [[1, 2, AI_CHART_MAX_SCATTER_SYMBOL_SIZE + 1]] }] }))).toContain(`up to ${AI_CHART_MAX_SCATTER_SYMBOL_SIZE}`);
    expect(reasonOf(scatter({ series: [{ name: "s", data: [{ value: [1, 2], size: AI_CHART_MAX_SCATTER_SYMBOL_SIZE + 1 }] }] }))).toContain(`up to ${AI_CHART_MAX_SCATTER_SYMBOL_SIZE}`);
    // The cap itself is allowed, and an unsized point keeps the default.
    expect(
      parsed(
        scatter({
          series: [
            {
              name: "s",
              data: [
                [1, 2, AI_CHART_MAX_SCATTER_SYMBOL_SIZE],
                [3, 4],
              ],
            },
          ],
        }),
      ).type,
    ).toBe("scatter");
  });

  it("keeps axis labels and rejects an axis category list", () => {
    const spec = parsed(scatter({ xAxis: { label: "requests" }, yAxis: { label: "latency" } }));
    if (spec.type !== "scatter") throw new Error("expected a scatter spec");
    expect(spec.xAxis).toEqual({ label: "requests" });
    expect(spec.yAxis).toEqual({ label: "latency" });
    expect(reasonOf(scatter({ xAxis: { values: ["a"] } }))).toContain("not supported on a scatter");
  });

  it("rejects an empty data array and an empty series array", () => {
    expect(reasonOf(scatter({ series: [] }))).toContain("non-empty series array");
    expect(reasonOf(scatter({ series: [{ name: "s", data: [] }] }))).toContain("non-empty array");
  });
});

describe("heatmap", () => {
  const heatmap = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    type: "heatmap",
    xAxis: { values: ["Mon", "Tue"] },
    yAxis: { values: ["9am", "5pm"] },
    data: [{ x: "Mon", y: "9am", value: 12 }],
    ...overrides,
  });

  it("accepts long-form cells and preserves the category vocabularies", () => {
    const spec = parsed(heatmap());
    if (spec.type !== "heatmap") throw new Error("expected a heatmap spec");
    expect(spec.xAxis.values).toEqual(["Mon", "Tue"]);
    expect(spec.yAxis.values).toEqual(["9am", "5pm"]);
    expect(spec.data).toEqual([{ x: "Mon", y: "9am", value: 12 }]);
  });

  it("matches categories through the same string projection ECharts uses (1 == '1')", () => {
    const spec = parsed(heatmap({ xAxis: { values: [1, 2] }, data: [{ x: "1", y: "9am", value: 5 }] }));
    if (spec.type !== "heatmap") throw new Error("expected a heatmap spec");
    expect(spec.data[0]).toEqual({ x: "1", y: "9am", value: 5 });
  });

  it("rejects a cell whose x or y is not in the axis vocabulary", () => {
    expect(reasonOf(heatmap({ data: [{ x: "Wed", y: "9am", value: 1 }] }))).toContain('"Wed" is not in xAxis.values');
    expect(reasonOf(heatmap({ data: [{ x: "Mon", y: "1am", value: 1 }] }))).toContain('"1am" is not in yAxis.values');
  });

  it("rejects duplicate axis categories (they would collapse rows silently)", () => {
    expect(reasonOf(heatmap({ xAxis: { values: ["Mon", "Mon"] } }))).toContain("duplicate category");
  });

  it("rejects two rows for the same cell instead of letting one win by paint order", () => {
    const duplicated = heatmap({
      data: [
        { x: "Mon", y: "9am", value: 1 },
        { x: "Mon", y: "9am", value: 2 },
      ],
    });
    expect(reasonOf(duplicated)).toContain("repeats the cell");
  });

  it("rejects a non-finite cell value", () => {
    expect(reasonOf(heatmap({ data: [{ x: "Mon", y: "9am", value: "Infinity" }] }))).toContain("must be a finite number");
  });

  it("rejects a missing axis object and an empty cell array", () => {
    expect(reasonOf({ version: 1, type: "heatmap", yAxis: { values: ["a"] }, data: [{ x: "a", y: "a", value: 1 }] })).toContain("requires a xAxis object");
    expect(reasonOf(heatmap({ data: [] }))).toContain("non-empty data array");
  });

  it("enforces the axis vocabulary, cell, and grid budgets", () => {
    const tooManyCategories = Array.from({ length: AI_CHART_MAX_HEATMAP_AXIS_CATEGORIES + 1 }, (_, i) => `c${i}`);
    expect(reasonOf(heatmap({ xAxis: { values: tooManyCategories } }))).toContain(`${AI_CHART_MAX_HEATMAP_AXIS_CATEGORIES} categories`);

    const manyCells = Array.from({ length: AI_CHART_MAX_HEATMAP_CELLS + 1 }, () => ({ x: "Mon", y: "9am", value: 1 }));
    expect(reasonOf(heatmap({ data: manyCells }))).toContain(`${AI_CHART_MAX_HEATMAP_CELLS} cells`);

    // A sparse grid: 70 x 70 categories is under both per-axis caps but its
    // Cartesian product is past the grid budget, which is the constraint that
    // actually protects ECharts' layout.
    const wide = Array.from({ length: 70 }, (_, i) => `x${i}`);
    const tall = Array.from({ length: 70 }, (_, i) => `y${i}`);
    expect(reasonOf(heatmap({ xAxis: { values: wide }, yAxis: { values: tall }, data: [{ x: "x0", y: "y0", value: 1 }] }))).toContain(`${AI_CHART_MAX_HEATMAP_GRID}`);
  });
});

describe("funnel", () => {
  const funnel = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    type: "funnel",
    data: [
      { name: "visit", value: 100 },
      { name: "cart", value: 40 },
    ],
    ...overrides,
  });

  it("accepts the pie-shaped payload", () => {
    const spec = parsed(funnel());
    if (spec.type !== "funnel") throw new Error("expected a funnel spec");
    expect(spec.data).toEqual([
      { name: "visit", value: 100 },
      { name: "cart", value: 40 },
    ]);
  });

  it("tolerates one zero stage but rejects negatives and an all-zero funnel", () => {
    expect(
      parsed(
        funnel({
          data: [
            { name: "a", value: 0 },
            { name: "b", value: 5 },
          ],
        }),
      ).type,
    ).toBe("funnel");
    expect(
      reasonOf(
        funnel({
          data: [
            { name: "a", value: -1 },
            { name: "b", value: 5 },
          ],
        }),
      ),
    ).toContain("must not be negative");
    expect(reasonOf(funnel({ data: [{ name: "a", value: 0 }] }))).toContain("all-zero");
  });

  it("caps the stage count well below the pie-ish general cap", () => {
    const stages = Array.from({ length: AI_CHART_MAX_FUNNEL_ENTRIES + 1 }, (_, i) => ({ name: `s${i}`, value: 1 }));
    expect(reasonOf(funnel({ data: stages }))).toContain(`${AI_CHART_MAX_FUNNEL_ENTRIES} stages`);
  });

  it("rejects an empty or missing data array", () => {
    expect(reasonOf(funnel({ data: [] }))).toContain("non-empty data array");
    expect(reasonOf({ version: 1, type: "funnel" })).toContain("non-empty data array");
  });
});

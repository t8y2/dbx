import { describe, expect, it } from "vitest";
import { AI_CHART_VERSION, parseAiChartSpec, AI_CHART_MAX_JSON_CHARS, AI_CHART_MAX_SERIES, AI_CHART_MAX_POINTS_PER_ARRAY, AI_CHART_MAX_TOTAL_POINTS, AI_CHART_MAX_CATEGORY_STRING_LENGTH } from "@/lib/ai/richContent/aiChartSpec";

const barSpec = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  type: "bar",
  xAxis: { values: ["Jan", "Feb", "Mar"] },
  series: [{ name: "Revenue", data: [120, 200, 150] }],
  ...overrides,
});

describe("parseAiChartSpec", () => {
  it("accepts a valid bar chart and normalizes data to numbers", () => {
    const result = parseAiChartSpec(JSON.stringify(barSpec()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.type).toBe("bar");
    if (result.spec.type !== "bar") return;
    expect(result.spec.version).toBe(1);
    expect(result.spec.xAxis.values).toEqual(["Jan", "Feb", "Mar"]);
    expect(result.spec.series[0].data).toEqual([120, 200, 150]);
  });

  it("accepts a valid line chart", () => {
    const result = parseAiChartSpec(JSON.stringify({ version: 1, type: "line", xAxis: { values: [1, 2, 3] }, series: [{ name: "s", data: [1.5, -2, 0] }] }));
    expect(result.ok).toBe(true);
  });

  it("accepts negative data values in line/bar", () => {
    const result = parseAiChartSpec(JSON.stringify(barSpec({ series: [{ name: "s", data: [-5, 0, 3] }] })));
    expect(result.ok).toBe(true);
  });

  it("accepts a valid pie chart with a single zero slice", () => {
    const result = parseAiChartSpec(
      JSON.stringify({
        version: 1,
        type: "pie",
        data: [
          { name: "A", value: 40 },
          { name: "B", value: 0 },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.spec.type !== "pie") return;
    expect(result.spec.data).toEqual([
      { name: "A", value: 40 },
      { name: "B", value: 0 },
    ]);
  });

  it("rejects invalid JSON", () => {
    const result = parseAiChartSpec("{ not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid JSON");
  });

  it("rejects a missing version (required protocol field)", () => {
    const { version: _omitted, ...missing } = barSpec();
    const result = parseAiChartSpec(JSON.stringify(missing));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("chart version is required");
  });

  it("accepts an explicit version 1", () => {
    const result = parseAiChartSpec(JSON.stringify(barSpec({ version: 1 })));
    expect(result.ok).toBe(true);
  });

  it("rejects an unsupported version with a reason containing 'unsupported chart version'", () => {
    const result = parseAiChartSpec(JSON.stringify(barSpec({ version: 2 })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("unsupported chart version");
  });

  it("rejects an unsupported chart type", () => {
    const result = parseAiChartSpec(JSON.stringify(barSpec({ type: "scatter" })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("unsupported chart type");
  });

  it("keeps category axis values as-is (no numeric coercion): ['Jan','Feb'] and ['华东','华南']", () => {
    for (const values of [
      ["Jan", "Feb"],
      ["华东", "华南"],
      ["产品A", "产品B"],
    ]) {
      const result = parseAiChartSpec(JSON.stringify(barSpec({ xAxis: { values }, series: [{ name: "Revenue", data: [120, 200] }] })));
      expect(result.ok).toBe(true);
      if (result.ok && result.spec.type === "bar") expect(result.spec.xAxis.values).toEqual(values);
    }
  });

  it("rejects non-finite numeric values in series data ('NaN', 'Infinity', non-numeric)", () => {
    for (const data of [
      ["NaN", 2, 3],
      ["Infinity", 2, 3],
      ["abc", 2, 3],
      ["  ", 2, 3],
    ]) {
      const result = parseAiChartSpec(JSON.stringify(barSpec({ series: [{ name: "s", data }] })));
      expect(result.ok).toBe(false);
    }
  });

  it("rejects non-finite pie values ('NaN', 'Infinity', non-numeric)", () => {
    for (const data of [[{ name: "A", value: "NaN" }], [{ name: "A", value: "Infinity" }], [{ name: "A", value: "n/a" }]]) {
      const result = parseAiChartSpec(JSON.stringify({ version: 1, type: "pie", data }));
      expect(result.ok).toBe(false);
    }
  });

  it("coerces numeric strings in series data and pie values", () => {
    const bar = parseAiChartSpec(JSON.stringify(barSpec({ series: [{ name: "s", data: ["12", "3.5", 0] }] })));
    expect(bar.ok).toBe(true);
    if (bar.ok && bar.spec.type === "bar") expect(bar.spec.series[0].data).toEqual([12, 3.5, 0]);

    const pie = parseAiChartSpec(JSON.stringify({ version: 1, type: "pie", data: [{ name: "A", value: "42" }] }));
    expect(pie.ok).toBe(true);
    if (pie.ok && pie.spec.type === "pie") expect(pie.spec.data[0].value).toBe(42);
  });

  it("rejects a missing or empty xAxis.values", () => {
    expect(parseAiChartSpec(JSON.stringify(barSpec({ xAxis: {} }))).ok).toBe(false);
    expect(parseAiChartSpec(JSON.stringify(barSpec({ xAxis: { values: [] } }))).ok).toBe(false);
  });

  it("rejects a missing or empty series array", () => {
    expect(parseAiChartSpec(JSON.stringify(barSpec({ series: [] }))).ok).toBe(false);
    expect(parseAiChartSpec(JSON.stringify(barSpec({ series: undefined }))).ok).toBe(false);
  });

  it("rejects length mismatch between a series data and xAxis.values", () => {
    const result = parseAiChartSpec(JSON.stringify(barSpec({ series: [{ name: "s", data: [1, 2] }] })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("length does not match");
  });

  it("rejects a pie with no data or all-zero data", () => {
    expect(parseAiChartSpec(JSON.stringify({ version: 1, type: "pie", data: [] })).ok).toBe(false);
    expect(
      parseAiChartSpec(
        JSON.stringify({
          version: 1,
          type: "pie",
          data: [
            { name: "A", value: 0 },
            { name: "B", value: 0 },
          ],
        }),
      ).ok,
    ).toBe(false);
  });

  it("rejects negative pie values", () => {
    const result = parseAiChartSpec(
      JSON.stringify({
        version: 1,
        type: "pie",
        data: [
          { name: "A", value: -1 },
          { name: "B", value: 2 },
        ],
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a non-object chart spec", () => {
    expect(parseAiChartSpec("[]").ok).toBe(false);
    expect(parseAiChartSpec('"text"').ok).toBe(false);
    expect(parseAiChartSpec("42").ok).toBe(false);
  });

  it("rejects an empty spec", () => {
    expect(parseAiChartSpec("").ok).toBe(false);
    expect(parseAiChartSpec("   \n  ").ok).toBe(false);
  });

  it("rejects a JSON body over 256KB", () => {
    // The raw-length gate fires before JSON.parse, so an oversized body is
    // rejected regardless of whether it would parse.
    const big = "x".repeat(AI_CHART_MAX_JSON_CHARS + 1);
    const result = parseAiChartSpec(big);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("256KB");
  });

  it("rejects more than 8 series", () => {
    const series = Array.from({ length: AI_CHART_MAX_SERIES + 1 }, (_, i) => ({ name: `s${i}`, data: [1, 2, 3] }));
    const result = parseAiChartSpec(JSON.stringify(barSpec({ series })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("8 series");
  });

  it("rejects a data/values array with more than 5000 points", () => {
    const values = Array.from({ length: AI_CHART_MAX_POINTS_PER_ARRAY + 1 }, (_, i) => i);
    const result = parseAiChartSpec(JSON.stringify(barSpec({ xAxis: { values }, series: [{ name: "s", data: values.map(() => 1) }] })));
    expect(result.ok).toBe(false);
  });

  it("rejects line/bar total points over 10000", () => {
    // 3 series x 4000 points = 12000 > 10000, each under the 5000 cap.
    const values = Array.from({ length: 4000 }, (_, i) => i);
    const series = Array.from({ length: 3 }, (_, i) => ({ name: `s${i}`, data: values.map(() => i) }));
    const result = parseAiChartSpec(JSON.stringify(barSpec({ xAxis: { values }, series })));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(String(AI_CHART_MAX_TOTAL_POINTS));
  });

  it("accepts a line/bar total exactly at the 10000 cap", () => {
    const values = Array.from({ length: 5000 }, (_, i) => i);
    const series = Array.from({ length: 2 }, (_, i) => ({ name: `s${i}`, data: values.map(() => i) }));
    const result = parseAiChartSpec(JSON.stringify(barSpec({ xAxis: { values }, series })));
    expect(result.ok).toBe(true);
  });

  it("rejects an over-long category axis string (>256 chars)", () => {
    const result = parseAiChartSpec(JSON.stringify(barSpec({ xAxis: { values: ["x".repeat(AI_CHART_MAX_CATEGORY_STRING_LENGTH + 1)] } })));
    expect(result.ok).toBe(false);
  });

  it("keeps optional title / axis labels when present", () => {
    const result = parseAiChartSpec(JSON.stringify(barSpec({ title: "Sales", xAxis: { label: "Month", values: ["Jan", "Feb"] }, yAxis: { label: "Amount" }, series: [{ name: "s", data: [1, 2] }] })));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.spec.type !== "bar") return;
    expect(result.spec.title).toBe("Sales");
    expect(result.spec.xAxis.label).toBe("Month");
    expect(result.spec.yAxis?.label).toBe("Amount");
  });

  it("returns a deterministic reason on failure and preserves raw", () => {
    const raw = "{ broken";
    const result = parseAiChartSpec(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid JSON");
      expect(result.raw).toBe(raw);
    }
  });

  it("exposes the chart version constant", () => {
    expect(AI_CHART_VERSION).toBe(1);
  });
});

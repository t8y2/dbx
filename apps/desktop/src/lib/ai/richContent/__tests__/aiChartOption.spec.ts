import { describe, expect, it } from "vitest";
import { buildAiChartOption, type AiChartTheme } from "@/lib/ai/richContent/aiChartOption";
import { parseAiChartSpec } from "@/lib/ai/richContent/aiChartSpec";
import type { AiChartSpec } from "@/lib/ai/richContent/aiChartSpec";

const light: AiChartTheme = { isDark: false };
const dark: AiChartTheme = { isDark: true };

function specOf(json: string): AiChartSpec {
  const result = parseAiChartSpec(json);
  if (!result.ok) throw new Error(`unexpected parse failure: ${result.reason}`);
  return result.spec;
}

describe("buildAiChartOption", () => {
  it("builds a bar option with a category xAxis and value yAxis", () => {
    const option = buildAiChartOption(specOf(JSON.stringify({ version: 1, type: "bar", xAxis: { values: ["Jan", "Feb"] }, series: [{ name: "Revenue", data: [1, 2] }] })), light);
    expect(option.xAxis).toMatchObject({ type: "category", data: ["Jan", "Feb"] });
    expect(option.yAxis).toMatchObject({ type: "value" });
    if (Array.isArray(option.series)) {
      expect(option.series).toHaveLength(1);
      expect(option.series[0]).toMatchObject({ type: "bar", data: [1, 2], name: "Revenue" });
    } else {
      expect(option.series).toBeDefined();
    }
  });

  it("uses smooth:true for line charts only", () => {
    const line = buildAiChartOption(specOf(JSON.stringify({ version: 1, type: "line", xAxis: { values: ["a", "b"] }, series: [{ name: "s", data: [1, 2] }] })), light);
    if (Array.isArray(line.series)) expect(line.series[0]).toMatchObject({ type: "line", smooth: true });

    const bar = buildAiChartOption(specOf(JSON.stringify({ version: 1, type: "bar", xAxis: { values: ["a", "b"] }, series: [{ name: "s", data: [1, 2] }] })), light);
    if (Array.isArray(bar.series)) expect(bar.series[0]).toMatchObject({ type: "bar", smooth: false });
  });

  it("maps pie data entries to name/value pairs with a donut radius", () => {
    const option = buildAiChartOption(
      specOf(
        JSON.stringify({
          version: 1,
          type: "pie",
          data: [
            { name: "A", value: 40 },
            { name: "B", value: 60 },
          ],
        }),
      ),
      light,
    );
    expect(option.tooltip).toMatchObject({ trigger: "item" });
    if (Array.isArray(option.series)) {
      expect(option.series[0]).toMatchObject({
        type: "pie",
        radius: ["30%", "60%"],
        data: [
          { name: "A", value: 40 },
          { name: "B", value: 60 },
        ],
      });
    }
  });

  it("applies axis label colors from the theme (dark vs light)", () => {
    const lightOption = buildAiChartOption(specOf(JSON.stringify({ version: 1, type: "bar", xAxis: { values: ["a"] }, series: [{ name: "s", data: [1] }] })), light);
    const darkOption = buildAiChartOption(specOf(JSON.stringify({ version: 1, type: "bar", xAxis: { values: ["a"] }, series: [{ name: "s", data: [1] }] })), dark);
    expect(lightOption.xAxis).toMatchObject({ axisLabel: { color: "#666" } });
    expect(darkOption.xAxis).toMatchObject({ axisLabel: { color: "#aaa" } });
  });

  it("applies legend text colors from the theme", () => {
    const lightOption = buildAiChartOption(specOf(JSON.stringify({ version: 1, type: "pie", data: [{ name: "A", value: 1 }] })), light);
    const darkOption = buildAiChartOption(specOf(JSON.stringify({ version: 1, type: "pie", data: [{ name: "A", value: 1 }] })), dark);
    expect(lightOption.legend).toMatchObject({ textStyle: { color: "#333" } });
    expect(darkOption.legend).toMatchObject({ textStyle: { color: "#ccc" } });
  });

  it("sets a title when the spec carries one", () => {
    const option = buildAiChartOption(specOf(JSON.stringify({ version: 1, type: "bar", title: "Sales", xAxis: { values: ["a"] }, series: [{ name: "s", data: [1] }] })), light);
    expect(option.title).toMatchObject({ text: "Sales" });
  });

  it("omits the title when the spec has none", () => {
    const option = buildAiChartOption(specOf(JSON.stringify({ version: 1, type: "bar", xAxis: { values: ["a"] }, series: [{ name: "s", data: [1] }] })), light);
    expect(option.title).toBeUndefined();
  });

  it("uses axis names from xAxis/yAxis labels", () => {
    const option = buildAiChartOption(specOf(JSON.stringify({ version: 1, type: "bar", xAxis: { label: "Month", values: ["a"] }, yAxis: { label: "Amount" }, series: [{ name: "s", data: [1] }] })), light);
    expect(option.xAxis).toMatchObject({ name: "Month" });
    expect(option.yAxis).toMatchObject({ name: "Amount" });
  });

  it("enables accessible output and zoom-safe labels for dense category axes", () => {
    const option = buildAiChartOption(specOf(JSON.stringify({ version: 1, type: "line", xAxis: { values: Array.from({ length: 13 }, (_, i) => `day-${i}`) }, series: [{ name: "s", data: Array.from({ length: 13 }, (_, i) => i) }] })), light);
    expect(option.aria).toMatchObject({ enabled: true });
    expect(option.dataZoom).toHaveLength(2);
    expect(option.xAxis).toMatchObject({ axisLabel: { rotate: 35, overflow: "truncate" } });
  });

  it("keeps the dense-axis slider at the canvas bottom edge and lifts the legend above it", () => {
    const dense = buildAiChartOption(specOf(JSON.stringify({ version: 1, type: "line", xAxis: { values: Array.from({ length: 13 }, (_, i) => `day-${i}`) }, series: [{ name: "s", data: Array.from({ length: 13 }, (_, i) => i) }] })), light);
    if (Array.isArray(dense.dataZoom)) {
      const slider = dense.dataZoom.find((zoom) => typeof zoom === "object" && zoom !== null && "type" in zoom && (zoom as { type?: string }).type === "slider") as { bottom?: number; height?: number } | undefined;
      expect(slider?.bottom).toBe(0);
      expect(slider?.height).toBe(16);
    }
    expect(dense.legend).toMatchObject({ bottom: 32 });
    expect(dense.grid).toMatchObject({ bottom: 76 });

    const sparse = buildAiChartOption(specOf(JSON.stringify({ version: 1, type: "line", xAxis: { values: ["a", "b"] }, series: [{ name: "s", data: [1, 2] }] })), light);
    expect(sparse.dataZoom).toBeUndefined();
    expect(sparse.legend).toMatchObject({ bottom: 0 });
  });
});

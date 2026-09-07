import { describe, expect, it } from "vitest";
import { AI_RICH_BLOCK_HANDLERS, isAiRichBlockLanguage } from "@/lib/ai/richContent/aiRichContent";
import { parseAiChartSpec } from "@/lib/ai/richContent/aiChartSpec";

const validBar = JSON.stringify({ version: 1, type: "bar", xAxis: { values: ["Jan", "Feb"] }, series: [{ name: "Revenue", data: [120, 200] }] });
const invalidBar = "{ not json";

describe("AI_RICH_BLOCK_HANDLERS", () => {
  it("registers exactly the chart-json handler in V1", () => {
    expect(Object.keys(AI_RICH_BLOCK_HANDLERS)).toEqual(["chart-json"]);
  });

  it("returns null for an unfinished fence (closed=false) without parsing", () => {
    const handler = AI_RICH_BLOCK_HANDLERS["chart-json"];
    expect(handler.language).toBe("chart-json");
    // Even a malformed body must not be parsed while the fence is still open.
    expect(handler.parse(invalidBar, { closed: false })).toBeNull();
  });

  it("parses a valid closed chart-json block into a chart segment", () => {
    const handler = AI_RICH_BLOCK_HANDLERS["chart-json"];
    const segment = handler.parse(validBar, { closed: true });
    expect(segment).not.toBeNull();
    expect(segment?.type).toBe("chart");
    expect(segment?.content).toBe(validBar);
    expect(parseAiChartSpec(segment!.content).ok).toBe(true);
  });

  it("returns null when a closed chart-json block fails validation", () => {
    const handler = AI_RICH_BLOCK_HANDLERS["chart-json"];
    expect(handler.parse(invalidBar, { closed: true })).toBeNull();
    expect(handler.parse(JSON.stringify({ version: 1, type: "pie", data: [{ name: "A", value: -1 }] }), { closed: true })).toBeNull();
  });

  it("does not treat sql/bash/json as rich block languages", () => {
    for (const lang of ["sql", "bash", "json", "SQL", "BASH", "chart-json "]) {
      expect(isAiRichBlockLanguage(lang)).toBe(lang.trim().toLowerCase() === "chart-json");
    }
  });

  it("matches the raw language tag case-insensitively", () => {
    expect(isAiRichBlockLanguage("CHART-JSON")).toBe(true);
    expect(isAiRichBlockLanguage(" Chart-Json ")).toBe(true);
  });
});

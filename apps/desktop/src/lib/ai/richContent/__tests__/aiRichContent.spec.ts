import { describe, expect, it } from "vitest";
import { AI_RICH_BLOCK_HANDLERS, isAiRichBlockLanguage } from "@/lib/ai/richContent/aiRichContent";
import { parseAiChartSpec } from "@/lib/ai/richContent/aiChartSpec";
import { AI_HTML_MAX_CONTENT_CHARS, AI_HTML_PREVIEW_CSP, buildSafeHtmlPreview } from "@/lib/ai/richContent/aiHtmlPreview";

const validBar = JSON.stringify({ version: 1, type: "bar", xAxis: { values: ["Jan", "Feb"] }, series: [{ name: "Revenue", data: [120, 200] }] });
const invalidBar = "{ not json";
const validHtml = "<p>Hello <strong>world</strong></p>";

describe("AI_RICH_BLOCK_HANDLERS", () => {
  it("registers exactly the chart-json and html handlers in V1", () => {
    expect(Object.keys(AI_RICH_BLOCK_HANDLERS)).toEqual(["chart-json", "html"]);
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

  it("keeps an unfinished html fence unpreviewed", () => {
    const handler = AI_RICH_BLOCK_HANDLERS.html;
    expect(handler.language).toBe("html");
    expect(handler.parse(validHtml, { closed: false })).toBeNull();
  });

  it("parses a closed html block into a segment carrying the safe document", () => {
    const handler = AI_RICH_BLOCK_HANDLERS.html;
    const segment = handler.parse(validHtml, { closed: true });
    expect(segment?.type).toBe("html");
    if (segment?.type !== "html") return;
    expect(segment.content).toBe(validHtml);
    // The document is the wrapped shell, never the raw source, and it is the
    // exact bytes "Save Safe HTML" writes.
    expect(segment.document).toBe(buildSafeHtmlPreview(validHtml));
    expect(segment.document).toContain(AI_HTML_PREVIEW_CSP);
    expect(segment.document).toContain(validHtml);
  });

  it("rejects an over-budget html body deterministically", () => {
    const handler = AI_RICH_BLOCK_HANDLERS.html;
    const oversize = "x".repeat(AI_HTML_MAX_CONTENT_CHARS + 1);
    expect(handler.parse(oversize, { closed: true })).toBeNull();
  });

  it("does not treat sql/bash/json as rich block languages", () => {
    for (const lang of ["sql", "bash", "json", "SQL", "BASH"]) {
      expect(isAiRichBlockLanguage(lang)).toBe(false);
    }
    expect(isAiRichBlockLanguage("chart-json ")).toBe(true);
    expect(isAiRichBlockLanguage("html")).toBe(true);
  });

  it("matches the raw language tag case-insensitively", () => {
    expect(isAiRichBlockLanguage("CHART-JSON")).toBe(true);
    expect(isAiRichBlockLanguage(" Chart-Json ")).toBe(true);
    expect(isAiRichBlockLanguage("HTML")).toBe(true);
    expect(isAiRichBlockLanguage(" Html ")).toBe(true);
  });
});

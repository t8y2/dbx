import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../AiAssistant.vue", import.meta.url), "utf8");

describe("AI assistant explain_query canvas containment", () => {
  it("bounds the embedded ExplainPlanViewer to a fixed, clipped height", () => {
    const match = source.match(/<div v-if="step\.toolName === 'explain_query' && step\.explainData[^>]*class="([^"]*)"/);
    expect(match, "explain_query wrapper div not found").not.toBeNull();
    const wrapperClass = match![1];
    expect(wrapperClass).toContain("h-64");
    expect(wrapperClass).toContain("overflow-hidden");
  });

  it("does not rely on an unresolvable max-height alone to contain the canvas", () => {
    expect(source).not.toContain('<ExplainPlanViewer :plan="parseExplainFromData(step.explainData, connection.db_type)" class="max-h-64" />');
  });
});

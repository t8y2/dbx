import { expect, it } from "vitest";
import { parseMcpApprovalSummary, normalizeMcpApprovalAiSettings } from "@/lib/mcp/mcpApprovalSummary";

it.each(["low", "medium", "high", "unknown"])("accepts the structured %s assessment", (riskLevel) => {
  const assessment = { riskLevel, summary: "执行操作。", risks: ["影响范围仍需核对。"] };
  expect(parseMcpApprovalSummary(JSON.stringify(assessment))).toEqual(assessment);
  expect(parseMcpApprovalSummary("```json\n" + JSON.stringify(assessment) + "\n```")).toEqual(assessment);
});

it.each([
  null,
  [],
  { riskLevel: "safe", summary: "执行", risks: ["无"] },
  { riskLevel: "low", summary: "", risks: ["原因"] },
  { riskLevel: "low", summary: "过长".repeat(200), risks: ["原因"] },
  { riskLevel: "low", summary: "执行", risks: [] },
  { riskLevel: "low", summary: "执行", risks: [null] },
  { riskLevel: "low", summary: "执行", risks: ["原因".repeat(150)] },
])("rejects malformed or verbose risk data instead of displaying a safe rating", (value) => {
  expect(() => parseMcpApprovalSummary(JSON.stringify(value))).toThrow();
});

it("defaults automatic disclosure to off and validates persisted selection types", () => {
  expect(normalizeMcpApprovalAiSettings()).toEqual({ configId: "", modelId: "", autoGenerate: false });
  expect(normalizeMcpApprovalAiSettings({ configId: " cfg ", modelId: " model ", autoGenerate: true })).toEqual({ configId: "cfg", modelId: "model", autoGenerate: true });
  expect(normalizeMcpApprovalAiSettings({ configId: 42, modelId: false, autoGenerate: "true" } as any)).toEqual({ configId: "", modelId: "", autoGenerate: false });
});

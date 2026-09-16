import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../SidebarTreeRuntimeHost.vue", import.meta.url), "utf8");

describe("executeTreeNodeSqlWithProductionGuard executionId", () => {
  it("only registers a backend execution id for callers that opt in, instead of generating one for every caller", () => {
    expect(source).toContain("const executionId = options.executionId;");
    expect(source).not.toMatch(/executionId\s*=\s*options\.executionId\s*\?\?\s*uuid\(\)/);
  });
});

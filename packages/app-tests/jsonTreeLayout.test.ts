import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("apps/desktop/src/components/common/JsonTree.vue", "utf8");

describe("JSON tree layout", () => {
  it("keeps a collapsed container closing bracket beside its summary", () => {
    expect(source).toMatch(/\.json-tree-summary\s*\{\s*flex: 0 1 auto;\s*min-width: 0;\s*\}/);
  });
});

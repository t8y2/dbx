import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../DdlViewDialog.vue", import.meta.url), "utf8");

describe("DdlViewDialog freshness", () => {
  it("bypasses persisted DDL when the dialog opens", () => {
    expect(source).toMatch(/watch\(\s*\(\) => props\.open,[\s\S]*?await loadDdl\(true\);/);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(new URL("../SchemaDiffDdlPanel.vue", import.meta.url), "utf8");

describe("SchemaDiffDdlPanel diff highlighting", () => {
  it("keeps modified rows height-stable and sticky DDL headers opaque", () => {
    expect(panelSource).not.toContain("border-yellow-500/40");
    expect(panelSource).not.toContain("sticky top-0 bg-muted/50");
    expect(panelSource.match(/sticky top-0 bg-background/g)).toHaveLength(4);
  });

  it("never applies the focused-row outline to empty padding lines", () => {
    expect(panelSource).toContain('if (line.isPadding || focusedLineNumber === null) return "";');
  });
});

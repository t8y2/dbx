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

  it("keeps rollback comparison based on the selected forward SQL", () => {
    expect(panelSource).toContain("rollbackForwardSql?: string;");
    expect(panelSource).toContain("props.rollbackForwardSql ?? props.deploySql");
  });

  it("does not expose selected-SQL execution from the focused script tab", () => {
    const focusedScript = panelSource.slice(panelSource.indexOf("<!-- Deploy Script -->"), panelSource.indexOf("<!-- Deploy Script All -->"));
    const selectedScript = panelSource.slice(panelSource.indexOf("<!-- Deploy Script All -->"));

    expect(focusedScript).not.toContain("$emit('executeScript')");
    expect(selectedScript).toContain("$emit('executeScript')");
  });
});

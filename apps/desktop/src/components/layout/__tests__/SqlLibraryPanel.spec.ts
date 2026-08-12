import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(new URL("../SqlLibraryPanel.vue", import.meta.url), "utf8");

describe("SqlLibraryPanel selection contrast", () => {
  it("uses the accent foreground for selected rows and their metadata", () => {
    expect(panelSource).toContain('return "bg-accent text-accent-foreground";');
    expect(panelSource).toMatch(/function fileMetaClass[\s\S]*\? "text-accent-foreground" : "text-muted-foreground";/);
    expect(panelSource).not.toContain('contextFile(fileId) ? "text-foreground/70"');
  });
});

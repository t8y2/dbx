import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const editorSearchPanelSource = readFileSync(new URL("../EditorSearchPanel.vue", import.meta.url), "utf8");

describe("EditorSearchPanel corner style", () => {
  it("uses the configurable five-pixel radius token for editor inputs", () => {
    expect(editorSearchPanelSource).toContain("border-radius: var(--dbx-radius-fixed-5);");
  });
});

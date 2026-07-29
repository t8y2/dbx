import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

describe("QueryEditor tooltip container", () => {
  it("keeps CodeMirror tooltips inside the editor instead of extending document.body", () => {
    expect(queryEditorSource).not.toContain("tooltips({ parent: document.body })");
  });
});

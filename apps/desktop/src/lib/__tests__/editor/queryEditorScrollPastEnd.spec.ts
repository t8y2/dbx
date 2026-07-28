import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

describe("QueryEditor bottom scroll space", () => {
  it("allows editable documents to scroll past the last line without changing read-only previews", () => {
    expect(queryEditorSource).toContain("scrollPastEnd, ViewPlugin");
    expect(queryEditorSource).toContain("props.readOnly ? [] : scrollPastEnd()");
  });
});

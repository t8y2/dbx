import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const objectSourceDialogSource = readFileSync(new URL("../ObjectSourceDialog.vue", import.meta.url), "utf8");

describe("ObjectSourceDialog edit draft wiring (issue #5057)", () => {
  it("seeds the initial edit draft from the pretty-printed source, not the raw single-line definition", () => {
    expect(objectSourceDialogSource).toMatch(/draft\.value = nextEditing && canEdit\.value \? resolveObjectSourceEditDraft\(props\.databaseType, resolvedType, formatted, editable\) : "";/);
  });

  it("seeds the draft opened via the Edit button from the pretty-printed source, not the raw single-line definition", () => {
    expect(objectSourceDialogSource).toMatch(/function editSource\(\) \{[\s\S]*?draft\.value = resolveObjectSourceEditDraft\(props\.databaseType, resolvedObjectType\.value, content\.value, editableText\.value\);/);
  });
});

import { describe, expect, it } from "vitest";
import { compactJsonText, valueEditorActions } from "@/lib/dataGrid/cellDetailPresentation";

describe("cellDetailPresentation", () => {
  it("offers compact JSON beside format JSON for editable JSON values", () => {
    expect(valueEditorActions({ canSetNull: true, canFormatJson: true })).toEqual(["formatJson", "compactJson", "setNull", "restoreOriginal"]);
    expect(valueEditorActions({ canSetNull: false, canFormatJson: false })).toEqual(["restoreOriginal"]);
    expect(compactJsonText('{\n  "name": "DBX",\n  "enabled": true\n}')).toBe('{"name":"DBX","enabled":true}');
  });
});

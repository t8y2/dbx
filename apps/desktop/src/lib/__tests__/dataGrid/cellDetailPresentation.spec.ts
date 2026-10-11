import { describe, expect, it } from "vitest";
import { compactJsonText, formatJsonText, looksLikeJsonContainerText, valueEditorActions } from "@/lib/dataGrid/cellDetailPresentation";

describe("cellDetailPresentation", () => {
  it("offers compact JSON beside format JSON for editable JSON values", () => {
    expect(valueEditorActions({ canSetNull: true, canFormatJson: true })).toEqual(["formatJson", "compactJson", "setNull", "restoreOriginal"]);
    expect(valueEditorActions({ canSetNull: false, canFormatJson: false })).toEqual(["restoreOriginal"]);
    expect(compactJsonText('{\n  "name": "DBX",\n  "enabled": true\n}')).toBe('{"name":"DBX","enabled":true}');
  });

  it("formats serialized JSON strings into pretty-printed JSON (issue #11636)", () => {
    const serialized = '"{\\"abc\\":\\"\\"}"';
    expect(looksLikeJsonContainerText(serialized)).toBe(true);
    expect(formatJsonText(serialized)).toBe('{\n  "abc": ""\n}');

    // Scalar string in quotes is not treated as a container
    expect(looksLikeJsonContainerText('"hello"')).toBe(false);
  });
});

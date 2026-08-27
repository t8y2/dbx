import { describe, expect, it } from "vitest";
import { buildTextDiff } from "@/lib/common/textDiff";
import { createJsonValueDiffSnapshot, formatJsonValueDiffText, isJsonValueDiffAvailable, JSON_VALUE_DIFF_MAX_FORMAT_LENGTH, type JsonValueDiffCandidate } from "@/lib/dataGrid/jsonValueDiff";

function candidate(patch: Partial<JsonValueDiffCandidate> = {}): JsonValueDiffCandidate {
  return {
    columnName: "payload",
    columnType: "JSON",
    originalValue: '{"profile":{"name":"Ada","roles":["reader"]},"obsolete":true}',
    currentValue: '{"profile":{"name":"Grace","roles":["reader","writer"]},"active":true}',
    isEditable: true,
    isEditing: true,
    ...patch,
  };
}

describe("JSON value diff", () => {
  it("only enables editable JSON sessions and snapshots changed draft text", () => {
    const source = candidate({ currentValue: '{"profile":' });
    expect(isJsonValueDiffAvailable(source)).toBe(true);
    expect(isJsonValueDiffAvailable(candidate({ isEditable: false }))).toBe(false);
    expect(isJsonValueDiffAvailable(candidate({ isEditing: false }))).toBe(false);
    expect(isJsonValueDiffAvailable(candidate({ columnType: "TEXT", originalValue: "plain text" }))).toBe(false);
    expect(isJsonValueDiffAvailable(candidate({ columnType: "TEXT" }))).toBe(true);
    expect(createJsonValueDiffSnapshot(candidate({ currentValue: candidate().originalValue }))).toBeNull();

    const snapshot = createJsonValueDiffSnapshot(source);
    source.currentValue = '{"later":true}';
    expect(snapshot).toEqual({ columnName: "payload", originalValue: candidate().originalValue, currentValue: '{"profile":' });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("formats nested object and array changes for aligned line and character diffs", () => {
    const original = formatJsonValueDiffText(candidate().originalValue, "json");
    const current = formatJsonValueDiffText(candidate().currentValue, "json");
    const rows = buildTextDiff(original.text, current.text);

    expect(original.error).toBeNull();
    expect(current.error).toBeNull();
    expect(rows.some((row) => row.kind === "modified" && row.beforeSegments.some((segment) => segment.changed))).toBe(true);
    expect(rows.some((row) => row.kind === "added" && row.afterText.includes('"writer"'))).toBe(true);
    expect(rows.some((row) => row.beforeText.includes('"obsolete"'))).toBe(true);
    expect(rows.some((row) => row.afterText.includes('"active"'))).toBe(true);
  });

  it("normalizes whitespace in JSON mode while preserving it in raw mode", () => {
    const original = '{"a":1,"items":[1,2]}';
    const current = '{ "a": 1, "items": [1, 2] }';
    const originalJson = formatJsonValueDiffText(original, "json");
    const currentJson = formatJsonValueDiffText(current, "json");

    expect(originalJson.text).toBe(currentJson.text);
    expect(buildTextDiff(originalJson.text, currentJson.text).every((row) => row.kind === "equal")).toBe(true);
    expect(buildTextDiff(formatJsonValueDiffText(original, "raw").text, formatJsonValueDiffText(current, "raw").text).some((row) => row.kind !== "equal")).toBe(true);
  });

  it("keeps an invalid current draft intact and reports the JSON fallback", () => {
    const invalid = '{"items":[1,2]';
    const result = formatJsonValueDiffText(invalid, "json");

    expect(result.text).toBe(invalid);
    expect(result.error).toMatchObject({ kind: "invalid-json" });
  });

  it("bounds large formatting and detailed character comparison", () => {
    const original = `{"payload":"${"a".repeat(JSON_VALUE_DIFF_MAX_FORMAT_LENGTH)}"}`;
    const current = `{"payload":"${"b".repeat(JSON_VALUE_DIFF_MAX_FORMAT_LENGTH)}"}`;
    const formatted = formatJsonValueDiffText(current, "json");
    const rows = buildTextDiff(original, current);

    expect(formatted).toEqual({ text: current, error: { kind: "too-large", limit: JSON_VALUE_DIFF_MAX_FORMAT_LENGTH } });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("modified");
    expect(rows[0].beforeSegments).toEqual([{ text: original, changed: true }]);
    expect(rows[0].afterSegments).toEqual([{ text: current, changed: true }]);
  });
});

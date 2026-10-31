import { describe, expect, it } from "vitest";
import { isFocusResultGridShortcut, isFocusSqlEditorShortcut } from "@/lib/editor/keyboardShortcuts";
import { DEFAULT_SHORTCUT_SETTINGS, normalizeShortcutSettings, SHORTCUT_DEFINITIONS } from "@/lib/editor/shortcutRegistry";
import { hasFocusableQueryResult } from "@/lib/query/queryOutput";
import type { QueryResult, QueryTab } from "@/types/database";

describe("query surface focus shortcuts", () => {
  it.each(["focusResultGrid", "focusSqlEditor"] as const)("registers %s globally without a default binding", (id) => {
    expect(SHORTCUT_DEFINITIONS.find((definition) => definition.id === id)).toMatchObject({ scope: "global", defaultShortcut: "" });
    expect(DEFAULT_SHORTCUT_SETTINGS[id]).toBe("");
    expect(normalizeShortcutSettings({ executeSql: "Mod+Enter" })[id]).toBe("");
  });

  it.each([isFocusResultGridShortcut, isFocusSqlEditorShortcut])("does not consume an unbound shortcut", (matches) => {
    expect(matches({ key: "F6" })).toBe(false);
  });

  it("matches configured bindings across platforms, including cleared bindings and IME input", () => {
    const shortcuts = normalizeShortcutSettings({ focusResultGrid: "Mod+Shift+G", focusSqlEditor: "F6" });
    expect(isFocusResultGridShortcut({ key: "G", ctrlKey: true, shiftKey: true }, shortcuts)).toBe(true);
    expect(isFocusResultGridShortcut({ key: "G", metaKey: true, shiftKey: true }, shortcuts)).toBe(true);
    expect(isFocusResultGridShortcut({ key: "G", ctrlKey: true }, shortcuts)).toBe(false);
    expect(isFocusSqlEditorShortcut({ key: "F6" }, shortcuts)).toBe(true);
    expect(isFocusSqlEditorShortcut({ key: "F6", isComposing: true }, shortcuts)).toBe(false);
    expect(isFocusSqlEditorShortcut({ key: "F6" }, { focusSqlEditor: "" })).toBe(false);
  });
});

describe("focusable query results", () => {
  const result: QueryResult = { columns: ["id"], rows: [[1]], affected_rows: 0, execution_time_ms: 1 };
  it.each([result, { ...result, rows: [] }])("accepts tabular results, including zero rows", (data) => {
    expect(hasFocusableQueryResult({ mode: "query", result: data })).toBe(true);
  });
  it.each([undefined, { columns: [], rows: [], affected_rows: 1, execution_time_ms: 1 }, { ...result, server_message: true }, { ...result, execution_error: true }])("ignores absent, update-only, message, and error results", (data) => {
    expect(hasFocusableQueryResult({ mode: "query", result: data })).toBe(false);
  });
  it("does not redirect non-query tabs", () => {
    expect(hasFocusableQueryResult({ mode: "data", result })).toBe(false);
    expect(hasFocusableQueryResult(undefined)).toBe(false);
    expect(hasFocusableQueryResult({ mode: "mongo" as QueryTab["mode"], result })).toBe(false);
  });
});

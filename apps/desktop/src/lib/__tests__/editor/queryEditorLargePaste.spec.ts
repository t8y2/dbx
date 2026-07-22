import { readFileSync } from "node:fs";
import { history, undo, undoDepth } from "@codemirror/commands";
import { EditorState, Transaction } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { LARGE_PASTE_HISTORY_USER_EVENT, LARGE_PASTE_NATIVE_RECOVERY_THRESHOLD, normalizeQueryEditorPasteText, recoverableNativePasteSuffix, shouldRecoverLargeTauriPaste } from "@/lib/editor/queryEditorLargePaste";

const queryEditorSource = readFileSync(new URL("../../../components/editor/QueryEditor.vue", import.meta.url), "utf8");

describe("QueryEditor large paste recovery", () => {
  it("recovers the suffix of a SQL paste truncated at the WebView boundary", () => {
    const sql = Array.from({ length: 10_925 }, (_, index) => `('Z${String(index).padStart(13, "0")}'),`).join("\r\n");
    const eventText = sql.slice(0, 128 * 1024);

    expect(shouldRecoverLargeTauriPaste(eventText, true)).toBe(true);
    const suffix = recoverableNativePasteSuffix(eventText, sql);
    expect(suffix).not.toBeNull();
    const recovered = normalizeQueryEditorPasteText(eventText) + suffix;
    expect(recovered).toBe(normalizeQueryEditorPasteText(sql));
    expect(recovered.split("\n")).toHaveLength(10_925);
  });

  it("does not alter small, web, unchanged, or unrelated clipboard text", () => {
    expect(shouldRecoverLargeTauriPaste("x".repeat(LARGE_PASTE_NATIVE_RECOVERY_THRESHOLD - 1), true)).toBe(false);
    expect(shouldRecoverLargeTauriPaste("x".repeat(LARGE_PASTE_NATIVE_RECOVERY_THRESHOLD), false)).toBe(false);
    expect(recoverableNativePasteSuffix("SELECT 1", "SELECT 1")).toBeNull();
    expect(recoverableNativePasteSuffix("SELECT 1", "SELECT 2 with more text")).toBeNull();
  });

  it("preserves Unicode separators that CodeMirror does not treat as line breaks", () => {
    expect(normalizeQueryEditorPasteText("SELECT '\u2028\u2029'\r\n")).toBe("SELECT '\u2028\u2029'\n");
  });

  it("groups the WebView prefix and native suffix into one undo step", () => {
    const pasteStartedAt = Date.now();
    let state = EditorState.create({ doc: "SELECT ", selection: { anchor: 7 }, extensions: [history()] });
    state = state.update({
      changes: { from: 7, insert: "prefix" },
      selection: { anchor: 13 },
      annotations: Transaction.time.of(pasteStartedAt),
      userEvent: LARGE_PASTE_HISTORY_USER_EVENT,
    }).state;
    state = state.update({
      changes: { from: 13, insert: "suffix" },
      selection: { anchor: 19 },
      annotations: Transaction.time.of(pasteStartedAt),
      userEvent: LARGE_PASTE_HISTORY_USER_EVENT,
    }).state;
    const view = {
      get state() {
        return state;
      },
      dispatch(transaction: Transaction) {
        state = transaction.state;
      },
    } as unknown as Parameters<typeof undo>[0];

    expect(undoDepth(state)).toBe(1);
    expect(undo(view)).toBe(true);
    expect(state.doc.toString()).toBe("SELECT ");
    expect(state.selection.main.from).toBe(7);
  });

  it("wires the recovery into the editor paste event", () => {
    expect(queryEditorSource).toMatch(/paste\(event, currentView\)[\s\S]*?recoverLargeTauriPaste\(event, currentView\)/);
  });
});

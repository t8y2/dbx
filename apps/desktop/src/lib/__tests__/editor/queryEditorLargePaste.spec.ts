import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LARGE_PASTE_NATIVE_RECOVERY_THRESHOLD, normalizeQueryEditorPasteText, recoverableNativePasteSuffix, shouldRecoverLargeTauriPaste } from "@/lib/editor/queryEditorLargePaste";

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

  it("wires the recovery into the editor paste event", () => {
    expect(queryEditorSource).toMatch(/paste\(event, currentView\)[\s\S]*?recoverLargeTauriPaste\(event, currentView\)/);
  });
});

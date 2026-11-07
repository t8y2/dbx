import { describe, expect, it } from "vitest";
import { isReplaceAllShortcut } from "@/lib/editor/replaceAllShortcut";

function key(overrides: Partial<Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">> = {}): Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey"> {
  return { key: "Enter", ctrlKey: false, metaKey: false, altKey: false, ...overrides };
}

describe("isReplaceAllShortcut", () => {
  it("matches Ctrl+Alt+Enter and Cmd+Alt+Enter", () => {
    expect(isReplaceAllShortcut(key({ ctrlKey: true, altKey: true }))).toBe(true);
    expect(isReplaceAllShortcut(key({ metaKey: true, altKey: true }))).toBe(true);
    expect(isReplaceAllShortcut(key({ ctrlKey: true, metaKey: true, altKey: true }))).toBe(true);
  });

  it("rejects Enter without the full modifier set and other keys", () => {
    expect(isReplaceAllShortcut(key())).toBe(false);
    expect(isReplaceAllShortcut(key({ ctrlKey: true }))).toBe(false);
    expect(isReplaceAllShortcut(key({ metaKey: true }))).toBe(false);
    expect(isReplaceAllShortcut(key({ altKey: true }))).toBe(false);
    expect(isReplaceAllShortcut(key({ ctrlKey: true, altKey: true, key: "N" }))).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { CELL_DETAIL_AUTO_WRAP_MIN_LENGTH, shouldAutoWrapLongSingleLine } from "../cellDetailWordWrap";

describe("shouldAutoWrapLongSingleLine (#12320)", () => {
  it("wraps a single-line value that exceeds the viewport threshold", () => {
    expect(shouldAutoWrapLongSingleLine("x".repeat(CELL_DETAIL_AUTO_WRAP_MIN_LENGTH))).toBe(true);
    expect(shouldAutoWrapLongSingleLine("y".repeat(500))).toBe(true);
  });

  it("keeps short single-line values unwrapped so the toggle semantics stay intact", () => {
    expect(shouldAutoWrapLongSingleLine("")).toBe(false);
    expect(shouldAutoWrapLongSingleLine("short value")).toBe(false);
    expect(shouldAutoWrapLongSingleLine("x".repeat(CELL_DETAIL_AUTO_WRAP_MIN_LENGTH - 1))).toBe(false);
  });

  it("never forces wrapping on multi-line documents", () => {
    const longPrefix = "x".repeat(CELL_DETAIL_AUTO_WRAP_MIN_LENGTH);
    expect(shouldAutoWrapLongSingleLine(`${longPrefix}\nnext line`)).toBe(false);
    expect(shouldAutoWrapLongSingleLine(`${longPrefix}\r\nnext line`)).toBe(false);
    // Pretty-printed JSON is multi-line; users who want it folded still have the global toggle.
    expect(shouldAutoWrapLongSingleLine(`{\n  "k": "${"v".repeat(300)}"\n}`)).toBe(false);
  });

  it("wraps a minified single-line JSON blob", () => {
    expect(shouldAutoWrapLongSingleLine(`{"payload":"${"v".repeat(300)}"}`)).toBe(true);
  });
});

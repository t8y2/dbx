import { describe, expect, it } from "vitest";
import { shouldPinResultRunOnClick } from "@/lib/tabs/resultRunPin";

describe("shouldPinResultRunOnClick", () => {
  it("pins an unpinned run while the option is enabled", () => {
    expect(shouldPinResultRunOnClick({ pinned: false }, true)).toBe(true);
    expect(shouldPinResultRunOnClick({}, true)).toBe(true);
  });

  it("unpins an already pinned run on click instead of leaving it alone (#13306)", () => {
    expect(shouldPinResultRunOnClick({ pinned: true }, true)).toBe(true);
  });

  it("does not toggle when the user disabled click-to-pin", () => {
    expect(shouldPinResultRunOnClick({ pinned: false }, false)).toBe(false);
    expect(shouldPinResultRunOnClick({ pinned: true }, false)).toBe(false);
  });

  it("ignores a missing run", () => {
    expect(shouldPinResultRunOnClick(undefined, true)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { shouldPinResultRunOnClick } from "@/lib/tabs/resultRunPin";

describe("shouldPinResultRunOnClick", () => {
  it("pins an unpinned run while the option is enabled", () => {
    expect(shouldPinResultRunOnClick({ pinned: false }, true)).toBe(true);
    expect(shouldPinResultRunOnClick({}, true)).toBe(true);
  });

  it("leaves an already pinned run alone", () => {
    expect(shouldPinResultRunOnClick({ pinned: true }, true)).toBe(false);
  });

  it("does not pin when the user disabled click-to-pin", () => {
    expect(shouldPinResultRunOnClick({ pinned: false }, false)).toBe(false);
  });

  it("ignores a missing run", () => {
    expect(shouldPinResultRunOnClick(undefined, true)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { shouldPinResultRunOnClick } from "@/lib/tabs/resultRunPin";

describe("shouldPinResultRunOnClick", () => {
  it("pins an unpinned run while the option is enabled", () => {
    expect(shouldPinResultRunOnClick({ pinned: false }, true)).toBe(true);
    expect(shouldPinResultRunOnClick({}, true)).toBe(true);
  });

  it("unpins the pinned run that is already shown when it is clicked again (#13306)", () => {
    expect(shouldPinResultRunOnClick({ pinned: true }, true, true)).toBe(true);
  });

  it("keeps a pinned run pinned when switching to it from another result tab (#14599)", () => {
    expect(shouldPinResultRunOnClick({ pinned: true }, true, false)).toBe(false);
    expect(shouldPinResultRunOnClick({ pinned: true }, true)).toBe(false);
  });

  it("pins an unpinned run whether or not it was already shown", () => {
    expect(shouldPinResultRunOnClick({ pinned: false }, true, true)).toBe(true);
    expect(shouldPinResultRunOnClick({ pinned: false }, true, false)).toBe(true);
  });

  it("does not toggle when the user disabled click-to-pin", () => {
    expect(shouldPinResultRunOnClick({ pinned: false }, false)).toBe(false);
    expect(shouldPinResultRunOnClick({ pinned: true }, false)).toBe(false);
  });

  it("ignores a missing run", () => {
    expect(shouldPinResultRunOnClick(undefined, true)).toBe(false);
  });
});

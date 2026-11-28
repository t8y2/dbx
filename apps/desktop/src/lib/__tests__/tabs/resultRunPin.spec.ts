import { describe, expect, it } from "vitest";
import { shouldPinResultRunOnClick } from "@/lib/tabs/resultRunPin";

describe("shouldPinResultRunOnClick", () => {
  it("pins an unpinned run when its tab is already shown and clicked again (#9975, #15037)", () => {
    expect(shouldPinResultRunOnClick({ pinned: false }, true, true)).toBe(true);
    expect(shouldPinResultRunOnClick({}, true, true)).toBe(true);
  });

  it("unpins the pinned run that is already shown when it is clicked again (#13306)", () => {
    expect(shouldPinResultRunOnClick({ pinned: true }, true, true)).toBe(true);
  });

  it("keeps a pinned run pinned when switching to it from another result tab (#14599)", () => {
    expect(shouldPinResultRunOnClick({ pinned: true }, true, false)).toBe(false);
    expect(shouldPinResultRunOnClick({ pinned: true }, true)).toBe(false);
  });

  it("does not pin an unpinned run when switching to it from another result tab (#15037)", () => {
    expect(shouldPinResultRunOnClick({ pinned: false }, true, false)).toBe(false);
    expect(shouldPinResultRunOnClick({ pinned: false }, true)).toBe(false);
    expect(shouldPinResultRunOnClick({}, true, false)).toBe(false);
  });

  it("does not toggle when the user disabled click-to-pin", () => {
    expect(shouldPinResultRunOnClick({ pinned: false }, false)).toBe(false);
    expect(shouldPinResultRunOnClick({ pinned: true }, false)).toBe(false);
  });

  it("ignores a missing run", () => {
    expect(shouldPinResultRunOnClick(undefined, true)).toBe(false);
  });
});

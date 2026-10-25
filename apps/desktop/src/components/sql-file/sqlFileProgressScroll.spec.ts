import { describe, expect, it } from "vitest";
import { BOTTOM_STICK_THRESHOLD_PX, isScrolledToBottom } from "./sqlFileProgressScroll";

describe("isScrolledToBottom", () => {
  it("reports a body that is exactly at its bottom", () => {
    expect(isScrolledToBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
  });

  it("reports a body that is still within the threshold of the bottom", () => {
    expect(isScrolledToBottom({ scrollTop: 600 - BOTTOM_STICK_THRESHOLD_PX, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
  });

  it("reports a body that was scrolled up", () => {
    expect(isScrolledToBottom({ scrollTop: 200, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
  });

  it("treats a body whose content fits as being at the bottom", () => {
    expect(isScrolledToBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true);
  });

  it("ignores a negative scroll offset produced by overscroll", () => {
    expect(isScrolledToBottom({ scrollTop: -30, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
  });

  it("rejects metrics that are not finite numbers", () => {
    expect(isScrolledToBottom({ scrollTop: Number.NaN, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
    expect(isScrolledToBottom({ scrollTop: 0, scrollHeight: Number.POSITIVE_INFINITY, clientHeight: 400 })).toBe(false);
  });

  it("honours a custom threshold", () => {
    expect(isScrolledToBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 }, 10)).toBe(false);
    expect(isScrolledToBottom({ scrollTop: 500, scrollHeight: 1000, clientHeight: 400 }, 100)).toBe(true);
  });
});

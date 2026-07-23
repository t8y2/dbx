import { describe, expect, it } from "vitest";
import { normalizeAppCornerStyle } from "@/lib/app/appTheme";

describe("app corner style", () => {
  it.each([
    [null, "small"],
    ["", "small"],
    ["invalid", "small"],
    ["none", "none"],
    ["small", "small"],
    ["large", "large"],
  ])("normalizes %s to %s", (value, expected) => {
    expect(normalizeAppCornerStyle(value)).toBe(expected);
  });
});

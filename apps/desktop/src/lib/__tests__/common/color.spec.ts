import { describe, expect, it } from "vitest";
import { hexToHsv, hexToRgba, hsvToHex } from "@/lib/common/color";

describe("hexToHsv", () => {
  it.each([
    ["#ff0000", 0, 1, 1],
    ["#00ff00", 120, 1, 1],
    ["#0000ff", 240, 1, 1],
    ["#ffffff", 0, 0, 1],
    ["#000000", 0, 0, 0],
    ["#808080", 0, 0, 0.502],
  ])("maps %s to its hue, saturation and value", (color, h, s, v) => {
    const hsv = hexToHsv(color);

    expect(hsv?.h).toBeCloseTo(h, 1);
    expect(hsv?.s).toBeCloseTo(s, 2);
    expect(hsv?.v).toBeCloseTo(v, 2);
  });

  it("accepts shorthand and hash-less input", () => {
    expect(hexToHsv("#f00")).toEqual(hexToHsv("#ff0000"));
    expect(hexToHsv("ff0000")).toEqual(hexToHsv("#ff0000"));
  });

  it.each([["#12345g"], ["rgb(0,0,0)"], ["red"], [""], ["#ff00"]])("rejects the non-hex input %p", (color) => {
    expect(hexToHsv(color)).toBeNull();
  });
});

describe("hsvToHex", () => {
  it.each([
    [{ h: 0, s: 1, v: 1 }, "#ff0000"],
    [{ h: 120, s: 1, v: 1 }, "#00ff00"],
    [{ h: 240, s: 1, v: 1 }, "#0000ff"],
    [{ h: 0, s: 0, v: 1 }, "#ffffff"],
    [{ h: 0, s: 0, v: 0 }, "#000000"],
    [{ h: 60, s: 1, v: 1 }, "#ffff00"],
  ])("renders %o as %s", (hsv, expected) => {
    expect(hsvToHex(hsv)).toBe(expected);
  });

  it("wraps the hue and clamps the fractions", () => {
    expect(hsvToHex({ h: 360, s: 1, v: 1 })).toBe("#ff0000");
    expect(hsvToHex({ h: -120, s: 1, v: 1 })).toBe("#0000ff");
    expect(hsvToHex({ h: 0, s: 4, v: 4 })).toBe("#ff0000");
    expect(hsvToHex({ h: 0, s: -1, v: -1 })).toBe("#000000");
  });

  it("always emits a six-digit lowercase hex", () => {
    for (let hue = 0; hue < 360; hue += 7) {
      expect(hsvToHex({ h: hue, s: 0.42, v: 0.73 })).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("round-trips a color through HSV without drift", () => {
    // The spectrum picker converts on every pointer move, so drift would creep.
    for (const color of ["#1d4ed8", "#0e7490", "#166534", "#c2410c", "#7e22ce", "#93c5fd", "#6ee7b7"]) {
      expect(hsvToHex(hexToHsv(color)!)).toBe(color);
    }
  });
});

describe("hexToRgba", () => {
  it("keeps working alongside the HSV helpers", () => {
    expect(hexToRgba("#ff0000", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
    expect(hexToRgba("nonsense", 1)).toBeUndefined();
  });
});

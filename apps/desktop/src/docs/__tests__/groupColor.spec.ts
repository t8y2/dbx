import { describe, expect, it } from "vitest";
import { groupStyle } from "../groupColor";

describe("groupStyle", () => {
  it("exposes the hue as a CSS custom property", () => {
    expect(groupStyle(28)).toEqual({ "--h": "28" });
  });

  it("returns no custom property for an ungrouped section", () => {
    expect(groupStyle(null)).toEqual({});
  });

  it("wraps hues into 0-359 rather than emitting an out-of-range value", () => {
    expect(groupStyle(360)).toEqual({ "--h": "0" });
    expect(groupStyle(388)).toEqual({ "--h": "28" });
    expect(groupStyle(-1)).toEqual({ "--h": "359" });
  });

  it("never emits a colour value", () => {
    // Lightness and chroma belong to the theme. If this function ever returns
    // a hex or oklch string, the dark-mode contrast guarantee is gone.
    const style = groupStyle(200);
    const serialized = JSON.stringify(style);
    expect(serialized).not.toContain("#");
    expect(serialized).not.toContain("oklch");
    expect(serialized).not.toContain("rgb");
  });

  it("coerces a non-integer hue to an integer", () => {
    expect(groupStyle(28.7)).toEqual({ "--h": "28" });
  });
});

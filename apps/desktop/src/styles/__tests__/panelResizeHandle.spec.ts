import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globalsCss = readFileSync(new URL("../globals.css", import.meta.url), "utf8");

function themeBlock(selector: string): string {
  const escaped = selector.replace(/\./g, "\\.");
  return globalsCss.match(new RegExp(`${escaped} \\{([^}]*)\\}`))?.[1] ?? "";
}

function rgbVar(block: string, name: string): [number, number, number] {
  const match = block.match(new RegExp(`${name}: rgb\\((\\d+) (\\d+) (\\d+)\\)`));
  expect(match, `${name} must be defined as an rgb() value`).not.toBeNull();
  return [Number(match![1]), Number(match![2]), Number(match![3])];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number): number => {
    const srgb = value / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("panel resize handle grip dots", () => {
  it("keeps the resting grip dots visible on light and dark backgrounds (#14925)", () => {
    // The dots are three currentColor dots on the sidebar edge. A translucent
    // resting color made them blend into a light sidebar (~1.5:1 contrast,
    // effectively white on white) while the opaque hover/drag colors stayed
    // visible, so the icon looked like it flipped between white and black.
    const handleRule = globalsCss.match(/\.panel-resize-handle::before \{([^}]*)\}/)?.[1] ?? "";
    expect(handleRule).not.toBe("");

    const color = handleRule.match(/color: ([^;]+);/)?.[1] ?? "";
    expect(color).toContain("var(--muted-foreground)");
    expect(color).not.toContain("transparent");

    const opacity = Number(handleRule.match(/opacity: ([0-9.]+);/)?.[1] ?? "1");
    // A color-mix with transparent thins the dots further; the resting color
    // must stay opaque so only the rule opacity applies.
    const mix = color.match(/color-mix\(in srgb, var\(--muted-foreground\) (\d+)%, transparent\)/);
    const effectiveAlpha = (mix ? Number(mix[1]) / 100 : 1) * opacity;

    for (const selector of ["html.theme-soft", "html.theme-soft.dark"]) {
      const block = themeBlock(selector);
      const foreground = rgbVar(block, "--muted-foreground");
      const background = rgbVar(block, "--background");
      const rendered = foreground.map((channel, index) => effectiveAlpha * channel + (1 - effectiveAlpha) * background[index]) as [number, number, number];
      expect(contrastRatio(rendered, background), `${selector}: grip dots must stay readable against the panel background`).toBeGreaterThanOrEqual(2.5);
    }
  });

  it("keeps opaque colors for the hover and resizing states", () => {
    const hoverRule = globalsCss.match(/\.panel-resize-handle:hover::before,[^}]*\{([^}]*)\}/)?.[1] ?? "";
    expect(hoverRule).toContain("color: var(--ring)");
    const resizingRule = globalsCss.match(/body\.dbx-is-resizing \.panel-resize-handle::before \{([^}]*)\}/)?.[1] ?? "";
    expect(resizingRule).toContain("color: var(--primary)");
  });
});

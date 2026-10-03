import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Fixes #10669: when querying few columns, the canvas/DOM grid only occupies
// the width of the columns, while the remaining viewport space to the right
// displays the background of the scroller container.
// Previously, `.canvas-grid-scroller` and `.data-grid-scroller` had hardcoded
// `background-color: rgb(19, 20, 22) !important;` (and `rgb(255, 255, 255)` in light mode),
// whereas the canvas rendered with the theme background (e.g. IntelliJ IDEA dark
// `--background: rgb(43, 43, 43)`). This caused a sharp, visible color mismatch
// between the column area and the empty space on the right.
const dataGridSource = readFileSync(new URL("../DataGrid.vue", import.meta.url), "utf8");

describe("DataGrid background color consistency (#10669)", () => {
  it("uses var(--background) for data-grid-root in both light and dark modes", () => {
    expect(dataGridSource).toMatch(/\[data-grid-root\]\s*\{[^}]*background-color:\s*var\(--background,\s*rgb\(255,\s*255,\s*255\)\);/);
    expect(dataGridSource).toMatch(/\[data-grid-root\]\.data-grid--dark[^}]*background-color:\s*var\(--background,\s*rgb\(19,\s*20,\s*22\)\);/);
  });

  it("uses var(--background) for .canvas-grid-scroller and .data-grid-scroller backgrounds", () => {
    // Light mode scroller
    expect(dataGridSource).toMatch(/\.canvas-grid-scroller\s*\{[^}]*background-color:\s*var\(--background,\s*rgb\(255,\s*255,\s*255\)\);/);
    expect(dataGridSource).toMatch(/\.data-grid-scroller:not\(\.canvas-grid-scroller\)\s*\{[^}]*background-color:\s*var\(--background,\s*rgb\(255,\s*255,\s*255\)\);/);

    // Dark mode scroller
    expect(dataGridSource).toMatch(/\[data-grid-root\]\.data-grid--dark \.canvas-grid-scroller[^}]*background-color:\s*var\(--background,\s*rgb\(19,\s*20,\s*22\)\)\s*!important;/);
    expect(dataGridSource).toMatch(/\[data-grid-root\]\.data-grid--dark \.data-grid-scroller:not\(\.canvas-grid-scroller\)[^}]*background-color:\s*var\(--background,\s*rgb\(19,\s*20,\s*22\)\)\s*!important;/);
  });

  it("uses var(--background) for horizontal and vertical scrollbar backgrounds", () => {
    expect(dataGridSource).toMatch(/\.data-grid-horizontal-scrollbar\s*\{[^}]*background-color:\s*var\(--background,\s*rgb\(255,\s*255,\s*255\)\);/);
    expect(dataGridSource).toMatch(/\[data-grid-root\]\.data-grid--dark \.data-grid-horizontal-scrollbar[^}]*background-color:\s*var\(--background,\s*rgb\(19,\s*20,\s*22\)\)\s*!important;/);
    expect(dataGridSource).toMatch(/:global\(\.dark\) \[data-grid-root\] \.data-grid-vertical-scrollbar\s*\{[^}]*background-color:\s*var\(--background,\s*rgb\(19,\s*20,\s*22\)\);/);
  });

  it("uses var(--background) for non-striped row background in dataGridRowStyle", () => {
    expect(dataGridSource).toContain('dark\n              ? "var(--background, rgb(19, 20, 22))"\n              : "var(--background, rgb(255, 255, 255))"');
  });

  it("does not contain hardcoded rgb(19, 20, 22) or rgb(255, 255, 255) as standalone background-color", () => {
    // None of the scroller or root styles should use standalone background-color without var(--background)
    expect(dataGridSource).not.toMatch(/background-color:\s*rgb\(19,\s*20,\s*22\)\s*(!important)?;(?!\s*\/\*)/);
    expect(dataGridSource).not.toMatch(/background-color:\s*rgb\(255,\s*255,\s*255\)\s*(!important)?;(?!\s*\/\*)/);
  });
});

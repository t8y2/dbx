import { describe, expect, it } from "vitest";
import { MAX_PNG_CANVAS_SIDE, resolvePngExportScale } from "@/lib/export/diagramFormats";

describe("resolvePngExportScale", () => {
  it("keeps the requested scale when the canvas fits", () => {
    expect(resolvePngExportScale(3000, 2000, 2)).toBe(2);
    expect(resolvePngExportScale(8000, 8000, 1)).toBe(1);
  });

  it("clamps the scale when a side would exceed the canvas limit", () => {
    // 9000x7000 at 2x → 18000 wide, beyond the 16384 side limit.
    const scale = resolvePngExportScale(9000, 7000, 2);
    expect(scale).toBeLessThan(2);
    expect(9000 * scale).toBeLessThanOrEqual(MAX_PNG_CANVAS_SIDE);
    expect(7000 * scale).toBeLessThanOrEqual(MAX_PNG_CANVAS_SIDE);
  });

  it("clamps the scale when the total pixel area would exceed the limit", () => {
    // 12000x12000 at 1x fits the side limit but exceeds the area budget at 2x.
    const scale = resolvePngExportScale(12000, 12000, 2);
    expect(scale).toBeLessThan(2);
    expect(12000 * scale * 12000 * scale).toBeLessThanOrEqual(MAX_PNG_CANVAS_SIDE * MAX_PNG_CANVAS_SIDE);
  });

  it("allows sub-1 scales for oversized diagrams instead of failing", () => {
    // A 40000px-wide diagram cannot fit at 1x; export at a reduced scale.
    const scale = resolvePngExportScale(40000, 30000, 2);
    expect(scale).toBeLessThan(1);
    expect(40000 * scale).toBeLessThanOrEqual(MAX_PNG_CANVAS_SIDE);
  });

  it("returns the requested scale unchanged for invalid dimensions", () => {
    expect(resolvePngExportScale(0, 100, 2)).toBe(2);
    expect(resolvePngExportScale(NaN, 100, 2)).toBe(2);
    expect(resolvePngExportScale(100, 100, 0)).toBe(0);
    expect(resolvePngExportScale(100, 100, Number.NaN)).toBe(Number.NaN);
  });
});

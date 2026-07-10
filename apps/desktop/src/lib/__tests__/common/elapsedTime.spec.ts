import { describe, expect, it } from "vitest";
import { formatElapsedSeconds } from "@/lib/common/elapsedTime";

describe("formatElapsedSeconds", () => {
  it("formats elapsed milliseconds with two fractional second digits", () => {
    expect(formatElapsedSeconds(1234)).toBe("1.23");
    expect(formatElapsedSeconds(5)).toBe("0.01");
    expect(formatElapsedSeconds(0)).toBe("0.00");
  });

  it("clamps invalid elapsed values to zero", () => {
    expect(formatElapsedSeconds(-100)).toBe("0.00");
    expect(formatElapsedSeconds(Number.NaN)).toBe("0.00");
  });
});

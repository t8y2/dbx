import { describe, expect, it } from "vitest";
import { formatElapsedSeconds } from "@/lib/common/elapsedTime";

describe("formatElapsedSeconds", () => {
  it("formats elapsed milliseconds with one fractional second digit", () => {
    expect(formatElapsedSeconds(1234)).toBe("1.2");
    expect(formatElapsedSeconds(1250)).toBe("1.3");
    expect(formatElapsedSeconds(5)).toBe("0.0");
    expect(formatElapsedSeconds(0)).toBe("0.0");
  });

  it("clamps invalid elapsed values to zero", () => {
    expect(formatElapsedSeconds(-100)).toBe("0.0");
    expect(formatElapsedSeconds(Number.NaN)).toBe("0.0");
  });
});

import { describe, expect, it } from "vitest";
import { formatDurationUs, formatQueryDuration } from "../duration";

describe("formatQueryDuration", () => {
  it("clamps non-finite and negative inputs", () => {
    expect(formatQueryDuration(Number.NaN)).toBe("0 ms");
    expect(formatQueryDuration(-1)).toBe("0 ms");
  });

  it("keeps sub-second durations in integer milliseconds", () => {
    expect(formatQueryDuration(0)).toBe("0 ms");
    expect(formatQueryDuration(999)).toBe("999 ms");
  });

  it("shows one decimal second between 1s and 60s (floor-truncated)", () => {
    expect(formatQueryDuration(1_000)).toBe("1.0 s");
    expect(formatQueryDuration(1_234)).toBe("1.2 s");
    expect(formatQueryDuration(59_999)).toBe("59.9 s");
  });

  it("shows minutes + seconds between 1min and 1h", () => {
    expect(formatQueryDuration(60_000)).toBe("1m 0s");
    expect(formatQueryDuration(65_000)).toBe("1m 5s");
    expect(formatQueryDuration(3_599_999)).toBe("59m 59s");
  });

  it("shows hours + minutes + seconds from 1h on", () => {
    expect(formatQueryDuration(3_600_000)).toBe("1h 0m 0s");
    expect(formatQueryDuration(3_661_000)).toBe("1h 1m 1s");
  });
});

describe("formatDurationUs", () => {
  it("keeps sub-millisecond values in microseconds", () => {
    expect(formatDurationUs(0)).toBe("0 µs");
    expect(formatDurationUs(999)).toBe("999 µs");
  });

  it("converts to the ms tiers from 1ms on", () => {
    expect(formatDurationUs(1_000)).toBe("1 ms");
    expect(formatDurationUs(1_999)).toBe("2 ms");
    expect(formatDurationUs(1_500_000)).toBe("1.5 s");
  });
});

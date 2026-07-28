import { describe, expect, it } from "vitest";
import { parseNonNegativeSafeInteger } from "@/lib/mq/mqPeekFilters";

describe("parseNonNegativeSafeInteger", () => {
  it("accepts non-negative safe integers", () => {
    expect(parseNonNegativeSafeInteger("0")).toBe(0);
    expect(parseNonNegativeSafeInteger("20")).toBe(20);
    expect(parseNonNegativeSafeInteger(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects decimals and non-integers", () => {
    expect(parseNonNegativeSafeInteger("1.9")).toBeNull();
    expect(parseNonNegativeSafeInteger("0.1")).toBeNull();
    expect(parseNonNegativeSafeInteger("abc")).toBeNull();
  });

  it("rejects negatives and values outside the safe integer range", () => {
    expect(parseNonNegativeSafeInteger("-1")).toBeNull();
    expect(parseNonNegativeSafeInteger(String(Number.MAX_SAFE_INTEGER + 1))).toBeNull();
  });

  it("rejects empty input", () => {
    expect(parseNonNegativeSafeInteger("")).toBeNull();
    expect(parseNonNegativeSafeInteger("   ")).toBeNull();
  });
});

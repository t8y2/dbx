import { describe, expect, it } from "vitest";
import { MAX_AGENT_TURNS_DEFAULT, MAX_AGENT_TURNS_MAX, MAX_AGENT_TURNS_MIN, maxAgentTurnsOutOfRange, normalizeMaxAgentTurns } from "@/lib/ai/maxAgentTurns";

describe("maxAgentTurnsOutOfRange", () => {
  it("accepts values within [min, max]", () => {
    expect(maxAgentTurnsOutOfRange(30)).toBe(false);
    expect(maxAgentTurnsOutOfRange(MAX_AGENT_TURNS_MIN)).toBe(false);
    expect(maxAgentTurnsOutOfRange(MAX_AGENT_TURNS_MAX)).toBe(false);
  });

  it("rejects values outside [min, max]", () => {
    expect(maxAgentTurnsOutOfRange(MAX_AGENT_TURNS_MIN - 1)).toBe(true);
    expect(maxAgentTurnsOutOfRange(MAX_AGENT_TURNS_MAX + 1)).toBe(true);
  });

  it("treats an empty input (undefined) as in range so the save button isn't force-disabled", () => {
    expect(maxAgentTurnsOutOfRange(undefined)).toBe(false);
  });

  it("flags +Infinity as out of range (regression: a bare Number.isFinite guard short-circuits this to false)", () => {
    // A user can type "1e400" into <input type="number">, which the browser accepts
    // and Number() parses to Infinity. The check must not short-circuit on it.
    expect(maxAgentTurnsOutOfRange(Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe("normalizeMaxAgentTurns", () => {
  it("preserves and rounds finite values within the supported range", () => {
    expect(normalizeMaxAgentTurns(100)).toBe(100);
    expect(normalizeMaxAgentTurns(30.6)).toBe(31);
  });

  it("clamps finite values outside the supported range", () => {
    expect(normalizeMaxAgentTurns(MAX_AGENT_TURNS_MIN - 1)).toBe(MAX_AGENT_TURNS_MIN);
    expect(normalizeMaxAgentTurns(MAX_AGENT_TURNS_MAX + 1)).toBe(MAX_AGENT_TURNS_MAX);
  });

  it("uses the default for empty and non-finite input", () => {
    expect(normalizeMaxAgentTurns(undefined)).toBe(MAX_AGENT_TURNS_DEFAULT);
    expect(normalizeMaxAgentTurns(Number.NaN)).toBe(MAX_AGENT_TURNS_DEFAULT);
    expect(normalizeMaxAgentTurns(Number.POSITIVE_INFINITY)).toBe(MAX_AGENT_TURNS_DEFAULT);
  });
});

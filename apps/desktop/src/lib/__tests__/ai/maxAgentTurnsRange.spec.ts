import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const settingsDialogSource = readFileSync(new URL("../../../components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");

const MAX_AGENT_TURNS_MIN = 5;
const MAX_AGENT_TURNS_MAX = 500;

// Mirrors maxAgentTurnsOutOfRange() in EditorSettingsDialog.vue.
function maxAgentTurnsOutOfRange(v: number | undefined): boolean {
  return typeof v === "number" && (v < MAX_AGENT_TURNS_MIN || v > MAX_AGENT_TURNS_MAX);
}

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

  it("does not reintroduce the Number.isFinite short-circuit removed in this fix", () => {
    const fnStart = settingsDialogSource.indexOf("function maxAgentTurnsOutOfRange");
    const fnEnd = settingsDialogSource.indexOf("\n}", fnStart);
    const fnSource = settingsDialogSource.slice(fnStart, fnEnd);
    expect(fnSource).not.toContain("Number.isFinite");
  });
});

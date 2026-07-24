import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_AGENT_TURNS_DEFAULT, MAX_AGENT_TURNS_MAX, MAX_AGENT_TURNS_MIN, maxAgentTurnsOutOfRange, normalizeMaxAgentTurns } from "@/lib/ai/maxAgentTurns";

const settingsDialogSource = readFileSync(new URL("../../../components/editor/EditorSettingsDialog.vue", import.meta.url), "utf8");

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

  it("leaves loading state to the dialog instead of treating it as a range error", () => {
    expect(maxAgentTurnsOutOfRange(undefined)).toBe(false);
  });

  it("flags +Infinity as out of range (regression: a bare Number.isFinite guard short-circuits this to false)", () => {
    // A user can type "1e400" into <input type="number">, which the browser accepts
    // and Number() parses to Infinity. The check must not short-circuit on it.
    expect(maxAgentTurnsOutOfRange(Number.POSITIVE_INFINITY)).toBe(true);
  });
});

describe("agent turn limit loading", () => {
  it("starts loading independently and blocks saves until the persisted value arrives", () => {
    const aiTabStart = settingsDialogSource.indexOf('if (tab === "ai") {');
    const aiTabBranch = settingsDialogSource.slice(aiTabStart, settingsDialogSource.indexOf('if (tab === "about"', aiTabStart));
    expect(aiTabBranch.indexOf("void loadMaxAgentTurnsSetting()")).toBeLessThan(aiTabBranch.indexOf("await promptTemplateStore.ensureLoaded()"));
    expect(settingsDialogSource).toContain("if (!maxAgentTurnsLoaded.value) return;");
    expect(settingsDialogSource).toContain(':disabled="!maxAgentTurnsLoaded || maxAgentTurnsSaving"');
    expect(settingsDialogSource).toContain(':disabled="!maxAgentTurnsLoaded || maxAgentTurnsSaving || maxAgentTurnsOutOfRange(editMaxAgentTurns)"');
  });

  it("keeps failed loads retryable instead of replacing them with the default", () => {
    const loadFunction = settingsDialogSource.slice(settingsDialogSource.indexOf("async function loadMaxAgentTurnsSetting()"), settingsDialogSource.indexOf("async function saveMaxAgentTurnsSetting()"));
    expect(loadFunction).toContain("maxAgentTurnsLoadError.value = e?.message || String(e)");
    expect(loadFunction).not.toContain("editMaxAgentTurns.value = MAX_AGENT_TURNS_DEFAULT");
    expect(settingsDialogSource).toContain('v-if="maxAgentTurnsLoadError"');
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

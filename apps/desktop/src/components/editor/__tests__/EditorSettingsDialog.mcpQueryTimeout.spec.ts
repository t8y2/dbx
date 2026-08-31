import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dialogSource = readFileSync(new URL("../EditorSettingsDialog.vue", import.meta.url), "utf8");

// Regression for the MCP query-timeout input: decimal values like 1.5 were
// silently Math.round-ed to 2 and saved, contradicting the "non-negative whole
// number" label. The UI must reject non-integers with the existing invalid
// toast instead of silently rewriting them.
describe("EditorSettingsDialog MCP query timeout validation", () => {
  function handlerBlock(): string {
    const start = dialogSource.indexOf("function onMcpQueryTimeoutInput()");
    const end = dialogSource.indexOf("const mcpSelectableConnections", start);
    if (start < 0 || end < 0) throw new Error("Missing onMcpQueryTimeoutInput handler block");
    return dialogSource.slice(start, end);
  }

  it("rejects non-integers instead of rounding them", () => {
    const block = handlerBlock();
    // The invalid path must test for integer-ness, not just finite + non-negative.
    expect(block).toMatch(/Number\.isInteger\(parsed\)/);
    // The valid save path must NOT wrap the value in Math.round anymore.
    expect(block).not.toContain("Math.round(parsed)");
    // A decimal input falls through to the invalid toast + revert branch.
    expect(block).toContain('toast(t("settings.mcpQueryTimeoutInvalid"), 5000)');
    expect(block).toMatch(/mcpQueryTimeoutInput\.value\s*=\s*settingsStore\.mcpGlobalPolicy\.queryTimeoutSecs === null \? "" : String\(settingsStore\.mcpGlobalPolicy\.queryTimeoutSecs\)/);
  });

  it("keeps null (inherit) and zero (no limit) working", () => {
    const block = handlerBlock();
    // Empty input still persists null (inherit the connection).
    expect(block).toContain("void saveMcpPolicy({ queryTimeoutSecs: null })");
    // A valid integer still reaches saveMcpPolicy with the exact value.
    expect(block).toContain("void saveMcpPolicy({ queryTimeoutSecs: parsed })");
  });
});

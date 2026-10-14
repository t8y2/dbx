import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-level guard for the layout-style control in the SQL formatter panel.
 * Mounting the panel would pull in the CodeMirror JSON editor, so the one
 * contract that matters for issue #11228 — the style select changes only the
 * engine, never any other option — is pinned against the component source
 * instead.
 *
 * There is deliberately no "apply classic preset" action: the user's decision
 * was that choosing the classic mode is enough, and a second control that
 * writes only part of what the old style needs reads as a partial application
 * of it. Do not re-add one — the two option values v0.6.16 also changed are
 * documented, not applied for the user.
 *
 * This assertion reads the component as text, so it depends on its current
 * formatting: `functionBody` requires the closing brace at column 0 — re-run
 * this spec after any formatter run, and keep comments inside that function
 * free of a `word:` shape, which the key-set check also scans for.
 */
const source = readFileSync(new URL("../SqlFormatterSettingsPanel.vue", import.meta.url), "utf8");

function functionBody(name: string): string {
  const body = source.match(new RegExp(String.raw`function ${name}\([^)]*\) \{\n([\s\S]*?)\n\}`))?.[1];
  expect(body, `${name} not found in SqlFormatterSettingsPanel.vue`).toBeTruthy();
  return body!;
}

describe("SQL formatter layout style panel wiring", () => {
  it("writes only layoutStyle when the style select changes", () => {
    const body = functionBody("onLayoutStyle");

    expect(body).toContain('updateOption("layoutStyle", value)');
    expect(body).not.toContain("expressionWidth");
    expect(body).not.toContain("fromClauseLayout");
  });

  it("offers both layout styles and no preset action", () => {
    expect(source).toContain('{ value: "dbx", labelKey: "settings.sqlFormatterLayoutStyleDbx" }');
    expect(source).toContain('{ value: "classic", labelKey: "settings.sqlFormatterLayoutStyleClassic" }');
    // One control only: the classic mode is chosen here, and nothing writes the
    // option values it used to imply. DEFAULT_SQL_FORMATTER_SETTINGS already is
    // the dbx end state, so Restore Defaults covers the other direction.
    expect(source).not.toContain("ApplyClassicPreset");
  });
});

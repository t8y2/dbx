import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Source-level guard for the layout-style controls in the SQL formatter panel.
 * Mounting the panel would pull in the CodeMirror JSON editor, so the two
 * contracts that matter for issue #11228 — the style select changes only the
 * engine, and the classic action writes only the two layout parameters v0.6.16
 * changed and never the engine — are pinned against the component source
 * instead.
 *
 * These assertions read the component as text, so they depend on its current
 * formatting: `functionBody` requires the closing brace at column 0, and the
 * key-set check scans for `word:` occurrences — re-run this spec after any
 * formatter run, and keep comments inside those two functions free of that shape.
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

  it("writes only expressionWidth and fromClauseLayout from the classic action", () => {
    const body = functionBody("onApplyClassicPreset");

    expect(body).toContain("expressionWidth: 50");
    expect(body).toContain('fromClauseLayout: "newLine"');
    // The layout engine belongs to the style select above; this action must not
    // touch it, nor silently reset unrelated options such as commaPosition.
    expect(body).not.toContain("layoutStyle");
    expect(body).not.toContain("commaPosition");
    // Those two are the whole payload: no other option key may be assigned.
    const writtenKeys = [...body.matchAll(/(\w+):/g)].map((match) => match[1]);
    expect(new Set(writtenKeys)).toEqual(new Set(["expressionWidth", "fromClauseLayout"]));
  });

  it("offers both layout styles and no symmetric dbx preset button", () => {
    expect(source).toContain('{ value: "dbx", labelKey: "settings.sqlFormatterLayoutStyleDbx" }');
    expect(source).toContain('{ value: "classic", labelKey: "settings.sqlFormatterLayoutStyleClassic" }');
    expect(source).toContain("settings.sqlFormatterApplyClassicPreset");
    // DEFAULT_SQL_FORMATTER_SETTINGS already is the dbx preset; Restore Defaults covers it.
    expect(source).not.toContain("sqlFormatterApplyDbxPreset");
  });
});

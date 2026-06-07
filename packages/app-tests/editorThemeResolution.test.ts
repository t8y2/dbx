import { strict as assert } from "node:assert";
import test from "node:test";
import { resolveEditorTheme } from "../../apps/desktop/src/lib/editorThemes.ts";

test("editor theme follows the resolved app appearance when configured to follow app theme", () => {
  assert.equal(resolveEditorTheme("app", "light"), "vscode-light");
  assert.equal(resolveEditorTheme("app", "dark"), "one-dark");
});

test("editor theme keeps explicit CodeMirror theme selections", () => {
  assert.equal(resolveEditorTheme("nord", "light"), "nord");
  assert.equal(resolveEditorTheme("xcode", "dark"), "xcode");
});

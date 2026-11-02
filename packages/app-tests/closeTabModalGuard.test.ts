import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const app = readFileSync("apps/desktop/src/App.vue", "utf8");

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `unterminated ${signature}`);
  return source.slice(start, end);
}

test("closing a tab stops at an open modal dialog", () => {
  // Cmd+W and the native macOS "Close Tab" menu item both funnel into
  // closeActiveSurface, so the modal handling has to live there.
  const body = functionBody(app, "async function closeActiveSurface()");
  assert.match(body, /if \(dismissOpenModalSurface\(\)\) return;/);
  assert.match(app, /import \{ dismissOpenModalSurface \} from "@\/lib\/ui\/modalSurface";/);
  assert.match(app, /if \(isCloseTabShortcut\(e, shortcuts\)\) \{\s*e\.preventDefault\(\);\s*await closeActiveSurface\(\);/);
});

test("the modal branch hands the keystroke to the dialog instead of dropping it", () => {
  const body = functionBody(app, "async function closeActiveSurface()");
  const guardIndex = body.indexOf("dismissOpenModalSurface()");
  const settingsIndex = body.indexOf("showSettingsPage.value");
  assert.notEqual(guardIndex, -1, "closeActiveSurface must dismiss an open modal");
  assert.ok(guardIndex < settingsIndex, "the modal must be dismissed before the surface behind it closes");
  assert.match(body, /if \(dismissOpenModalSurface\(\)\) return;/);
});

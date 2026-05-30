import { strict as assert } from "node:assert";
import test from "node:test";
import {
  classifyIdeaDarkSqlTokens,
  loadEditorTheme,
  loadSqlEditorTheme,
  resolveEditorTheme,
} from "../../apps/desktop/src/lib/editorThemes.ts";

test("editor theme follows the resolved app appearance when configured to follow app theme", () => {
  assert.equal(resolveEditorTheme("app", "light"), "vscode-light");
  assert.equal(resolveEditorTheme("app", "dark"), "idea-dark");
});

test("editor theme keeps explicit CodeMirror theme selections", () => {
  assert.equal(resolveEditorTheme("idea-dark", "light"), "idea-dark");
  assert.equal(resolveEditorTheme("nord", "light"), "nord");
  assert.equal(resolveEditorTheme("xcode", "dark"), "xcode");
});

test("loads the IDEA dark editor theme used by the app dark appearance", async () => {
  const theme = await loadEditorTheme("app", "dark");
  assert.ok(theme);
});

test("loads the SQL-specific IDEA dark editor theme overlay", async () => {
  const theme = await loadSqlEditorTheme("app", "dark");
  assert.ok(theme);
});

test("classifies IDEA dark SQL tokens with function and source context", () => {
  const text = "SELECT COALESCE((SELECT id FROM la_system_menu WHERE paths = 'finance' AND type = 'menu'), 0)";
  const tokens = classifyIdeaDarkSqlTokens(text);
  const matchingToken = (value: string, kind: string) =>
    tokens.find((token) => token.kind === kind && text.slice(token.from, token.to) === value);

  assert.ok(matchingToken("SELECT", "keyword"));
  assert.ok(matchingToken("COALESCE", "function"));
  assert.ok(matchingToken("id", "identifier"));
  assert.ok(matchingToken("la_system_menu", "source"));
  assert.ok(matchingToken("paths", "identifier"));
  assert.ok(matchingToken("'finance'", "string"));
  assert.ok(matchingToken("0", "number"));
});

test("classifies IDEA dark SQL type tokens separately from function calls", () => {
  const text = "CREATE TABLE user_account (id BIGINT, name VARCHAR(255), created_at TIMESTAMP DEFAULT NOW())";
  const tokens = classifyIdeaDarkSqlTokens(text);
  const matchingToken = (value: string, kind: string) =>
    tokens.find((token) => token.kind === kind && text.slice(token.from, token.to) === value);

  assert.ok(matchingToken("CREATE", "keyword"));
  assert.ok(matchingToken("TABLE", "keyword"));
  assert.ok(matchingToken("user_account", "source"));
  assert.ok(matchingToken("BIGINT", "type"));
  assert.ok(matchingToken("VARCHAR", "type"));
  assert.ok(matchingToken("TIMESTAMP", "type"));
  assert.ok(matchingToken("NOW", "function"));
});

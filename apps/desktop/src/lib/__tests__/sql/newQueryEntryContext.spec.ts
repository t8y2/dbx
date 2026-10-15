import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression coverage for https://github.com/t8y2/dbx/issues/11517.
//
// Every ad-hoc "new query" entry (app toolbar, keyboard shortcut, welcome
// screen, editor-group "+") funnels into App.vue's newQuery(). That shared entry
// used to carry a sticky `newQueryContextSource`, which the sidebar selection
// watcher set to "sidebar" while only the active-tab watcher and editor-group
// "+" reset it. The global toolbar and shortcut could therefore use a stale
// sidebar connection instead of the editor the user was looking at.
//
// The precedence itself is unit-tested in newQueryContext.spec.ts; this suite
// pins the App.vue wiring, because App.vue is a large SFC the suite never mounts.
const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");

function bodyOf(fnSignature: string): string {
  const start = appSource.indexOf(fnSignature);
  expect(start, `expected to find "${fnSignature}" in App.vue`).toBeGreaterThanOrEqual(0);
  const closingParen = appSource.indexOf(")", start);
  const searchStart = closingParen >= 0 ? closingParen : start;
  const braceStart = appSource.indexOf("{", searchStart);
  let depth = 0;
  for (let i = braceStart; i < appSource.length; i++) {
    if (appSource[i] === "{") depth++;
    else if (appSource[i] === "}") {
      depth--;
      if (depth === 0) return appSource.slice(braceStart, i + 1);
    }
  }
  throw new Error(`unbalanced braces reading body of "${fnSignature}"`);
}

describe("new query entry context wiring", () => {
  it("does not keep a sticky context source that can outrank the active tab", () => {
    expect(appSource).not.toContain("newQueryContextSource");
  });

  it("resolves the shared new-query entry from the active tab and unique online SQL connection", () => {
    const body = bodyOf("async function newQuery");
    expect(body).toContain('quickConnectionOpenTarget(connection).kind === "query"');
    expect(body).toContain("connectedSqlConnectionIds,");
    expect(body).toContain("preferredSource: options.preferredSource");
  });

  it("creates an unbound editor for manual SQL connection selection when the target is ambiguous", () => {
    const body = bodyOf("async function newQuery");
    expect(body).toContain("if (sqlConnections.length > 0)");
    expect(body).toContain('queryStore.createTab("", "", undefined, "query")');
  });

  it("keeps the editor-group entry focused on its own group and tab context", () => {
    const body = bodyOf("newQuery: (groupId: string) =>");
    expect(body).toContain("queryStore.focusGroup(groupId)");
    expect(body).toContain('preferredSource: "tab"');
  });

  it("routes keyboard shortcut with sidebar context when the sidebar is focused (#11801)", () => {
    const body = bodyOf("async function handleKeydown");
    expect(body).toContain('sidebarFocused ? "sidebar" : undefined');
  });

  it("routes the app toolbar through the last focused sidebar context (#11791)", () => {
    const toolbar = appSource.slice(appSource.indexOf("<AppToolbar"), appSource.indexOf("/>", appSource.indexOf("<AppToolbar")));
    expect(toolbar).toContain(`@new-query="newQuery({ preferredSource: lastFocusedSidebarSurface ? 'sidebar' : undefined })"`);
  });

  it("opens the database default query for Cmd+Enter from the sidebar", () => {
    const body = bodyOf("async function handleKeydown");
    expect(body).toContain("isExecuteSqlShortcut(e, shortcuts) && defaultQueryShortcutTarget");
    expect(body).toContain('newQuery({ preferredSource: "sidebar", openDefault: true })');
    expect(bodyOf("async function newQuery")).toContain("queryStore.openDefaultQuery");
  });

  it("clears lastFocusedSidebarSurface when editor content is clicked", () => {
    expect(appSource).toContain("rememberEditorContentSurface");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Regression coverage for https://github.com/t8y2/dbx/issues/11517 and
// https://github.com/t8y2/dbx/issues/11791.
//
// Every ad-hoc "new query" entry (app toolbar, keyboard shortcut, welcome
// screen, editor-group "+") funnels into App.vue's newQuery(). The context
// source it passes to the resolver must follow the surface the user last
// worked in. It used to be set by a watcher on the sidebar selection id and
// reset only on tab switches, so returning to the editor without switching
// tabs kept a stale sidebar context (#11517). Removing the source altogether
// then made a freshly selected sidebar database lose to the active tab (#11791).
//
// The precedence itself is unit-tested in newQueryContext.spec.ts; this suite
// pins the App.vue wiring, because App.vue is a large SFC the suite never mounts.
const appSource = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");

function bodyOf(fnSignature: string): string {
  const start = appSource.indexOf(fnSignature);
  expect(start, `expected to find "${fnSignature}" in App.vue`).toBeGreaterThanOrEqual(0);
  const braceStart = appSource.indexOf("{", start);
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
  it("derives the context source from pointer and focus events on the sidebar and editor area", () => {
    const sidebar = appSource.slice(appSource.indexOf("<AppSidebar"), appSource.indexOf("/>", appSource.indexOf("<AppSidebar")));
    expect(sidebar).toContain(`@pointerdown.capture="newQueryContextSource = 'sidebar'"`);
    expect(sidebar).toContain(`@focusin.capture="newQueryContextSource = 'sidebar'"`);
    const editorArea = appSource.slice(appSource.indexOf("data-editor-content"), appSource.indexOf(">", appSource.indexOf("data-editor-content")));
    expect(editorArea).toContain(`@pointerdown.capture="newQueryContextSource = 'tab'"`);
    expect(editorArea).toContain(`@focusin.capture="newQueryContextSource = 'tab'"`);
  });

  it("resolves the shared new-query entry from the context source and unique online SQL connection", () => {
    const body = bodyOf("async function newQuery()");
    expect(body.match(/preferredSource: newQueryContextSource\.value,/g)).toHaveLength(2);
    expect(body).toContain('quickConnectionOpenTarget(connection).kind === "query"');
    expect(body).toContain("connectedSqlConnectionIds,");
  });

  it("creates an unbound editor for manual SQL connection selection when the target is ambiguous", () => {
    const body = bodyOf("async function newQuery()");
    expect(body).toContain("if (sqlConnections.length > 0)");
    expect(body).toContain('queryStore.createTab("", "", undefined, "query")');
  });

  it("keeps the editor-group entry focused on its own group", () => {
    const body = bodyOf("newQuery: (groupId: string) =>");
    expect(body).toContain("queryStore.focusGroup(groupId)");
    expect(body).toContain('newQueryContextSource.value = "tab"');
  });
});

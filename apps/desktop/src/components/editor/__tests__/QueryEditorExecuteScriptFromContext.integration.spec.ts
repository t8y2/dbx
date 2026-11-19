// @vitest-environment happy-dom

import { EditorView } from "@codemirror/view";
import { createPinia } from "pinia";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, h, type App } from "vue";
import { createI18n } from "vue-i18n";
import QueryEditor from "../QueryEditor.vue";
import { useSettingsStore } from "@/stores/settingsStore";
import { executableStatementRanges } from "@/lib/sql/sqlStatementRanges";
import type { SqlExecutionSnapshot } from "@/lib/sql/sqlExecutionTarget";

const procedure = "CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\nEND //";
const ordinary = "SELECT 2;";
const script = ["SELECT 'before';", "DELIMITER //", "", procedure, "DELIMITER ;", ordinary].join("\n");

let app: App | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  app?.unmount();
  host?.remove();
  vi.restoreAllMocks();
});

async function executeFromContext(sql: string, rightClick: number): Promise<SqlExecutionSnapshot> {
  const pinia = createPinia();
  useSettingsStore(pinia).editorSettings.sidebarMenuLayout = "full";
  const request = vi.fn<(snapshot: SqlExecutionSnapshot) => void>();
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(QueryEditor, { modelValue: sql, databaseType: "mysql", dialect: "mysql", autoFocus: false, onExecute: request }) });
  app.use(pinia);
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
  app.mount(host);

  const editor = await vi.waitFor(
    () => {
      const element = host!.querySelector<HTMLElement>(".cm-editor");
      expect(element).not.toBeNull();
      return EditorView.findFromDOM(element!);
    },
    { timeout: 5000 },
  );
  expect(editor?.state.selection.main.head).toBe(0);
  // happy-dom has no layout. Keep the actual context menu and execution event,
  // replacing only the pointer-to-document coordinate calculation.
  vi.spyOn(EditorView.prototype, "posAtCoords").mockReturnValue(rightClick);
  host.querySelector("[data-query-editor-root]")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  const action = await vi.waitFor(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("[data-dbx-context-menu] button")].find((item) => item.textContent?.includes("editor.contextMenu.executeScriptFromHere"));
    expect(button).toBeDefined();
    return button!;
  });
  action.click();
  expect(request).toHaveBeenCalledTimes(1);
  return request.mock.calls[0]![0];
}

function expectMappedStatements(request: SqlExecutionSnapshot, source: string, statements: string[]) {
  expect(request.fullSql).toBe(source);
  expect(request.selectionTo).toBe(source.length);
  const ranges = executableStatementRanges(request.selectedSql, "mysql");
  expect(ranges.map((range) => range.sql)).toEqual(statements);
  for (const range of ranges) {
    expect(request.selectionFrom + range.from).toBe(source.indexOf(range.sql));
  }
}

describe("QueryEditor execute script from a MySQL context position", () => {
  it("keeps the source directive and skips preceding SQL when the directive is clicked", async () => {
    const offset = script.indexOf("DELIMITER //");
    const request = await executeFromContext(script, offset + 2);
    expect(request.selectedSql).toBe(script.slice(offset));
    expectMappedStatements(request, script, [procedure.slice(0, -3), "SELECT 2"]);
  });

  it.each([
    ["the routine definition", script.indexOf("CREATE PROCEDURE") + 7],
    ["the routine body", script.indexOf("SELECT 1") + 4],
    ["the blank line after the directive", script.indexOf("\n\nCREATE") + 1],
  ])("keeps the active delimiter when right-clicking %s", async (_name, position) => {
    const request = await executeFromContext(script, position);
    expect(request.selectedSql).toBe(`DELIMITER //\n${script.slice(script.indexOf(procedure))}`);
    expectMappedStatements(request, script, [procedure.slice(0, -3), "SELECT 2"]);
  });

  it("runs only the requested suffix after restoring the normal delimiter", async () => {
    const request = await executeFromContext(script, script.indexOf(ordinary) + 2);
    expect(request.selectedSql).toBe(ordinary);
    expectMappedStatements(request, script, ["SELECT 2"]);
  });

  it("reuses the lexical delimiter without executing earlier statements or reading directives inside comments and strings", async () => {
    const sql = ["DELIMITER //", "SELECT 'previous", "DELIMITER $$", "string' //", "/*", "DELIMITER ;;", "*/", procedure, "DELIMITER ;", ordinary].join("\n");
    const request = await executeFromContext(sql, sql.indexOf("SELECT 1") + 3);
    expect(request.selectedSql).toBe(`DELIMITER //\n${sql.slice(sql.indexOf(procedure))}`);
    expectMappedStatements(request, sql, [procedure.slice(0, -3), "SELECT 2"]);
  });

  it.each([
    ["the whitespace before a semicolon", " ;", 0, ["SELECT 1", "SELECT 2"]],
    ["the semicolon", ";", 0, ["SELECT 1", "SELECT 2"]],
    ["a trailing comment", "-- first tail", 5, ["SELECT 1", "SELECT 2"]],
    ["the last trailing comment", "# last tail", 5, ["SELECT 2"]],
    ["the blank line between statements", "\n\n", 1, ["SELECT 2"]],
  ])("starts at the expected statement when right-clicking %s", async (_name, token, offset, expected) => {
    const sql = "SELECT 1   ; -- first tail\n\nSELECT 2   ; # last tail";
    const request = await executeFromContext(sql, sql.indexOf(token) + offset);
    expect(request.selectedSql).toBe(sql.slice(sql.indexOf(expected[0])));
    expectMappedStatements(request, sql, expected);
  });

  it("starts at the next statement when right-clicking its text on the same line", async () => {
    const sql = "SELECT 1; SELECT 2;";
    const request = await executeFromContext(sql, sql.indexOf("SELECT 2"));
    expect(request.selectedSql).toBe("SELECT 2;");
    expectMappedStatements(request, sql, ["SELECT 2"]);
  });

  it("keeps the routine when right-clicking its custom delimiter and trailing comment on the next line", async () => {
    const sql = ["SELECT 'before';", "DELIMITER //", procedure.slice(0, -3), "  // -- routine tail", "DELIMITER ;", ordinary].join("\n");
    const request = await executeFromContext(sql, sql.indexOf("routine tail"));
    expect(request.selectedSql).toBe(`DELIMITER //\n${sql.slice(sql.indexOf("CREATE PROCEDURE"))}`);
    expectMappedStatements(request, sql, [procedure.slice(0, -3), "SELECT 2"]);
  });
});

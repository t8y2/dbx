// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { currentInlineQueryResults, inlineQueryResultSnapshots, inlineQueryResultsExtension, setInlineQueryResults } from "./inlineQueryResults";
import { createInlineQueryResultPortal } from "./inlineQueryResultPortal";
import type { QueryResult } from "@/types/database";
const sql = "select 1;\nselect 2;";
const result = (overrides: Partial<QueryResult> = {}): QueryResult => ({ columns: ["value"], rows: [[1]], affected_rows: 0, execution_time_ms: 1, sourceFrom: 0, sourceTo: 9, sourceStatement: "select 1;", ...overrides }) as QueryResult;
let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
  document.body.replaceChildren();
});
function mount() {
  const parent = document.createElement("div");
  document.body.append(parent);
  const mountHost = vi.fn();
  const unmountHost = vi.fn();
  view = new EditorView({ parent, state: EditorState.create({ doc: sql, extensions: inlineQueryResultsExtension({ mount: mountHost, unmount: unmountHost }) }) });
  view.dispatch({ effects: setInlineQueryResults.of(inlineQueryResultSnapshots(sql, [result()])) });
  return { editor: view, mountHost, unmountHost };
}
describe("inline query result hosts", () => {
  it("creates a non-editable host without copying result data or inserting SQL", () => {
    const { editor, mountHost } = mount();
    const host = editor.dom.querySelector<HTMLElement>(".cm-inline-query-result")!;
    expect(host.contentEditable).toBe("false");
    expect(host.children).toHaveLength(0);
    expect(mountHost).toHaveBeenCalledWith(host, expect.objectContaining({ sourceStatement: "select 1;" }));
    expect(editor.state.doc.toString()).toBe(sql);
  });
  it("preserves the host while editing and removes it only when the whole statement is deleted", () => {
    const { editor, unmountHost } = mount();
    editor.dispatch({ effects: setInlineQueryResults.of(inlineQueryResultSnapshots(sql, [result({ sourceFrom: 10, sourceTo: 19, sourceStatement: "select 2;" })])) });
    const host = editor.dom.querySelector(".cm-inline-query-result");
    editor.dispatch({ changes: { from: 0, insert: "-- prefix\n" } });
    expect(editor.dom.querySelector(".cm-inline-query-result")).toBe(host);
    editor.dispatch({ changes: { from: 27, to: 28, insert: "3" } });
    expect(editor.dom.querySelector(".cm-inline-query-result")).toBe(host);
    const range = currentInlineQueryResults(editor)[0]!;
    editor.dispatch({ changes: { from: range.from, to: range.to } });
    expect(editor.dom.querySelector(".cm-inline-query-result")).toBeNull();
    expect(unmountHost).toHaveBeenCalledWith(host, expect.anything());
  });
  it("removes the target when results are cleared", () => {
    const { editor, unmountHost } = mount();
    editor.dispatch({ effects: setInlineQueryResults.of([]) });
    expect(editor.dom.querySelector(".cm-inline-query-result")).toBeNull();
    expect(unmountHost).toHaveBeenCalledTimes(1);
  });
  it("rejects stale positions and failed results", () => {
    expect(inlineQueryResultSnapshots(sql, [result({ sourceStatement: "select 2;" }), result({ sourceFrom: undefined }), result({ execution_error: true })])).toEqual([]);
  });
  it("keeps the original result including all rows and columns", () => {
    const original = result({ columns: Array.from({ length: 25 }, (_, index) => String(index)), rows: Array.from({ length: 100 }, () => [1]) });
    expect(inlineQueryResultSnapshots(sql, [original])[0]?.result).toBe(original);
  });
  it("does not remove a replacement target during old host cleanup", () => {
    const portal = createInlineQueryResultPortal();
    const first = document.createElement("div");
    const second = document.createElement("div");
    const original = result();
    portal.mount("tab", original, first);
    portal.mount("tab", original, second);
    portal.unmount("tab", original, first);
    expect(portal.targets.get("tab")?.get(original)).toBe(second);
    portal.unmount("tab", original, second);
    expect(portal.targets.has("tab")).toBe(false);
  });
  it("keeps two independent result hosts through editing and result synchronization", () => {
    const { editor } = mount();
    const first = result();
    const second = result({ sourceFrom: 10, sourceTo: 19, sourceStatement: "select 2;" });
    editor.dispatch({ effects: setInlineQueryResults.of(inlineQueryResultSnapshots(sql, [first, second])) });
    const hosts = [...editor.dom.querySelectorAll(".cm-inline-query-result")];
    expect(hosts).toHaveLength(2);
    editor.dispatch({ changes: { from: 7, to: 8, insert: "123" } });
    editor.dispatch({ effects: setInlineQueryResults.of(inlineQueryResultSnapshots(editor.state.doc.toString(), [first, second], currentInlineQueryResults(editor))) });
    expect([...editor.dom.querySelectorAll(".cm-inline-query-result")]).toEqual(hosts);
    expect(currentInlineQueryResults(editor).map(({ from, to }) => [from, to])).toEqual([
      [0, 11],
      [12, 21],
    ]);
  });
  it("bounds the grid viewport independently of the SQL content width", () => {
    const { editor } = mount();
    Object.defineProperty(editor.scrollDOM, "clientWidth", { value: 800, configurable: true });
    editor.dispatch({ effects: setInlineQueryResults.of(inlineQueryResultSnapshots(sql, [result()])) });
    expect(editor.dom.querySelector<HTMLElement>(".cm-inline-query-result")?.style.width).toBe("792px");
  });
  it("keeps the edited statement anchor when paging replaces the result payload", () => {
    const { editor } = mount();
    editor.dispatch({ changes: { from: 7, to: 8, insert: "123" } });
    const nextPage = result({ rows: [[2]] });
    editor.dispatch({ effects: setInlineQueryResults.of(inlineQueryResultSnapshots(editor.state.doc.toString(), [nextPage], currentInlineQueryResults(editor))) });
    expect(currentInlineQueryResults(editor)[0]).toMatchObject({ from: 0, to: 11, result: nextPage });
    expect(editor.dom.querySelector(".cm-inline-query-result")).not.toBeNull();
  });
});

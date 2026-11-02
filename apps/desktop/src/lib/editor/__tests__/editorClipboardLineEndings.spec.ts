import { strict as assert } from "node:assert";
import { afterEach, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorClipboardLineEndingsExtension } from "@/lib/editor/editorClipboardLineEndings";

const SQL = "SELECT 1\nFROM t\nWHERE a = 1;";

/** Run the document through the filters CodeMirror applies to copied text. */
function copiedText(state: EditorState, text: string): string {
  return state.facet(EditorView.clipboardOutputFilter).reduce((value, filter) => filter(value, state), text);
}

function stateWithExtension(): EditorState {
  return EditorState.create({ doc: SQL, extensions: [editorClipboardLineEndingsExtension(EditorView)] });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubPlatform(userAgent: string) {
  vi.stubGlobal("navigator", { userAgent });
}

test("copied editor text uses CRLF on Windows", () => {
  stubPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  assert.equal(copiedText(stateWithExtension(), SQL), "SELECT 1\r\nFROM t\r\nWHERE a = 1;");
});

test("the document itself keeps LF", () => {
  stubPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  assert.equal(stateWithExtension().doc.toString(), SQL);
});

test("copied editor text keeps LF on macOS", () => {
  stubPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)");
  assert.equal(copiedText(stateWithExtension(), SQL), SQL);
});

test("single-line text is unchanged on Windows", () => {
  stubPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  assert.equal(copiedText(stateWithExtension(), "SELECT 1;"), "SELECT 1;");
});

test("a view without the facet contributes no extension", () => {
  const state = EditorState.create({ doc: SQL, extensions: [editorClipboardLineEndingsExtension({})] });
  assert.deepEqual(state.facet(EditorView.clipboardOutputFilter), []);
});

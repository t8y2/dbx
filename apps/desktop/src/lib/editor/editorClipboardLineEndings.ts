import type { Extension } from "@codemirror/state";
import { clipboardLineEndings } from "@/lib/common/clipboard";

type EditorViewWithClipboardFilter = {
  clipboardOutputFilter?: { of(filter: (text: string) => string): Extension };
};

/**
 * Give text copied out of a CodeMirror editor the same line endings as every other DBX
 * copy path.
 *
 * `copyToClipboard` rewrites line endings to CRLF on Windows, but CodeMirror serves
 * Ctrl+C/Ctrl+X itself and writes `text/plain` straight from the document, which always
 * uses `\n`. Windows native edit controls (the Win32 EDIT control, and the WinForms apps
 * built on it) treat only CRLF as a line break, so a multi-line statement copied from an
 * editor arrives there as a single line.
 *
 * `EditorView.clipboardOutputFilter` is CodeMirror's own hook for copy/cut/drag text, so
 * the document keeps using `\n` and only what leaves the editor is rewritten.
 */
export function editorClipboardLineEndingsExtension(editorView: EditorViewWithClipboardFilter | null | undefined): Extension {
  const facet = editorView?.clipboardOutputFilter;
  // The facet arrived in @codemirror/view 6.32; without it the copy path keeps LF.
  if (!facet) return [];
  return facet.of((text) => clipboardLineEndings(text));
}

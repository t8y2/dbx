// Pure helpers for applying a snippet completion across multiple cursors/lines.
// Issue #14096: accepting a snippet while multiple cursors are active (or a
// selection spans several lines) only replaces the main cursor's token, leaving
// the other lines untouched. These helpers expand the snippet template once and
// replace each cursor's completion token with that expansion.

import type { EditorView } from "@codemirror/view";

/**
 * Expand a CodeMirror snippet template into plain text, filling every `${}`
 * field with its default value (so `${1:table_name}` becomes `table_name` and
 * `${0}` / `${name}` collapse to the empty string). Multi-cursor acceptance
 * cannot activate per-instance Tab navigation, so the snippet is inserted as
 * static text — matching what the single-cursor path produces after the user
 * tabs through all fields.
 */
export function expandSnippetTemplate(template: string): string {
  return (
    template
      // `${1:default}` -> default (numbered fields)
      .replace(/\$\{(\d+):([^{}]*)\}/g, (_match, _seq: string, defaultValue: string) => defaultValue)
      // `${0}` -> "" (final cursor position)
      .replace(/\$\{0\}/g, "")
      // `${name}` -> "" (named fields)
      .replace(/\$\{([^{}]*)\}/g, "")
  );
}

/**
 * Compute the token span to replace for each cursor. The main cursor (whose
 * head is `mainHead`) reuses the completion framework's `[mainFrom, mainTo]`
 * span; every other cursor matches the identifier-ish token immediately before
 * its head (the `sf` prefix), falling back to a plain insertion at the head.
 */
export function snippetReplacementSpans(heads: number[], mainHead: number, mainFrom: number, mainTo: number, lineFrom: (pos: number) => number, sliceDoc: (from: number, to: number) => string): Array<{ from: number; to: number }> {
  return heads.map((head) => {
    if (head === mainHead) return { from: mainFrom, to: mainTo };
    // Walk back over identifier characters (word chars, `.`, `$`) from head.
    const lineStart = lineFrom(head);
    let from = head;
    while (from > lineStart) {
      const ch = sliceDoc(from - 1, from);
      if (/[\w$.]/.test(ch)) from -= 1;
      else break;
    }
    return { from, to: head };
  });
}

/**
 * Apply `template` as plain text at every cursor in `view.state.selection`,
 * replacing each cursor's completion token (the typed snippet prefix). Used
 * when the completion is accepted with multiple cursors active, where the
 * single-cursor CodeMirror `snippet()` apply would only touch the main cursor.
 */
export function applySnippetAcrossRanges(view: EditorView, template: string, mainFrom: number, mainTo: number): void {
  const ranges = view.state.selection.ranges;
  const mainHead = ranges[0]?.head ?? mainTo;
  const heads = ranges.map((range) => range.head);
  const spans = snippetReplacementSpans(
    heads,
    mainHead,
    mainFrom,
    mainTo,
    (pos) => view.state.doc.lineAt(pos).from,
    (from, to) => view.state.sliceDoc(from, to),
  );
  const insert = expandSnippetTemplate(template);
  const changes = spans.map((span) => ({ from: span.from, to: span.to, insert }));
  view.dispatch({ changes, selection: { anchor: mainFrom + insert.length }, scrollIntoView: true });
}

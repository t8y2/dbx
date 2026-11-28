import { RangeSet, type Extension } from "@codemirror/state";
import { GutterMarker, gutterLineClass } from "@codemirror/view";

class ActiveLineGutterMarker extends GutterMarker {
  elementClass = "cm-activeLineGutter";
}

const activeLineGutterMarker = new ActiveLineGutterMarker();

/**
 * `highlightActiveLineGutter`, limited to cursors the way the editor's own
 * active-line highlight already is: once the main selection is a range, no line
 * is active in the content, so none is in the gutter either.
 *
 * Besides keeping the two highlights in step, this is what keeps a drag cheap.
 * CodeMirror re-syncs every gutter element of the viewport whenever the gutter
 * line classes change, and a class that follows the selection head changes on
 * every pointer move that crosses a line — re-rendering the line number, run,
 * fold and bookmark markers of the lines it leaves and enters each time.
 */
export function highlightActiveCursorLineGutter(): Extension {
  return gutterLineClass.compute(["selection"], (state) => {
    if (!state.selection.main.empty) return RangeSet.empty;
    const marks = [];
    let last = -1;
    for (const range of state.selection.ranges) {
      if (!range.empty) continue;
      const lineStart = state.doc.lineAt(range.head).from;
      if (lineStart > last) {
        last = lineStart;
        marks.push(activeLineGutterMarker.range(lineStart));
      }
    }
    return RangeSet.of(marks);
  });
}

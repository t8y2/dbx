import { layer, RectangleMarker, type EditorView } from "@codemirror/view";

function domRangeForSelection(view: EditorView, from: number, to: number): Range | null {
  try {
    const start = view.domAtPos(from);
    const end = view.domAtPos(to, -1);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  } catch {
    // domAtPos may throw for positions outside the viewport.
  }
  return null;
}

export function vscodeSelectionLayer() {
  return layer({
    above: false,
    class: "cm-vscodeSelectionLayer",
    markers(view) {
      const markers: InstanceType<typeof RectangleMarker>[] = [];
      const baseRect = view.scrollDOM.getBoundingClientRect();
      const base = {
        left: baseRect.left - view.scrollDOM.scrollLeft * view.scaleX,
        top: baseRect.top - view.scrollDOM.scrollTop * view.scaleY,
      };
      for (const r of view.state.selection.ranges) {
        if (r.empty) continue;
        const range = domRangeForSelection(view, r.from, r.to);
        if (!range) continue;
        const rects = Array.from(range.getClientRects());
        for (const rect of rects) {
          if (rect.width <= 0 || rect.height <= 0) continue;
          markers.push(
            new RectangleMarker(
              "cm-vscodeSelection",
              rect.left - base.left,
              rect.top - base.top,
              rect.width,
              rect.height,
            ),
          );
        }
        range.detach();
      }
      return markers;
    },
    update(update, _dom) {
      return update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged;
    },
  });
}

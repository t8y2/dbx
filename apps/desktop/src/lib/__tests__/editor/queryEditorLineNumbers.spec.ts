import { describe, expect, it, vi } from "vitest";
import { createQueryEditorLineNumberAlignmentExtension } from "@/lib/editor/queryEditorLineNumbers";

type MeasureSpec = {
  read: (view: unknown) => unknown;
  write: (data: unknown) => void;
};

function createPluginClass() {
  let captured: unknown;
  const FakeViewPlugin = {
    fromClass(cls: unknown) {
      captured = cls;
      return cls;
    },
  };
  createQueryEditorLineNumberAlignmentExtension(FakeViewPlugin as unknown as typeof import("@codemirror/view").ViewPlugin);
  return captured as unknown as new (view: FakeView) => {
    update: (update: { docChanged?: boolean; geometryChanged?: boolean; viewportChanged?: boolean; view: FakeView }) => void;
    docViewUpdate: (view: FakeView) => void;
  };
}

class FakeView {
  lineWrapping: boolean;
  requestMeasure = vi.fn((spec: MeasureSpec) => {
    spec.write(spec.read(this));
  });
  defaultLineHeight = 20;
  dom = {
    querySelectorAll: () => [] as HTMLElement[],
  };

  constructor(lineWrapping: boolean) {
    this.lineWrapping = lineWrapping;
  }
}

describe("query editor line number alignment extension", () => {
  it("skips gutter measurement while line wrapping is off and clears once on transitions", () => {
    const PluginClass = createPluginClass();
    const view = new FakeView(false);
    const plugin = new PluginClass(view);

    // Constructor runs one pass because the initial state assumes wrapping
    // until proven otherwise; that pass clears any stale inline alignment.
    expect(view.requestMeasure).toHaveBeenCalledTimes(1);

    // Steady state without wrapping: geometry changes (every drag frame)
    // must not schedule further gutter reads.
    plugin.update({ geometryChanged: true, view });
    plugin.update({ docChanged: true, view });
    plugin.docViewUpdate(view);
    expect(view.requestMeasure).toHaveBeenCalledTimes(1);

    // Enabling wrapping resumes measurement.
    view.lineWrapping = true;
    plugin.update({ geometryChanged: true, view });
    expect(view.requestMeasure).toHaveBeenCalledTimes(2);

    // Disabling wrapping runs exactly one clearing pass, then stops again.
    view.lineWrapping = false;
    plugin.update({ geometryChanged: true, view });
    expect(view.requestMeasure).toHaveBeenCalledTimes(3);
    plugin.update({ viewportChanged: true, view });
    expect(view.requestMeasure).toHaveBeenCalledTimes(3);
  });
});

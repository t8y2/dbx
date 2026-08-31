import type { Extension } from "@codemirror/state";
import type { lineNumbers } from "@codemirror/view";

type LineNumbersFactory = typeof lineNumbers;
type LineNumbersConfig = NonNullable<Parameters<LineNumbersFactory>[0]>;

export const WRAPPED_LINE_NUMBER_GUTTER_CLASS = "cm-db-wrapped-line-number";

export function isWrappedLineNumberGutter(gutterHeight: number, lineHeight: number): boolean {
  return gutterHeight > lineHeight + 1;
}

export function buildQueryEditorLineNumbersExtension(factory: LineNumbersFactory | null, enabled: boolean, config: LineNumbersConfig): Extension {
  return enabled && factory ? factory(config) : [];
}

export function createQueryEditorLineNumberAlignmentExtension(ViewPlugin: typeof import("@codemirror/view").ViewPlugin): Extension {
  return ViewPlugin.fromClass(
    class {
      private measureScheduled = false;

      constructor(view: import("@codemirror/view").EditorView) {
        this.scheduleMeasure(view);
      }

      update(update: import("@codemirror/view").ViewUpdate) {
        if (update.docChanged || update.geometryChanged || update.viewportChanged) this.scheduleMeasure(update.view);
      }

      docViewUpdate(view: import("@codemirror/view").EditorView) {
        this.scheduleMeasure(view);
      }

      private scheduleMeasure(view: import("@codemirror/view").EditorView) {
        if (this.measureScheduled) return;
        this.measureScheduled = true;
        view.requestMeasure({
          read: (measuredView) => {
            const lineHeight = measuredView.defaultLineHeight;
            return [...measuredView.dom.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement")].map((element) => ({
              element,
              wrapped: isWrappedLineNumberGutter(element.getBoundingClientRect().height, lineHeight),
            }));
          },
          write: (measurements) => {
            this.measureScheduled = false;
            for (const { element, wrapped } of measurements) element.classList.toggle(WRAPPED_LINE_NUMBER_GUTTER_CLASS, wrapped);
          },
        });
      }
    },
  );
}

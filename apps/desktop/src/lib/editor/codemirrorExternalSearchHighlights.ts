import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

export interface ExternalSearchHighlight {
  from: number;
  to: number;
  active?: boolean;
}

export const setExternalSearchHighlights = StateEffect.define<ExternalSearchHighlight[]>();

const matchDecoration = Decoration.mark({ class: "cm-externalSearchMatch" });
const activeMatchDecoration = Decoration.mark({ class: "cm-externalSearchMatchActive" });

function buildDecorations(highlights: readonly ExternalSearchHighlight[], length: number): DecorationSet {
  const ranges = highlights
    .filter(({ from, to }) => Number.isFinite(from) && Number.isFinite(to) && from < to)
    .flatMap(({ from, to, active }) => {
      const start = Math.max(0, Math.min(from, length));
      const end = Math.max(start, Math.min(to, length));
      return start < end ? [(active ? activeMatchDecoration : matchDecoration).range(start, end)] : [];
    })
    .sort((a, b) => a.from - b.from || a.to - b.to);
  return ranges.length ? Decoration.set(ranges) : Decoration.none;
}

export function externalSearchHighlights(): Extension {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, transaction) {
      let next = transaction.docChanged ? value.map(transaction.changes) : value;
      for (const effect of transaction.effects) {
        if (effect.is(setExternalSearchHighlights)) next = buildDecorations(effect.value, transaction.state.doc.length);
      }
      return next;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

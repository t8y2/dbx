import { StateEffect, StateField, type ChangeSet } from "@codemirror/state";
import { invertedEffects } from "@codemirror/commands";

/** Apply normalized editor offsets without rewriting untouched source line endings. */
export function applyChangesPreservingLineEndings(source: string, changes: ChangeSet): string {
  const lineEnding = source.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  let rawOffset = 0;
  let documentOffset = 0;
  function sourceOffset(target: number): number {
    while (documentOffset < target && rawOffset < source.length) {
      if (source[rawOffset] === "\r" && source[rawOffset + 1] === "\n") rawOffset++;
      rawOffset++;
      documentOffset++;
    }
    return rawOffset;
  }

  const parts: string[] = [];
  let copiedUntil = 0;
  changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
    const start = sourceOffset(from);
    const end = sourceOffset(to);
    parts.push(source.slice(copiedUntil, start), inserted.sliceString(0, inserted.length, lineEnding));
    copiedUntil = end;
  });
  parts.push(source.slice(copiedUntil));
  return parts.join("");
}

// Store raw source alongside the normalized document and include it in undo/redo.
export const restoreRawSource = StateEffect.define<string>();
export const rawSourceField = StateField.define<string>({
  create: () => "",
  update(source, transaction) {
    // Grouped history events carry newest-to-oldest inverse effects.
    for (let index = transaction.effects.length - 1; index >= 0; index--) {
      const effect = transaction.effects[index];
      if (effect.is(restoreRawSource)) return effect.value;
    }
    return transaction.docChanged ? applyChangesPreservingLineEndings(source, transaction.changes) : source;
  },
});

export function preserveSourceHistory(source: string) {
  return [rawSourceField.init(() => source), invertedEffects.of((transaction) => (transaction.docChanged || transaction.effects.some((effect) => effect.is(restoreRawSource)) ? [restoreRawSource.of(transaction.startState.field(rawSourceField))] : []))];
}

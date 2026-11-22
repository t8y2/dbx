import { closeBrackets, deleteBracketPair, insertBracket } from "@codemirror/autocomplete";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/legacy-modes/mode/javascript";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";

const inputStates = new WeakMap<HTMLTextAreaElement, EditorState>();
const language = StreamLanguage.define(javascript);

function textChange(before: string, after: string) {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let to = before.length;
  let end = after.length;
  while (to > from && end > from && before[to - 1] === after[end - 1]) {
    to--;
    end--;
  }
  return { from, to, insert: after.slice(from, end) };
}

/** Reuse the editor's pairing rules while retaining the textarea's native undo history. */
export function handleMongoQueryInputBrackets(event: KeyboardEvent, enabled: boolean): boolean {
  const input = event.currentTarget as HTMLTextAreaElement | null;
  if (!input) return false;
  if (!enabled) {
    inputStates.delete(input);
    return false;
  }
  if (event.isComposing || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || input.readOnly || input.disabled || input.ownerDocument.activeElement !== input) return false;
  if (event.key !== "Backspace" && !"()[]{}\"'`".includes(event.key)) return false;

  const text = input.value;
  const backward = input.selectionDirection === "backward";
  const selection = EditorSelection.single(backward ? input.selectionEnd : input.selectionStart, backward ? input.selectionStart : input.selectionEnd);
  let state = inputStates.get(input) ?? EditorState.create({ doc: text, extensions: [language, closeBrackets()] });
  // Map ordinary typing, paste and undo through the state so automatically
  // inserted closing brackets remain distinguishable from literal ones.
  state = state.update({ changes: textChange(state.doc.toString(), text), selection }).state;
  inputStates.set(input, state);

  // Keep the query bar's existing shorthand: starting with a quoted key opens
  // the surrounding document as well as the quote pair.
  if (!text && (event.key === '"' || event.key === "'")) state = insertBracket(state, "{")!.state;

  let transaction: Transaction | null = null;
  if (event.key === "Backspace") {
    deleteBracketPair({ state, dispatch: (value) => (transaction = value) });
  } else {
    transaction = insertBracket(state, event.key);
  }
  if (!transaction) return false;
  const nextState = transaction.state;
  const nextText = nextState.doc.toString();
  if (nextText !== text) {
    const change = textChange(text, nextText);
    input.setSelectionRange(change.from, change.to);
    // insertText participates in native undo; manual value replacement does not.
    if (!input.ownerDocument.execCommand("insertText", false, change.insert)) {
      input.setSelectionRange(selection.main.from, selection.main.to, backward ? "backward" : "forward");
      return false;
    }
  }
  const nextSelection = nextState.selection.main;
  input.setSelectionRange(nextSelection.from, nextSelection.to, nextSelection.anchor > nextSelection.head ? "backward" : "forward");
  inputStates.set(input, nextState);
  event.preventDefault();
  return true;
}

import type { Command } from "@codemirror/view";

interface QueryEditorEscapeOptions {
  clearBatchSelection: () => void;
  cancelPendingAcceptance: () => void;
  closeSearch: () => boolean;
  closeCompletion: Command;
}

/** Run at highest precedence, before the dynamically installed snippet keymap. */
export function createQueryEditorEscapeHandler(options: QueryEditorEscapeOptions): Command {
  return (view) => {
    options.clearBatchSelection();
    options.cancelPendingAcceptance();
    // Keep search dismissal first. Consume completion dismissal so Escape does
    // not reach clearSnippet and discard the remaining placeholder navigation.
    return options.closeSearch() || options.closeCompletion(view);
  };
}

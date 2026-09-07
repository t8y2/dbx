import type { EditorState } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";

type SelectedCompletionIndex = (state: EditorState) => number | null;
type CompletionStatus = (state: EditorState) => "active" | "pending" | null;

interface RetryCompletionAcceptanceOptions {
  completionStatus: CompletionStatus;
  acceptCompletion: Command | null;
  selectedCompletionIndex: SelectedCompletionIndex | null;
  selectFirstCompletion: Command | null;
  retryDelayMs: number;
  maxWaitMs: number;
  onUnavailable: () => void;
  onSettled?: () => void;
  /** Called before each retry; when an IME composition started while waiting, the queued acceptance must be dropped instead of fighting the IME. */
  isComposing?: () => boolean;
}

interface CompletionAcceptanceAttempt {
  handled: boolean;
  cancel?: () => void;
}

export function acceptSelectedOrFirstCompletion(view: EditorView, acceptCompletion: Command | null, selectedCompletionIndex: SelectedCompletionIndex | null, selectFirstCompletion: Command | null): boolean {
  if (!acceptCompletion) return false;
  if (!selectedCompletionIndex || !selectFirstCompletion) return acceptCompletion(view);
  if (selectedCompletionIndex(view.state) !== null) return acceptCompletion(view);
  if (!selectFirstCompletion(view)) return false;
  return acceptCompletion(view);
}

export function acceptSelectedCompletionWithRetry(view: EditorView, options: RetryCompletionAcceptanceOptions): CompletionAcceptanceAttempt {
  if (options.completionStatus(view.state) !== "active") return { handled: false };
  if (acceptSelectedOrFirstCompletion(view, options.acceptCompletion, options.selectedCompletionIndex, options.selectFirstCompletion)) return { handled: true };

  const initialDoc = view.state.doc;
  const initialSelectionRanges = view.state.selection.ranges.map((range) => ({ anchor: range.anchor, head: range.head }));
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  const settle = () => {
    if (settled) return;
    settled = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    options.onSettled?.();
  };

  const retry = () => {
    timer = null;
    if (settled) return;

    if (options.isComposing?.()) {
      settle();
      return;
    }

    const selectionRanges = view.state.selection.ranges;
    if (view.state.doc !== initialDoc || selectionRanges.length !== initialSelectionRanges.length || selectionRanges.some((range, index) => range.anchor !== initialSelectionRanges[index]?.anchor || range.head !== initialSelectionRanges[index]?.head)) {
      settle();
      return;
    }

    const completionStatus = options.completionStatus(view.state);
    if (completionStatus === "active" && acceptSelectedOrFirstCompletion(view, options.acceptCompletion, options.selectedCompletionIndex, options.selectFirstCompletion)) {
      settle();
      return;
    }
    if (completionStatus && Date.now() - startedAt < options.maxWaitMs) {
      timer = setTimeout(retry, options.retryDelayMs);
      return;
    }

    settle();
    options.onUnavailable();
  };

  timer = setTimeout(retry, options.retryDelayMs);
  return { handled: true, cancel: settle };
}

import type { EditorView as EditorViewType } from "@codemirror/view";
import { type QueryCompletionOption } from "./useQueryEditorBatchSelection";
import { insertQueryEditorNewline } from "@/lib/editor/queryEditorNewline";
import { isBatchColumnSelectionCompletionActive } from "@/lib/editor/batchColumnSelection";
import { normalizeShortcutSettings, shortcutToCodeMirrorKey } from "@/lib/editor/shortcutRegistry";
import { acceptSelectedCompletionWithRetry, acceptSelectedOrFirstCompletion } from "@/lib/editor/queryEditorCompletionAcceptance";
import type { QueryEditorProps } from "./queryEditorTypes";
import type { QueryEditorCodeMirrorRuntime } from "./queryEditorCodeMirrorRuntime";
import type { useSettingsStore } from "@/stores/settingsStore";
import type { useQueryEditorCompletion } from "./useQueryEditorCompletion";
import type { useQueryEditorBatchSelection } from "./useQueryEditorBatchSelection";

interface QueryEditorCompletionKeysOptions {
  props: Readonly<QueryEditorProps>;
  settingsStore: ReturnType<typeof useSettingsStore>;
  runtime: QueryEditorCodeMirrorRuntime;
  completion: Pick<ReturnType<typeof useQueryEditorCompletion>, "suppressAutoStartUntil">;
  batchSelection: Pick<ReturnType<typeof useQueryEditorBatchSelection>, "applySelectedBatchColumnSelection">;
  isEditorComposing: (view: EditorViewType) => boolean;
  retryDelayMs: number;
  tabMaxWaitMs: number;
  enterMaxWaitMs: number;
}

export function useQueryEditorCompletionKeys(options: QueryEditorCompletionKeysOptions) {
  const { props, settingsStore, runtime: codeMirrorRuntime, completion, isEditorComposing } = options;
  const { applySelectedBatchColumnSelection } = options.batchSelection;
  const COMPLETION_TAB_RETRY_DELAY_MS = options.retryDelayMs;
  const COMPLETION_TAB_MAX_WAIT_MS = options.tabMaxWaitMs;
  const COMPLETION_ENTER_MAX_WAIT_MS = options.enterMaxWaitMs;
  let pendingCompletionTabTimer: ReturnType<typeof setTimeout> | null = null;

  let cancelPendingCompletionEnter: (() => void) | null = null;

  // Resolve the indent unit (one Tab worth) from the SQL formatter settings so
  // the Tab key, multi-line indent and auto-indent all honor the configured width.
  function editorIndentUnit(): string {
    const { useTabs, tabWidth } = settingsStore.editorSettings.sqlFormatter;
    return useTabs ? "\t" : " ".repeat(tabWidth);
  }

  function handleTab(view: EditorViewType): boolean {
    if (isEditorComposing(view)) return false;
    if (view.state.selection.ranges.some((range) => !range.empty)) {
      // Snippet navigation selects the whole field, including after Shift+Tab.
      // Give that active session priority over ordinary selected-text indentation.
      return (codeMirrorRuntime.codeMirrorNextSnippetField?.(view) ?? false) || (codeMirrorRuntime.codeMirrorIndentMore?.(view) ?? false);
    }
    if (tabKeyAcceptsCompletion()) {
      return acceptCompletionOrNextSnippetField(view) || performNormalTab(view);
    }
    return handleTabWithoutAcceptingCompletion(view) || performNormalTab(view);
  }

  // The Tab key is always wired up for indentation and snippet-field navigation,
  // but it must only accept an open completion popup when the user's configured
  // "accept completion" shortcut is actually Tab — otherwise a user who remapped
  // that shortcut (e.g. to Enter) would find Tab silently accepting completions
  // anyway, ignoring their setting (dbx#6236).
  function tabKeyAcceptsCompletion(): boolean {
    const shortcuts = normalizeShortcutSettings(settingsStore.editorSettings.shortcuts);
    return shortcutToCodeMirrorKey(shortcuts.acceptCompletion) === "Tab";
  }

  function handleTabWithoutAcceptingCompletion(view: EditorViewType): boolean {
    if (codeMirrorRuntime.codeMirrorCompletionStatus?.(view.state)) return false;
    return codeMirrorRuntime.codeMirrorNextSnippetField?.(view) ?? false;
  }

  function performNormalTab(view: EditorViewType): boolean {
    const { state, dispatch } = view;
    if (state.selection.ranges.some((range) => !range.empty)) return codeMirrorRuntime.codeMirrorIndentMore?.(view) ?? false;
    const sel = state.selection.main;
    const line = state.doc.lineAt(sel.from);
    const before = line.text.slice(0, sel.from - line.from);
    if (/^\s*$/.test(before)) return codeMirrorRuntime.codeMirrorIndentMore?.(view) ?? false;
    dispatch(
      state.update(state.replaceSelection(editorIndentUnit()), {
        userEvent: "input.type",
      }),
    );
    return true;
  }

  function handleEnter(view: EditorViewType): boolean {
    // While an IME composition is active, Enter confirms the composition (the
    // candidate list); intercepting it here would accept a completion popup on
    // top of the composition instead of committing the typed text (issue #8029).
    if (isEditorComposing(view)) return false;
    clearPendingCompletionEnter();
    if (isBatchColumnSelectionCompletionActive(codeMirrorRuntime.codeMirrorCompletionStatus?.(view.state) ?? null) && applySelectedBatchColumnSelection(view)) return true;
    // CodeMirror's default completion keymap is disabled so batch selection can
    // take precedence. Preserve its normal single-item acceptance here.
    if (codeMirrorRuntime.codeMirrorAcceptCompletion?.(view)) return true;
    if (settingsStore.editorSettings.selectFirstCompletionOnOpen && codeMirrorRuntime.codeMirrorCompletionStatus) {
      let cancelRetry: (() => void) | null = null;
      const result = acceptSelectedCompletionWithRetry(view, {
        completionStatus: codeMirrorRuntime.codeMirrorCompletionStatus,
        acceptCompletion: codeMirrorRuntime.codeMirrorAcceptCompletion,
        selectedCompletionIndex: codeMirrorRuntime.codeMirrorSelectedCompletionIndex,
        selectFirstCompletion: codeMirrorRuntime.codeMirrorSelectFirstCompletion,
        retryDelayMs: COMPLETION_TAB_RETRY_DELAY_MS,
        maxWaitMs: COMPLETION_ENTER_MAX_WAIT_MS,
        isComposing: () => isEditorComposing(view),
        onUnavailable: () => insertNewlineWithoutCompletion(view),
        onSettled: () => {
          if (cancelPendingCompletionEnter === cancelRetry) cancelPendingCompletionEnter = null;
        },
      });
      if (result.handled) {
        cancelRetry = result.cancel ?? null;
        cancelPendingCompletionEnter = cancelRetry;
        return true;
      }
    }
    return insertNewlineWithoutCompletion(view);
  }

  function clearPendingCompletionEnter() {
    cancelPendingCompletionEnter?.();
    cancelPendingCompletionEnter = null;
  }

  function insertNewlineWithoutCompletion(view: EditorViewType): boolean {
    codeMirrorRuntime.codeMirrorCloseCompletion?.(view);
    completion.suppressAutoStartUntil = Date.now() + 750;
    const handled = insertQueryEditorNewline(view, codeMirrorRuntime.codeMirrorInsertNewlineKeepIndent, props.databaseType);
    if (!handled) completion.suppressAutoStartUntil = 0;
    return handled;
  }

  function acceptCompletionOrNextSnippetField(view: EditorViewType): boolean {
    // A non-empty selection belongs to snippet navigation or block indentation,
    // not word completion. A popup opened by an indent edit must not hijack Tab.
    if (isEditorComposing(view)) return false;
    if (view.state.selection.ranges.every((range) => range.empty)) {
      const completionStatus = codeMirrorRuntime.codeMirrorCompletionStatus?.(view.state) ?? null;
      if (isBatchColumnSelectionCompletionActive(completionStatus) && applySelectedBatchColumnSelection(view)) return true;
      if (completionStatus === "active" && acceptSelectedOrFirstCompletion(view, codeMirrorRuntime.codeMirrorAcceptCompletion, codeMirrorRuntime.codeMirrorSelectedCompletionIndex, codeMirrorRuntime.codeMirrorSelectFirstCompletion)) return true;
      if (completionStatus) return waitForCompletionTab(view);
    }
    return codeMirrorRuntime.codeMirrorNextSnippetField?.(view) ?? false;
  }

  function acceptSqlServerCompletionOnSpace(view: EditorViewType): boolean {
    if (isEditorComposing(view)) return false;
    if (props.databaseType !== "sqlserver" || !settingsStore.editorSettings.sqlServerSpaceConfirmsCompletion) return false;
    if (codeMirrorRuntime.codeMirrorCompletionStatus?.(view.state) !== "active") return false;
    // A non-empty selection belongs to block editing, not word completion.
    if (!view.state.selection.main.empty) return false;
    const selected = codeMirrorRuntime.codeMirrorSelectedCompletion?.(view.state) as QueryCompletionOption | null | undefined;
    const completionType = selected?.type;
    if (completionType !== "keyword" && completionType !== "table" && completionType !== "column") return false;
    // Batch-selection rows own Space for checkbox toggling; this Prec.highest binding outranks their keymap.
    if (selected?.dbxBatchColumnSelection || selected?.dbxBatchColumnSelectionAction) return false;
    if (!(codeMirrorRuntime.codeMirrorAcceptCompletion?.(view) ?? false)) return false;

    const selection = view.state.selection.main;
    if (!selection.empty) return true;
    const cursor = selection.head;
    const previousCharacter = cursor > 0 ? view.state.sliceDoc(cursor - 1, cursor) : "";
    if (/\s/.test(previousCharacter)) return true;

    const nextCharacter = view.state.sliceDoc(cursor, cursor + 1);
    if (/\s/.test(nextCharacter)) {
      view.dispatch({ selection: { anchor: cursor + 1 }, scrollIntoView: true });
    } else {
      view.dispatch({
        changes: { from: cursor, insert: " " },
        selection: { anchor: cursor + 1 },
        scrollIntoView: true,
      });
    }
    return true;
  }

  function clearPendingCompletionTab() {
    if (pendingCompletionTabTimer === null) return;
    clearTimeout(pendingCompletionTabTimer);
    pendingCompletionTabTimer = null;
  }

  function waitForCompletionTab(view: EditorViewType): boolean {
    clearPendingCompletionTab();
    const initialDoc = view.state.doc;
    const initialSelectionRanges = view.state.selection.ranges.map((range) => ({ anchor: range.anchor, head: range.head }));
    const startedAt = Date.now();

    const retry = () => {
      pendingCompletionTabTimer = null;
      // The user started an IME composition while waiting for the pending
      // completion; Tab now belongs to the candidate list, so drop the queued
      // acceptance (and the normal-Tab fallback) instead of fighting the IME.
      if (isEditorComposing(view)) return;
      const selectionRanges = view.state.selection.ranges;
      if (view.state.doc !== initialDoc || selectionRanges.length !== initialSelectionRanges.length || selectionRanges.some((range, index) => !range.empty || range.anchor !== initialSelectionRanges[index]?.anchor || range.head !== initialSelectionRanges[index]?.head)) return;

      const completionStatus = codeMirrorRuntime.codeMirrorCompletionStatus?.(view.state) ?? null;
      if (completionStatus === "active" && acceptSelectedOrFirstCompletion(view, codeMirrorRuntime.codeMirrorAcceptCompletion, codeMirrorRuntime.codeMirrorSelectedCompletionIndex, codeMirrorRuntime.codeMirrorSelectFirstCompletion)) return;
      if (completionStatus && Date.now() - startedAt < COMPLETION_TAB_MAX_WAIT_MS) {
        pendingCompletionTabTimer = setTimeout(retry, COMPLETION_TAB_RETRY_DELAY_MS);
        return;
      }

      // A pending completion may resolve without any applicable option. Preserve
      // snippet navigation first, then fall back to the editor's normal Tab action.
      if (codeMirrorRuntime.codeMirrorNextSnippetField?.(view)) return;
      performNormalTab(view);
    };

    pendingCompletionTabTimer = setTimeout(retry, COMPLETION_TAB_RETRY_DELAY_MS);
    return true;
  }

  return { editorIndentUnit, handleTab, handleEnter, acceptCompletionOrNextSnippetField, acceptSqlServerCompletionOnSpace, clearPendingCompletionEnter, clearPendingCompletionTab };
}

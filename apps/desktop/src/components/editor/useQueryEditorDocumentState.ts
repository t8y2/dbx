import { watch, nextTick } from "vue";
import { Transaction } from "@codemirror/state";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { createDeferredEditorTask } from "@/lib/editor/deferredEditorTask";
import { focusEditorView } from "@/lib/editor/queryEditorFocus";
import type { ShallowRef, Ref } from "vue";
import type { QueryEditorProps } from "./queryEditorTypes";

const BEFORE_TAB_SWITCH_EVENT = "dbx:before-tab-switch";

interface QueryEditorDocumentStateRuntime {
  historyResetComp: import("@codemirror/state").Compartment | null;
  codeMirrorHistory: typeof import("@codemirror/commands").history | null;
  codeMirrorEditorSelection: typeof import("@codemirror/state").EditorSelection | null;
  editorIsActive: boolean;
}

interface QueryEditorDocumentStateOptions {
  props: Readonly<QueryEditorProps>;
  view: ShallowRef<EditorViewType | null>;
  previewContextSql: Readonly<Ref<string>>;
  runtime: QueryEditorDocumentStateRuntime;
  emit: {
    (event: "selectionStateChange", selection: { anchor: number; head: number }): void;
    (event: "viewportChange", viewport: { scrollTop: number; scrollLeft: number }, tabId?: string): void;
    (event: "editorStateFlushed"): void;
    (event: "editorRevealConsumed"): void;
    (event: "previewChangesAvailable", value: boolean): void;
  };
  scheduleSemanticDiagnostics: (delay?: number, options?: { preserveOutsideRanges?: boolean }) => void;
  clearScheduledPreviewContextRefresh: () => void;
  syncContextMenuState: (view: EditorViewType) => void;
  applyEditorAppearance: () => Promise<void>;
  applyEditorShortcutKeymaps: () => void;
  applyEditorIndentExtension: () => void;
  applyEditorCompletionExtension: () => void;
  invalidateSemanticDiagnosticsForDocumentChange: () => void;
  currentEditorDocText: (view: EditorViewType) => string;
  scheduleDocumentSearchUpdate: () => void;
  isEditorComposing: (view: EditorViewType) => boolean;
}

export function useQueryEditorDocumentState(options: QueryEditorDocumentStateOptions) {
  const { isEditorComposing } = options;
  const {
    props,
    view,
    previewContextSql,
    runtime,
    emit,
    scheduleDocumentSearchUpdate,
    scheduleSemanticDiagnostics,
    clearScheduledPreviewContextRefresh,
    syncContextMenuState,
    applyEditorAppearance,
    applyEditorShortcutKeymaps,
    applyEditorIndentExtension,
    applyEditorCompletionExtension,
    invalidateSemanticDiagnosticsForDocumentChange,
    currentEditorDocText,
  } = options;

  let viewportOwnerTabId = props.tabId;
  const viewportEmitTask = createDeferredEditorTask(() => {
    if (latestViewport) emitEditorViewport(latestViewport);
  }, 150);
  let viewportRestoreFrame: number | null = null;
  let latestViewport: { scrollTop: number; scrollLeft: number } | undefined = props.initialViewport;
  let lastEmittedViewport: { scrollTop: number; scrollLeft: number } | undefined = props.initialViewport;
  let tabSwitchStateCaptured = false;
  let latestSelection: { anchor: number; head: number } | undefined = props.initialSelection;

  // A single editor instance serves every tab, so the document swap on tab
  // switches must not push "previous tab's content → new content" onto a shared
  // undo history (one undo in the new tab restored the old tab's text). Each
  // tab's editor state — including its undo history — is cached per tabId and
  // reinstalled with setState; first-seen tabs get the document swapped in with a
  // transaction excluded from history, and the history extension is dropped and
  // re-added in two separate transactions (a compartment reconfigure alone keeps
  // the old field value) so the previous tab's edits cannot leak in.
  const tabStateCache = new Map<string, import("@codemirror/state").EditorState>();
  const MAX_CACHED_TAB_STATES = 16;

  function swapEditorDocument(doc: string) {
    const currentView = view.value;
    if (!currentView || !runtime.historyResetComp || !runtime.codeMirrorHistory) return;
    if (doc !== currentView.state.doc.toString()) {
      currentView.dispatch({
        changes: { from: 0, to: currentView.state.doc.length, insert: doc },
        annotations: Transaction.addToHistory.of(false),
      });
    }
    currentView.dispatch({ effects: runtime.historyResetComp.reconfigure([]) });
    currentView.dispatch({ effects: runtime.historyResetComp.reconfigure(runtime.codeMirrorHistory()) });
    scheduleSemanticDiagnostics();
  }

  function activateTabDocument(prevTabId: string | undefined, tabId: string | undefined, doc: string) {
    const currentView = view.value;
    if (!currentView) return;
    // Flush the outgoing document before props and restored scroll positions
    // become the new tab's state. The event carries its original owner. A
    // before-tab-switch capture already flushed this editor while it was still
    // visible, so avoid reading the reset scroll position during the transition.
    if (!tabSwitchStateCaptured) flushEditorViewport();
    viewportOwnerTabId = tabId;
    latestViewport = props.initialViewport ?? { scrollTop: 0, scrollLeft: 0 };
    lastEmittedViewport = undefined;
    clearScheduledPreviewContextRefresh();
    if (prevTabId !== undefined) {
      tabStateCache.set(prevTabId, currentView.state);
      if (tabStateCache.size > MAX_CACHED_TAB_STATES) {
        const oldest = tabStateCache.keys().next();
        if (!oldest.done) tabStateCache.delete(oldest.value);
      }
    }
    const cached = tabId === undefined ? undefined : tabStateCache.get(tabId);
    if (!cached) {
      swapEditorDocument(doc);
      // First activation in this editor instance (or a cache-evicted tab, e.g.
      // beyond MAX_CACHED_TAB_STATES): restore the tab's saved cursor and scroll
      // position exactly like the cached-state branch, otherwise the swapped-in
      // document keeps whatever scroll offset the dispatch left behind (#8374).
      // A brand-new tab has no saved state, so reset it instead of falling back
      // to the previous tab's latest position (#8378).
      restoreEditorSelection(props.initialSelection ?? { anchor: 0, head: 0 }, !props.initialViewport);
      restoreEditorViewport(props.initialViewport ?? { scrollTop: 0, scrollLeft: 0 });
      clearScheduledPreviewContextRefresh();
      syncContextMenuState(currentView);
      emit("previewChangesAvailable", !!previewContextSql.value);
      return;
    }
    // setState swaps doc, selection, undo history and all fields at once, but it
    // is not a transaction, so update-listener side effects are re-run manually.
    currentView.setState(cached);
    // Compartments in the restored state may lag behind settings that changed
    // while another tab was active; re-sync them from current values.
    void applyEditorAppearance();
    applyEditorShortcutKeymaps();
    applyEditorIndentExtension();
    applyEditorCompletionExtension();
    if (doc !== currentView.state.doc.toString()) {
      // Content changed while the tab was inactive (external file change, AI
      // edit, another split group): apply it as a regular undoable edit.
      currentView.dispatch({
        changes: { from: 0, to: currentView.state.doc.length, insert: doc },
      });
    }
    scheduleDocumentSearchUpdate();
    invalidateSemanticDiagnosticsForDocumentChange();
    restoreEditorSelection(undefined, !props.initialViewport);
    restoreEditorViewport();
    clearScheduledPreviewContextRefresh();
    syncContextMenuState(currentView);
    emit("previewChangesAvailable", !!previewContextSql.value);
    scheduleSemanticDiagnostics();
  }

  watch([() => props.tabId, () => props.modelValue], ([tabId, val], [prevTabId]) => {
    if (!view.value) return;
    if (tabId !== prevTabId) {
      activateTabDocument(prevTabId, tabId, val);
      if (props.autoFocus) restoreEditorFocus();
      return;
    }
    if (val !== currentEditorDocText(view.value)) {
      if (isEditorComposing(view.value)) return;
      view.value.dispatch({
        changes: { from: 0, to: view.value.state.doc.length, insert: val },
      });
      scheduleSemanticDiagnostics();
    }
  });

  watch(
    () => props.initialViewport,
    (viewport, previousViewport) => {
      if (!view.value || !viewport || previousViewport) return;
      // Saved SQL content can hydrate after the editor has already mounted. In
      // that case the initial prop was undefined and the mount-time restore had
      // nothing to apply.
      latestViewport = { ...viewport };
      lastEmittedViewport = { ...viewport };
      restoreEditorViewport(viewport);
    },
    { deep: true },
  );

  watch(
    () => props.initialSelection,
    (selection, previousSelection) => {
      if (!view.value || !selection || previousSelection) return;
      // Keep the cursor and viewport in sync when a saved SQL tab hydrates after
      // the editor component has already been mounted.
      restoreEditorSelection(selection, !props.initialViewport);
    },
    { deep: true },
  );

  function captureEditorStateBeforeTabSwitch(event: Event) {
    const fromTabId = (event as CustomEvent<{ fromTabId?: string }>).detail?.fromTabId;
    if (!view.value || !fromTabId || fromTabId !== props.tabId) return;
    // Capture while the outgoing editor is still visible. Once KeepAlive starts
    // deactivating the surface, WebKit can report a reset scrollTop of zero.
    flushEditorViewport();
    flushEditorSelection();
    emit("editorStateFlushed");
    tabSwitchStateCaptured = true;
  }

  function readEditorViewport(currentView: EditorViewType) {
    return {
      scrollTop: Math.max(0, currentView.scrollDOM.scrollTop),
      scrollLeft: Math.max(0, currentView.scrollDOM.scrollLeft),
    };
  }

  function sameEditorViewport(a: { scrollTop: number; scrollLeft: number } | undefined, b: { scrollTop: number; scrollLeft: number }) {
    return a?.scrollTop === b.scrollTop && a.scrollLeft === b.scrollLeft;
  }

  function normalizedEditorSelection(selection: { anchor: number; head: number } | undefined, docLength: number) {
    if (!selection) return undefined;
    return {
      anchor: Math.min(Math.max(0, selection.anchor), docLength),
      head: Math.min(Math.max(0, selection.head), docLength),
    };
  }

  function readEditorSelection(currentView: EditorViewType) {
    const selection = currentView.state.selection.main;
    return {
      anchor: selection.anchor,
      head: selection.head,
    };
  }

  function emitEditorSelection(selection: { anchor: number; head: number }) {
    emit("selectionStateChange", selection);
  }

  function flushEditorSelection() {
    if (view.value) latestSelection = readEditorSelection(view.value);
    if (latestSelection) emitEditorSelection(latestSelection);
  }

  function restoreEditorSelection(selection = props.initialSelection ?? latestSelection, scrollIntoView = false) {
    const normalizedSelection = normalizedEditorSelection(selection, props.modelValue.length);
    if (!view.value || !normalizedSelection) return;
    view.value.dispatch({ selection: normalizedSelection, scrollIntoView });
  }

  /** Move cursor/scroll to a 1-based line/column, e.g. from a global content-search match. */
  function revealEditorSelection(line: number, column?: number) {
    const currentView = view.value;
    const EditorSelection = runtime.codeMirrorEditorSelection;
    if (!currentView || !EditorSelection) return;
    const doc = currentView.state.doc;
    const targetLine = Math.max(1, Math.min(line ?? 1, doc.lines));
    const lineOffset = doc.line(targetLine).from;
    const charColumn = Math.max(1, column ?? 1);
    const offset = Math.min(lineOffset + charColumn - 1, doc.length);
    currentView.dispatch({ selection: EditorSelection.cursor(offset), scrollIntoView: true });
    focusEditorView(currentView);
  }

  /** Consume a pending reveal request (fires once per new id / on mount). */
  function performEditorReveal() {
    const request = props.revealRequest;
    if (!request || !view.value) return;
    revealEditorSelection(request.line, request.column);
    emit("editorRevealConsumed");
  }

  function restoreEditorFocus() {
    const focusEditorAcrossFrames = () => {
      focusEditorView(view.value);
    };
    focusEditorAcrossFrames();
    nextTick(() => {
      focusEditorAcrossFrames();
      requestAnimationFrame(focusEditorAcrossFrames);
    });
  }

  function emitEditorViewport(viewport: { scrollTop: number; scrollLeft: number }) {
    if (sameEditorViewport(lastEmittedViewport, viewport)) return;
    lastEmittedViewport = { ...viewport };
    emit("viewportChange", viewport, viewportOwnerTabId);
  }

  function scheduleEditorViewportEmit() {
    if (!view.value || !runtime.editorIsActive) return;
    latestViewport = readEditorViewport(view.value);
    scheduleSemanticDiagnostics(700, { preserveOutsideRanges: true });
    viewportEmitTask.schedule();
  }

  function flushEditorViewport() {
    if (view.value) latestViewport = readEditorViewport(view.value);
    viewportEmitTask.flush();
    if (latestViewport) emitEditorViewport(latestViewport);
  }

  function restoreEditorViewport(viewport = props.initialViewport ?? latestViewport) {
    if (!view.value || !viewport) return;
    const restoreScroll = () => {
      if (!view.value) return;
      view.value.scrollDOM.scrollTo({
        top: viewport.scrollTop,
        left: viewport.scrollLeft,
      });
      view.value.scrollDOM.scrollTop = viewport.scrollTop;
      view.value.scrollDOM.scrollLeft = viewport.scrollLeft;
    };

    if (viewportRestoreFrame !== null) cancelAnimationFrame(viewportRestoreFrame);
    restoreScroll();
    nextTick(() => {
      restoreScroll();
      let attempts = 0;
      const restoreNextFrame = () => {
        restoreScroll();
        attempts += 1;
        if (attempts >= 32) {
          viewportRestoreFrame = null;
          return;
        }
        viewportRestoreFrame = requestAnimationFrame(restoreNextFrame);
      };
      viewportRestoreFrame = requestAnimationFrame(restoreNextFrame);
    });
  }

  function recordSelection(currentView: EditorViewType) {
    latestSelection = readEditorSelection(currentView);
    if (runtime.editorIsActive) emitEditorSelection(latestSelection);
  }

  function flushBeforeDeactivation() {
    const stateWasCapturedBeforeTabSwitch = tabSwitchStateCaptured;
    tabSwitchStateCaptured = false;
    // A KeepAlive-evicted editor can be unmounted after it was already
    // deactivated. Its DOM scroll position has been reset by then, so flushing
    // that inactive view would overwrite the saved viewport with zero.
    if (runtime.editorIsActive && !stateWasCapturedBeforeTabSwitch) {
      flushEditorViewport();
      flushEditorSelection();
      emit("editorStateFlushed");
    }
  }

  function attach() {
    window.addEventListener(BEFORE_TAB_SWITCH_EVENT, captureEditorStateBeforeTabSwitch);
  }

  function dispose() {
    viewportEmitTask.cancel();
    if (viewportRestoreFrame !== null) {
      cancelAnimationFrame(viewportRestoreFrame);
      viewportRestoreFrame = null;
    }
    view.value?.scrollDOM.removeEventListener("scroll", scheduleEditorViewportEmit);
    window.removeEventListener(BEFORE_TAB_SWITCH_EVENT, captureEditorStateBeforeTabSwitch);
  }

  return { normalizedEditorSelection, restoreEditorSelection, performEditorReveal, restoreEditorFocus, scheduleEditorViewportEmit, restoreEditorViewport, recordSelection, flushBeforeDeactivation, attach, dispose };
}

import { type ShallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { useToast } from "@/composables/useToast";
import type { useSettingsStore } from "@/stores/settingsStore";
import type { Completion } from "@codemirror/autocomplete";

import type { EditorView as EditorViewType } from "@codemirror/view";
import { type ElasticsearchCompletionItem } from "@/lib/elasticsearch/elasticsearchCompletion";
import { type MongoCompletionItem } from "@/lib/mongo/mongoCompletion";
import { batchColumnSelectionColumnList, batchColumnSelectionInsertReplacement, batchColumnSelectionReplaceTo, isBatchColumnSelectionCompletionActive } from "@/lib/editor/batchColumnSelection";
import { type RedisCompletionItem } from "@/lib/redis/redisCompletion";
import { type SoqlCompletionItem } from "@/lib/soql/soqlCompletion";
import type { SqlCompletionItem } from "@/lib/sql/sqlCompletion";

export type QueryCompletionItem = SqlCompletionItem | ElasticsearchCompletionItem | RedisCompletionItem | MongoCompletionItem | SoqlCompletionItem;

export interface BatchColumnSelectionActionItem {
  label: string;
  filterText?: string;
  type: "text";
  detail: string;
  boost: number;
  batchColumnSelectionAction: true;
  /** Toggles every candidate checkbox instead of inserting the selection. */
  batchColumnSelectionToggleAll?: true;
  sessionKey: string;
}

export type QueryCompletionOption = Completion & {
  dbxBatchColumnSelection?: { sessionKey: string; candidateKey: string };
  dbxBatchColumnSelectionAction?: { sessionKey: string; toggleAll?: true };
};

interface QueryEditorBatchSelectionRuntime {
  completionComp: import("@codemirror/state").Compartment | null;
  buildSqlCompletionExtension: (() => import("@codemirror/state").Extension) | null;
  codeMirrorCompletionStatus: typeof import("@codemirror/autocomplete").completionStatus | null;
  codeMirrorStartCompletion: typeof import("@codemirror/autocomplete").startCompletion | null;
  codeMirrorCurrentCompletions: typeof import("@codemirror/autocomplete").currentCompletions | null;
  codeMirrorSetSelectedCompletion: typeof import("@codemirror/autocomplete").setSelectedCompletion | null;
  codeMirrorSelectedCompletion: typeof import("@codemirror/autocomplete").selectedCompletion | null;
  codeMirrorSnippetCompletion: typeof import("@codemirror/autocomplete").snippetCompletion;
}

interface QueryEditorBatchSelectionOptions {
  view: ShallowRef<EditorViewType | null>;
  settingsStore: ReturnType<typeof useSettingsStore>;
  runtime: QueryEditorBatchSelectionRuntime;
  markCompletionAccepted: (item: QueryCompletionItem | BatchColumnSelectionActionItem) => void;
}

export function useQueryEditorBatchSelection(options: QueryEditorBatchSelectionOptions) {
  const { view, settingsStore, runtime, markCompletionAccepted } = options;
  const { t } = useI18n();
  const { toast } = useToast();

  interface BatchColumnSelectionCandidate {
    key: string;
    apply: string;
  }

  interface BatchColumnSelectionSession {
    key: string;
    mode: "select" | "insert";
    qualifier?: string;
    document: string;
    from: number;
    to: number;
    replaceClosingQuote?: SqlCompletionItem["replaceClosingQuote"];
    replaceSelectWildcard?: true;
    candidates: BatchColumnSelectionCandidate[];
    selectedKeys: Set<string>;
    completionOptions: Map<string, QueryCompletionOption>;
  }

  let batchColumnSelectionSession: BatchColumnSelectionSession | null = null;
  type BatchColumnSelectionCheckboxMarker = NonNullable<QueryCompletionOption["dbxBatchColumnSelection"]>;
  interface BatchColumnSelectionDragState {
    view: EditorViewType;
    sessionKey: string;
    pointerId: number;
    anchorCandidateKey: string;
    baseSelectedKeys: Set<string>;
    selected: boolean;
    focusCandidateKey: string;
    previousUserSelect: string;
    scrollElement: HTMLElement | null;
    pointerClientX: number;
    pointerClientY: number;
    autoScrollFrame: number;
  }

  const batchColumnSelectionCheckboxMarkers = new WeakMap<HTMLElement, BatchColumnSelectionCheckboxMarker>();
  const batchColumnSelectionActionMarkers = new WeakMap<HTMLElement, { sessionKey: string; toggleAll: boolean }>();
  const batchColumnSelectionTooltipParents = new WeakMap<EditorViewType, HTMLElement>();
  let batchColumnSelectionDragState: BatchColumnSelectionDragState | null = null;
  let batchColumnSelectionRefreshCleanup: (() => void) | null = null;
  let batchColumnSelectionExpandedRendering = false;
  let batchColumnSelectionRenderLimitTimer: number | null = null;

  function cancelBatchColumnSelectionRefresh() {
    batchColumnSelectionRefreshCleanup?.();
    batchColumnSelectionRefreshCleanup = null;
  }

  function setBatchColumnSelectionExpandedRendering(expanded: boolean) {
    if (batchColumnSelectionExpandedRendering === expanded) return;
    batchColumnSelectionExpandedRendering = expanded;
    if (batchColumnSelectionRenderLimitTimer !== null) window.clearTimeout(batchColumnSelectionRenderLimitTimer);

    const currentView = view.value;
    if (!currentView || !runtime.completionComp || !runtime.buildSqlCompletionExtension) return;
    batchColumnSelectionRenderLimitTimer = window.setTimeout(() => {
      batchColumnSelectionRenderLimitTimer = null;
      if (view.value !== currentView || !runtime.completionComp || !runtime.buildSqlCompletionExtension) return;
      currentView.dispatch({ effects: runtime.completionComp.reconfigure(runtime.buildSqlCompletionExtension()) });
      if (expanded && runtime.codeMirrorCompletionStatus?.(currentView.state) === "active") runtime.codeMirrorStartCompletion?.(currentView);
    }, 0);
  }

  function setBatchColumnSelectionValue(sessionKey: string, candidateKey: string, selected: boolean, checkbox?: HTMLInputElement) {
    const session = batchColumnSelectionSession;
    if (!session || session.key !== sessionKey || !session.candidates.some((candidate) => candidate.key === candidateKey)) return;
    if (selected) session.selectedKeys.add(candidateKey);
    else session.selectedKeys.delete(candidateKey);
    if (checkbox) checkbox.checked = selected;
  }

  function batchColumnSelectionAllSelected(session: BatchColumnSelectionSession): boolean {
    return session.candidates.length > 0 && session.selectedKeys.size === session.candidates.length;
  }

  function updateBatchColumnSelectionActionLabel(view: EditorViewType, sessionKey: string) {
    const session = batchColumnSelectionSession;
    if (!session || session.key !== sessionKey) return;
    const insertLabel = t("editor.completion.insertSelectedColumns", { count: session.selectedKeys.size });
    const toggleAllLabel = batchColumnSelectionAllSelected(session) ? t("editor.completion.deselectAllColumns") : t("editor.completion.selectAllColumns");
    const tooltipParent = batchColumnSelectionTooltipParents.get(view) ?? view.dom;
    tooltipParent.querySelectorAll<HTMLElement>(".cm-batch-column-selection-action-marker").forEach((marker) => {
      const markerState = batchColumnSelectionActionMarkers.get(marker);
      if (!markerState || markerState.sessionKey !== sessionKey) return;
      const element = marker.closest("li")?.querySelector<HTMLElement>(".cm-completionLabel");
      if (!element) return;
      const label = markerState.toggleAll ? toggleAllLabel : insertLabel;
      if (element.textContent !== label) element.textContent = label;
    });
  }

  /** Check or clear every field checkbox of the active batch selection. */
  function toggleAllBatchColumnSelection(view: EditorViewType, sessionKey: string) {
    const session = batchColumnSelectionSession;
    if (!session || session.key !== sessionKey) return;
    const selectAll = !batchColumnSelectionAllSelected(session);
    session.selectedKeys = selectAll ? new Set(session.candidates.map((candidate) => candidate.key)) : new Set();
    updateBatchColumnSelectionActionLabel(view, sessionKey);
    // Reopen the list so every rendered checkbox and both action rows reflect the new state.
    scheduleBatchColumnSelectionRefresh(view, sessionKey, session.candidates[0]?.key ?? "");
  }

  function scheduleBatchColumnSelectionRefresh(view: EditorViewType, sessionKey: string, focusCandidateKey: string, scrollState?: { element: HTMLElement | null; top: number; left: number }) {
    cancelBatchColumnSelectionRefresh();
    const preservedScroll =
      scrollState ??
      (() => {
        const element =
          visibleBatchColumnSelectionCheckboxes(sessionKey)
            .map(({ checkbox }) => batchColumnSelectionScrollElement(checkbox))
            .find((candidate): candidate is HTMLElement => !!candidate) ?? null;
        return { element, top: element?.scrollTop ?? 0, left: element?.scrollLeft ?? 0 };
      })();
    const restoreScroll = () => {
      const currentElement =
        visibleBatchColumnSelectionCheckboxes(sessionKey)
          .map(({ checkbox }) => batchColumnSelectionScrollElement(checkbox))
          .find((candidate): candidate is HTMLElement => !!candidate) ?? preservedScroll.element;
      if (!currentElement) return;
      currentElement.scrollTop = Math.min(preservedScroll.top, Math.max(0, currentElement.scrollHeight - currentElement.clientHeight));
      currentElement.scrollLeft = Math.min(preservedScroll.left, Math.max(0, currentElement.scrollWidth - currentElement.clientWidth));
    };
    let restoreAttempts = 0;
    let restoreFrame = 0;
    let restoreTimer = 0;
    let restoreStartTimer = 0;
    let stopped = false;
    const restoreObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(restoreScroll);
    const stopRestore = () => {
      if (stopped) return;
      stopped = true;
      restoreObserver?.disconnect();
      if (restoreFrame) window.cancelAnimationFrame(restoreFrame);
      if (restoreTimer) window.clearTimeout(restoreTimer);
      if (restoreStartTimer) window.clearTimeout(restoreStartTimer);
      if (batchColumnSelectionRefreshCleanup === stopRestore) batchColumnSelectionRefreshCleanup = null;
    };
    batchColumnSelectionRefreshCleanup = stopRestore;
    const restoreNextFrame = () => {
      if (batchColumnSelectionSession?.key !== sessionKey) {
        stopRestore();
        return;
      }
      restoreScroll();
      restoreAttempts += 1;
      if (restoreAttempts < 60) restoreFrame = window.requestAnimationFrame(restoreNextFrame);
      else stopRestore();
    };
    restoreStartTimer = window.setTimeout(() => {
      if (stopped || batchColumnSelectionSession?.key !== sessionKey) {
        stopRestore();
        return;
      }
      restoreObserver?.observe(document.body, { childList: true, subtree: true });
      // Keep CodeMirror's virtualized range anchored to the item where the drag ended.
      const focusIndex =
        runtime.codeMirrorCurrentCompletions?.(view.state).findIndex((completion) => {
          const marker = (completion as QueryCompletionOption).dbxBatchColumnSelection;
          return marker?.sessionKey === sessionKey && marker.candidateKey === focusCandidateKey;
        }) ?? -1;
      if (focusIndex >= 0 && runtime.codeMirrorSetSelectedCompletion) view.dispatch({ effects: runtime.codeMirrorSetSelectedCompletion(focusIndex) });
      runtime.codeMirrorStartCompletion?.(view);
      restoreNextFrame();
      restoreTimer = window.setTimeout(stopRestore, 1500);
    }, 0);
  }

  function finishBatchColumnSelectionDrag(refresh = true) {
    const state = batchColumnSelectionDragState;
    if (!state) return;
    const scrollState = state.scrollElement ? { element: state.scrollElement, top: state.scrollElement.scrollTop, left: state.scrollElement.scrollLeft } : undefined;
    batchColumnSelectionDragState = null;
    if (state.autoScrollFrame) window.cancelAnimationFrame(state.autoScrollFrame);
    window.removeEventListener("pointermove", onBatchColumnSelectionPointerMove, true);
    window.removeEventListener("pointerup", onBatchColumnSelectionPointerUp, true);
    window.removeEventListener("pointercancel", onBatchColumnSelectionPointerCancel, true);
    window.removeEventListener("blur", onBatchColumnSelectionPointerCancel, true);
    document.body.style.userSelect = state.previousUserSelect;
    if (refresh) scheduleBatchColumnSelectionRefresh(state.view, state.sessionKey, state.focusCandidateKey, scrollState);
  }

  function clearBatchColumnSelectionSession() {
    finishBatchColumnSelectionDrag(false);
    cancelBatchColumnSelectionRefresh();
    setBatchColumnSelectionExpandedRendering(false);
    batchColumnSelectionSession = null;
  }

  function isBatchColumnSelectionAction(item: QueryCompletionItem | BatchColumnSelectionActionItem): item is BatchColumnSelectionActionItem {
    return "batchColumnSelectionAction" in item && item.batchColumnSelectionAction === true;
  }

  function batchColumnSelectionCandidateKey(item: SqlCompletionItem): string {
    return `${item.label}\u0000${item.apply ?? item.label}`;
  }

  function prepareBatchColumnSelectionSession(items: SqlCompletionItem[], document: string, from: number, to: number): BatchColumnSelectionSession | null {
    const selectableItems = items.filter((item) => item.type === "column" && item.batchSelectionMode && item.apply);
    if (selectableItems.length === 0) {
      // One completion request builds several result sets (the local pass plus
      // the metadata pass) and only some of them carry column candidates.
      // Clearing the stored session for such an empty sibling result left the
      // checkbox rows rendered by the other result attached to a session that
      // no longer existed, so clicking a checkbox did nothing. It also made the
      // expanded-rendering flag flap false→true on every pass, reconfiguring
      // CodeMirror's autocompletion compartment while a source was still
      // pending; the recreated list stayed disabled (ArrowUp/Down ignored, then
      // closed on the next caret move). Keep the session and only report "no
      // batch selection" for this result (dbx#9973). The session is still
      // dropped when the popup closes, on Escape and after an accepted row.
      return null;
    }

    const mode = selectableItems[0]!.batchSelectionMode!;
    const candidates = selectableItems.filter((item) => item.batchSelectionMode === mode).map((item) => ({ key: batchColumnSelectionCandidateKey(item), apply: item.apply! }));
    const key = `${mode}\u0000${from}\u0000${to}\u0000${document}`;
    if (!batchColumnSelectionSession || batchColumnSelectionSession.key !== key) {
      batchColumnSelectionSession = {
        key,
        mode,
        qualifier: selectableItems[0]!.batchSelectionQualifier,
        document,
        from,
        to,
        replaceClosingQuote: selectableItems[0]!.replaceClosingQuote,
        replaceSelectWildcard: selectableItems[0]!.replaceSelectWildcard,
        candidates,
        selectedKeys: new Set(),
        completionOptions: new Map(),
      };
      setBatchColumnSelectionExpandedRendering(true);
      return batchColumnSelectionSession;
    }

    setBatchColumnSelectionExpandedRendering(true);
    batchColumnSelectionSession.candidates = candidates;
    batchColumnSelectionSession.qualifier = selectableItems[0]!.batchSelectionQualifier;
    const candidateKeys = new Set(candidates.map((candidate) => candidate.key));
    batchColumnSelectionSession.selectedKeys = new Set([...batchColumnSelectionSession.selectedKeys].filter((candidateKey) => candidateKeys.has(candidateKey)));
    batchColumnSelectionSession.completionOptions = new Map([...batchColumnSelectionSession.completionOptions].filter(([candidateKey]) => candidateKeys.has(candidateKey)));
    return batchColumnSelectionSession;
  }

  function batchColumnSelectionMarkerForItem(item: QueryCompletionItem): QueryCompletionOption["dbxBatchColumnSelection"] | undefined {
    if (!("batchSelectionMode" in item) || item.type !== "column" || !item.batchSelectionMode || !item.apply) return undefined;
    const session = batchColumnSelectionSession;
    if (!session || session.mode !== item.batchSelectionMode) return undefined;
    const candidateKey = batchColumnSelectionCandidateKey(item);
    if (!session.candidates.some((candidate) => candidate.key === candidateKey)) return undefined;
    return { sessionKey: session.key, candidateKey };
  }

  function cacheBatchColumnSelectionOption(marker: QueryCompletionOption["dbxBatchColumnSelection"], option: QueryCompletionOption): QueryCompletionOption {
    if (!marker || !batchColumnSelectionSession || batchColumnSelectionSession.key !== marker.sessionKey) return option;
    const cached = batchColumnSelectionSession.completionOptions.get(marker.candidateKey);
    if (cached) return cached;
    batchColumnSelectionSession.completionOptions.set(marker.candidateKey, option);
    return option;
  }

  function toggleBatchColumnSelection(view: EditorViewType, sessionKey: string, candidateKey: string) {
    const session = batchColumnSelectionSession;
    if (!session || session.key !== sessionKey || !session.candidates.some((candidate) => candidate.key === candidateKey)) return;
    setBatchColumnSelectionValue(sessionKey, candidateKey, !session.selectedKeys.has(candidateKey));
    updateBatchColumnSelectionActionLabel(view, sessionKey);
    // Reopen the list so the action row and all virtualized checkboxes reflect the new state.
    scheduleBatchColumnSelectionRefresh(view, sessionKey, candidateKey);
  }

  function toggleSelectedBatchColumnSelection(view: EditorViewType): boolean {
    const completion = runtime.codeMirrorSelectedCompletion?.(view.state) as QueryCompletionOption | null | undefined;
    const marker = completion?.dbxBatchColumnSelection;
    if (!marker) return false;
    toggleBatchColumnSelection(view, marker.sessionKey, marker.candidateKey);
    return true;
  }

  function batchColumnSelectionMarkerAtPoint(clientX: number, clientY: number): { checkbox: HTMLInputElement; marker: BatchColumnSelectionCheckboxMarker } | null {
    const target = document.elementFromPoint(clientX, clientY);
    if (!(target instanceof HTMLElement)) return null;
    const checkbox = target.closest<HTMLInputElement>("input.cm-batch-column-selection-checkbox") ?? target.closest<HTMLElement>("[role='option']")?.querySelector<HTMLInputElement>("input.cm-batch-column-selection-checkbox") ?? null;
    if (!checkbox) return null;
    const marker = batchColumnSelectionCheckboxMarkers.get(checkbox);
    return marker ? { checkbox, marker } : null;
  }

  function batchColumnSelectionScrollElement(checkbox: HTMLElement): HTMLElement | null {
    let current = checkbox.parentElement;
    while (current && current !== document.body) {
      const style = window.getComputedStyle(current);
      if (current.scrollHeight > current.clientHeight && /(auto|scroll|overlay)/.test(style.overflowY)) return current;
      current = current.parentElement;
    }
    return null;
  }

  function visibleBatchColumnSelectionCheckboxes(sessionKey: string): Array<{ checkbox: HTMLInputElement; marker: BatchColumnSelectionCheckboxMarker }> {
    return Array.from(document.querySelectorAll<HTMLInputElement>("input.cm-batch-column-selection-checkbox")).flatMap((checkbox) => {
      const marker = batchColumnSelectionCheckboxMarkers.get(checkbox);
      return marker?.sessionKey === sessionKey ? [{ checkbox, marker }] : [];
    });
  }

  function updateBatchColumnSelectionAtPoint(state: BatchColumnSelectionDragState, clientX: number, clientY: number) {
    const hit = batchColumnSelectionMarkerAtPoint(clientX, clientY);
    if (!hit || hit.marker.sessionKey !== state.sessionKey) return;
    state.focusCandidateKey = hit.marker.candidateKey;
    const session = batchColumnSelectionSession;
    if (!session) return;
    const visibleCheckboxes = visibleBatchColumnSelectionCheckboxes(state.sessionKey);
    const anchorIndex = visibleCheckboxes.findIndex(({ marker }) => marker.candidateKey === state.anchorCandidateKey);
    const focusIndex = visibleCheckboxes.findIndex(({ marker }) => marker.candidateKey === hit.marker.candidateKey);
    if (anchorIndex < 0 || focusIndex < 0) return;
    const nextSelectedKeys = new Set(state.baseSelectedKeys);
    const rangeStart = Math.min(anchorIndex, focusIndex);
    const rangeEnd = Math.max(anchorIndex, focusIndex);
    for (let index = rangeStart; index <= rangeEnd; index++) {
      const candidate = visibleCheckboxes[index]?.marker;
      if (!candidate) continue;
      if (state.selected) nextSelectedKeys.add(candidate.candidateKey);
      else nextSelectedKeys.delete(candidate.candidateKey);
    }
    session.selectedKeys = nextSelectedKeys;
    visibleCheckboxes.forEach(({ checkbox, marker }) => {
      checkbox.checked = nextSelectedKeys.has(marker.candidateKey);
    });
    updateBatchColumnSelectionActionLabel(state.view, state.sessionKey);
  }

  const BATCH_COLUMN_SELECTION_AUTO_SCROLL_EDGE_PX = 36;
  const BATCH_COLUMN_SELECTION_AUTO_SCROLL_MAX_PX = 20;

  function runBatchColumnSelectionAutoScroll() {
    const state = batchColumnSelectionDragState;
    if (!state) return;
    state.autoScrollFrame = 0;
    const scroller = state.scrollElement;
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    if (state.pointerClientX < rect.left || state.pointerClientX > rect.right) return;
    let delta = 0;
    if (state.pointerClientY < rect.top + BATCH_COLUMN_SELECTION_AUTO_SCROLL_EDGE_PX) {
      delta = -BATCH_COLUMN_SELECTION_AUTO_SCROLL_MAX_PX * Math.min(1, (rect.top + BATCH_COLUMN_SELECTION_AUTO_SCROLL_EDGE_PX - state.pointerClientY) / BATCH_COLUMN_SELECTION_AUTO_SCROLL_EDGE_PX);
    } else if (state.pointerClientY > rect.bottom - BATCH_COLUMN_SELECTION_AUTO_SCROLL_EDGE_PX) {
      delta = BATCH_COLUMN_SELECTION_AUTO_SCROLL_MAX_PX * Math.min(1, (state.pointerClientY - (rect.bottom - BATCH_COLUMN_SELECTION_AUTO_SCROLL_EDGE_PX)) / BATCH_COLUMN_SELECTION_AUTO_SCROLL_EDGE_PX);
    }
    if (!delta) return;
    const previousScrollTop = scroller.scrollTop;
    scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, scroller.scrollTop + delta));
    if (scroller.scrollTop === previousScrollTop) return;
    updateBatchColumnSelectionAtPoint(state, state.pointerClientX, state.pointerClientY);
    state.autoScrollFrame = window.requestAnimationFrame(runBatchColumnSelectionAutoScroll);
  }

  function scheduleBatchColumnSelectionAutoScroll(state: BatchColumnSelectionDragState) {
    if (!state.scrollElement || state.autoScrollFrame) return;
    state.autoScrollFrame = window.requestAnimationFrame(runBatchColumnSelectionAutoScroll);
  }

  function onBatchColumnSelectionPointerMove(event: PointerEvent) {
    const state = batchColumnSelectionDragState;
    if (!state || event.pointerId !== state.pointerId) return;
    if ((event.buttons & 1) === 0) {
      finishBatchColumnSelectionDrag();
      return;
    }
    state.pointerClientX = event.clientX;
    state.pointerClientY = event.clientY;
    updateBatchColumnSelectionAtPoint(state, event.clientX, event.clientY);
    scheduleBatchColumnSelectionAutoScroll(state);
  }

  function onBatchColumnSelectionPointerUp(event: PointerEvent) {
    const state = batchColumnSelectionDragState;
    if (!state || event.pointerId !== state.pointerId) return;
    finishBatchColumnSelectionDrag();
  }

  function onBatchColumnSelectionPointerCancel() {
    finishBatchColumnSelectionDrag();
  }

  function startBatchColumnSelectionDrag(view: EditorViewType, marker: BatchColumnSelectionCheckboxMarker, checkbox: HTMLInputElement, event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary) return;
    finishBatchColumnSelectionDrag(false);
    cancelBatchColumnSelectionRefresh();
    const session = batchColumnSelectionSession;
    if (!session || session.key !== marker.sessionKey) return;
    if (!session.candidates.some((candidate) => candidate.key === marker.candidateKey)) return;
    const selected = !session.selectedKeys.has(marker.candidateKey);
    const baseSelectedKeys = new Set(session.selectedKeys);
    setBatchColumnSelectionValue(marker.sessionKey, marker.candidateKey, selected, checkbox);
    batchColumnSelectionDragState = {
      view,
      sessionKey: marker.sessionKey,
      pointerId: event.pointerId,
      anchorCandidateKey: marker.candidateKey,
      baseSelectedKeys,
      selected,
      focusCandidateKey: marker.candidateKey,
      previousUserSelect: document.body.style.userSelect,
      scrollElement: batchColumnSelectionScrollElement(checkbox),
      pointerClientX: event.clientX,
      pointerClientY: event.clientY,
      autoScrollFrame: 0,
    };
    updateBatchColumnSelectionActionLabel(view, marker.sessionKey);
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onBatchColumnSelectionPointerMove, true);
    window.addEventListener("pointerup", onBatchColumnSelectionPointerUp, true);
    window.addEventListener("pointercancel", onBatchColumnSelectionPointerCancel, true);
    window.addEventListener("blur", onBatchColumnSelectionPointerCancel, true);
  }

  function renderBatchColumnSelectionCheckbox(completion: Completion, _state: import("@codemirror/state").EditorState, currentView: EditorViewType): Node | null {
    const marker = (completion as QueryCompletionOption).dbxBatchColumnSelection;
    const session = batchColumnSelectionSession;
    if (!marker || !session || session.key !== marker.sessionKey) return null;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "cm-batch-column-selection-checkbox";
    checkbox.checked = session.selectedKeys.has(marker.candidateKey);
    checkbox.tabIndex = -1;
    checkbox.setAttribute("aria-label", completion.displayLabel ?? completion.label);
    batchColumnSelectionCheckboxMarkers.set(checkbox, marker);
    checkbox.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      startBatchColumnSelectionDrag(currentView, marker, checkbox, event);
    });
    checkbox.addEventListener("mousedown", (event) => {
      // CodeMirror accepts the completion on a list-item mousedown. Keep this
      // interaction local to the checkbox so a field can be toggled repeatedly.
      event.preventDefault();
      event.stopPropagation();
    });
    checkbox.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    return checkbox;
  }

  // The checkbox above only guards its own hitbox. A mousedown/click anywhere
  // else in the row (the label, detail text, icon — most of the row's area)
  // falls through to CodeMirror's own list-item handler, which accepts that
  // row as a single completion and discards every other checked field. Guard
  // the whole row the same way, at the document level, since the completion
  // tooltip renders outside the editor's own DOM (see tooltipParent above).
  function onBatchColumnSelectionRowGuard(event: MouseEvent) {
    if (event.button !== 0 || !batchColumnSelectionSession) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest("input.cm-batch-column-selection-checkbox")) return;
    const hit = batchColumnSelectionMarkerAtPoint(event.clientX, event.clientY);
    if (!hit || hit.marker.sessionKey !== batchColumnSelectionSession.key) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.type !== "mousedown") return;
    const currentView = view.value;
    if (currentView) toggleBatchColumnSelection(currentView, hit.marker.sessionKey, hit.marker.candidateKey);
  }

  function renderBatchColumnSelectionActionMarker(completion: Completion): Node | null {
    const action = (completion as QueryCompletionOption).dbxBatchColumnSelectionAction;
    if (!action) return null;
    const marker = document.createElement("span");
    marker.className = "cm-batch-column-selection-action-marker";
    marker.hidden = true;
    batchColumnSelectionActionMarkers.set(marker, { sessionKey: action.sessionKey, toggleAll: action.toggleAll === true });
    return marker;
  }

  function applyBatchColumnSelection(view: EditorViewType, item: BatchColumnSelectionActionItem, from: number, to: number) {
    const session = batchColumnSelectionSession;
    if (!session || session.key !== item.sessionKey || session.document !== view.state.doc.toString()) return;

    const selected = session.candidates.filter((candidate) => session.selectedKeys.has(candidate.key));
    if (selected.length === 0) {
      toast(t("editor.completion.selectColumnsBeforeInsert"), 3000);
      return;
    }

    const columns = batchColumnSelectionColumnList(
      selected.map((candidate) => candidate.apply),
      session.mode,
      session.qualifier,
    );
    let replaceTo = batchColumnSelectionReplaceTo({
      from,
      to,
      mode: session.mode,
      nextCharacter: view.state.sliceDoc(to, to + 1),
      replaceClosingQuote: session.replaceClosingQuote,
      replaceSelectWildcard: session.replaceSelectWildcard,
    });
    let insert = columns;
    if (session.mode === "insert") {
      const replacement = batchColumnSelectionInsertReplacement({
        document: view.state.doc.toString(),
        to,
        columns,
        valuesKeyword: settingsStore.editorSettings.sqlFormatter.keywordCase === "lower" ? "values" : "VALUES",
        valueCount: selected.length,
      });
      replaceTo = replacement.replaceTo;
      insert = replacement.insert;
    }

    if (session.mode === "insert" && !runtime.codeMirrorSnippetCompletion) {
      clearBatchColumnSelectionSession();
      return;
    }
    clearBatchColumnSelectionSession();
    markCompletionAccepted(item);
    if (session.mode === "insert") {
      const snippet = runtime.codeMirrorSnippetCompletion(insert, { label: item.label });
      if (typeof snippet.apply === "function") {
        snippet.apply(view, snippet, from, replaceTo);
        return;
      }
    }
    view.dispatch({
      changes: { from, to: replaceTo, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
    });
  }

  function applySelectedBatchColumnSelection(view: EditorViewType): boolean {
    const session = batchColumnSelectionSession;
    if (!session || !isBatchColumnSelectionCompletionActive(runtime.codeMirrorCompletionStatus?.(view.state) ?? null) || session.document !== view.state.doc.toString() || session.selectedKeys.size === 0) return false;
    applyBatchColumnSelection(
      view,
      {
        label: t("editor.completion.insertSelectedColumns", { count: session.selectedKeys.size }),
        type: "text",
        detail: t("editor.completion.insertSelectedColumnsDetail"),
        boost: -1000,
        batchColumnSelectionAction: true,
        sessionKey: session.key,
      },
      session.from,
      session.to,
    );
    return true;
  }

  function attach(currentView: EditorViewType, tooltipParent: HTMLElement) {
    batchColumnSelectionTooltipParents.set(currentView, tooltipParent);
    document.addEventListener("mousedown", onBatchColumnSelectionRowGuard, true);
    document.addEventListener("click", onBatchColumnSelectionRowGuard, true);
  }

  function dispose() {
    finishBatchColumnSelectionDrag(false);
    cancelBatchColumnSelectionRefresh();
    if (batchColumnSelectionRenderLimitTimer !== null) window.clearTimeout(batchColumnSelectionRenderLimitTimer);
    batchColumnSelectionRenderLimitTimer = null;
    batchColumnSelectionSession = null;
    document.removeEventListener("mousedown", onBatchColumnSelectionRowGuard, true);
    document.removeEventListener("click", onBatchColumnSelectionRowGuard, true);
  }

  return {
    cancelBatchColumnSelectionRefresh,
    batchColumnSelectionAllSelected,
    toggleAllBatchColumnSelection,
    finishBatchColumnSelectionDrag,
    clearBatchColumnSelectionSession,
    isBatchColumnSelectionAction,
    prepareBatchColumnSelectionSession,
    batchColumnSelectionMarkerForItem,
    cacheBatchColumnSelectionOption,
    toggleSelectedBatchColumnSelection,
    renderBatchColumnSelectionCheckbox,
    onBatchColumnSelectionRowGuard,
    renderBatchColumnSelectionActionMarker,
    applyBatchColumnSelection,
    applySelectedBatchColumnSelection,
    attach,
    dispose,
    get expandedRendering() {
      return batchColumnSelectionExpandedRendering;
    },
  };
}

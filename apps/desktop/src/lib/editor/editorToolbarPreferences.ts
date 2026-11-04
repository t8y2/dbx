export const EDITOR_TOOLBAR_ACTION_IDS = [
  "execute",
  "execute-all",
  "execute-in-new-result-tab",
  "preview-changes",
  "explain",
  "format",
  "compress",
  "fold-all",
  "unfold-all",
  "keyword-case",
  "word-wrap",
  "semantic-diagnostics",
  "insert-value-hints",
  "save",
  "open-sql",
  "import-result-archive",
  "paste-sql-condition",
  "multi-execute",
] as const;

export type EditorToolbarActionId = (typeof EDITOR_TOOLBAR_ACTION_IDS)[number];

export const DEFAULT_EDITOR_TOOLBAR_ORDER: readonly EditorToolbarActionId[] = [...EDITOR_TOOLBAR_ACTION_IDS];

/** Safety-critical while a query is running, so it remains discoverable. */
export const REQUIRED_EDITOR_TOOLBAR_ACTIONS: readonly EditorToolbarActionId[] = ["execute"];

const ACTION_IDS = new Set<string>(EDITOR_TOOLBAR_ACTION_IDS);
const REQUIRED_ACTION_IDS = new Set<string>(REQUIRED_EDITOR_TOOLBAR_ACTIONS);

export interface EditorToolbarPresentationItem {
  id: EditorToolbarActionId;
  order: number;
  visible: boolean;
  available: boolean;
}

function knownActionIds(value: unknown): EditorToolbarActionId[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is EditorToolbarActionId => typeof id === "string" && ACTION_IDS.has(id)))];
}

export function normalizeEditorToolbarOrder(value: unknown): EditorToolbarActionId[] {
  const persisted = knownActionIds(value);
  const included = new Set(persisted);
  return [...persisted, ...DEFAULT_EDITOR_TOOLBAR_ORDER.filter((id) => !included.has(id))];
}

export function normalizeEditorToolbarHiddenActions(value: unknown): EditorToolbarActionId[] {
  return knownActionIds(value).filter((id) => !REQUIRED_ACTION_IDS.has(id));
}

export function moveEditorToolbarAction(order: unknown, actionId: EditorToolbarActionId, direction: "up" | "down"): EditorToolbarActionId[] {
  const normalized = normalizeEditorToolbarOrder(order);
  const index = normalized.indexOf(actionId);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= normalized.length) return normalized;
  const next = [...normalized];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function resolveEditorToolbarPresentation(input: { order: unknown; hiddenActions: unknown; availableActions?: readonly EditorToolbarActionId[] }): EditorToolbarPresentationItem[] {
  const order = normalizeEditorToolbarOrder(input.order);
  const hidden = new Set(normalizeEditorToolbarHiddenActions(input.hiddenActions));
  const available = input.availableActions ? new Set(input.availableActions) : new Set(EDITOR_TOOLBAR_ACTION_IDS);
  return order.map((id, index) => ({
    id,
    order: index,
    visible: !hidden.has(id) && available.has(id),
    available: available.has(id),
  }));
}

export function editorToolbarActionVisible(presentation: readonly EditorToolbarPresentationItem[], actionId: EditorToolbarActionId): boolean {
  return presentation.find((item) => item.id === actionId)?.visible === true;
}

export function editorToolbarActionOrder(presentation: readonly EditorToolbarPresentationItem[], actionId: EditorToolbarActionId): number {
  return presentation.find((item) => item.id === actionId)?.order ?? DEFAULT_EDITOR_TOOLBAR_ORDER.length;
}

export interface QueryEditorPointerEvent {
  altKey: boolean;
  button: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export interface QueryEditorSelectionDragEvent {
  detail: number;
  shiftKey: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export interface QueryEditorObjectNavigationModifierEvent {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export function startsQueryEditorRectangularSelection(event: QueryEditorPointerEvent): boolean {
  if (event.button === 1) return true;
  // Alt+Ctrl/Cmd belongs to independent multi-cursor selection, including
  // double-click word selection, rather than rectangular selection.
  return event.altKey && !event.ctrlKey && !event.metaKey;
}

export function startsQueryEditorSelectionDrag(event: QueryEditorSelectionDragEvent): boolean {
  return !event.shiftKey && event.detail <= 1 && !(event.altKey && (event.ctrlKey || event.metaKey));
}

export function usesQueryEditorObjectNavigationModifier(event: QueryEditorObjectNavigationModifierEvent): boolean {
  return !event.altKey && (event.metaKey || event.ctrlKey);
}

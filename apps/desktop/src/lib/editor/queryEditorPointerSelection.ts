export interface QueryEditorPointerEvent {
  altKey: boolean;
  button: number;
}

export interface QueryEditorObjectNavigationModifierEvent {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

export function startsQueryEditorRectangularSelection(event: QueryEditorPointerEvent): boolean {
  return event.altKey || event.button === 1;
}

export function usesQueryEditorObjectNavigationModifier(event: QueryEditorObjectNavigationModifierEvent): boolean {
  return !event.altKey && (event.metaKey || event.ctrlKey);
}

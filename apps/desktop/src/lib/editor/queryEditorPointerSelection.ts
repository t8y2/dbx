export interface QueryEditorPointerEvent {
  altKey: boolean;
  button: number;
}

export function startsQueryEditorRectangularSelection(event: QueryEditorPointerEvent): boolean {
  return event.altKey || event.button === 1;
}

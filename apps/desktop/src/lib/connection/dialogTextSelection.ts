function isDialogTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable) || !!target.closest("[contenteditable='true'], [role='textbox']");
}

export function preventDialogDocumentSelectAll(event: KeyboardEvent): boolean {
  const isSelectAll = event.key.toLowerCase() === "a" && (event.metaKey || event.ctrlKey) && !event.altKey;
  if (!isSelectAll || isDialogTextInputTarget(event.target)) return false;
  event.preventDefault();
  return true;
}

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

function isPasswordFieldTarget(target: EventTarget | null): target is HTMLInputElement {
  if (!(target instanceof HTMLInputElement)) return false;
  // A revealed password is a plain text input, so the reveal toggle marks it
  // explicitly; a masked one is recognizable from its type alone.
  return target.type === "password" || target.hasAttribute("data-password-input");
}

/**
 * Copy the whole password value when a copy shortcut runs without a selection.
 *
 * A password input only copies its selection, so pressing Ctrl/Cmd+C with just
 * a caret writes nothing and leaves the previous clipboard content in place.
 * Users who reveal a stored password and copy it that way would then paste
 * whatever they copied earlier - typically the percent-encoded connection URL -
 * which looks like the password itself was escaped. Writing the field value
 * keeps the clipboard identical to what the field shows; an explicit selection
 * still copies the native substring.
 */
export function copyDialogPasswordFieldValue(event: ClipboardEvent): boolean {
  const input = event.target;
  if (!isPasswordFieldTarget(input)) return false;
  if ((input.selectionStart ?? 0) !== (input.selectionEnd ?? 0)) return false;
  if (!input.value) return false;
  const clipboard = event.clipboardData;
  if (!clipboard) return false;
  event.preventDefault();
  clipboard.setData("text/plain", input.value);
  return true;
}

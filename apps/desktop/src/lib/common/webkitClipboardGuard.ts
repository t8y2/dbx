/**
 * WebKitGTK 2.54 can dispatch copy/cut twice for one keydown when the
 * CodeMirror selection is collapsed: the native command reports failure
 * after CodeMirror already handled the first event, so its keypress
 * fallback runs the command again. For cut that deletes a second line and
 * leaves only that line on the clipboard. Track the keydown that targeted
 * a CodeMirror editor, stop the fallback after the first clipboard event,
 * and drop duplicate clipboard events for the same keystroke.
 */
export function installWebKitClipboardGuard(): () => void {
  let pending: { editor: Element; keydown: KeyboardEvent; seen: Set<string> } | null = null;

  const reset = () => {
    pending = null;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const editor = event.target instanceof Element ? event.target.closest(".cm-content") : null;
    pending = editor ? { editor, keydown: event, seen: new Set() } : null;
  };

  const onClipboard = (event: Event) => {
    if (!pending || !(event.target instanceof Element) || event.target.closest(".cm-content") !== pending.editor) return;
    // A keydown that was already handled may intentionally run several
    // clipboard commands (for example a macro); leave those alone.
    if (pending.seen.size === 0 && pending.keydown.defaultPrevented) return;
    if (pending.seen.has(event.type)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    } else {
      pending.seen.add(event.type);
      // The native command can still report failure after CodeMirror
      // handles this event. Preventing the keydown stops its keypress
      // fallback from dispatching the command a second time.
      pending.keydown.preventDefault();
    }
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", reset, true);
  window.addEventListener("pointerdown", reset, true);
  window.addEventListener("blur", reset, true);
  window.addEventListener("copy", onClipboard, true);
  window.addEventListener("cut", onClipboard, true);

  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", reset, true);
    window.removeEventListener("pointerdown", reset, true);
    window.removeEventListener("blur", reset, true);
    window.removeEventListener("copy", onClipboard, true);
    window.removeEventListener("cut", onClipboard, true);
  };
}

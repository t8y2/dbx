/**
 * The Replace All accelerator shared by the app's search-and-replace panels —
 * the query editor's find/replace panel (Ctrl+H) and the result grid's search
 * bar — matching VS Code's find-widget shortcut. Ctrl on Windows/Linux and Cmd
 * on macOS keyboards, both with Alt; nothing else in the app binds the combo,
 * so accepting either covers both platforms without platform detection.
 */
export function isReplaceAllShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  return event.key === "Enter" && (event.ctrlKey || event.metaKey) && !!event.altKey;
}

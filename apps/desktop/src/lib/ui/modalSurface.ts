/**
 * Whether a modal layer currently owns the window, so an app-level shortcut such as
 * "close tab" (Cmd/Ctrl+W) is handed to that dialog instead of tearing down the surface
 * behind it.
 *
 * Modal Reka dialogs render through `DialogContent.vue` / `DialogScrollContent.vue`,
 * which mount `data-slot="dialog-overlay"` with the `data-state` Reka writes onto the
 * layer. `data-state="open"` skips a layer that is only on screen for its exit
 * animation.
 *
 * The overlay -- not the dialog body -- is the marker on purpose, because the overlay is
 * what actually covers the app (Reka gives it `pointer-events: auto`). The one dialog
 * that stays interactive renders no overlay at all: `DialogScrollContent` with
 * `:show-overlay="false"`, used by the background table import. `role="dialog"` alone is
 * not enough either: Reka popovers, date pickers and similar floating surfaces reuse that
 * role and stay open while the user keeps working in the shell. Hand-rolled full-screen
 * modals opt in with `aria-modal="true"`, while non-modal peek overlays pass
 * `aria-modal="false"`.
 */
const OPEN_MODAL_SURFACE_SELECTOR = '[data-slot="dialog-overlay"][data-state="open"], [role="dialog"][aria-modal="true"]';

/** True while a modal dialog layer is open above the current surface. */
export function hasOpenModalSurface(root: ParentNode | null | undefined = globalThis.document ?? null): boolean {
  if (!root || typeof root.querySelector !== "function") return false;
  return root.querySelector(OPEN_MODAL_SURFACE_SELECTOR) !== null;
}

/**
 * Hand "close this" to the modal dialog that owns the window, and report whether a modal
 * took the shortcut. The keystroke is replayed as a cancelable Escape keydown on the
 * window because that is the dismissal path every Reka layer already implements: only the
 * top-most layer in the layer stack reacts, layer-specific guards
 * (`@escape-key-down`, e.g. cancelling a pending inline edit first) still run, and focus
 * returns where users expect it.
 *
 * So Cmd+W with a dialog open closes that dialog -- an open popover inside it first, the
 * dialog itself on the next press -- instead of leaving the user with a dead shortcut.
 */
export function dismissOpenModalSurface(target: Pick<Window, "dispatchEvent"> | null | undefined = globalThis.window ?? null): boolean {
  if (!target || typeof target.dispatchEvent !== "function" || !hasOpenModalSurface()) return false;
  target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  return true;
}

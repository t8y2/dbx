const DIALOG_BACKDROP_CLASS = "dbx-dialog-backdrop-active";

let dialogBackdropObserver: MutationObserver | undefined;

function hasDialogOverlay(): boolean {
  return Array.from(document.body.children).some((child) => child.matches('[data-slot="dialog-overlay"]') || child.querySelector('[data-slot="dialog-overlay"]'));
}

function syncDialogBackdrop() {
  document.documentElement.classList.toggle(DIALOG_BACKDROP_CLASS, hasDialogOverlay());
}

export function startDialogBackdropSync() {
  if (typeof document === "undefined" || dialogBackdropObserver) return;
  dialogBackdropObserver = new MutationObserver(syncDialogBackdrop);
  dialogBackdropObserver.observe(document.body, { childList: true });
  syncDialogBackdrop();
}

export function stopDialogBackdropSync() {
  dialogBackdropObserver?.disconnect();
  dialogBackdropObserver = undefined;
  document.documentElement.classList.remove(DIALOG_BACKDROP_CLASS);
}

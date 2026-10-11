import { watch, type Ref } from "vue";

/**
 * Restores focus to the CodeMirror editor that was focused when a dialog opened.
 *
 * Reka UI's default close-auto-focus calls plain DOM `.focus()` on the element that was active
 * before the dialog opened. In WebKit, refocusing a CodeMirror contenteditable this way can reset
 * its caret to the start of the document, which makes the editor scroll to the top (#7692).
 * `EditorView.focus()` restores CodeMirror's internal selection without creating that false change.
 *
 * The returned handler suppresses the native restoration only when a CodeMirror editor actually
 * held focus at open time; other triggers keep the default behavior.
 */
export function useDialogEditorFocusRestore(open: Ref<boolean>) {
  // The CodeMirror editor (if any) that was focused when this dialog opened, so
  // its internal selection can be restored without letting the browser move the caret.
  let editorRootToRestoreFocus: HTMLElement | null = null;
  let focusRestoreGeneration = 0;

  watch(
    open,
    (isOpen) => {
      if (!isOpen) return;
      focusRestoreGeneration += 1;
      // Keep the original editor while a prior close animation is still pending.
      if (editorRootToRestoreFocus) return;
      const active = document.activeElement;
      editorRootToRestoreFocus = active instanceof HTMLElement ? active.closest(".cm-editor") : null;
    },
    { immediate: true },
  );

  function onCloseAutoFocus(event: Event) {
    const target = editorRootToRestoreFocus;
    if (!target || !target.isConnected) {
      editorRootToRestoreFocus = null;
      return;
    }
    event.preventDefault();
    // An interrupted close may emit after the dialog has reopened. Suppress the stale native
    // restoration, but retain the editor for the next completed close.
    if (open.value) return;
    const generation = focusRestoreGeneration;
    void import("@codemirror/view").then(({ EditorView }) => {
      if (open.value || generation !== focusRestoreGeneration || editorRootToRestoreFocus !== target) return;
      editorRootToRestoreFocus = null;
      EditorView.findFromDOM(target)?.focus();
    });
  }

  return { onCloseAutoFocus };
}

type RenameInput = Pick<HTMLInputElement, "focus" | "select">;
type FrameScheduler = (callback: () => void) => number;
type PendingRenameFocusRestore = { value: boolean };

const scheduleAnimationFrame: FrameScheduler = (callback) => {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }
  return setTimeout(callback, 0) as unknown as number;
};

export function focusSidebarRenameInput(getInput: () => RenameInput | undefined, schedule: FrameScheduler = scheduleAnimationFrame) {
  schedule(() => {
    const input = getInput();
    input?.focus();
    input?.select();
  });
}

export function shouldPreventRenameCloseAutoFocus(pending: PendingRenameFocusRestore): boolean {
  if (!pending.value) return false;
  pending.value = false;
  return true;
}

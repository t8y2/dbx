/** Keep nonvisual work off continuous typing/scrolling, with an explicit lifecycle flush. */
export function createDeferredEditorTask(run: () => void, delay: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  function cancel() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  return {
    schedule() {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delay);
    },
    cancel,
    flush() {
      if (timer === null) return;
      cancel();
      run();
    },
  };
}

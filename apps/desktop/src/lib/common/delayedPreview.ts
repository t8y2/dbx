export interface DelayedPreview<T> {
  schedule(value: T): void;
  runNow(value: T): void;
  cancel(): void;
}

export function createDelayedPreview<T>(apply: (value: T) => void, delayMs: number): DelayedPreview<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  function cancel() {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  }

  return {
    schedule(value) {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        apply(value);
      }, delayMs);
    },
    runNow(value) {
      cancel();
      apply(value);
    },
    cancel,
  };
}

export interface UiScaleApplyQueue {
  request: (scale: number) => void;
  whenIdle: () => Promise<void>;
}

export function createUiScaleApplyQueue(apply: (scale: number) => Promise<void>, onApplied: (scale: number) => void, onError: (scale: number, error: unknown) => void): UiScaleApplyQueue {
  let queuedScale: number | undefined;
  let applying = false;
  let lastAppliedScale: number | undefined;
  let idleResolvers: Array<() => void> = [];

  function resolveIdle() {
    if (applying || queuedScale !== undefined) return;
    const resolvers = idleResolvers;
    idleResolvers = [];
    resolvers.forEach((resolve) => resolve());
  }

  async function flush() {
    try {
      while (queuedScale !== undefined) {
        const scale = queuedScale;
        queuedScale = undefined;
        if (scale === lastAppliedScale) continue;

        try {
          await apply(scale);
        } catch (error) {
          onError(scale, error);
          continue;
        }

        // Newer requests replace this completed IPC result. Repeating the same
        // scale is already satisfied by this call, so coalesce it as well.
        if (queuedScale === undefined || queuedScale === scale) {
          queuedScale = undefined;
          lastAppliedScale = scale;
          onApplied(scale);
        }
      }
    } finally {
      applying = false;
      if (queuedScale !== undefined) {
        applying = true;
        void flush();
      } else {
        resolveIdle();
      }
    }
  }

  function request(scale: number) {
    queuedScale = scale;
    if (applying) return;
    applying = true;
    void flush();
  }

  function whenIdle() {
    if (!applying && queuedScale === undefined) return Promise.resolve();
    return new Promise<void>((resolve) => idleResolvers.push(resolve));
  }

  return { request, whenIdle };
}

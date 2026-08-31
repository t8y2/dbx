export interface OpenTabsRestorationBarrier {
  readonly settled: Promise<void>;
  settle: () => void;
}

export function createOpenTabsRestorationBarrier(): OpenTabsRestorationBarrier {
  let resolveBarrier: () => void;
  let isSettled = false;
  const settled = new Promise<void>((resolve) => {
    resolveBarrier = resolve;
  });

  return {
    settled,
    settle: () => {
      if (isSettled) return;
      isSettled = true;
      resolveBarrier();
    },
  };
}

interface InitializeOpenTabsOptions {
  initializeOptionalState: () => Promise<void>;
  restoreOpenTabs: () => Promise<void>;
  onOptionalStateError: (error: unknown) => void;
}

export async function initializeOpenTabs({ initializeOptionalState, restoreOpenTabs, onOptionalStateError }: InitializeOpenTabsOptions): Promise<void> {
  try {
    await initializeOptionalState();
  } catch (error) {
    onOptionalStateError(error);
  }
  await restoreOpenTabs();
}

interface InitializeDesktopOpenTabsOptions extends InitializeOpenTabsOptions {
  barrier: OpenTabsRestorationBarrier;
}

export async function initializeDesktopOpenTabs({ barrier, ...options }: InitializeDesktopOpenTabsOptions): Promise<void> {
  try {
    await initializeOpenTabs(options);
  } finally {
    barrier.settle();
  }
}

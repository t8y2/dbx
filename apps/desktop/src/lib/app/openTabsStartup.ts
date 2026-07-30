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

interface InitializeDesktopOpenTabsOptions {
  barrier: OpenTabsRestorationBarrier;
  initializeOptionalState: () => Promise<void>;
  restoreOpenTabs: () => Promise<void>;
  onOptionalStateError: (error: unknown) => void;
}

export async function initializeDesktopOpenTabs({ barrier, initializeOptionalState, restoreOpenTabs, onOptionalStateError }: InitializeDesktopOpenTabsOptions): Promise<void> {
  try {
    try {
      await initializeOptionalState();
    } catch (error) {
      onOptionalStateError(error);
    }
    await restoreOpenTabs();
  } finally {
    barrier.settle();
  }
}

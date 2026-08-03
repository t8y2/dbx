export const DATA_GRID_NATIVE_SELECTION_BLOCK_CLASS = "dbx-data-grid-native-selection-blocked";
export const DATA_GRID_NATIVE_SELECTION_RELEASE_DELAY_MS = 2000;

interface NativeSelectionBlockEnvironment {
  document?: {
    documentElement?: {
      classList: {
        add(className: string): void;
        remove(className: string): void;
      };
    };
  };
  getSelection?: () => { removeAllRanges(): void } | null;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export type DataGridNativeSelectionBlockOwner = object;

interface ActiveSelectionBlock {
  environment: NativeSelectionBlockEnvironment;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

const activeSelectionBlocks = new Map<DataGridNativeSelectionBlockOwner, ActiveSelectionBlock>();

function defaultEnvironment(): NativeSelectionBlockEnvironment {
  return globalThis as unknown as NativeSelectionBlockEnvironment;
}

function clearReleaseTimer(owner: DataGridNativeSelectionBlockOwner) {
  const activeBlock = activeSelectionBlocks.get(owner);
  if (activeBlock?.releaseTimer === undefined) return;
  activeBlock.environment.clearTimeout(activeBlock.releaseTimer);
  activeBlock.releaseTimer = undefined;
}

function hasActiveBlockForEnvironment(environment: NativeSelectionBlockEnvironment) {
  const documentElement = environment.document?.documentElement;
  return [...activeSelectionBlocks.values()].some((activeBlock) => activeBlock.environment.document?.documentElement === documentElement);
}

export function beginDataGridNativeSelectionBlock(owner: DataGridNativeSelectionBlockOwner, environment: NativeSelectionBlockEnvironment = defaultEnvironment()) {
  clearReleaseTimer(owner);
  activeSelectionBlocks.set(owner, { environment });
  environment.document?.documentElement?.classList.add(DATA_GRID_NATIVE_SELECTION_BLOCK_CLASS);
  environment.getSelection?.()?.removeAllRanges();
}

export function finishDataGridNativeSelectionBlock(owner: DataGridNativeSelectionBlockOwner, environment: NativeSelectionBlockEnvironment = defaultEnvironment(), delay = DATA_GRID_NATIVE_SELECTION_RELEASE_DELAY_MS) {
  beginDataGridNativeSelectionBlock(owner, environment);
  const activeBlock = activeSelectionBlocks.get(owner);
  if (!activeBlock) return;
  activeBlock.releaseTimer = environment.setTimeout(() => {
    activeSelectionBlocks.delete(owner);
    if (!hasActiveBlockForEnvironment(environment)) {
      environment.document?.documentElement?.classList.remove(DATA_GRID_NATIVE_SELECTION_BLOCK_CLASS);
    }
  }, delay);
}

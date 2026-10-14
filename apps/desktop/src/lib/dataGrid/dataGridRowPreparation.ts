export interface DataGridRowPreparationProgress {
  completed: number;
  total: number;
  phase?: "parsing";
}

export interface DataGridClipboardLimits {
  maxRows?: number;
  maxCells?: number;
}

export class DataGridClipboardCapacityError extends Error {
  constructor() {
    super("Clipboard exceeds grid preparation capacity");
    this.name = "DataGridClipboardCapacityError";
  }
}

export const DATA_GRID_CLIPBOARD_BATCH_CHARS = 32_768;

export interface DataGridRowPreparationOptions {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  onProgress?: (progress: DataGridRowPreparationProgress) => void;
}

// Bound the entire pending buffer, including repeated insertions and wide tables.
export function dataGridPendingRowLimit(columnCount: number): number {
  return Math.min(100_000, Math.floor(1_000_000 / Math.max(1, columnCount)));
}

export function dataGridPreparationBatchSize(columnCount: number): number {
  return Math.max(1, Math.min(1000, Math.floor(20_000 / Math.max(1, columnCount))));
}

export function finishDataGridRowPreparation<T>(operation: Generator<DataGridRowPreparationProgress, T>): T {
  let step = operation.next();
  while (!step.done) step = operation.next();
  return step.value;
}

export async function runDataGridRowPreparation<T>(operation: Generator<DataGridRowPreparationProgress, T>, options: DataGridRowPreparationOptions, cancelled: T): Promise<T> {
  const isCancelled = () => options.signal?.aborted || options.isCurrent?.() === false;
  try {
    if (isCancelled()) return cancelled;
    let step = operation.next();
    while (!step.done) {
      options.onProgress?.(step.value);
      if (isCancelled()) return cancelled;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (isCancelled()) return cancelled;
      step = operation.next();
    }
    return step.value;
  } finally {
    operation.return(cancelled);
  }
}

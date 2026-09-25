export const DATABASE_SEARCH_TABLE_BATCH_SIZE = 200;

export type DatabaseSearchBatchRange = {
  start: number;
  end: number;
};

export function databaseSearchBatchRange(nextIndex: number, total: number, scanAllRemaining = false, batchSize = DATABASE_SEARCH_TABLE_BATCH_SIZE): DatabaseSearchBatchRange {
  const safeTotal = Math.max(0, Math.trunc(total));
  const start = Math.min(Math.max(0, Math.trunc(nextIndex)), safeTotal);
  const safeBatchSize = Math.max(1, Math.trunc(batchSize));
  return {
    start,
    end: scanAllRemaining ? safeTotal : Math.min(start + safeBatchSize, safeTotal),
  };
}

export function databaseSearchNextBatchSize(nextIndex: number, total: number, batchSize = DATABASE_SEARCH_TABLE_BATCH_SIZE): number {
  const range = databaseSearchBatchRange(nextIndex, total, false, batchSize);
  return range.end - range.start;
}

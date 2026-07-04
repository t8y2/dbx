export interface HistoryDateRange {
  startDate: string;
  endDate: string;
}

export function hasHistoryDateRange(range: HistoryDateRange): boolean {
  return !!range.startDate || !!range.endDate;
}

export function historyEntryMatchesDateRange(executedAt: string, range: HistoryDateRange): boolean {
  if (!hasHistoryDateRange(range)) return true;

  const executedTime = new Date(executedAt).getTime();
  if (Number.isNaN(executedTime)) return false;

  const startTime = startOfLocalDate(range.startDate);
  const endTime = endOfLocalDate(range.endDate);
  if (startTime !== null && executedTime < startTime) return false;
  if (endTime !== null && executedTime > endTime) return false;
  return true;
}

export function historyDateRangeIsValid(range: HistoryDateRange): boolean {
  const startTime = startOfLocalDate(range.startDate);
  const endTime = endOfLocalDate(range.endDate);
  return startTime === null || endTime === null || startTime <= endTime;
}

function startOfLocalDate(value: string): number | null {
  const parts = parseDateInput(value);
  if (!parts) return null;
  return new Date(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0).getTime();
}

function endOfLocalDate(value: string): number | null {
  const parts = parseDateInput(value);
  if (!parts) return null;
  return new Date(parts.year, parts.month - 1, parts.day, 23, 59, 59, 999).getTime();
}

function parseDateInput(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { year, month, day };
}

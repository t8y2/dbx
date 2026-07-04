export const HISTORY_ROW_HEIGHT = 72;
export const HISTORY_SCROLL_BUFFER = 600;

export function shouldVirtualizeHistory(count: number): boolean {
  return count > 0;
}

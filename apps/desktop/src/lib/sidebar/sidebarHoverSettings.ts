export const SIDEBAR_HOVER_DELAY_DEFAULT = 300;
export const SIDEBAR_HOVER_DELAY_MIN = 100;
export const SIDEBAR_HOVER_DELAY_MAX = 2000;

export function normalizeSidebarHoverDelay(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return SIDEBAR_HOVER_DELAY_DEFAULT;
  return Math.min(SIDEBAR_HOVER_DELAY_MAX, Math.max(SIDEBAR_HOVER_DELAY_MIN, Math.round(value)));
}

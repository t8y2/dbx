import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

/**
 * The large-table preview notice can be muted for the rest of the local day.
 * Only the day is stored, so the notice comes back by itself tomorrow — this is
 * a snooze, not a permanent setting.
 */
export const TABLE_DATA_PREVIEW_NOTICE_MUTED_DAY_KEY = "dbx-table-data-preview-notice-muted-day";
/** Broadcast so grids kept alive in other tabs hide the notice too. */
export const TABLE_DATA_PREVIEW_NOTICE_SNOOZE_CHANGED_EVENT = "dbx:table-data-preview-notice-snooze-changed";

/** Local calendar day as `YYYY-MM-DD`; local time so "today" matches the user's clock. */
export function localDayKey(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isTableDataPreviewNoticeMutedToday(now: Date = new Date()): boolean {
  return safeLocalStorageGet(TABLE_DATA_PREVIEW_NOTICE_MUTED_DAY_KEY) === localDayKey(now);
}

export function muteTableDataPreviewNoticeForToday(now: Date = new Date()): boolean {
  const saved = safeLocalStorageSet(TABLE_DATA_PREVIEW_NOTICE_MUTED_DAY_KEY, localDayKey(now));
  if (saved && typeof window !== "undefined") window.dispatchEvent(new Event(TABLE_DATA_PREVIEW_NOTICE_SNOOZE_CHANGED_EVENT));
  return saved;
}

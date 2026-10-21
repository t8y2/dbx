import { afterEach, describe, expect, it, vi } from "vitest";
import { isTableDataPreviewNoticeMutedToday, localDayKey, muteTableDataPreviewNoticeForToday, TABLE_DATA_PREVIEW_NOTICE_SNOOZE_CHANGED_EVENT } from "@/lib/dataGrid/tableDataPreviewNotice";

const MUTED_DAY_KEY = "dbx-table-data-preview-notice-muted-day";

function installLocalStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
  return data;
}

describe("table data preview notice snooze", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the notice by default", () => {
    installLocalStorage();
    expect(isTableDataPreviewNoticeMutedToday(new Date(2026, 9, 21, 9, 30))).toBe(false);
  });

  it("stays muted for the rest of the same local day", () => {
    installLocalStorage();
    expect(muteTableDataPreviewNoticeForToday(new Date(2026, 9, 21, 9, 30))).toBe(true);
    expect(isTableDataPreviewNoticeMutedToday(new Date(2026, 9, 21, 23, 59))).toBe(true);
  });

  it("shows the notice again on the next local day", () => {
    installLocalStorage();
    muteTableDataPreviewNoticeForToday(new Date(2026, 9, 21, 9, 30));
    expect(isTableDataPreviewNoticeMutedToday(new Date(2026, 9, 22, 0, 1))).toBe(false);
  });

  it("stores the local calendar day as a plain YYYY-MM-DD value", () => {
    const storage = installLocalStorage();
    muteTableDataPreviewNoticeForToday(new Date(2026, 0, 5, 9, 30));
    expect(storage.get(MUTED_DAY_KEY)).toBe("2026-01-05");
  });

  it("rolls over across a month boundary", () => {
    installLocalStorage();
    muteTableDataPreviewNoticeForToday(new Date(2026, 0, 31, 22, 0));
    expect(localDayKey(new Date(2026, 0, 31, 22, 0))).toBe("2026-01-31");
    expect(isTableDataPreviewNoticeMutedToday(new Date(2026, 1, 1, 8, 0))).toBe(false);
  });

  it("ignores malformed stored values", () => {
    installLocalStorage({ [MUTED_DAY_KEY]: "yesterday" });
    expect(isTableDataPreviewNoticeMutedToday(new Date(2026, 9, 21, 9, 30))).toBe(false);
  });

  it("notifies grids kept alive in other tabs when the notice is muted", () => {
    installLocalStorage();
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });

    muteTableDataPreviewNoticeForToday(new Date(2026, 9, 21, 9, 30));

    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: TABLE_DATA_PREVIEW_NOTICE_SNOOZE_CHANGED_EVENT }));
  });

  it("degrades to showing the notice when localStorage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(isTableDataPreviewNoticeMutedToday(new Date(2026, 9, 21, 9, 30))).toBe(false);
    expect(muteTableDataPreviewNoticeForToday(new Date(2026, 9, 21, 9, 30))).toBe(false);
  });
});

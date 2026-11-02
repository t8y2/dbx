export const OBJECT_BROWSER_SEARCH_FOCUS_EVENT = "dbx:focus-object-browser-search";

type ObjectBrowserSearchFocusDetail = {
  tabId: string;
};

export function requestObjectBrowserSearchFocus(tabId: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ObjectBrowserSearchFocusDetail>(OBJECT_BROWSER_SEARCH_FOCUS_EVENT, { detail: { tabId } }));
}

export function objectBrowserSearchFocusTabId(event: Event): string | undefined {
  if (!(event instanceof CustomEvent)) return undefined;
  const tabId = (event.detail as Partial<ObjectBrowserSearchFocusDetail> | null)?.tabId;
  return typeof tabId === "string" && tabId.length > 0 ? tabId : undefined;
}

export const TAB_DRAG_MIME = "application/x-dbx-tab";

export interface TabDragPayload {
  mime: typeof TAB_DRAG_MIME;
  tabId: string;
  sourceGroupId: string;
}

/**
 * Serializes the drag contract under the project's custom MIME type. The MIME
 * value travels inside the payload as a discriminator, so a drop handler can
 * reject foreign or stale payloads before touching store state.
 */
export function serializeTabDragPayload(payload: { tabId: string; sourceGroupId: string }): string {
  return JSON.stringify({ mime: TAB_DRAG_MIME, tabId: payload.tabId, sourceGroupId: payload.sourceGroupId });
}

export function parseTabDragPayload(raw: string): TabDragPayload | null {
  try {
    const value = JSON.parse(raw) as Partial<TabDragPayload>;
    if (value.mime === TAB_DRAG_MIME && typeof value.tabId === "string" && typeof value.sourceGroupId === "string") {
      return { mime: TAB_DRAG_MIME, tabId: value.tabId, sourceGroupId: value.sourceGroupId };
    }
    return null;
  } catch {
    return null;
  }
}

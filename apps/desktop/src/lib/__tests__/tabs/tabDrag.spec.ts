import { describe, expect, it } from "vitest";
import { parseTabDragPayload, serializeTabDragPayload, TAB_DRAG_MIME } from "@/lib/tabs/tabDrag";

describe("tab drag payload", () => {
  it("serializes and parses a valid payload", () => {
    const raw = serializeTabDragPayload({ tabId: "tab-1", sourceGroupId: "group-1" });
    expect(raw).toContain(TAB_DRAG_MIME);
    expect(parseTabDragPayload(raw)).toEqual({ mime: TAB_DRAG_MIME, tabId: "tab-1", sourceGroupId: "group-1" });
  });

  it("rejects malformed payloads", () => {
    expect(parseTabDragPayload("not-json")).toBeNull();
    expect(parseTabDragPayload(JSON.stringify({ tabId: "tab-1" }))).toBeNull();
  });

  it("rejects payloads carrying a foreign MIME discriminator", () => {
    expect(parseTabDragPayload(JSON.stringify({ mime: "application/json", tabId: "tab-1", sourceGroupId: "group-1" }))).toBeNull();
  });

  it("exposes the custom MIME type", () => {
    expect(TAB_DRAG_MIME).toBe("application/x-dbx-tab");
  });
});

import { describe, expect, it } from "vitest";
import { eventEditorInstanceKey, resolveInitialEventEditorRequest } from "./eventEditorRequest";

const base = { openedRequestKey: "" };

describe("eventEditorInstanceKey", () => {
  it("separates repeated CREATE requests", () => {
    expect(eventEditorInstanceKey({ createRequestId: 1 })).not.toBe(eventEditorInstanceKey({ createRequestId: 2 }));
  });

  it("separates ALTER rows from CREATE mode", () => {
    expect(eventEditorInstanceKey({ openRequestId: 1, rowId: "event:old_event" })).not.toBe(eventEditorInstanceKey({ createRequestId: 3 }));
    expect(eventEditorInstanceKey({ openRequestId: 1, rowId: "event:old_event" })).not.toBe(eventEditorInstanceKey({ openRequestId: 1, rowId: "event:other_event" }));
  });
});

describe("resolveInitialEventEditorRequest", () => {
  describe("create request (New Event)", () => {
    it("opens CREATE mode without requiring an existing EVENT row", () => {
      const decision = resolveInitialEventEditorRequest({ ...base, eventCreateRequestId: 7, hasEventRow: false });
      expect(decision).toEqual({ type: "create", requestKey: "create:7" });
    });

    it("dedupes only the same request id", () => {
      expect(resolveInitialEventEditorRequest({ ...base, eventCreateRequestId: 3, openedRequestKey: "create:2" })).toEqual({ type: "create", requestKey: "create:3" });
      expect(resolveInitialEventEditorRequest({ openedRequestKey: "create:3", eventCreateRequestId: 3 })).toEqual({ type: "ignore" });
    });

    it("re-enters CREATE mode when the request id increments on a reused tab", () => {
      const first = resolveInitialEventEditorRequest({ openedRequestKey: "", eventCreateRequestId: 1 });
      expect(first).toEqual({ type: "create", requestKey: "create:1" });
      // second click on the SAME tab with a fresh request id must open again
      const second = resolveInitialEventEditorRequest({ openedRequestKey: first.type === "create" ? first.requestKey : "", eventCreateRequestId: 2 });
      expect(second).toEqual({ type: "create", requestKey: "create:2" });
    });

    it("defers while the object list is still loading", () => {
      expect(resolveInitialEventEditorRequest({ ...base, eventCreateRequestId: 1, loadingObjects: true })).toEqual({ type: "ignore" });
      expect(resolveInitialEventEditorRequest({ ...base, eventCreateRequestId: 1, loadingObjects: false })).toEqual({ type: "create", requestKey: "create:1" });
    });
  });

  describe("edit request (existing event)", () => {
    it("opens the existing EVENT editor only when the row is present", () => {
      expect(resolveInitialEventEditorRequest({ ...base, eventName: "foo_event", eventOpenRequestId: 2, hasEventRow: true })).toEqual({ type: "edit", requestKey: "2:foo_event" });
      expect(resolveInitialEventEditorRequest({ ...base, eventName: "foo_event", eventOpenRequestId: 2, hasEventRow: false })).toEqual({ type: "ignore" });
    });

    it("remains ALTER-mode safe: same name + new request id reopens", () => {
      const first = resolveInitialEventEditorRequest({ openedRequestKey: "", eventName: "foo_event", eventOpenRequestId: 1, hasEventRow: true });
      expect(first).toEqual({ type: "edit", requestKey: "1:foo_event" });
      const second = resolveInitialEventEditorRequest({ openedRequestKey: first.type === "edit" ? first.requestKey : "", eventName: "foo_event", eventOpenRequestId: 2, hasEventRow: true });
      expect(second).toEqual({ type: "edit", requestKey: "2:foo_event" });
    });
  });

  describe("plain Event list open", () => {
    it("does not open any editor when there is no event intent", () => {
      expect(resolveInitialEventEditorRequest({ ...base, openedRequestKey: "" })).toEqual({ type: "ignore" });
      expect(resolveInitialEventEditorRequest({ ...base, openedRequestKey: "", initialObjectFilterIntent: undefined } as any)).toEqual({ type: "ignore" });
    });

    it("does not open CREATE mode for stale blank names", () => {
      expect(resolveInitialEventEditorRequest({ ...base, eventName: "  " })).toEqual({ type: "ignore" });
    });
  });

  describe("create priority over stale edit target", () => {
    it("honors a fresh create request even when an edit target lingers", () => {
      const decision = resolveInitialEventEditorRequest({ ...base, eventCreateRequestId: 5, eventName: "old_event", eventOpenRequestId: 9, hasEventRow: true });
      expect(decision).toEqual({ type: "create", requestKey: "create:5" });
    });
  });
});

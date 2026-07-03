import { describe, expect, it } from "vitest";
import { visibleToActualIndex } from "@/lib/aiMessageEdit";

describe("visibleToActualIndex", () => {
  it("maps visible index 0 to first non-summary message", () => {
    const messages = [{ kind: undefined }, { kind: undefined }, { kind: undefined }];
    expect(visibleToActualIndex(messages, 0)).toBe(0);
  });

  it("maps visible index 1 correctly with no summaries", () => {
    const messages = [{ kind: undefined }, { kind: undefined }, { kind: undefined }];
    expect(visibleToActualIndex(messages, 1)).toBe(1);
  });

  it("skips contextSummary messages when computing visible index", () => {
    const messages = [{ kind: undefined }, { kind: "contextSummary" }, { kind: undefined }, { kind: undefined }];
    // visible[0] → actual[0], visible[1] → actual[2], visible[2] → actual[3]
    expect(visibleToActualIndex(messages, 0)).toBe(0);
    expect(visibleToActualIndex(messages, 1)).toBe(2);
    expect(visibleToActualIndex(messages, 2)).toBe(3);
  });

  it("skips multiple consecutive contextSummary messages", () => {
    const messages = [{ kind: "contextSummary" }, { kind: "contextSummary" }, { kind: undefined }, { kind: undefined }];
    expect(visibleToActualIndex(messages, 0)).toBe(2);
    expect(visibleToActualIndex(messages, 1)).toBe(3);
  });

  it("returns -1 when visibleIndex is out of range", () => {
    const messages = [{ kind: undefined }, { kind: undefined }];
    expect(visibleToActualIndex(messages, 5)).toBe(-1);
  });

  it("returns -1 for empty messages array", () => {
    expect(visibleToActualIndex([], 0)).toBe(-1);
  });

  it("returns -1 when all messages are contextSummary", () => {
    const messages = [{ kind: "contextSummary" }, { kind: "contextSummary" }];
    expect(visibleToActualIndex(messages, 0)).toBe(-1);
  });

  it("handles last visible message correctly", () => {
    const messages = [{ kind: undefined }, { kind: "contextSummary" }, { kind: undefined }];
    expect(visibleToActualIndex(messages, 1)).toBe(2);
    expect(visibleToActualIndex(messages, 2)).toBe(-1);
  });
});

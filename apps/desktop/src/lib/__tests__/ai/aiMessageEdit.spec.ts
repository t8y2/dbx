import { describe, expect, it } from "vitest";
import { retryableUserMessageIndex, visibleToActualIndex } from "@/lib/ai/aiMessageEdit";

describe("retryableUserMessageIndex", () => {
  it("finds the closest preceding user turn", () => {
    const messages = [
      { role: "user" as const, content: "first" },
      { role: "assistant" as const, content: "reply" },
      { role: "user" as const, content: "latest" },
      { role: "assistant" as const, content: "latest reply" },
    ];
    expect(retryableUserMessageIndex(messages, 3)).toBe(2);
  });

  it("keeps attachment-only requests retryable", () => {
    const messages = [
      { role: "user" as const, content: "", imageAttachments: [{}] },
      { role: "assistant" as const, content: "reply" },
    ];
    expect(retryableUserMessageIndex(messages, 1)).toBe(0);
  });

  it("returns -1 when no preceding user request exists", () => {
    expect(retryableUserMessageIndex([{ role: "assistant", content: "reply" }], 0)).toBe(-1);
  });
});

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

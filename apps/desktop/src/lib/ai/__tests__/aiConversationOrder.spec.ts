import { describe, expect, it } from "vitest";
import { compareAiConversations, mostRecentConversation, sortAiConversations, splitPinnedConversations } from "../aiConversationOrder";

type Row = { id: string; pinned?: boolean; updatedAt: string };

const row = (id: string, updatedAt: string, pinned = false): Row => ({ id, updatedAt, ...(pinned ? { pinned: true } : {}) });

describe("compareAiConversations", () => {
  it("puts pinned conversations before unpinned ones regardless of timestamp", () => {
    const oldPinned = row("old-pinned", "2020-01-01", true);
    const newUnpinned = row("new-unpinned", "2026-11-04");
    expect([newUnpinned, oldPinned].sort(compareAiConversations).map((c) => c.id)).toEqual(["old-pinned", "new-unpinned"]);
  });

  it("orders by updatedAt descending inside a group", () => {
    const rows = [row("a", "2026-01-01"), row("c", "2026-03-01"), row("b", "2026-02-01")];
    expect(sortAiConversations(rows).map((c) => c.id)).toEqual(["c", "b", "a"]);
  });

  it("treats a missing pinned field as unpinned", () => {
    const legacy = { id: "legacy", updatedAt: "2026-05-01" } as Row;
    const pinned = row("pinned", "2026-01-01", true);
    expect([legacy, pinned].sort(compareAiConversations).map((c) => c.id)).toEqual(["pinned", "legacy"]);
  });

  it("does not mutate the input array", () => {
    const rows = [row("a", "2026-01-01"), row("b", "2026-02-01")];
    const copy = [...rows];
    sortAiConversations(rows);
    expect(rows).toEqual(copy);
  });
});

describe("mostRecentConversation", () => {
  it("returns the newest conversation even when an older one is pinned", () => {
    const rows = [row("pinned-old", "2020-01-01", true), row("recent", "2026-11-04")];
    expect(mostRecentConversation(rows)?.id).toBe("recent");
  });

  it("ignores pinned ordering entirely", () => {
    const rows = sortAiConversations([row("a", "2026-01-01", true), row("b", "2026-03-01")]);
    expect(rows[0].id).toBe("a");
    expect(mostRecentConversation(rows)?.id).toBe("b");
  });

  it("returns undefined for an empty list", () => {
    expect(mostRecentConversation([])).toBeUndefined();
  });
});

describe("splitPinnedConversations", () => {
  it("keeps each section in the order it received", () => {
    const ordered = [row("p1", "2026-01-01", true), row("p2", "2026-02-01", true), row("r1", "2026-03-01")];
    const { pinned, recent } = splitPinnedConversations(ordered);
    expect(pinned.map((c) => c.id)).toEqual(["p1", "p2"]);
    expect(recent.map((c) => c.id)).toEqual(["r1"]);
  });

  it("returns an empty pinned section when nothing is pinned", () => {
    const { pinned, recent } = splitPinnedConversations([row("r1", "2026-03-01")]);
    expect(pinned).toEqual([]);
    expect(recent).toHaveLength(1);
  });
});

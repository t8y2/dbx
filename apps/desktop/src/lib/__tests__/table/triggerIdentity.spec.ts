import { describe, expect, it } from "vitest";
import { triggerDisplayName, triggerIdentity } from "@/lib/table/triggerIdentity";
import { createTriggerDrafts } from "@/lib/table/tableStructureEditorState";

describe("trigger catalog identity", () => {
  it("keeps same-name owners and punctuation distinct without folding quoted names", () => {
    const triggers = [
      { owner: "A", name: "AUDIT", timing: "AFTER", event: "INSERT" },
      { owner: "B", name: "AUDIT", timing: "BEFORE", event: "UPDATE" },
      { owner: "A:B", name: "C", timing: "AFTER", event: "INSERT" },
      { owner: "A", name: "B:C", timing: "AFTER", event: "INSERT" },
      { owner: "a", name: "AUDIT", timing: "AFTER", event: "INSERT" },
    ];
    const drafts = createTriggerDrafts(triggers);
    expect(new Set(triggers.map(triggerIdentity)).size).toBe(triggers.length);
    expect(new Set(drafts.map((draft) => draft.id)).size).toBe(triggers.length);
    expect(drafts.map((draft) => draft.original?.owner)).toEqual(["A", "B", "A:B", "A", "a"]);
    expect(triggers.slice(0, 2).map(triggerDisplayName)).toEqual(["A.AUDIT", "B.AUDIT"]);
  });

  it("keeps missing legacy owner unknown and separate from explicit catalog owner", () => {
    const trigger = { name: "AUDIT", event: "INSERT", timing: "AFTER" };
    const [draft] = createTriggerDrafts([trigger]);
    expect(draft?.original?.owner).toBeUndefined();
    expect(triggerIdentity(trigger)).toBe(triggerIdentity({ ...trigger, owner: null }));
    expect(triggerIdentity(trigger)).not.toBe(triggerIdentity({ ...trigger, owner: "APP" }));
    expect(triggerDisplayName(trigger)).toBe("AUDIT");
  });
});

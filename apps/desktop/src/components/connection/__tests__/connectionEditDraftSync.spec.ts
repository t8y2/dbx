import { describe, expect, it } from "vitest";
import { connectionEditDraftSyncAction } from "../connectionEditDraftSync";

describe("connectionEditDraftSyncAction", () => {
  it("hydrates normal connection edits without reloading an active draft", () => {
    expect(connectionEditDraftSyncAction("connection-a", true, null)).toBe("hydrate");
    expect(connectionEditDraftSyncAction("connection-a", true, "connection-a")).toBe("preserve");
    expect(connectionEditDraftSyncAction("connection-b", true, "connection-a")).toBe("hydrate");
    expect(connectionEditDraftSyncAction("connection-a", false, "connection-a")).toBe("preserve");
    expect(connectionEditDraftSyncAction("connection-a", true, null)).toBe("hydrate");
  });

  it("keeps a copied connection draft when its saved snapshot is refreshed", () => {
    const draft = { id: "connection-b", host: "edited.example.test", password: "edited-secret" };
    const savedCopySnapshot = { id: "connection-b", host: "original.example.test", password: "original-secret" };

    const action = connectionEditDraftSyncAction(savedCopySnapshot.id, true, draft.id);

    expect(action).toBe("preserve");
    expect(draft).toEqual({ id: "connection-b", host: "edited.example.test", password: "edited-secret" });
  });
});

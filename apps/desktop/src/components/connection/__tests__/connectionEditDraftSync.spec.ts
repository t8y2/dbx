import { describe, expect, it } from "vitest";
import { canPersistConnectionTestResult, connectionEditDraftSyncAction } from "../connectionEditDraftSync";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("connectionEditDraftSyncAction", () => {
  it("hydrates normal connection edits without reloading an active draft", () => {
    expect(connectionEditDraftSyncAction("connection-a", true, null)).toBe("hydrate");
    expect(connectionEditDraftSyncAction("connection-a", true, "connection-a")).toBe("preserve");
    expect(connectionEditDraftSyncAction("connection-b", true, "connection-a")).toBe("hydrate");
    expect(connectionEditDraftSyncAction("connection-a", false, "connection-a")).toBe("preserve");
    expect(connectionEditDraftSyncAction("connection-a", true, null)).toBe("hydrate");
  });

  it("keeps a copied connection draft when its saved snapshot is refreshed", () => {
    const draft = { id: "connection-b", name: "edited copy", host: "edited.example.test", password: "edited-secret" };
    const savedCopySnapshot = { id: "connection-b", name: "original copy", host: "original.example.test", password: "original-secret" };

    const action = connectionEditDraftSyncAction(savedCopySnapshot.id, true, draft.id);

    expect(action).toBe("preserve");
    expect(draft).toEqual({ id: "connection-b", name: "edited copy", host: "edited.example.test", password: "edited-secret" });
  });

  it("does not persist an asynchronous test after the user edits the copied name", async () => {
    const pendingTest = deferred<string>();
    const draft = { id: "connection-b", name: "original copy", fingerprint: "saved-copy" };
    const completion = pendingTest.promise.then((submittedFingerprint) =>
      canPersistConnectionTestResult({
        testConfigId: draft.id,
        activeDraftId: draft.id,
        testRunId: 7,
        activeTestRunId: 7,
        submittedFingerprint,
        savedFingerprint: "saved-copy",
        currentDraftFingerprint: draft.fingerprint,
      }),
    );

    draft.name = "edited copy";
    draft.fingerprint = "edited-copy";
    pendingTest.resolve("saved-copy");

    expect(await completion).toBe(false);
    expect(draft.name).toBe("edited copy");
  });

  it("rejects test side effects after switching targets or closing the dialog", () => {
    const baseState = {
      testConfigId: "connection-a",
      testRunId: 4,
      submittedFingerprint: "saved-a",
      savedFingerprint: "saved-a",
      currentDraftFingerprint: "saved-a",
    };

    expect(canPersistConnectionTestResult({ ...baseState, activeDraftId: "connection-b", activeTestRunId: 5 })).toBe(false);
    expect(canPersistConnectionTestResult({ ...baseState, activeDraftId: null, activeTestRunId: 5 })).toBe(false);
    expect(connectionEditDraftSyncAction("connection-b", true, "connection-a")).toBe("hydrate");
    expect(connectionEditDraftSyncAction("connection-a", false, "connection-a")).toBe("preserve");
  });

  it("preserves the normal unchanged test persistence path", () => {
    expect(
      canPersistConnectionTestResult({
        testConfigId: "connection-a",
        activeDraftId: "connection-a",
        testRunId: 3,
        activeTestRunId: 3,
        submittedFingerprint: "saved-a",
        savedFingerprint: "saved-a",
        currentDraftFingerprint: "saved-a",
      }),
    ).toBe(true);
  });
});

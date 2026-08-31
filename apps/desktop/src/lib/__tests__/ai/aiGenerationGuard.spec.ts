import { describe, expect, it } from "vitest";
import { AiGenerationGuard } from "@/lib/ai/aiGenerationGuard";

// Race coverage requested on https://github.com/t8y2/dbx/pull/6332: clearing/switching
// the AI chat while a request is in flight must isolate that request's async callbacks
// from whatever generation is active by the time they run, independent of whether the
// backend cancel RPC actually reached a registered stream id.

describe("AiGenerationGuard", () => {
  it("begin() returns increasing ids and starts current", () => {
    const guard = new AiGenerationGuard();
    const g1 = guard.begin();
    expect(guard.isCurrent(g1)).toBe(true);
    const g2 = guard.begin();
    expect(g2).toBeGreaterThan(g1);
    expect(guard.isCurrent(g1)).toBe(false);
    expect(guard.isCurrent(g2)).toBe(true);
  });

  it("invalidate() supersedes the active generation even with no new send()", () => {
    const guard = new AiGenerationGuard();
    const g1 = guard.begin();
    guard.invalidate();
    expect(guard.isCurrent(g1)).toBe(false);
  });

  // peek() lets a caller that isn't itself a send() invocation (the Stop button —
  // see AiAssistant.vue's cancelStream()) snapshot the active generation without
  // starting a new one, then later check isCurrent() against that snapshot. This
  // is what lets Stop detect "did the request I clicked on get superseded" even
  // when there's no session id registered yet to compare against instead
  // (reviewed on PR #6332).
  it("peek() snapshots the current generation without advancing it", () => {
    const guard = new AiGenerationGuard();
    const g1 = guard.begin();
    const snapshot = guard.peek();
    expect(snapshot).toBe(g1);
    expect(guard.isCurrent(snapshot)).toBe(true);
    // peek() itself must not consume/advance the generation the way begin() does.
    expect(guard.peek()).toBe(snapshot);
  });

  it("peek() reflects invalidation the same way isCurrent() does", () => {
    const guard = new AiGenerationGuard();
    const clickedGeneration = guard.peek();
    expect(guard.isCurrent(clickedGeneration)).toBe(true);
    // A newer send() starting (begin()) or an abandon (invalidate()) after the
    // click must both make the snapshot stale.
    guard.begin();
    expect(guard.isCurrent(clickedGeneration)).toBe(false);
  });

  // Race 1: clear/switch fires before send() has registered a stream id with the
  // backend (cancelStream() would be a no-op in this window). The guard must still
  // mark the generation stale immediately and synchronously.
  it("invalidating before stream registration still supersedes the pending send()", async () => {
    const guard = new AiGenerationGuard();
    let registeredWhileCurrent: boolean | null = null;

    async function send() {
      const gen = guard.begin();
      // Simulate the async work send() does before it registers a session id
      // with the backend (e.g. awaiting promptTemplateStore.ensureLoaded()).
      await Promise.resolve();
      // The user cleared the chat during that await, before registration.
      registeredWhileCurrent = guard.isCurrent(gen);
    }

    const pending = send();
    // Clear fires synchronously, before send()'s microtask queue drains —
    // i.e. before any session id could have been registered.
    guard.invalidate();
    await pending;

    expect(registeredWhileCurrent).toBe(false);
  });

  // Race 2: cancel, then immediately start a new send() — the old request's promise
  // resolves later. The old generation's completion handlers must not touch state
  // that now belongs to the new generation.
  it("an old generation resolving after a newer one started must not report current", async () => {
    const guard = new AiGenerationGuard();
    const applied: string[] = [];

    function startSend(label: string, resolveAfter: Promise<void>) {
      const gen = guard.begin();
      return resolveAfter.then(() => {
        if (guard.isCurrent(gen)) applied.push(label);
      });
    }

    let releaseOld: () => void;
    const oldFinishes = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const oldSend = startSend("old", oldFinishes);

    // User cancels (clear/switch) and immediately fires a new request before the
    // old one has resolved.
    guard.invalidate();
    const newSend = startSend("new", Promise.resolve());
    await newSend;

    // Old request's backend call finally settles well after the new one started.
    releaseOld!();
    await oldSend;

    expect(applied).toEqual(["new"]);
  });
});

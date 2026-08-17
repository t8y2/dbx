import { describe, expect, it } from "vitest";
import { createSidebarSearchLoadingTracker } from "@/lib/sidebar/sidebarSearchLoadingTracker";

describe("sidebar search loading tracker", () => {
  it("is idle until a search dispatch begins", () => {
    const tracker = createSidebarSearchLoadingTracker();
    expect(tracker.isLoading).toBe(false);
  });

  it("reports loading while a dispatch is in flight and clears on matching end", () => {
    const tracker = createSidebarSearchLoadingTracker();
    const generation = tracker.begin();
    expect(tracker.isLoading).toBe(true);
    expect(tracker.end(generation)).toBe(true);
    expect(tracker.isLoading).toBe(false);
  });

  it("ignores a stale end() from a superseded dispatch (fast typing race)", () => {
    // This is the exact race in ConnectionTree.vue's search watcher: each keystroke
    // (after debounce) re-dispatches expansion tasks; a slow earlier dispatch must not
    // clear the spinner set by a newer, still-in-flight dispatch.
    const tracker = createSidebarSearchLoadingTracker();
    const firstGeneration = tracker.begin();
    const secondGeneration = tracker.begin();
    expect(tracker.isLoading).toBe(true);

    expect(tracker.end(firstGeneration)).toBe(false);
    expect(tracker.isLoading).toBe(true);

    expect(tracker.end(secondGeneration)).toBe(true);
    expect(tracker.isLoading).toBe(false);
  });

  it("cancel() immediately clears loading and invalidates any pending end()", () => {
    const tracker = createSidebarSearchLoadingTracker();
    const generation = tracker.begin();
    tracker.cancel();
    expect(tracker.isLoading).toBe(false);

    expect(tracker.end(generation)).toBe(false);
    expect(tracker.isLoading).toBe(false);
  });
});

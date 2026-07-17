import { describe, expect, it } from "vitest";
import { createSidePanelRequestGuard } from "@/lib/table/sidePanelRequestGuard";

describe("SidePanelRequestGuard", () => {
  it("fresh capture is not stale", () => {
    const guard = createSidePanelRequestGuard();
    const epoch = guard.capture();
    expect(guard.isStale(epoch)).toBe(false);
    expect(guard.isFresh(epoch)).toBe(true);
  });

  it("bump invalidates previously captured epoch", () => {
    const guard = createSidePanelRequestGuard();
    const epoch = guard.capture();
    guard.bump();
    expect(guard.isStale(epoch)).toBe(true);
    expect(guard.isFresh(epoch)).toBe(false);
  });

  it("multiple bumps invalidate all previous epochs", () => {
    const guard = createSidePanelRequestGuard();
    const e1 = guard.capture();
    guard.bump();
    const e2 = guard.capture();
    guard.bump();
    const e3 = guard.capture();
    expect(guard.isStale(e1)).toBe(true);
    expect(guard.isStale(e2)).toBe(true);
    expect(guard.isStale(e3)).toBe(false);
    expect(guard.isFresh(e3)).toBe(true);
  });

  it("starting B invalidates an in-flight request for A", () => {
    const guard = createSidePanelRequestGuard();
    const epochA = guard.start();
    const epochB = guard.start();

    expect(guard.isStale(epochA)).toBe(true);
    expect(guard.isFresh(epochB)).toBe(true);
  });

  it("simulates database context change: old results are stale", () => {
    const guard = createSidePanelRequestGuard();
    const epochDb1 = guard.capture();
    // Database switch → close panel + bump epoch
    guard.bump();
    // Old request from DB1 arrives — must be discarded
    expect(guard.isStale(epochDb1)).toBe(true);
  });

  it("guards are independent", () => {
    const guard1 = createSidePanelRequestGuard();
    const guard2 = createSidePanelRequestGuard();
    const e1 = guard1.capture();
    guard2.bump();
    expect(guard1.isStale(e1)).toBe(false);
    expect(guard2.isStale(e1)).toBe(true);
  });
});

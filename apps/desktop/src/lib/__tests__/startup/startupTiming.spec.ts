import { afterEach, describe, expect, it, vi } from "vitest";
import { markStartupPhase } from "@/lib/startup/startupTiming";

afterEach(() => vi.unstubAllGlobals());

describe("startup phase marks", () => {
  it("records each phase once without confusing gate mount with app readiness", () => {
    const entries = new Set<string>();
    const mark = vi.fn((name: string) => entries.add(name));
    vi.stubGlobal("performance", { mark, getEntriesByName: (name: string) => (entries.has(name) ? [{}] : []) });
    markStartupPhase("gate-mounted");
    markStartupPhase("gate-mounted");
    expect(mark).toHaveBeenCalledTimes(1);
    expect(entries.has("dbx:startup:app-mounted")).toBe(false);
    markStartupPhase("app-mounted");
    expect(mark).toHaveBeenCalledTimes(2);
  });

  it("does not block startup when performance marks are unavailable", () => {
    vi.stubGlobal("performance", {});
    expect(() => markStartupPhase("bootstrap")).not.toThrow();
  });
});

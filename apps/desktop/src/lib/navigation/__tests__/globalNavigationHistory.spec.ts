import { describe, expect, it } from "vitest";
import { createGlobalNavigationHistory, moveGlobalNavigation, recordGlobalNavigation } from "../globalNavigationHistory";
import type { GlobalNavigationEntry } from "../navigationEntry";

const entry = (id: string): GlobalNavigationEntry => ({ id, surface: "query", tabId: id });

describe("global navigation history", () => {
  it("records visits without duplicating the current entry", () => {
    let history = createGlobalNavigationHistory();
    history = recordGlobalNavigation(history, entry("a"));
    history = recordGlobalNavigation(history, entry("a"));
    expect(history.entries.map((item) => item.id)).toEqual(["a"]);
    expect(history.index).toBe(0);
  });

  it("clears the forward branch after a new visit", () => {
    let history = createGlobalNavigationHistory();
    for (const id of ["a", "b", "c"]) history = recordGlobalNavigation(history, entry(id));
    const back = moveGlobalNavigation(history, -1, () => true);
    expect(back?.entry.id).toBe("b");
    history = back!.history;
    history = recordGlobalNavigation(history, entry("d"));
    expect(history.entries.map((item) => item.id)).toEqual(["a", "b", "d"]);
    expect(moveGlobalNavigation(history, 1, () => true)).toBeNull();
  });

  it("skips invalid entries while moving", () => {
    let history = createGlobalNavigationHistory();
    for (const id of ["a", "closed", "c"]) history = recordGlobalNavigation(history, entry(id));
    const back = moveGlobalNavigation(history, -1, (item) => item.id !== "closed");
    expect(back?.entry.id).toBe("a");
  });
  it("coalesces an asynchronous source identity resolution into the same visit", () => {
    let history = recordGlobalNavigation(createGlobalNavigationHistory(), entry("previous"));
    history = recordGlobalNavigation(history, { id: "pending", surface: "query", kind: "objectSource", tabId: "source", objectType: "PROCEDURE" });
    history = recordGlobalNavigation(history, { id: "loaded", surface: "query", kind: "objectSource", tabId: "source", objectType: "FUNCTION" });
    expect(history.entries.map((item) => item.id)).toEqual(["previous", "loaded"]);
    expect(moveGlobalNavigation(history, -1, () => true)?.entry.id).toBe("previous");
  });
});

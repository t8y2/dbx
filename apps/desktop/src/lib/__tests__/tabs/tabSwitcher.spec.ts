import { describe, expect, it } from "vitest";
import { initialTabSwitcherSelection, moveTabSwitcherSelection, tabSwitcherOrder } from "@/lib/tabs/tabSwitcher";

const tabs = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

describe("tabSwitcherOrder", () => {
  it("orders tabs by most recent use first", () => {
    expect(tabSwitcherOrder(tabs, ["a", "c"]).map((tab) => tab.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("returns tab-bar order when there is no history", () => {
    expect(tabSwitcherOrder(tabs, []).map((tab) => tab.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("drops history ids whose tab no longer exists", () => {
    expect(tabSwitcherOrder(tabs, ["gone", "b"]).map((tab) => tab.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("keeps duplicated history entries only once, at their latest position", () => {
    expect(tabSwitcherOrder(tabs, ["a", "b", "a"]).map((tab) => tab.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("initialTabSwitcherSelection", () => {
  it("highlights the previous tab so a quick tap toggles between the two most recent", () => {
    expect(initialTabSwitcherSelection(3)).toBe(1);
  });

  it("highlights the only tab when just one is open", () => {
    expect(initialTabSwitcherSelection(1)).toBe(0);
  });
});

describe("moveTabSwitcherSelection", () => {
  it("moves forward and wraps past the end", () => {
    expect(moveTabSwitcherSelection(1, 1, 3)).toBe(2);
    expect(moveTabSwitcherSelection(2, 1, 3)).toBe(0);
  });

  it("moves backward and wraps before the start", () => {
    expect(moveTabSwitcherSelection(0, -1, 3)).toBe(2);
    expect(moveTabSwitcherSelection(2, -1, 3)).toBe(1);
  });

  it("returns -1 when there is nothing to select", () => {
    expect(moveTabSwitcherSelection(0, 1, 0)).toBe(-1);
  });

  it("enters the list from an unset highlight", () => {
    expect(moveTabSwitcherSelection(-1, 1, 3)).toBe(0);
    expect(moveTabSwitcherSelection(-1, -1, 3)).toBe(2);
  });
});

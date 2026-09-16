import { describe, expect, it } from "vitest";
import { createSidebarSearchExpansionState } from "@/lib/sidebar/sidebarSearchExpansionState";

describe("sidebar search expansion state", () => {
  it("keeps auto-expanded ownership after a filtered group becomes an unfiltered ancestor match", () => {
    const state = createSidebarSearchExpansionState();

    state.markFiltered("group-tables", true);
    expect(state.markUnfiltered("group-tables")).toBe(true);

    expect(state.filteredNodeIds.has("group-tables")).toBe(false);
    expect(state.autoExpandedNodeIds.has("group-tables")).toBe(true);
    expect(state.shouldRestore("group-tables")).toBe(true);
  });

  it("clears tracked ownership when ordinary search exits through another mode", () => {
    const state = createSidebarSearchExpansionState();
    state.markFiltered("group-tables", true);

    state.clear();

    expect(state.hasTrackedNodes()).toBe(false);
    expect(state.shouldRestore("group-tables")).toBe(false);
  });
});

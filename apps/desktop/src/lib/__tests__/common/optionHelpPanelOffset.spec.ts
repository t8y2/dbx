import { describe, expect, it } from "vitest";
import { optionHelpPanelOffsetTop } from "@/lib/common/optionHelpPanelOffset";

describe("optionHelpPanelOffsetTop", () => {
  it("aligns a help panel with the active option when there is room", () => {
    expect(optionHelpPanelOffsetTop({ activeItemTop: 48, listCardHeight: 260, panelHeight: 80 })).toBe(48);
  });

  it("does not produce a negative offset", () => {
    expect(optionHelpPanelOffsetTop({ activeItemTop: -12, listCardHeight: 260, panelHeight: 80 })).toBe(0);
  });

  it("clamps the panel upward at the list card bottom", () => {
    expect(optionHelpPanelOffsetTop({ activeItemTop: 210, listCardHeight: 260, panelHeight: 80 })).toBe(180);
  });

  it("pins a panel taller than the list card to the top", () => {
    expect(optionHelpPanelOffsetTop({ activeItemTop: 48, listCardHeight: 80, panelHeight: 120 })).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { EDITOR_TOOLBAR_MAX_TIER, EDITOR_TOOLBAR_STEP_DOWN_MIN_GROWTH_PX, EDITOR_TOOLBAR_STEP_DOWN_SLACK_PX, resolveNextEditorToolbarTier } from "@/lib/tabs/editorToolbarLayout";

describe("editor toolbar measured condensation", () => {
  it("steps up one tier while the content overflows", () => {
    expect(resolveNextEditorToolbarTier({ tier: 0, availableWidth: 400, contentWidth: 700 })).toBe(1);
    expect(resolveNextEditorToolbarTier({ tier: 1, availableWidth: 400, contentWidth: 450 })).toBe(2);
    expect(resolveNextEditorToolbarTier({ tier: 2, availableWidth: 400, contentWidth: 420 })).toBe(3);
  });

  it("holds at the maximum tier when even the condensed row overflows", () => {
    expect(resolveNextEditorToolbarTier({ tier: EDITOR_TOOLBAR_MAX_TIER, availableWidth: 200, contentWidth: 400 })).toBe(EDITOR_TOOLBAR_MAX_TIER);
  });

  it("holds the current tier while the row fits without real slack", () => {
    expect(resolveNextEditorToolbarTier({ tier: 1, availableWidth: 500, contentWidth: 480 })).toBe(1);
    expect(resolveNextEditorToolbarTier({ tier: 1, availableWidth: 500, contentWidth: 500 - EDITOR_TOOLBAR_STEP_DOWN_SLACK_PX + 1 })).toBe(1);
  });

  it("steps down only with slack and real pane growth since the last condensation", () => {
    const grown = 400 + EDITOR_TOOLBAR_STEP_DOWN_MIN_GROWTH_PX + 10;
    expect(resolveNextEditorToolbarTier({ tier: 2, availableWidth: grown, contentWidth: grown - EDITOR_TOOLBAR_STEP_DOWN_SLACK_PX - 10, condensedAtWidth: 400 })).toBe(1);
  });

  it("never oscillates: slack alone without pane growth keeps the condensed tier", () => {
    // The row fits with plenty of slack, but the pane barely grew since the
    // toolbar condensed at this width — stepping down would overflow again.
    expect(resolveNextEditorToolbarTier({ tier: 2, availableWidth: 410, contentWidth: 350, condensedAtWidth: 400 })).toBe(2);
    expect(resolveNextEditorToolbarTier({ tier: 2, availableWidth: 410, contentWidth: 410 - EDITOR_TOOLBAR_STEP_DOWN_SLACK_PX - 1, condensedAtWidth: 400 })).toBe(2);
  });

  it("allows stepping down immediately when the toolbar was never condensed", () => {
    expect(resolveNextEditorToolbarTier({ tier: 1, availableWidth: 900, contentWidth: 500 })).toBe(0);
  });

  it("keeps the current tier for unmeasured or invalid input", () => {
    expect(resolveNextEditorToolbarTier({ tier: 1, availableWidth: 0, contentWidth: 0 })).toBe(1);
    expect(resolveNextEditorToolbarTier({ tier: 2, availableWidth: Number.NaN, contentWidth: 100 })).toBe(2);
  });
});

import { describe, expect, it } from "vitest";
import { OPTION_HELP_PANEL_CLASS } from "./optionHelpPanel";

describe("OptionHelpPanel layout", () => {
  it("keeps the panel compact at the top and scrolls long help content", () => {
    expect(OPTION_HELP_PANEL_CLASS).toContain("self-start");
    expect(OPTION_HELP_PANEL_CLASS).toContain("max-h-64");
    expect(OPTION_HELP_PANEL_CLASS).toContain("overflow-y-auto");
    expect(OPTION_HELP_PANEL_CLASS).toContain("rounded-lg");
    expect(OPTION_HELP_PANEL_CLASS).toContain("shadow-md");
    expect(OPTION_HELP_PANEL_CLASS).toContain("sm:mt-[var(--option-help-offset)]");
  });
});

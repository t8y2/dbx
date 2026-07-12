import { describe, expect, it } from "vitest";
import { SEARCHABLE_SELECT_HELP_PANEL_ALIGN, searchableSelectKeyboardTooltipOption, searchableSelectSelectedOrFirstHelpOption } from "@/lib/common/searchableSelectTooltip";

describe("searchableSelectKeyboardTooltipOption", () => {
  it("anchors the help panel to the trigger's left edge", () => {
    expect(SEARCHABLE_SELECT_HELP_PANEL_ALIGN).toBe("start");
  });

  it("activates the highlighted option help during Arrow-key navigation", () => {
    const optionTooltip = (option: string) => (option === "json" ? "Validated JSON document" : undefined);

    // ArrowDown moves highlight from int (index 0) to json (index 1) while the search input retains focus.
    expect(searchableSelectKeyboardTooltipOption(["int", "json"], 0, optionTooltip)).toBeUndefined();
    expect(searchableSelectKeyboardTooltipOption(["int", "json"], 1, optionTooltip)).toBe("json");
  });

  it("does not activate help for the initial unhighlighted list state", () => {
    const optionTooltip = () => "Type help";

    expect(searchableSelectKeyboardTooltipOption(["int"], -1, optionTooltip)).toBeUndefined();
  });

  it("activates selected help on open and the first matching option after search", () => {
    const optionTooltip = (option: string) => (option === "json" || option === "int" ? `${option} help` : undefined);

    expect(searchableSelectSelectedOrFirstHelpOption(["int", "json"], "json", optionTooltip)).toBe("json");
    expect(searchableSelectSelectedOrFirstHelpOption(["int", "json"], "unknown", optionTooltip)).toBe("int");
    expect(searchableSelectSelectedOrFirstHelpOption(["custom"], "unknown", optionTooltip)).toBeUndefined();
    expect(searchableSelectSelectedOrFirstHelpOption(["dynamic_unknown", "json"], "dynamic_unknown", optionTooltip)).toBe("json");
  });

  it("does not activate a tooltip when the optional callback is absent or returns no content", () => {
    expect(searchableSelectKeyboardTooltipOption(["int", "json"], 1)).toBeUndefined();
    expect(searchableSelectKeyboardTooltipOption(["int", "json"], 0, () => undefined)).toBeUndefined();
  });
});

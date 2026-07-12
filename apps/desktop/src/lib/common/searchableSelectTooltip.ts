export type SearchableSelectOptionTooltip = (option: string) => string | undefined;

/** Keep the option list aligned with its trigger while help expands rightward. */
export const SEARCHABLE_SELECT_HELP_PANEL_ALIGN = "start";

/**
 * Returns the option whose help panel is activated by keyboard navigation
 * while focus remains in the searchable input. Empty-string options are valid.
 */
export function searchableSelectKeyboardTooltipOption(options: readonly string[], highlightIndex: number, optionTooltip?: SearchableSelectOptionTooltip): string | undefined {
  const option = options[highlightIndex];
  return option === undefined || !optionTooltip?.(option) ? undefined : option;
}

/** Returns the selected option's help, or the first available option's help. */
export function searchableSelectSelectedOrFirstHelpOption(options: readonly string[], selectedOption: string, optionTooltip?: SearchableSelectOptionTooltip): string | undefined {
  if (options.includes(selectedOption) && optionTooltip?.(selectedOption)) return selectedOption;
  return options.find((option) => !!optionTooltip?.(option));
}
